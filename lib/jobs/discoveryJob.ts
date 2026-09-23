/**
 * Cloud infrastructure discovery — durable job definition.
 *
 * This is the same work app/api/cloud-accounts/[id]/discover/route.ts used to
 * run as an unawaited in-process Promise. It's now enqueued via pg-boss
 * (see lib/jobs/queue.ts) and processed by a separate worker process
 * (workers/discoveryWorker.ts), so it survives the web process restarting
 * and gets automatic retries on transient failure.
 *
 * Security: the job payload intentionally carries only { runId, accountId,
 * orgId } — never decrypted credentials. Putting credentials in the payload
 * would mean they sit in the pgboss.job table (Postgres) for however long the
 * job is queued, which is a real exposure window a fire-and-forget in-memory
 * Promise never had. Instead, the worker re-fetches and decrypts credentials
 * itself right before use, exactly like the route used to, keeping them
 * transient and in-process only.
 */
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { discoveryRepository } from '@/lib/repositories/discoveryRepository';
import { createDiscoveryProvider } from '@/lib/cloud/provider';
import type { CloudCredentials } from '@/lib/cloud/types';
import { getQueue } from './queue';

export const DISCOVERY_QUEUE = 'cloud-discovery';

export interface DiscoveryJobData {
  runId: string;
  accountId: string;
  orgId: string;
  regions?: string[];
}

/**
 * Ensures the discovery queue exists with its retry policy, idempotent to
 * call repeatedly (pg-boss no-ops if the queue is already configured this way).
 * Both the producer (this module, called from the API route) and the worker
 * call this on their own PgBoss instance at startup.
 */
export async function ensureDiscoveryQueue(): Promise<void> {
  const boss = await getQueue();
  await boss.createQueue(DISCOVERY_QUEUE, {
    // A stuck/hung discovery attempt is retried rather than left "running" forever.
    expireInSeconds: 600,
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
  });
}

/**
 * Enqueues a discovery run. The run row is created by the caller (so a
 * runId exists to return to the client immediately); this only schedules
 * the actual work.
 */
export async function enqueueDiscoveryJob(data: DiscoveryJobData): Promise<void> {
  await ensureDiscoveryQueue();
  const boss = await getQueue();
  await boss.send(DISCOVERY_QUEUE, data);
}

/**
 * Runs one discovery job. All errors are caught and persisted as a failed
 * run status — a thrown error here would just cause pg-boss to retry
 * against the same (already-failed) precondition, which isn't useful for
 * discovery (a bad credential or missing account won't fix itself on retry).
 * Only genuinely transient failures (e.g. a cloud API timeout) benefit from
 * pg-boss's retry, and those are already retried inside the discovery
 * adapters themselves (retryWithBackoff) before they'd ever surface here.
 */
export async function processDiscoveryJob(data: DiscoveryJobData): Promise<void> {
  const { runId, accountId, orgId, regions } = data;

  await discoveryRepository.markRunning(runId);

  const credentialsJson = await cloudAccountRepository.getCredentials(accountId, orgId);
  if (!credentialsJson) {
    await discoveryRepository.markFailed(runId, 'CloudAccount credentials not found');
    return;
  }

  let credentials: CloudCredentials;
  try {
    credentials = JSON.parse(credentialsJson) as CloudCredentials;
  } catch {
    await discoveryRepository.markFailed(runId, 'Stored credentials are malformed');
    return;
  }

  const provider = await createDiscoveryProvider(credentials);
  try {
    const result = await provider.discoverAll(regions);

    if (result.status === 'completed') {
      await discoveryRepository.markCompleted(runId, result.resources, result.summary, result.relationships);
      await cloudAccountRepository.updateStatus(accountId, orgId, 'active');
      console.info(`[Discovery] Run ${runId} completed. Account: ${accountId}. Resources: ${result.resources.length}`);
    } else {
      const errorMsg = result.error ?? 'Discovery failed with unknown error';
      await discoveryRepository.markFailed(runId, errorMsg);
      console.error(`[Discovery] Run ${runId} failed. Account: ${accountId}. Error: ${errorMsg}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Discovery] Run ${runId} threw unexpectedly. Account: ${accountId}. Error: ${message}`);
    await discoveryRepository.markFailed(runId, message);
  } finally {
    await provider.dispose();
  }
}
