/**
 * Tests for the durable discovery job (lib/jobs/discoveryJob.ts,
 * lib/jobs/queue.ts) that replaced the fire-and-forget in-process Promise
 * previously run by app/api/cloud-accounts/[id]/discover/route.ts.
 *
 * pg-boss itself needs a live Postgres connection, so it's mocked here —
 * these tests verify CloudCraft's own logic: what gets enqueued, what the
 * worker does with a job, and critically, that decrypted credentials never
 * appear in the job payload sent to pg-boss (they'd otherwise sit in the
 * pgboss.job table in Postgres for as long as the job is queued).
 */

const mockBossInstance = {
  start: jest.fn(),
  stop: jest.fn(),
  createQueue: jest.fn(),
  send: jest.fn(),
  work: jest.fn(),
  on: jest.fn(),            // the queue registers an error listener (an unhandled pg-boss error would crash the process)
};

jest.mock('pg-boss', () => ({
  PgBoss: jest.fn().mockImplementation(() => mockBossInstance),
}));

jest.mock('@/lib/repositories/cloudAccountRepository', () => ({
  cloudAccountRepository: {
    getCredentials: jest.fn(),
    updateStatus: jest.fn(),
  },
}));

jest.mock('@/lib/repositories/discoveryRepository', () => ({
  discoveryRepository: {
    markRunning: jest.fn(),
    markCompleted: jest.fn(),
    markFailed: jest.fn(),
  },
}));

jest.mock('@/lib/cloud/provider', () => ({
  createDiscoveryProvider: jest.fn(),
}));

import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { discoveryRepository } from '@/lib/repositories/discoveryRepository';
import { createDiscoveryProvider } from '@/lib/cloud/provider';
import { enqueueDiscoveryJob, processDiscoveryJob, DISCOVERY_QUEUE } from '@/lib/jobs/discoveryJob';

// The pg-boss instance is memoized on `global.__cloudcraft_boss__` (real
// process-wide global state, not module-scoped) — clear it between tests so
// each test starts a fresh boss.start() with the current DATABASE_URL.
function clearQueueSingleton(): void {
  (global as unknown as { __cloudcraft_boss__?: unknown }).__cloudcraft_boss__ = undefined;
}

