/**
 * A project release — durable job definition (see lib/deploy/project and docs/IN_APP_DEPLOYMENT_DESIGN.md).
 *
 * It runs in the same worker process as `terraform apply` (workers/terraformApplyWorker.ts) on a queue of its own: the same Terraform binary, the same
 * kill switch, the same blast-radius reasoning. The payload carries only ids: never a credential, never a secret value. The worker reads the account's
 * credentials itself when it needs them.
 *
 * Like an apply it is never retried automatically: a failed release may have changed real infrastructure, so it stops and says which step failed,
 * and a person decides (retry from that step, or plan again).
 */
import { getQueue } from './queue';
import { terraformExecutionDisabled } from '@/lib/terraform/execution/killSwitch';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { releaseProjectLock } from '@/lib/terraform/execution/projectLock';
import { PgReleaseStore } from '@/lib/deploy/project/pgReleaseStore';
import { azureOpsForAccount } from '@/lib/deploy/project/accountOps';
import { createTerraformInfraRunner } from '@/lib/deploy/project/infra';
import { runRelease, type OrchestratorDeps } from '@/lib/deploy/project/orchestrator';
import type { ReleaseStore } from '@/lib/deploy/project/releaseStore';
import { PgSourceStore, type SourceStore } from '@/lib/deploy/project/sourceStore';

export const PROJECT_RELEASE_QUEUE = 'project-release';

export interface ProjectReleaseJobData {
  releaseId: string;
  orgId: string;
  projectId: string;
  requestedBy: string;
}

export async function ensureProjectReleaseQueue(): Promise<void> {
  const boss = await getQueue();
  await boss.createQueue(PROJECT_RELEASE_QUEUE, {
    // A first release creates a cluster-sized set of resources and builds images: allow it hours, not minutes.
    expireInSeconds: 3 * 3600,
    retryLimit: 0,
  });
}

export async function enqueueReleaseJob(data: ProjectReleaseJobData): Promise<string> {
  await ensureProjectReleaseQueue();
  const boss = await getQueue();
  const jobId = await boss.send(PROJECT_RELEASE_QUEUE, data);
  if (!jobId) throw new Error('Failed to enqueue the release');
  return jobId;
}

/** Dependencies of a run, replaceable in tests. */
export interface ReleaseJobDeps {
  store: ReleaseStore;
  sources?: SourceStore;
  opsFor: typeof azureOpsForAccount;
  infra: OrchestratorDeps['infra'];
  killSwitch: () => boolean;
}

const defaultDeps = (): ReleaseJobDeps => ({ store: new PgReleaseStore(), sources: new PgSourceStore(), opsFor: azureOpsForAccount, infra: createTerraformInfraRunner(), killSwitch: terraformExecutionDisabled });

/** Runs inside the worker process. Never throws: what went wrong is on the release. */
export async function processReleaseJob(data: ProjectReleaseJobData, deps: ReleaseJobDeps = defaultDeps()): Promise<{ status: string; message: string }> {
  const audit = { action: 'release' as const, orgId: data.orgId, projectId: data.projectId, userId: data.requestedBy };
  try {
    const release = await deps.store.get(data.releaseId);
    if (!release || release.orgId !== data.orgId || release.projectId !== data.projectId) throw new Error('The release was not found.');
    let ops;
    try { ops = await deps.opsFor(release.orgId, release.cloudAccountId); }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      release.status = 'failed'; release.error = `account: ${message}`; release.updatedAt = Date.now();
      await deps.store.save(release);
      await recordTerraformAudit({ ...audit, planId: release.planId, planHash: release.planHash, outcome: 'failed', detail: `release ${release.id}: ${message}` });
      return { status: 'failed', message };
    }
    const result = await runRelease({ store: deps.store, sources: deps.sources, ops, infra: deps.infra, killSwitch: deps.killSwitch, log: (id, line) => console.info(`[project-release ${id}] ${line}`) }, data.releaseId);
    const outcome = result.status === 'succeeded' ? 'succeeded' : result.status === 'waiting' || result.status === 'cancelled' ? 'allowed' : 'failed';
    await recordTerraformAudit({ ...audit, planId: result.planId, planHash: result.planHash, outcome, detail: `release ${result.id}: ${result.status}${result.error ? `: ${result.error}` : ''}` });
    return { status: result.status, message: result.error ?? result.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[project-release] release ${data.releaseId} could not run: ${message}`);
    await recordTerraformAudit({ ...audit, outcome: 'failed', detail: `release ${data.releaseId}: ${message}` });
    return { status: 'failed', message };
  } finally {
    releaseProjectLock(data.projectId);
  }
}
