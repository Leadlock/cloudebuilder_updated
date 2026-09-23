/**
 * Standalone worker process for `terraform apply` execution.
 *
 * Run as its own long-running process (`npm run worker:terraform-apply`),
 * separate from both the Next.js server and the discovery worker — keeping
 * a bad apply run's blast radius (a hung terraform process, a runaway
 * timeout) isolated from unrelated discovery jobs. Requires the same
 * environment as the main app (DATABASE_URL, ENCRYPTION_KEY) plus the
 * `terraform` CLI itself on PATH — see lib/terraform/execution/cli.ts.
 */
import type { Job } from 'pg-boss';
import { getQueue, stopQueue } from '../lib/jobs/queue';
import { TERRAFORM_APPLY_QUEUE, ensureTerraformApplyQueue, processApplyJob } from '../lib/jobs/terraformApplyJob';
import type { TerraformApplyJobData } from '../lib/terraform/execution/types';

async function main(): Promise<void> {
  await ensureTerraformApplyQueue();
  const boss = await getQueue();

  await boss.work<TerraformApplyJobData>(TERRAFORM_APPLY_QUEUE, async ([job]: Job<TerraformApplyJobData>[]) => {
    console.info(`[terraformApplyWorker] Picked up apply job ${job.id} (run ${job.data.applyRunId})`);
    return processApplyJob(job.data);
  });

  console.info('[terraformApplyWorker] Started. Waiting for terraform-apply jobs...');
}

async function shutdown(signal: string): Promise<void> {
  console.info(`[terraformApplyWorker] Received ${signal}, shutting down gracefully...`);
  await stopQueue();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  console.error('[terraformApplyWorker] Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