describe('Discovery job queue', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    clearQueueSingleton();
    process.env = { ...ORIGINAL_ENV, DATABASE_URL: 'postgresql://test:test@localhost:5432/test' };
    mockBossInstance.start.mockResolvedValue(mockBossInstance);
    mockBossInstance.stop.mockResolvedValue(undefined);
    mockBossInstance.createQueue.mockResolvedValue(undefined);
    mockBossInstance.send.mockResolvedValue('job-id-123');
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    clearQueueSingleton();
  });

  describe('enqueueDiscoveryJob', () => {
    it('registers an error listener on the queue, so a dropped connection is logged instead of crashing the process', async () => {
      await enqueueDiscoveryJob({ runId: 'run-1', accountId: 'acct-1', orgId: 'org-1', regions: ['us-east-1'] });
      expect(mockBossInstance.on).toHaveBeenCalledWith('error', expect.any(Function));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const handler = mockBossInstance.on.mock.calls.find((c) => c[0] === 'error')![1] as (e: unknown) => void;
      expect(() => handler(new Error('terminating connection'))).not.toThrow();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('creates the queue and sends the job with only runId/accountId/orgId/regions — never credentials', async () => {
      await enqueueDiscoveryJob({ runId: 'run-1', accountId: 'acct-1', orgId: 'org-1', regions: ['us-east-1'] });

      expect(mockBossInstance.createQueue).toHaveBeenCalledWith(
        DISCOVERY_QUEUE,
        expect.objectContaining({ retryLimit: expect.any(Number), retryBackoff: true }),
      );
      expect(mockBossInstance.send).toHaveBeenCalledWith(
        DISCOVERY_QUEUE,
        { runId: 'run-1', accountId: 'acct-1', orgId: 'org-1', regions: ['us-east-1'] },
      );

      const payload = mockBossInstance.send.mock.calls[0]![1] as Record<string, unknown>;
      const json = JSON.stringify(payload);
      expect(json).not.toMatch(/roleArn|clientSecret|externalId|accessKeyId|secretAccessKey/i);
    });

    it('throws a clear error when DATABASE_URL is not configured', async () => {
      delete process.env['DATABASE_URL'];
      await expect(
        enqueueDiscoveryJob({ runId: 'run-1', accountId: 'acct-1', orgId: 'org-1' }),
      ).rejects.toThrow(/DATABASE_URL/);
    });
  });

  describe('processDiscoveryJob', () => {
    const jobData = { runId: 'run-1', accountId: 'acct-1', orgId: 'org-1', regions: ['us-east-1'] };

    it('marks the run running, then completed, and activates the account on success', async () => {
      (cloudAccountRepository.getCredentials as jest.Mock).mockResolvedValue(
        JSON.stringify({ roleArn: 'arn:aws:iam::123456789012:role/x', externalId: 'ext', region: 'us-east-1' }),
      );
      const mockDispose = jest.fn().mockResolvedValue(undefined);
      (createDiscoveryProvider as jest.Mock).mockResolvedValue({
        discoverAll: jest.fn().mockResolvedValue({
          status: 'completed', resources: [{ id: 'r1' }], relationships: [], summary: { vpc: 1 },
        }),
        dispose: mockDispose,
      });

      await processDiscoveryJob(jobData);

      expect(discoveryRepository.markRunning).toHaveBeenCalledWith('run-1');
      expect(discoveryRepository.markCompleted).toHaveBeenCalledWith('run-1', [{ id: 'r1' }], { vpc: 1 }, []);
      expect(cloudAccountRepository.updateStatus).toHaveBeenCalledWith('acct-1', 'org-1', 'active');
      expect(mockDispose).toHaveBeenCalled();
      expect(discoveryRepository.markFailed).not.toHaveBeenCalled();
    });

    it('marks the run failed when discovery reports a failed status, and does not activate the account', async () => {
      (cloudAccountRepository.getCredentials as jest.Mock).mockResolvedValue(
        JSON.stringify({ roleArn: 'arn:aws:iam::123456789012:role/x', externalId: 'ext', region: 'us-east-1' }),
      );
      (createDiscoveryProvider as jest.Mock).mockResolvedValue({
        discoverAll: jest.fn().mockResolvedValue({ status: 'failed', error: 'Access denied' }),
        dispose: jest.fn().mockResolvedValue(undefined),
      });

      await processDiscoveryJob(jobData);

      expect(discoveryRepository.markFailed).toHaveBeenCalledWith('run-1', 'Access denied');
      expect(cloudAccountRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('marks the run failed (not left running forever) when the provider throws unexpectedly', async () => {
      (cloudAccountRepository.getCredentials as jest.Mock).mockResolvedValue(
        JSON.stringify({ roleArn: 'arn:aws:iam::123456789012:role/x', externalId: 'ext', region: 'us-east-1' }),
      );
      const mockDispose = jest.fn().mockResolvedValue(undefined);
      (createDiscoveryProvider as jest.Mock).mockResolvedValue({
        discoverAll: jest.fn().mockRejectedValue(new Error('network timeout')),
        dispose: mockDispose,
      });

      await processDiscoveryJob(jobData);

      expect(discoveryRepository.markFailed).toHaveBeenCalledWith('run-1', 'network timeout');
      expect(mockDispose).toHaveBeenCalled();
    });

    it('marks the run failed when the account has no stored credentials, without calling the provider', async () => {
      (cloudAccountRepository.getCredentials as jest.Mock).mockResolvedValue(null);

      await processDiscoveryJob(jobData);

      expect(discoveryRepository.markFailed).toHaveBeenCalledWith('run-1', expect.stringContaining('credentials'));
      expect(createDiscoveryProvider).not.toHaveBeenCalled();
    });

    it('marks the run failed when stored credentials are malformed JSON, without calling the provider', async () => {
      (cloudAccountRepository.getCredentials as jest.Mock).mockResolvedValue('{not valid json');

      await processDiscoveryJob(jobData);

      expect(discoveryRepository.markFailed).toHaveBeenCalledWith('run-1', expect.stringContaining('malformed'));
      expect(createDiscoveryProvider).not.toHaveBeenCalled();
    });
  });
});
