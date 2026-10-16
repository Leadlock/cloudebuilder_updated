/**
 * Real Terraform plan/apply execution against a connected cloud account.
 *
 * Plan generation (generatePlan) runs synchronously within the API request
 * that calls it — `terraform plan` is non-mutating and read-only against
 * the target cloud account, so a request-scoped timeout is an acceptable
 * risk the way it isn't for `apply` (see runApply, invoked only from the
 * durable job worker — workers/terraformApplyWorker.ts).
 *
 * Safety gates enforced here, all required by design, not configurable:
 * 1. RBAC + review-approval + hash-tamper — reuses
 *    ArchitectureReviewService's existing gates verbatim; plan generation
 *    is refused unless the exact current architecture has an approved review.
 * 2. Remote state backend — required on every call; there is no "local
 *    backend" code path. CloudCraft does not provision the backend
 *    (S3 bucket / Azure Storage container) itself, only requires one.
 * 3. Destroy actions are blocked entirely — any plan containing so much as
 *    one resource `delete` action throws PlanBlockedError and the plan
 *    is never stored or confirmable. This is a first-version policy
 *    limitation, not a UI toggle.
 */
import { randomUUID, createHash } from 'crypto';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { terraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import { ArchitectureReviewService } from '@/lib/services/ArchitectureReviewService';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { resolveExecutionCredentials } from '@/lib/cloud/credentials/resolveExecutionCredentials';
import { runAwsPreflight, awsPreflightClients, regionFromTfvars } from './preflight';
import { retryPluginStartup } from './runSupport';
import { findProtectedResources, disableDeletionProtection, protectionClients, minimalAwsDestroyConfig } from './teardownSupport';
import { assertTerraformCapable } from '@/lib/cloud/terraformCapability';
import type { CloudCredentials } from '@/lib/cloud/types';
import type { CanvasNode, CanvasEdge } from '@/types';
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';
import { runTerraform } from './cli';
import { selectTargets } from './targetSelection';
import { renderBackendConfig } from './backendConfig';
import { assertSafeHcl } from '@/lib/engines/terraform/hclSafety';
import { terraformSecretVarsFor } from './deploymentSecrets';
import { decideAutoUnlock, describeHeldLock, isStateLockError, type LockedOperation } from './stateLock';
import { initWithRetry, validateConfiguration } from './runSupport';
import { acquireProjectLock, releaseProjectLock } from './projectLock';
import { startRun, type RunHandle } from './runRegistry';
import { savePreparedDestroy, peekPreparedDestroy, takePreparedDestroy, type PreparedDestroyPlan } from './destroyPlans';
import { recordTerraformAudit } from './audit';
import { evaluatePlanGuardrails, PlanGuardrailError, type PlanJsonForGuardrails } from './planGuardrails';
import { savePlan, getPlan, deletePlan, planTtlMs } from './planStore';
import type { PlanRecord, PlanResourceAction, PlanSummary, TerraformStateBackendConfig } from './types';

/** A valid, non-empty zip with an index.js, used as the package for placeholder AWS Lambda functions. */
const LAMBDA_PLACEHOLDER_ZIP = Buffer.from(
  'UEsDBBQAAAAAAAAAAABSXXJzQQAAAEEAAAAIAAAAaW5kZXguanNleHBvcnRzLmhhbmRsZXIgPSBhc3luYyAoKSA9PiAoeyBzdGF0dXNDb2RlOiAyMDAsIGJvZHk6ICJPSyIgfSk7ClBLAQIUABQAAAAAAAAAAABSXXJzQQAAAEEAAAAIAAAAAAAAAAAAAAAAAAAAAABpbmRleC5qc1BLBQYAAAAAAQABADYAAABnAAAAAAA=',
  'base64',
);

export class PlanBlockedError extends Error {
  constructor(public readonly destroyedAddresses: string[]) {
    super(
      `Plan blocked: contains ${destroyedAddresses.length} resource destroy action(s) ` +
      `(${destroyedAddresses.slice(0, 5).join(', ')}${destroyedAddresses.length > 5 ? ', …' : ''}). ` +
      'CloudCraft does not apply plans that destroy infrastructure. This usually means the design changed after an earlier deployment, so something that was already built is no longer in the design. ' +
      'To start over cleanly, use Teardown to remove the earlier deployment, then generate a new plan; or review and run this manually with the Terraform CLI if the destroy is intentional.',
    );
    this.name = 'PlanBlockedError';
  }
}

interface GeneratePlanInput {
  projectId: string;
  orgId: string;
  environment: string;
  cloudAccountId: string;
  stateBackend: TerraformStateBackendConfig;
  user: { id: string; name: string; email: string; role: string };
  resources: DbArchitectureResource[];
  connections: DbArchitectureConnection[];
  architectureId: string;
  projectName: string;
  /** Canvas resource ids: plan and deploy only these (and what they need), not the whole architecture. */
  targetNodeIds?: string[];
}

type TerraformPlanJson = PlanJsonForGuardrails;

function toResourceMap(
  nodes: DbArchitectureResource[],
  connections: DbArchitectureConnection[],
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  // ArchitectureReviewService.computeArchitectureHash operates on
  // CanvasNode/CanvasEdge — the same shape the hash was computed from at
  // review-submission time — so this conversion must reproduce every field
  // that function reads (id/resourceType/provider/groupId/config/position
  // for nodes; id/source/target/edgeType for edges) or the hash will never
  // match and every plan generation will fail the tamper gate.
  const canvasNodes: CanvasNode[] = nodes.map((r) => ({
    id: r.id,
    type: 'cloudNode',
    resourceType: r.resourceType,
    provider: r.provider as 'aws' | 'azure',
    label: r.label,
    position: { x: r.positionX, y: r.positionY },
    config: JSON.parse(r.configJson || '{}'),
    groupId: r.groupId ?? undefined,
    locked: r.locked,
  }));
  const canvasEdges: CanvasEdge[] = connections.map((c) => ({
    id: c.id,
    source: c.sourceId,
    target: c.targetId,
    label: c.label ?? undefined,
    edgeType: c.edgeType ?? 'network',
  }));
  return { nodes: canvasNodes, edges: canvasEdges };
}

/**
 * Runs a terraform step; if the remote state is locked it explains who holds the lock. It only clears the lock itself
 * when that is provably safe (see stateLock.ts: our own machine, older than any run we allow, never for a destroy) —
 * breaking a lock held by a live run elsewhere can corrupt shared state.
 */
async function handleStateLockAndRetry<T>(
  fn: () => Promise<T>,
  workDir: string,
  env: Record<string, string>,
  operation: LockedOperation,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isStateLockError(msg)) throw err;
    const decision = decideAutoUnlock(msg, operation);
    if (!decision.unlock) throw new Error(describeHeldLock(msg, decision));
    try {
      console.warn(`[TerraformExecution] Releasing a stale state lock of our own (${decision.id}) before retrying ${operation}.`);
      await runTerraform(['force-unlock', '-force', decision.id], { cwd: workDir, env });
      return await fn();
    } catch (unlockErr) {
      console.warn('[TerraformExecution] Auto-unlock attempt failed:', unlockErr instanceof Error ? unlockErr.message : String(unlockErr));
      throw err;
    }
  }
}

