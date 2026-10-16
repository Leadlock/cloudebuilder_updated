/**
 * POST /api/projects/[id]/releases/[rid]/destroy — tear down everything a release created (the whole resource group: VM, registry, vault, network).
 *
 *   POST (no confirmationToken)  PREVIEW — `terraform plan -destroy` of the release's Terraform against its state; lists exactly what would be removed and returns a
 *                                one-time confirmation token bound to that exact plan.
 *   POST (with token + planId + confirmName)  RUN — runs that same plan in the background (the existing teardown machinery) and returns a run id.
 *   GET  ?runId=...              STATUS — see GET /api/projects/[id]/terraform/destroy.
 *
 * Same rules as any teardown: administrators on the restricted list only, an approval for exactly the previewed plan (single use), a typed confirmation of
 * the project's name, and nothing runs that was not previewed. The data of a database on the VM is deleted with it.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { StateBackendSchema } from '@/lib/terraform/execution/backendSchema';
import { ok, created, notFound, internalError, badRequest, apiError, tooManyRequests, parseBody } from '@/lib/api/response';
import { checkRateLimit } from '@/lib/api/rateLimit';
import { consumeApproval, returnApproval } from '@/lib/terraform/execution/approvals';
import { planLimit, planRateKey } from '@/lib/terraform/execution/limits';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { consumeDestroyConfirmation, issueDestroyConfirmation } from '@/lib/terraform/execution/destroyConfirmation';
import { peekPreparedDestroy } from '@/lib/terraform/execution/destroyPlans';
import { prepareDestroy, startDestroyRun } from '@/lib/terraform/execution/TerraformExecutionService';
import { TerraformNotInstalledError } from '@/lib/terraform/execution/cli';
import type { TerraformStateBackendConfig } from '@/lib/terraform/execution/types';
import { PgReleaseStore } from '@/lib/deploy/project/pgReleaseStore';
import { findRelease, releaseGate } from '@/lib/deploy/project/routeGate';
import { buildAzureVmBundle } from '@/lib/deploy/project/bundle';
import { throwawayPublicKey } from '@/lib/deploy/project/infra';
import type { StackProject } from '@/lib/engines/containers/stackProject';

export const dynamic = 'force-dynamic';

const Body = z.object({
  stateBackend: StateBackendSchema,
  confirmationToken: z.string().min(10).max(4000).optional(),
  planId: z.string().min(10).max(100).optional(),
  /** Step 2: the project's name, typed. */
  confirmName: z.string().max(100).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  try {
    const { id: projectId, rid } = await params;
    const gate = await releaseGate(req, projectId);
    if (!gate.ok) return gate.response;
    const { identity, orgId } = gate;
    const found = await findRelease(new PgReleaseStore(), gate, rid);
    if (!('id' in found)) return found;
    const release = found;
    if (release.steps.find((s) => s.name === 'infrastructure')?.state !== 'done') return apiError('CONFLICT', 'This release never created anything, so there is nothing to tear down.', 409);

    const parsed = await parseBody(req, Body);
    if (!parsed.ok) return parsed.response;
    const { stateBackend, confirmationToken, planId, confirmName } = parsed.data;
    const backend = stateBackend as TerraformStateBackendConfig;
    const user = { id: identity.userId, email: identity.email ?? 'admin@cloudcraft.io', name: 'Cloud Administrator', role: identity.role ?? 'admin' };
    const environment = release.environment; const cloudAccountId = release.cloudAccountId;

    if (!confirmationToken) {
      const { limit, windowMs } = planLimit();
      const rl = await checkRateLimit(planRateKey(identity.userId), limit, windowMs);   // a destroy preview is a plan: it counts as one
      if (!rl.allowed) {
        await recordTerraformAudit({ action: 'destroy', outcome: 'denied', orgId, projectId, userId: identity.userId, detail: 'rate limited' });
        return tooManyRequests(rl.retryAfterSeconds);
      }
      const bundle = buildAzureVmBundle(release.settings as StackProject);
      const prepared = await prepareDestroy({
        projectId, orgId, environment, cloudAccountId, stateBackend: backend, user, resources: [], connections: [], architectureId: release.id, projectName: release.project,
        bundleFiles: bundle.terraform.filter((f) => f.filename.endsWith('.tf') || f.filename === 'cloud-init.sh' || f.filename === 'compose.deploy.yml'),
        extraEnv: { TF_VAR_admin_ssh_public_key: throwawayPublicKey() },
      });
      if (!prepared.planId || !prepared.planHash) {
        await recordTerraformAudit({ action: 'destroy', outcome: 'requested', orgId, projectId, userId: identity.userId, detail: `release ${release.id}: nothing in the state to destroy` });
        return ok({ status: 'nothing_to_destroy', resourceCount: 0, resources: [] });
      }
      const { token, expiresAt } = issueDestroyConfirmation({
        userId: identity.userId, orgId, projectId, environment, cloudAccountId, stateBackend,
        resources: prepared.resources.map((r) => ({ id: r.address, resourceType: r.type })), planHash: prepared.planHash,
      });
      await recordTerraformAudit({ action: 'destroy', outcome: 'requested', orgId, projectId, userId: identity.userId, planId: prepared.planId, planHash: prepared.planHash, detail: `release ${release.id}: preview of ${prepared.resources.length} resource(s) in the state` });
      return ok({ status: 'confirmation_required', confirmationToken: token, expiresAt, planId: prepared.planId, planHash: prepared.planHash, resourceCount: prepared.resources.length, resources: prepared.resources.slice(0, 200), project: release.project });
    }

    if (!planId) return badRequest('planId is required with a confirmation token.');
    if (confirmName !== release.project) return badRequest(`Type the project name (${release.project}) to confirm.`);
    const prepared = peekPreparedDestroy(planId);
    if (!prepared || prepared.orgId !== orgId || prepared.projectId !== projectId) return notFound('The destroy preview has expired or was already used. Preview it again.');
    const approval = await consumeApproval({ orgId, projectId, action: 'destroy', planId, planHash: prepared.planHash, userId: identity.userId });
    if (!approval.ok) {
      await recordTerraformAudit({ action: 'destroy', outcome: 'blocked', orgId, projectId, userId: identity.userId, planId, planHash: prepared.planHash, detail: `approval: ${approval.code}` });
      return apiError('APPROVAL_REQUIRED', approval.reason, 403);
    }
    const giveBack = async () => { if (approval.approval) await returnApproval(approval.approval.id).catch(() => undefined); };
    const confirmed = consumeDestroyConfirmation(confirmationToken, {
      userId: identity.userId, orgId, projectId, environment, cloudAccountId, stateBackend,
      resources: prepared.resources.map((r) => ({ id: r.address, resourceType: r.type })), planHash: prepared.planHash,
    });
    if (!confirmed.ok) {
      await giveBack();
      await recordTerraformAudit({ action: 'destroy', outcome: 'blocked', orgId, projectId, userId: identity.userId, planId, planHash: prepared.planHash, detail: confirmed.reason });
      return badRequest(confirmed.reason);
    }
    let runId: string;
    try { ({ runId } = await startDestroyRun({ planId, planHash: prepared.planHash, orgId, projectId, cloudAccountId, stateBackend: backend, user })); }
    catch (startErr) { await giveBack(); throw startErr; }
    await recordTerraformAudit({ action: 'destroy', outcome: 'allowed', orgId, projectId, userId: identity.userId, planId, planHash: prepared.planHash, detail: `release ${release.id}: teardown started (${approval.approval ? `approved by ${approval.approval.decidedBy}` : 'approval switched off'})` });
    return created({ status: 'started', runId });
  } catch (err) {
    if (err instanceof TerraformNotInstalledError) return badRequest(err.message);
    const statusCode = (err as { statusCode?: number })?.statusCode;
    const message = err instanceof Error ? err.message : 'Teardown failed';
    if (statusCode === 403) return apiError('FORBIDDEN', message, 403);
    if (statusCode === 404) return notFound(message);
    if (statusCode === 400) return badRequest(message);
    if (statusCode === 409) return apiError('CONFLICT', message, 409);
    console.error('[POST /api/projects/:id/releases/:rid/destroy]', message.slice(0, 500));
    return internalError(message.slice(0, 4000));
  }
}
