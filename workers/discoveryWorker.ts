/**
 * Standalone worker process for cloud infrastructure discovery jobs.
 *
 * Run this as its own long-running process, separate from the Next.js
 * server (`npm run worker:discovery`). It shares nothing in-memory with the
 * web process — it coordinates purely through the pgboss tables in the same
 * Postgres database (DATABASE_URL). This is what makes discovery durable:
 * the API route only enqueues a job and returns; this process is what
 * actually runs it, with pg-boss retrying on failure and the job surviving
 * a web-process restart because it's persisted before the HTTP response
 * that queued it ever returns.
 *
 * Requires the same environment as the main app: DATABASE_URL and
 * ENCRYPTION_KEY (to decrypt stored cloud account credentials).
 */
import type { Job } from 'pg-boss';
import { getQueue, stopQueue } from '../lib/jobs/queue';
import { DISCOVERY_QUEUE, ensureDiscoveryQueue, processDiscoveryJob, type DiscoveryJobData } from '../lib/jobs/discoveryJob';

async function main(): Promise<void> {
  await ensureDiscoveryQueue();
  const boss = await getQueue();

  await boss.work<DiscoveryJobData>(DISCOVERY_QUEUE, async ([job]: Job<DiscoveryJobData>[]) => {
    console.info(`[discoveryWorker] Picked up job ${job.id} (run ${job.data.runId})`);
    await processDiscoveryJob(job.data);
  });

  console.info('[discoveryWorker] Started. Waiting for cloud-discovery jobs...');
}

async function shutdown(signal: string): Promise<void> {
  console.info(`[discoveryWorker] Received ${signal}, shutting down gracefully...`);
  await stopQueue();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  console.error('[discoveryWorker] Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
