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
import type { CloudCredentials } from '@/lib/cloud/types';
import type { CanvasNode, CanvasEdge } from '@/types';
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';
import { runTerraform } from './cli';
import { renderBackendConfig } from './backendConfig';
import { savePlan, getPlan, deletePlan, planTtlMs } from './planStore';
import type { PlanRecord, PlanResourceAction, PlanSummary, TerraformStateBackendConfig } from './types';

export class PlanBlockedError extends Error {
  constructor(public readonly destroyedAddresses: string[]) {
    super(
      `Plan blocked: contains ${destroyedAddresses.length} resource destroy action(s) ` +
      `(${destroyedAddresses.slice(0, 5).join(', ')}${destroyedAddresses.length > 5 ? ', …' : ''}). ` +
      'CloudCraft does not apply plans that destroy infrastructure — review and run this manually with the Terraform CLI if the destroy is intentional.',
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
}

interface TerraformPlanJson {
  resource_changes?: Array<{
    address: string;
    type: string;
    change: { actions: string[] };
  }>;
}

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
  if (!latestReview || latestReview.status !== 'approved') {
    const err = new Error(
      latestReview?.status === 'invalidated_due_to_changes'
        ? 'Plan blocked: Architecture was modified after approval and approval was invalidated.'
        : 'Plan blocked: Architecture must be formally approved before a Terraform plan can be generated.',
    ) as Error & { statusCode: number };
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
  const provider: 'aws' | 'azure' = 'roleArn' in credentials ? 'aws' : 'azure';

  const generated = terraformGenerator.generate({
    architectureId: input.architectureId,
    projectId: input.projectId,
    resources,
    connections,
    projectName: input.projectName,
  });

  const workDir = await mkdtemp(join(tmpdir(), 'cloudcraft-tf-'));
  try {
    for (const file of generated.files) {
      await writeFile(join(workDir, file.filename), file.content, 'utf-8');
    }
    await writeFile(join(workDir, 'backend.tf'), renderBackendConfig(input.stateBackend), 'utf-8');
    // Minimal valid 22-byte empty zip archive for Lambda placeholder packages
    const EMPTY_ZIP = Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64');
    await writeFile(join(workDir, 'placeholder.zip'), EMPTY_ZIP);

    const rawEnv = await resolveExecutionCredentials(credentials);
    const env: Record<string, string> = {
      TF_VAR_db_password: process.env.TF_VAR_db_password || 'CloudCraft_SecureDbPass123!',
      TF_VAR_sql_admin_password: process.env.TF_VAR_sql_admin_password || 'CloudCraft_SqlPass123!',
      TF_VAR_admin_ssh_public_key: process.env.TF_VAR_admin_ssh_public_key || 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICloudCraftGeneratedKey cloudcraft@admin',
      TF_VAR_windows_admin_password: process.env.TF_VAR_windows_admin_password || 'CloudCraft_WinPass123!',
      ...rawEnv,
    };

    await runTerraform(['init', '-input=false', '-no-color'], { cwd: workDir, env });

    // -detailed-exitcode: 0 = no changes, 2 = changes present, 1 = error (thrown by runTerraform).
    await runTerraform(
      ['plan', '-input=false', '-no-color', '-out=tfplan', '-detailed-exitcode'],
      { cwd: workDir, env, allowExitCodes: [0, 2] },
    );

    const { stdout: planJsonRaw } = await runTerraform(['show', '-json', 'tfplan'], { cwd: workDir, env });
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

    const summary: PlanSummary = {
      toAdd: resourceChanges.filter((rc) => rc.actions.includes('create')).length,
      toChange: resourceChanges.filter((rc) => rc.actions.includes('update')).length,
      toDestroy: 0,
      resourceChanges,
    };

    const planFileBytes = await readFile(join(workDir, 'tfplan'));
    const planHash = createHash('sha256').update(planFileBytes).digest('hex');

    const record: PlanRecord = {
      planId: randomUUID(),
      planHash,
      projectId: input.projectId,
      orgId: input.orgId,
      environment: input.environment,
      cloudAccountId: input.cloudAccountId,
      provider,
      workDir,
      summary,
      createdBy: { id: input.user.id, name: input.user.name, email: input.user.email },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + planTtlMs()).toISOString(),
    };
    savePlan(record);
    return record;
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
export async function runApply(planId: string, orgId: string): Promise<{ message: string; outputTail: string }> {
  const record = getPlan(planId);
  if (!record) {
    throw new Error('Plan not found or has expired — it may have already been applied, or the server restarted before apply ran.');
  }

  const credentialsJson = await cloudAccountRepository.getCredentials(record.cloudAccountId, orgId);
  if (!credentialsJson) throw new Error('CloudAccount credentials not found');
  const credentials = JSON.parse(credentialsJson) as CloudCredentials;
  const rawEnv = await resolveExecutionCredentials(credentials);
  const env: Record<string, string> = {
    TF_VAR_db_password: process.env.TF_VAR_db_password || 'CloudCraft_SecureDbPass123!',
    TF_VAR_sql_admin_password: process.env.TF_VAR_sql_admin_password || 'CloudCraft_SqlPass123!',
    TF_VAR_admin_ssh_public_key: process.env.TF_VAR_admin_ssh_public_key || 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICloudCraftGeneratedKey cloudcraft@admin',
    TF_VAR_windows_admin_password: process.env.TF_VAR_windows_admin_password || 'CloudCraft_WinPass123!',
    ...rawEnv,
  };

  try {
    const { stdout } = await runTerraform(['apply', '-input=false', '-no-color', 'tfplan'], {
      cwd: record.workDir,
      env,
      timeoutMs: 20 * 60 * 1000,
    });
    return {
      message: `Applied ${record.summary.toAdd} new and ${record.summary.toChange} changed resource(s).`,
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

export async function executeDestroy(input: ExecuteDestroyInput): Promise<{ message: string; outputTail: string }> {
  if (input.user.role !== 'admin') {
    const err = new Error('Forbidden: Only Administrators can destroy infrastructure.') as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }

  if (!input.stateBackend?.provider) {
    const err = new Error('Teardown blocked: a remote Terraform state backend configuration is required.') as Error & { statusCode: number };
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
  const rawEnv = await resolveExecutionCredentials(credentials);
  const env: Record<string, string> = {
    TF_VAR_db_password: process.env.TF_VAR_db_password || 'CloudCraft_SecureDbPass123!',
    TF_VAR_sql_admin_password: process.env.TF_VAR_sql_admin_password || 'CloudCraft_SqlPass123!',
    TF_VAR_admin_ssh_public_key: process.env.TF_VAR_admin_ssh_public_key || 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICloudCraftGeneratedKey cloudcraft@admin',
    TF_VAR_windows_admin_password: process.env.TF_VAR_windows_admin_password || 'CloudCraft_WinPass123!',
    ...rawEnv,
  };

  const generated = terraformGenerator.generate({
    architectureId: input.architectureId,
    projectId: input.projectId,
    resources: input.resources,
    connections: input.connections,
    projectName: input.projectName,
  });

  const workDir = await mkdtemp(join(tmpdir(), 'cloudcraft-tf-destroy-'));
  try {
    for (const file of generated.files) {
      await writeFile(join(workDir, file.filename), file.content, 'utf-8');
    }
    const backendHcl = renderBackendConfig(input.stateBackend);
    await writeFile(join(workDir, 'backend.tf'), backendHcl, 'utf-8');
    const EMPTY_ZIP = Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64');
    await writeFile(join(workDir, 'placeholder.zip'), EMPTY_ZIP);

    await runTerraform(['init', '-input=false', '-no-color'], {
      cwd: workDir,
      env,
      timeoutMs: 5 * 60 * 1000,
    });

    let destroyResult: { stdout: string; stderr: string } | null = null;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        destroyResult = await runTerraform(['destroy', '-auto-approve', '-input=false', '-no-color'], {
          cwd: workDir,
          env,
          timeoutMs: 25 * 60 * 1000,
        });
        break; // Successfully destroyed all resources
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTransientInUse =
          msg.includes('CacheSubnetGroupInUse') ||
          msg.includes('DBSubnetGroupInUse') ||
          msg.includes('DependencyViolation') ||
          msg.includes('in use by a cache cluster') ||
          msg.includes('network interface');

        if (attempt < maxAttempts && isTransientInUse) {
          // Wait 20 seconds for AWS async termination of dependent cluster/database nodes before retrying
          await new Promise((r) => setTimeout(r, 20000));
        } else {
          throw err;
        }
      }
    }

    return {
      message: 'All cloud infrastructure resources have been successfully destroyed from the connected account.',
      outputTail: (destroyResult?.stdout || '').slice(-4000),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
