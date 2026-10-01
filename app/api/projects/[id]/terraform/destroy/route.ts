/**
 * Teardown of the real infrastructure behind a project and its remote state backend.
 *
 *   POST (no confirmationToken)  PREVIEW — runs `terraform plan -destroy`, lists exactly what the state holds and would
 *                                be removed, and returns a one-time confirmation token bound to that exact plan.
 *   POST (with token + planId)   RUN — executes that same saved plan in the background and returns a run id at once.
 *   GET  ?runId=...              STATUS — state, elapsed time and the live tail of Terraform's output.
 *
 * Nothing is destroyed until the second step, and only the plan that was previewed can be run: if the state changed in
 * between, Terraform refuses the stale plan. Access is gated like plan/apply (see lib/api/terraformAccess.ts).
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { StateBackendSchema } from '@/lib/terraform/execution/backendSchema';
import { ok, created, notFound, forbidden, unauthorized, internalError, badRequest, apiError, tooManyRequests, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { terraformExecutionDenied } from '@/lib/api/terraformAccess';
import { checkRateLimit } from '@/lib/api/rateLimit';
import { planLimit, planRateKey } from '@/lib/terraform/execution/limits';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { consumeDestroyConfirmation, issueDestroyConfirmation } from '@/lib/terraform/execution/destroyConfirmation';
import { peekPreparedDestroy } from '@/lib/terraform/execution/destroyPlans';
import { getRunSnapshot } from '@/lib/terraform/execution/runRegistry';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { prepareDestroy, startDestroyRun } from '@/lib/terraform/execution/TerraformExecutionService';
import { TerraformNotInstalledError } from '@/lib/terraform/execution/cli';
import type { TerraformStateBackendConfig } from '@/lib/terraform/execution/types';

export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  environment: z.string().default('production'),
  cloudAccountId: z.string().min(1),
  stateBackend: StateBackendSchema,
  /** Both absent on the first call (preview); both required on the second (run). */
  confirmationToken: z.string().min(10).max(4000).optional(),
  planId: z.string().min(10).max(100).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized('Authentication required to destroy infrastructure');
    if (identity.role !== 'admin') return forbidden('Access denied: Infrastructure teardown is strictly restricted to Administrators.');

    const { id: projectId } = await params;
    const parsed = await parseBody(req, RequestSchema);
    if (!parsed.ok) return parsed.response;
    const { environment, cloudAccountId, stateBackend, confirmationToken, planId } = parsed.data;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const denied = await terraformExecutionDenied(identity.userId, orgId);
    if (denied) {
      await recordTerraformAudit({ action: 'destroy', outcome: 'denied', orgId, projectId, userId: identity.userId, detail: denied });
      return forbidden(denied);
    }

    const ctx = await resolveArchitecture(projectId, orgId, environment);
    if ('error' in ctx) {
      if (ctx.error === 'project_not_found') return notFound('Project');
      if (ctx.error === 'architecture_not_found') return badRequest('No saved architecture to destroy for this environment');
      return notFound('Environment');
    }
    const { arch, project } = ctx;
    const user = { id: identity.userId, email: identity.email ?? 'admin@cloudcraft.io', name: 'Cloud Administrator', role: identity.role };
    const backend = stateBackend as TerraformStateBackendConfig;

    // ── Step 1: preview with a real `terraform plan -destroy` ────────────────────────────────────────────────────
    if (!confirmationToken) {
      const { limit, windowMs } = planLimit();
      const rl = checkRateLimit(planRateKey(identity.userId), limit, windowMs);   // a destroy preview is a plan: it counts as one
      if (!rl.allowed) {
        await recordTerraformAudit({ action: 'destroy', outcome: 'denied', orgId, projectId, userId: identity.userId, detail: 'rate limited' });
        return tooManyRequests(rl.retryAfterSeconds);
      }
      const prepared = await prepareDestroy({
        projectId, orgId, environment, cloudAccountId, stateBackend: backend, user,
        resources: arch.resources, connections: arch.connections, architectureId: arch.id,
        projectName: project.name.replace(/\s+/g, '-').toLowerCase(),
      });
      if (!prepared.planId || !prepared.planHash) {
        await recordTerraformAudit({ action: 'destroy', outcome: 'requested', orgId, projectId, userId: identity.userId, detail: 'nothing in the state to destroy' });
        return ok({ status: 'nothing_to_destroy', resourceCount: 0, resources: [] });
      }
      const { token, expiresAt } = issueDestroyConfirmation({
        userId: identity.userId, orgId, projectId, environment, cloudAccountId, stateBackend,
        resources: prepared.resources.map((r) => ({ id: r.address, resourceType: r.type })), planHash: prepared.planHash,
      });
      await recordTerraformAudit({ action: 'destroy', outcome: 'requested', orgId, projectId, userId: identity.userId, planId: prepared.planId, planHash: prepared.planHash, detail: `preview of ${prepared.resources.length} resource(s) in the state` });
      return ok({
        status: 'confirmation_required', confirmationToken: token, expiresAt, planId: prepared.planId,
        resourceCount: prepared.resources.length, resources: prepared.resources.slice(0, 200),
      });
    }

    // ── Step 2: run exactly the plan that was previewed ──────────────────────────────────────────────────────────
    if (!planId) return badRequest('planId is required with a confirmation token.');
    const prepared = peekPreparedDestroy(planId);
    if (!prepared) return notFound('The destroy preview has expired or was already used. Preview it again.');
    const confirmed = consumeDestroyConfirmation(confirmationToken, {
      userId: identity.userId, orgId, projectId, environment, cloudAccountId, stateBackend,
      resources: prepared.resources.map((r) => ({ id: r.address, resourceType: r.type })), planHash: prepared.planHash,
    });
    if (!confirmed.ok) {
      await recordTerraformAudit({ action: 'destroy', outcome: 'blocked', orgId, projectId, userId: identity.userId, planId, planHash: prepared.planHash, detail: confirmed.reason });
      return badRequest(confirmed.reason);
    }
    const { runId } = await startDestroyRun({ planId, planHash: prepared.planHash, orgId, projectId, cloudAccountId, stateBackend: backend, user });
    await recordTerraformAudit({ action: 'destroy', outcome: 'allowed', orgId, projectId, userId: identity.userId, planId, planHash: prepared.planHash, detail: 'teardown started' });
    return created({ status: 'started', runId });
  } catch (err) {
    if (err instanceof TerraformNotInstalledError) return badRequest(err.message);
    const statusCode = (err as { statusCode?: number })?.statusCode;
    const message = err instanceof Error ? err.message : 'Teardown failed';
    if (statusCode === 403) return forbidden(message);
    if (statusCode === 404) return notFound(message);
    if (statusCode === 400) return badRequest(message);
    if (statusCode === 409) return apiError('CONFLICT', message, 409);
    console.error('[POST /api/projects/:id/terraform/destroy]', message.slice(0, 500));
    return internalError(message.slice(0, 4000));
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    await params;
    const runId = new URL(req.url).searchParams.get('runId');
    if (!runId) return badRequest('runId is required');
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    if (!(await getOrgRole(identity.userId, orgId))) return forbidden();
    const snapshot = getRunSnapshot(runId, orgId);
    if (!snapshot) return notFound('Run');
    return ok(snapshot);
  } catch (err) {
    console.error('[GET /api/projects/:id/terraform/destroy]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
