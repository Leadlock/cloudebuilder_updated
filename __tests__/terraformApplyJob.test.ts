/**
 * Tests for the durable Terraform apply job
 * (lib/jobs/terraformApplyJob.ts) — pg-boss is mocked (needs a live
 * Postgres connection). Verifies: the enqueued payload never carries
 * credentials, apply is configured with no automatic retry (unlike
 * discovery — a partially-applied `terraform apply` should not be blindly
 * re-run), the worker handler never throws (a failed apply becomes job
 * *output*, not a pg-boss job failure — see the reasoning in the module
 * itself), and status polling correctly distinguishes a completed-success
 * job from a completed-job-whose-output-says-failed.
 */

const mockBossInstance = {
  start: jest.fn(),
  stop: jest.fn(),
  createQueue: jest.fn(),
  send: jest.fn(),
  work: jest.fn(),
  getJobById: jest.fn(),
};

jest.mock('pg-boss', () => ({
  PgBoss: jest.fn().mockImplementation(() => mockBossInstance),
}));

jest.mock('@/lib/terraform/execution/TerraformExecutionService', () => ({
  runApply: jest.fn(),
}));

import { runApply } from '@/lib/terraform/execution/TerraformExecutionService';
import {
  enqueueApplyJob, processApplyJob, getApplyJobStatus, TERRAFORM_APPLY_QUEUE,
} from '@/lib/jobs/terraformApplyJob';

function clearQueueSingleton(): void {
  (global as unknown as { __cloudcraft_boss__?: unknown }).__cloudcraft_boss__ = undefined;
}

describe('Terraform apply job queue', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    clearQueueSingleton();
    process.env = { ...ORIGINAL_ENV, DATABASE_URL: 'postgresql://test:test@localhost:5432/test' };
    mockBossInstance.start.mockResolvedValue(mockBossInstance);
    mockBossInstance.createQueue.mockResolvedValue(undefined);
    mockBossInstance.send.mockResolvedValue('job-id-456');
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    clearQueueSingleton();
  });

  describe('enqueueApplyJob', () => {
    it('creates the queue with no automatic retry and sends only { applyRunId, planId, accountId, orgId } — never credentials', async () => {
      const jobId = await enqueueApplyJob({ applyRunId: 'run-1', planId: 'plan-1', accountId: 'acct-1', orgId: 'org-1' });
      expect(jobId).toBe('job-id-456');

      expect(mockBossInstance.createQueue).toHaveBeenCalledWith(
        TERRAFORM_APPLY_QUEUE,
        expect.objectContaining({ retryLimit: 0 }),
      );
      expect(mockBossInstance.send).toHaveBeenCalledWith(
        TERRAFORM_APPLY_QUEUE,
        { applyRunId: 'run-1', planId: 'plan-1', accountId: 'acct-1', orgId: 'org-1' },
      );

      const payload = mockBossInstance.send.mock.calls[0]![1] as Record<string, unknown>;
      expect(JSON.stringify(payload)).not.toMatch(/roleArn|clientSecret|accessKeyId|secretAccessKey/i);
    });

    it('throws if pg-boss fails to return a job id', async () => {
      mockBossInstance.send.mockResolvedValue(null);
      await expect(
        enqueueApplyJob({ applyRunId: 'run-1', planId: 'plan-1', accountId: 'acct-1', orgId: 'org-1' }),
      ).rejects.toThrow(/enqueue/i);
    });
  });

  describe('processApplyJob', () => {
    it('returns success output when runApply succeeds', async () => {
      (runApply as jest.Mock).mockResolvedValue({ message: 'Applied 2 resources.', outputTail: 'Apply complete!' });
      const result = await processApplyJob({ applyRunId: 'run-1', planId: 'plan-1', accountId: 'acct-1', orgId: 'org-1' });
      expect(result).toEqual({ status: 'success', message: 'Applied 2 resources.', outputTail: 'Apply complete!' });
    });

    it('never throws — a runApply failure becomes { status: "failed" } output', async () => {
      (runApply as jest.Mock).mockRejectedValue(new Error('terraform apply exited 1'));
      const result = await processApplyJob({ applyRunId: 'run-1', planId: 'plan-1', accountId: 'acct-1', orgId: 'org-1' });
      expect(result.status).toBe('failed');
      expect(result.message).toContain('terraform apply exited 1');
    });
  });

  describe('getApplyJobStatus', () => {
    it('reports pending for a created/retry job', async () => {
      mockBossInstance.getJobById.mockResolvedValue({ state: 'created', output: null });
      expect((await getApplyJobStatus('job-1')).state).toBe('pending');
    });

    it('reports active for a running job', async () => {
      mockBossInstance.getJobById.mockResolvedValue({ state: 'active', output: null });
      expect((await getApplyJobStatus('job-1')).state).toBe('active');
    });

    it('reports completed when pg-boss state is completed AND output says success', async () => {
      mockBossInstance.getJobById.mockResolvedValue({
        state: 'completed', output: { status: 'success', message: 'done', outputTail: '' },
      });
      const status = await getApplyJobStatus('job-1');
      expect(status.state).toBe('completed');
      expect(status.output?.message).toBe('done');
    });

    it('reports failed when pg-boss state is completed but output says failed (processApplyJob never throws)', async () => {
      mockBossInstance.getJobById.mockResolvedValue({
        state: 'completed', output: { status: 'failed', message: 'apply error', outputTail: '' },
      });
      const status = await getApplyJobStatus('job-1');
      expect(status.state).toBe('failed');
      expect(status.output?.message).toBe('apply error');
    });

    it('reports unknown when the job does not exist', async () => {
      mockBossInstance.getJobById.mockResolvedValue(null);
      expect((await getApplyJobStatus('missing')).state).toBe('unknown');
    });
  });
});
