/**
 * Terraform apply — durable job definition.
 *
 * `terraform apply` genuinely mutates a user's cloud infrastructure and can
 * run for many minutes; it must not be a fire-and-forget in-request
 * operation the way discovery originally was (see lib/jobs/discoveryJob.ts
 * for the same reasoning). It's processed by
 * workers/terraformApplyWorker.ts, a separate long-running process from
 * the Next.js server.
 *
 * Security: same credential-hygiene rule as the discovery job — the payload
 * carries only { applyRunId, planId, accountId, orgId }, never decrypted
 * credentials. The worker re-fetches and decrypts them itself right before
 * running `terraform apply` (see TerraformExecutionService.runApply).
 *
 * Status is NOT tracked in a separate app-owned table. pg-boss's own job
 * state (queried via getJobById) IS the source of truth for "pending /
 * running / completed / failed" — see getApplyJobStatus below — which
 * avoids a second, harder-to-keep-consistent status store, and works
 * correctly across the producer (web) and consumer (worker) processes
 * without any additional plumbing.
 */
import { getQueue } from './queue';
import { terraformExecutionDisabled } from '@/lib/terraform/execution/killSwitch';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { releaseProjectLock } from '@/lib/terraform/execution/projectLock';
import { runApply } from '@/lib/terraform/execution/TerraformExecutionService';
import type { TerraformApplyJobData, ApplyJobOutput } from '@/lib/terraform/execution/types';
import { getPlan } from '@/lib/terraform/execution/planStore';
import { ApplyProgressTracker, readRunProgress, writeRunProgress, type RunProgressRecord } from '@/lib/terraform/execution/applyProgress';

export const TERRAFORM_APPLY_QUEUE = 'terraform-apply';

export async function ensureTerraformApplyQueue(): Promise<void> {
  const boss = await getQueue();
  await boss.createQueue(TERRAFORM_APPLY_QUEUE, {
    expireInSeconds: 3600,
    // Apply is NOT safely retryable in general — a failed apply may have
    // partially modified real infrastructure, and blindly re-running it
    // could compound the problem rather than fix it. No automatic retry;
    // a failure surfaces to the admin to investigate and re-plan.
    retryLimit: 0,
  });
}

export async function enqueueApplyJob(data: TerraformApplyJobData): Promise<string> {
  await ensureTerraformApplyQueue();
  const boss = await getQueue();
  const jobId = await boss.send(TERRAFORM_APPLY_QUEUE, data);
  if (!jobId) throw new Error('Failed to enqueue Terraform apply job');
  return jobId;
}

/**
 * Keeps the run's progress record up to date while Terraform runs: every chunk of its output is parsed into per-resource states and the
 * record is rewritten at most once a second (the web server reads it when the page polls). Never throws: progress is advisory.
 */
function startProgressReporting(data: TerraformApplyJobData) {
  const planned = getPlan(data.planId)?.summary.resourceChanges.map((c) => ({ address: c.address, type: c.type })) ?? [];
  const tracker = new ApplyProgressTracker(planned);
  const previous = readRunProgress(data.applyRunId);
  const meta = { runId: data.applyRunId, orgId: data.orgId, projectId: data.projectId ?? previous?.projectId ?? '' };
  const startedAt = Date.now();
  let dirty = true;
  let status: RunProgressRecord['status'] = 'running';
  let final: { message?: string; error?: string; finishedAt?: number } = {};

  const write = () => {
    dirty = false;
    writeRunProgress({ ...meta, status, enqueuedAt: previous?.enqueuedAt ?? startedAt, startedAt, updatedAt: Date.now(), ...final, ...tracker.snapshot() });
  };
  write();
  const timer = setInterval(() => { if (dirty) write(); }, 1000);
  timer.unref?.();
  return {
    onOutput: (chunk: string) => { try { tracker.feed(chunk); dirty = true; } catch { /* a parsing problem must never stop the apply */ } },
    finish: (ok: boolean, text: string) => {
      clearInterval(timer);
      tracker.finish(ok);
      status = ok ? 'succeeded' : 'failed';
      final = { finishedAt: Date.now(), ...(ok ? { message: text } : { error: text.slice(0, 2000) }) };
      write();
    },
  };
}

/** Runs inside the worker process. */
export async function processApplyJob(data: TerraformApplyJobData): Promise<ApplyJobOutput> {
  const audit = { action: 'apply' as const, orgId: data.orgId, projectId: data.projectId, userId: data.requestedBy, planId: data.planId };
  const reporting = startProgressReporting(data);
  try {
    // Kill switch: honoured even for jobs that were already queued when it was switched on.
    if (terraformExecutionDisabled()) {
      const message = 'Terraform execution was switched off by the server operator before this apply ran.';
      await recordTerraformAudit({ ...audit, outcome: 'blocked', detail: message });
      reporting.finish(false, message);
      return { status: 'failed', message, outputTail: '' };
    }
    const result = await runApply(data.planId, data.orgId, reporting.onOutput);
    await recordTerraformAudit({ ...audit, outcome: 'succeeded' });
    reporting.finish(true, result.message);
    return { status: 'success', message: result.message, outputTail: result.outputTail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporting.finish(false, message);
    console.error(`[terraformApplyWorker] Apply run ${data.applyRunId} failed: ${message}`);
    await recordTerraformAudit({ ...audit, outcome: 'failed', detail: message });
    return { status: 'failed', message, outputTail: '' };
  } finally {
    if (data.projectId) releaseProjectLock(data.projectId);
  }
}

export interface ApplyJobStatus {
  state: 'pending' | 'active' | 'completed' | 'failed' | 'unknown';
  output: ApplyJobOutput | null;
}

/**
 * Polled by the API route to report apply progress back to the client.
 *
 * processApplyJob() deliberately never throws — a failed `terraform apply`
 * is reported as job output `{ status: 'failed', ... }`, not a pg-boss job
 * failure (a thrown handler would otherwise queue a retry, and apply is
 * explicitly not safe to retry automatically — see ensureTerraformApplyQueue).
 * So pg-boss's own `completed` state covers both outcomes; the real
 * success/failure signal is `output.status`.
 */
export async function getApplyJobStatus(jobId: string): Promise<ApplyJobStatus> {
  const boss = await getQueue();
  const job = await boss.getJobById<ApplyJobOutput>(TERRAFORM_APPLY_QUEUE, jobId);
  if (!job) return { state: 'unknown', output: null };

  const output = (job.output as ApplyJobOutput) ?? null;

  if (job.state === 'created' || job.state === 'retry') return { state: 'pending', output: null };
  if (job.state === 'active') return { state: 'active', output: null };
  if (job.state === 'completed') return { state: output?.status === 'failed' ? 'failed' : 'completed', output };
  return { state: 'failed', output };
}