interface PlanInWorkDirInput {
  /** A folder that already holds the Terraform files and backend.tf. */
  workDir: string;
  env: Record<string, string>;
  provider: 'aws' | 'azure';
  targets: string[];
  /** Warnings from whoever generated the files, shown with the plan. */
  notes: string[];
  projectId: string; orgId: string; environment: string; cloudAccountId: string;
  user: { id: string; name: string; email: string };
}

/**
 * Initialises, validates and plans the Terraform in a folder, refuses a plan that destroys anything or fails the safety checks, and stores the
 * plan for approval. Shared by the plan of an architecture and the plan of a project release. On failure the caller removes the folder.
 */
async function planInWorkDir(a: PlanInWorkDirInput): Promise<PlanRecord> {
  await initWithRetry(a.workDir, a.env);
  await validateConfiguration(a.workDir, a.env);   // a configuration Terraform will reject fails here, in seconds

  // -detailed-exitcode: 0 = no changes, 2 = changes present, 1 = error (thrown by runTerraform).
  await handleStateLockAndRetry(
    () =>
      retryPluginStartup(() => runTerraform(['plan', '-input=false', '-no-color', '-out=tfplan', '-detailed-exitcode', ...a.targets.map((t) => `-target=${t}`)], {
        cwd: a.workDir,
        env: a.env,
        allowExitCodes: [0, 2],
      }), sleep),
    a.workDir,
    a.env,
    'plan',
  );

  const { stdout: planJsonRaw } = await retryPluginStartup(() => runTerraform(['show', '-json', '-no-color', 'tfplan'], { cwd: a.workDir, env: a.env }), sleep);
  const planJson = JSON.parse(planJsonRaw) as TerraformPlanJson;

  const resourceChanges = (planJson.resource_changes ?? [])
    .filter((rc) => !rc.change.actions.includes('no-op') || rc.change.actions.length === 0)
    .map((rc) => ({
      address: rc.address,
      type: rc.type,
      actions: rc.change.actions as PlanResourceAction[],
    }))
    .filter((rc) => rc.actions.length > 0 && !(rc.actions.length === 1 && rc.actions[0] === 'no-op'));

  const destroyed = resourceChanges.filter((rc) => rc.actions.includes('delete')).map((rc) => rc.address);
  if (destroyed.length > 0) {
    throw new PlanBlockedError(destroyed);
  }

  // Look at what Terraform would actually do before this plan can ever be approved.
  const guardrails = evaluatePlanGuardrails(planJson);
  if (!guardrails.passed) throw new PlanGuardrailError(guardrails);

  const summary: PlanSummary = {
    toAdd: resourceChanges.filter((rc) => rc.actions.includes('create')).length,
    toChange: resourceChanges.filter((rc) => rc.actions.includes('update')).length,
    toDestroy: 0,
    resourceChanges,
    // The generator's warnings, minus the one that is just the diagram's cloud outline (a drawing helper, not a resource).
    notes: a.notes.filter((w) => !/^Unsupported AWS resource type: aws_cloud_boundary/.test(w)).slice(0, 8),
    guardrails,
    ...(a.targets.length > 0 ? { targets: a.targets } : {}),
  };

  const planFileBytes = await readFile(join(a.workDir, 'tfplan'));
  const planHash = createHash('sha256').update(planFileBytes).digest('hex');

  const record: PlanRecord = {
    planId: randomUUID(),
    planHash,
    projectId: a.projectId,
    orgId: a.orgId,
    environment: a.environment,
    cloudAccountId: a.cloudAccountId,
    provider: a.provider,
    workDir: a.workDir,
    summary,
    createdBy: { id: a.user.id, name: a.user.name, email: a.user.email },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + planTtlMs()).toISOString(),
  };
  savePlan(record);
  return record;
}

