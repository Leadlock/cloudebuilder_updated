/**
 * The daily readiness snapshot (evidence over time). Runs inside the existing worker process (workers/discoveryWorker.ts), which already owns the job queue,
 * so deploying needs no extra process. pg-boss schedules it once for the whole system, not once per worker instance.
 */
import { snapshotAllProjects } from '@/lib/compliance/snapshotService';
import { getQueue } from './queue';

export const READINESS_SNAPSHOT_QUEUE = 'readiness-snapshot';
/** 03:30 UTC every day. */
export const READINESS_SNAPSHOT_CRON = '30 3 * * *';

export async function ensureReadinessSnapshotQueue(): Promise<void> {
  const boss = await getQueue();
  await boss.createQueue(READINESS_SNAPSHOT_QUEUE, { expireInSeconds: 1800, retryLimit: 2, retryDelay: 300, retryBackoff: true });
  await boss.schedule(READINESS_SNAPSHOT_QUEUE, READINESS_SNAPSHOT_CRON, null, { tz: 'UTC' });
}

export async function processReadinessSnapshotJob(): Promise<void> {
  const r = await snapshotAllProjects();
  console.info(`[readinessSnapshot] ${r.projects} projects, ${r.taken} snapshots taken, ${r.skipped} skipped, ${r.failed} failed`);
  // A run where everything failed is a failed job (so pg-boss retries it); a partial failure is logged and the rest stand.
  if (r.failed > 0 && r.taken === 0) throw new Error('Every readiness snapshot failed');
}