export async function generatePlan(input: GeneratePlanInput): Promise<PlanRecord> {
  const { resources, connections } = input;
  const { nodes, edges } = toResourceMap(resources, connections);

  // Gate 1: reuse ArchitectureReviewService's RBAC + review-approval + hash-tamper checks.
  // (executeDeployment also runs a security-critical-findings gate; reused implicitly
  // by calling it is not possible without also creating a deployment record, so the
  // three identity/approval gates are re-checked directly here instead.)
  if (input.user.role !== 'admin') {
    const err = new Error('Forbidden: Only Administrators can generate a Terraform plan for a target environment.') as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
  const latestReview = ArchitectureReviewService.getLatestReview(input.projectId, input.environment);
  if (!latestReview || !ArchitectureReviewService.approvalIsValid(latestReview)) {
    const err = new Error(ArchitectureReviewService.approvalBlockedMessage(latestReview, 'Plan')) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  const currentHash = ArchitectureReviewService.computeArchitectureHash(nodes, edges);
  if (latestReview.architectureHash !== currentHash) {
    const err = new Error('Plan blocked: Architecture hash mismatch. The live canvas contains unapproved changes.') as Error & { statusCode: number };
    err.statusCode = 409;
    throw err;
  }

  // Gate 2: remote state backend is mandatory (type system already requires
  // stateBackend to be passed — this just guards against an empty/malformed value).
  if (!input.stateBackend?.provider) {
    const err = new Error('Plan blocked: a remote Terraform state backend configuration is required.') as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const credentialsJson = await cloudAccountRepository.getCredentials(input.cloudAccountId, input.orgId);
  if (!credentialsJson) {
    const err = new Error('CloudAccount credentials not found') as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  const credentials = JSON.parse(credentialsJson) as CloudCredentials;
  assertTerraformCapable(credentials);       // an account connected with an access key is for discovery only
  const provider: 'aws' | 'azure' = 'tenantId' in credentials ? 'azure' : 'aws';

  const generated = terraformGenerator.generate({
    architectureId: input.architectureId,
    projectId: input.projectId,
    resources,
    connections,
    projectName: input.projectName,
  });
  // Problems the cloud would only report halfway through an apply (see TerraformGenerationResult.blocking) stop the plan here.
  if (generated.blocking && generated.blocking.length > 0) {
    throw Object.assign(new Error(`Plan blocked: ${generated.blocking.join(' ')}`), { statusCode: 400 });
  }

  let targets: string[] = [];
  if (input.targetNodeIds && input.targetNodeIds.length > 0) {
    const picked = selectTargets(generated, input.targetNodeIds, (id) => resources.find((r) => r.id === id)?.label ?? id);
    if (picked.error !== undefined) throw Object.assign(new Error(`Plan blocked: ${picked.error}`), { statusCode: 400 });
    targets = picked.addresses;
  }

  const workDir = await mkdtemp(join(tmpdir(), 'cloudcraft-tf-'));
  try {
    for (const file of generated.files) {
      await writeFile(join(workDir, file.filename), file.content, 'utf-8');
    }
    const planBackendHcl = renderBackendConfig(input.stateBackend);
    assertSafeHcl([...generated.files, { filename: 'backend.tf', content: planBackendHcl }]);
    await writeFile(join(workDir, 'backend.tf'), planBackendHcl, 'utf-8');

    await writeFile(join(workDir, 'placeholder.zip'), LAMBDA_PLACEHOLDER_ZIP);

    const rawEnv = await resolveExecutionCredentials(credentials);
    const env: Record<string, string> = {
      ...(await terraformSecretVarsFor(input.orgId, input.cloudAccountId)),
      ...rawEnv,
    };

    // Read-only checks against the real account for refusals AWS would only report halfway through an apply (see preflight.ts).
    if (provider === 'aws') {
      const region = regionFromTfvars(generated.files.find((f) => f.filename === 'terraform.tfvars')?.content);
      if (region && rawEnv['AWS_ACCESS_KEY_ID']) {
        const problems = await runAwsPreflight({ resources, region, clients: awsPreflightClients(rawEnv, region) });
        if (problems.length > 0) throw Object.assign(new Error(`Plan blocked: ${problems.join(' ')}`), { statusCode: 400 });
      }
    }

    return await planInWorkDir({
      workDir, env, provider, targets, notes: generated.warnings,
      projectId: input.projectId, orgId: input.orgId, environment: input.environment, cloudAccountId: input.cloudAccountId, user: input.user,
    });
  } catch (err) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export interface PlanBundleInput {
  projectId: string; orgId: string; environment: string; cloudAccountId: string;
  stateBackend: TerraformStateBackendConfig;
  user: { id: string; name: string; email: string; role: string };
  /** The Terraform project of a release (main.tf, variables.tf, ...; no backend.tf: the state backend is added here). */
  files: Array<{ filename: string; content: string }>;
  notes: string[];
  /** Extra environment for Terraform, for example TF_VAR_... values. */
  extraEnv?: Record<string, string>;
  /** The cloud the Terraform is for: the connected account must be of it. */
  provider: 'aws' | 'azure';
}

const BUNDLE_FILE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Plans the Terraform project of a release (the files of a project's deployment) against a connected account. The gates of a plan that
 * come from the Deploy tab's architecture review do not apply here: a release has its own approval, bound to its files and to this plan.
 * What does apply is the same: administrators only, a connected account that can run Terraform, the mandatory remote state, no plan that
 * destroys anything, and the plan safety checks.
 */
export async function planBundle(input: PlanBundleInput): Promise<PlanRecord> {
  if (input.user.role !== 'admin') throw httpError('Forbidden: Only Administrators can generate a Terraform plan for a target environment.', 403);
  if (!input.stateBackend?.provider) throw httpError('Plan blocked: a remote Terraform state backend configuration is required.', 400);
  if (input.stateBackend.provider !== input.provider) throw httpError(`Plan blocked: the state backend is for ${input.stateBackend.provider}, the deployment is for ${input.provider}.`, 400);
  for (const f of input.files) if (!BUNDLE_FILE.test(f.filename) || f.filename === 'backend.tf' || f.filename.startsWith('.')) throw httpError(`Plan blocked: ${JSON.stringify(f.filename.slice(0, 40))} is not an allowed file name.`, 400);

  const credentialsJson = await cloudAccountRepository.getCredentials(input.cloudAccountId, input.orgId);
  if (!credentialsJson) throw httpError('CloudAccount credentials not found', 404);
  const credentials = JSON.parse(credentialsJson) as CloudCredentials;
  assertTerraformCapable(credentials);
  const provider: 'aws' | 'azure' = 'tenantId' in credentials ? 'azure' : 'aws';
  if (provider !== input.provider) throw httpError(`Plan blocked: this deployment is for ${input.provider}, but the connected account is ${provider}.`, 400);

  const backendHcl = renderBackendConfig(input.stateBackend);
  assertSafeHcl([...input.files.filter((f) => f.filename.endsWith('.tf')), { filename: 'backend.tf', content: backendHcl }]);

  const workDir = await mkdtemp(join(tmpdir(), 'cloudcraft-tf-release-'));
  try {
    for (const f of input.files) await writeFile(join(workDir, f.filename), f.content, 'utf-8');
    await writeFile(join(workDir, 'backend.tf'), backendHcl, 'utf-8');
    const rawEnv = await resolveExecutionCredentials(credentials);
    const env: Record<string, string> = { ...(await terraformSecretVarsFor(input.orgId, input.cloudAccountId)), ...rawEnv, ...(input.extraEnv ?? {}) };
    return await planInWorkDir({
      workDir, env, provider, targets: [], notes: input.notes,
      projectId: input.projectId, orgId: input.orgId, environment: input.environment, cloudAccountId: input.cloudAccountId, user: input.user,
    });
  } catch (err) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export function verifyPlanForApply(planId: string, planHash: string): PlanRecord {
  const record = getPlan(planId);
  if (!record) {
    const err = new Error('Plan not found or has expired — generate a new plan.') as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  if (record.planHash !== planHash) {
    const err = new Error('Plan hash mismatch — the plan you confirmed does not match the one on file. Generate a new plan.') as Error & { statusCode: number };
    err.statusCode = 409;
    throw err;
  }
  if (record.summary.guardrails && !record.summary.guardrails.passed) {
    // Defense in depth — generatePlan already refuses to store a plan that failed its safety checks.
    const err = new Error('Plan blocked by safety checks.') as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  if (record.summary.toDestroy > 0) {
    // Defense in depth — generatePlan already refuses to store a plan with destroys.
    const err = new Error('Plan blocked: contains destroy actions.') as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  return record;
}

/**
 * Actually runs `terraform apply` for an already-confirmed plan. Called ONLY
 * from the durable job worker (workers/terraformApplyWorker.ts) — never
 * directly from an API route — since this is the genuinely long-running,
 * infrastructure-mutating step.
 */
export async function runApply(
  planId: string, orgId: string, onOutput?: (chunk: string) => void,
  /** Runs after a successful apply, while the plan's folder and the account's environment still exist (to read Terraform's outputs, for instance). */
  afterApply?: (ctx: { workDir: string; env: Record<string, string> }) => Promise<void>,
): Promise<{ message: string; outputTail: string }> {
  const record = getPlan(planId);
  if (!record) {
    throw new Error('Plan not found or has expired — it may have already been applied, or the server restarted before apply ran.');
  }

  const credentialsJson = await cloudAccountRepository.getCredentials(record.cloudAccountId, orgId);
  if (!credentialsJson) throw new Error('CloudAccount credentials not found');
  const credentials = JSON.parse(credentialsJson) as CloudCredentials;
  const rawEnv = await resolveExecutionCredentials(credentials);
  const env: Record<string, string> = {
    ...(await terraformSecretVarsFor(orgId, record.cloudAccountId)),
    ...rawEnv,
  };

  try {
    const { stdout } = await handleStateLockAndRetry(
      () =>
        runTerraform(['apply', '-input=false', '-no-color', 'tfplan'], {
          cwd: record.workDir,
          env,
          timeoutMs: 45 * 60 * 1000,
          onOutput,
        }),
      record.workDir,
      env,
      'apply',
    );
    if (afterApply) await afterApply({ workDir: record.workDir, env });
    const forgotten = await forgetCredentialsAfterSuccess(record.cloudAccountId, orgId);
    return {
      message: `Applied ${record.summary.toAdd} new and ${record.summary.toChange} changed resource(s).${forgotten ? ' As you asked, the credentials for this account were then deleted from CloudCraft.' : ''}`,
      outputTail: stdout.slice(-4000),
    };
  } finally {
    deletePlan(record.planId);
    await rm(record.workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface ExecuteDestroyInput {
  projectId: string;
  orgId: string;
  environment: string;
  cloudAccountId: string;
  stateBackend: TerraformStateBackendConfig;
  user: { id: string; name: string; email: string; role: string };
  resources: DbArchitectureResource[];
  connections: DbArchitectureConnection[];
  architectureId: string;
  projectName: string;
}

// ─── Teardown ─────────────────────────────────────────────────────────────────
//
// Two steps, like apply: PREPARE runs `terraform plan -destroy` and lists exactly what is in the state and would be
// removed; RUN executes that same saved plan in the background, with live output. If the state changed in between,
// Terraform refuses the stale plan instead of destroying something the user did not see.

let sleepImpl = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sleep = (ms: number) => sleepImpl(ms);
/** For tests: replace the real wait between retries. */
export function _setSleepForTests(fn: (ms: number) => Promise<void>): void { sleepImpl = fn; }

/**
 * For an account set to "forget after a successful deployment": erases its credentials now that the work has succeeded.
 * Best effort and silent on failure: it must never turn a successful run into a failed one.
 */
async function forgetCredentialsAfterSuccess(accountId: string, orgId: string): Promise<boolean> {
  try { return await cloudAccountRepository.forgetAfterDeploy(accountId, orgId); } catch { return false; }
}

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/** Errors that mean "a dependent resource is still shutting down" — worth waiting for and trying again. */
function isTransientInUse(message: string): boolean {
  return message.includes('CacheSubnetGroupInUse') || message.includes('DBSubnetGroupInUse') || message.includes('DependencyViolation')
    || message.includes('in use by a cache cluster') || message.includes('network interface');
}

async function destroyEnvironment(input: { cloudAccountId: string; orgId: string; stateBackend: TerraformStateBackendConfig; user: { role: string } }): Promise<Record<string, string>> {
  if (input.user.role !== 'admin') throw httpError('Forbidden: Only Administrators can destroy infrastructure.', 403);
  if (!input.stateBackend?.provider) throw httpError('Teardown blocked: a remote Terraform state backend configuration is required.', 400);
  const credentialsJson = await cloudAccountRepository.getCredentials(input.cloudAccountId, input.orgId);
  if (!credentialsJson) throw httpError('CloudAccount credentials not found', 404);
  const rawEnv = await resolveExecutionCredentials(JSON.parse(credentialsJson) as CloudCredentials);
  return { ...(await terraformSecretVarsFor(input.orgId, input.cloudAccountId)), ...rawEnv };
}

async function writeTerraformFiles(workDir: string, generated: { files: { filename: string; content: string }[] }, stateBackend: TerraformStateBackendConfig): Promise<void> {
  for (const file of generated.files) await writeFile(join(workDir, file.filename), file.content, 'utf-8');
  const backendHcl = renderBackendConfig(stateBackend);
  assertSafeHcl([...generated.files, { filename: 'backend.tf', content: backendHcl }]);
  await writeFile(join(workDir, 'backend.tf'), backendHcl, 'utf-8');
  await writeFile(join(workDir, 'placeholder.zip'), LAMBDA_PLACEHOLDER_ZIP);
}

export interface PreparedDestroy {
  /** Null when the state holds nothing to destroy. */
  planId: string | null;
  planHash: string | null;
  resources: { address: string; type: string }[];
  /** Protected resources the plan deletes: deletion protection is switched off on them when the teardown is confirmed. */
  protectedResources?: { type: string; id: string; address: string }[];
}

/**
 * Step 1: `terraform plan -destroy`. Takes a minute or two (it initialises Terraform and reads the real state), changes
 * nothing, and keeps the saved plan for ten minutes so the confirmation can run exactly it.
 */
export async function prepareDestroy(input: ExecuteDestroyInput, onOutput?: (chunk: string) => void): Promise<PreparedDestroy> {
  const env = await destroyEnvironment(input);
  // The saved design is only needed so Terraform has a configuration to load; what gets destroyed is whatever the state records.
  let generated: { files: { filename: string; content: string }[] } | null = null;
  try {
    generated = terraformGenerator.generate({
      architectureId: input.architectureId, projectId: input.projectId, resources: input.resources, connections: input.connections, projectName: input.projectName,
    });
  } catch { generated = null; }
  const region = regionFromTfvars(generated?.files.find((f) => f.filename === 'terraform.tfvars')?.content)
    ?? input.resources.find((r) => r.region)?.region ?? env['AWS_DEFAULT_REGION'] ?? 'us-east-1';

  let workDir = await mkdtemp(join(tmpdir(), 'cloudcraft-tf-destroy-'));
  let keep = false;
  try {
    let usable = false;
    if (generated) {
      try {
        await writeTerraformFiles(workDir, generated, input.stateBackend);
        await initWithRetry(workDir, env, { onOutput });
        await validateConfiguration(workDir, env);
        usable = true;
      } catch (err) {
        if (input.stateBackend.provider !== 'aws') throw err;   // the fallback below is for AWS
        onOutput?.(`\n[CloudCraft] The saved design cannot be used as it is (${err instanceof Error ? err.message.slice(0, 160) : 'error'}). The teardown will work from what Terraform recorded instead.\n`);
      }
    }
    if (!usable) {
      if (input.stateBackend.provider !== 'aws') throw httpError('The saved design could not be turned into a valid configuration, so this teardown cannot run. Fix the design and try again.', 400);
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      workDir = await mkdtemp(join(tmpdir(), 'cloudcraft-tf-destroy-'));
      await writeTerraformFiles(workDir, { files: minimalAwsDestroyConfig(region) }, input.stateBackend);
      await initWithRetry(workDir, env, { onOutput });
      await validateConfiguration(workDir, env);
    }

    await handleStateLockAndRetry(
      () => retryPluginStartup(() => runTerraform(['plan', '-destroy', '-input=false', '-no-color', '-out=tfplan'], { cwd: workDir, env, timeoutMs: 15 * 60 * 1000, onOutput }), sleep, 3, () => onOutput?.('\n[CloudCraft] The AWS plugin was slow to start; trying again.\n')),
      workDir, env, 'destroy',
    );
    const { stdout } = await retryPluginStartup(() => runTerraform(['show', '-json', '-no-color', 'tfplan'], { cwd: workDir, env }), sleep, 3, () => onOutput?.('\n[CloudCraft] The AWS plugin was slow to start; trying again.\n'));
    const planJson = JSON.parse(stdout) as PlanJsonForGuardrails;
    const resources = (planJson.resource_changes ?? [])
      .filter((rc) => (rc.mode ?? 'managed') === 'managed' && rc.change.actions.includes('delete'))
      .map((rc) => ({ address: rc.address, type: rc.type }));
    if (resources.length === 0) return { planId: null, planHash: null, resources: [] };

    const planHash = createHash('sha256').update(await readFile(join(workDir, 'tfplan'))).digest('hex');
    const planId = randomUUID();
    await savePreparedDestroy({
      planId, planHash, workDir, orgId: input.orgId, projectId: input.projectId, userId: input.user.id,
      environment: input.environment, cloudAccountId: input.cloudAccountId, stateBackend: input.stateBackend, resources,
      protectedResources: findProtectedResources(planJson as never), region,
    });
    keep = true;
    return { planId, planHash, resources, protectedResources: findProtectedResources(planJson as never) };
  } finally {
    if (!keep) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface StartDestroyInput {
  planId: string;
  planHash: string;
  orgId: string;
  projectId: string;
  cloudAccountId: string;
  stateBackend: TerraformStateBackendConfig;
  user: { id: string; name: string; email: string; role: string };
  /** Switch deletion protection off on the protected resources the plan deletes. Default true; false leaves them protected (AWS then refuses them). */
  disableProtection?: boolean;
}

/**
 * Step 2: runs the prepared plan in the background and returns a run id at once. One teardown or apply at a time per
 * project; the plan can be used only once.
 */
export async function startDestroyRun(input: StartDestroyInput): Promise<{ runId: string }> {
  const env = await destroyEnvironment(input);
  const prepared = peekPreparedDestroy(input.planId);
  if (!prepared) throw httpError('The destroy preview has expired or was already used. Preview it again.', 404);
  if (prepared.planHash !== input.planHash || prepared.orgId !== input.orgId || prepared.projectId !== input.projectId || prepared.userId !== input.user.id) {
    throw httpError('This preview does not match the request. Preview it again.', 409);
  }
  if (!acquireProjectLock(input.projectId)) throw httpError('Another Terraform apply or teardown is already running for this project. Wait for it to finish.', 409);
  const taken = takePreparedDestroy(input.planId);
  if (!taken) { releaseProjectLock(input.projectId); throw httpError('The destroy preview was just used. Preview it again.', 409); }

  const run = startRun({ runId: randomUUID(), orgId: input.orgId, projectId: input.projectId, kind: 'destroy' });
  void runDestroyPlan({ run, prepared: taken, env, userId: input.user.id, disableProtection: input.disableProtection !== false });
  return { runId: run.runId };
}

async function runDestroyPlan(args: { run: RunHandle; prepared: PreparedDestroyPlan; env: Record<string, string>; userId: string; disableProtection: boolean }): Promise<void> {
  const { run, prepared, env, userId, disableProtection } = args;
  const audit = { action: 'destroy' as const, orgId: prepared.orgId, projectId: prepared.projectId, userId, planId: prepared.planId, planHash: prepared.planHash };
  try {
    run.append(`[CloudCraft] Destroying ${prepared.resources.length} resource(s) from the plan you reviewed.\n`);
    // AWS refuses to delete a protected load balancer, database or table: switch protection off on exactly those the plan deletes.
    if (prepared.protectedResources && prepared.protectedResources.length > 0 && !disableProtection) {
      run.append(`[CloudCraft] You chose to leave deletion protection on for ${prepared.protectedResources.length} resource(s): ${prepared.protectedResources.map((p) => p.address).join(', ')}. AWS will refuse to delete them; everything else is deleted.\n`);
    }
    if (prepared.protectedResources && prepared.protectedResources.length > 0 && disableProtection && env['AWS_ACCESS_KEY_ID']) {
      run.append(`[CloudCraft] ${prepared.protectedResources.length} resource(s) have deletion protection on; switching it off so they can be removed.\n`);
      await disableDeletionProtection(prepared.protectedResources, protectionClients(env, prepared.region ?? env['AWS_DEFAULT_REGION'] ?? 'us-east-1'), run.append);
    }
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        await handleStateLockAndRetry(
          () => runTerraform(['apply', '-input=false', '-no-color', 'tfplan'], { cwd: prepared.workDir, env, timeoutMs: 45 * 60 * 1000, onOutput: run.append }),
          prepared.workDir, env, 'destroy',
        );
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts && isTransientInUse(msg)) {
          run.append('\n[CloudCraft] A dependent resource is still shutting down. Waiting 20 seconds, then planning what is left and trying again.\n');
          await sleep(20_000);
          await runTerraform(['plan', '-destroy', '-input=false', '-no-color', '-out=tfplan'], { cwd: prepared.workDir, env, timeoutMs: 15 * 60 * 1000, onOutput: run.append });
          continue;
        }
        throw err;
      }
    }
    const forgotten = await forgetCredentialsAfterSuccess(prepared.cloudAccountId, prepared.orgId);
    if (forgotten) run.append('[CloudCraft] As you asked, the credentials for this account were deleted from CloudCraft.\n');
    run.finish(true, 'The planned resources were destroyed.');
    await recordTerraformAudit({ ...audit, outcome: 'succeeded' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run.finish(false, message);
    await recordTerraformAudit({ ...audit, outcome: 'failed', detail: message }).catch(() => undefined);
  } finally {
    releaseProjectLock(prepared.projectId);
    await rm(prepared.workDir, { recursive: true, force: true }).catch(() => {});
  }
}
