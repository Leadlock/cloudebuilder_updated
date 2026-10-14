/**
 * POST /api/projects/[id]/terraform/plan — generate a real Terraform plan
 * against a connected cloud account.
 *
 * This is the READ-ONLY step: `terraform plan` never mutates the target
 * cloud account. It requires the same RBAC + approved-review + hash-tamper
 * gates as the existing /deploy endpoint (enforced inside
 * TerraformExecutionService.generatePlan), plus two more that endpoint
 * never had: a remote state backend is mandatory, and any plan containing
 * a resource destroy is refused outright rather than stored.
 *
 * The returned planHash must be echoed back exactly to
 * POST /api/projects/[id]/terraform/apply to actually run it — this is the
 * "explicit re-confirmation bound to this specific plan" safety gate.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { StateBackendSchema } from '@/lib/terraform/execution/backendSchema';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest, tooManyRequests, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { terraformExecutionDenied } from '@/lib/api/terraformAccess';
import { checkRateLimit } from '@/lib/api/rateLimit';
import { planLimit, planRateKey } from '@/lib/terraform/execution/limits';
import { recordTerraformAudit } from '@/lib/terraform/execution/audit';
import { PlanGuardrailError } from '@/lib/terraform/execution/planGuardrails';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { generatePlan, PlanBlockedError } from '@/lib/terraform/execution/TerraformExecutionService';
import { TerraformNotInstalledError } from '@/lib/terraform/execution/cli';
import type { TerraformStateBackendConfig } from '@/lib/terraform/execution/types';

export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  environment: z.string().default('production'),
  cloudAccountId: z.string().min(1),
  stateBackend: StateBackendSchema,
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized('Authentication required to generate a Terraform plan');
    if (identity.role !== 'admin') {
      return forbidden('Access denied: Terraform plan generation is strictly restricted to Administrators.');
    }

    const { id: projectId } = await params;
    const parsed = await parseBody(req, RequestSchema);
    if (!parsed.ok) return parsed.response;
    const { environment, cloudAccountId, stateBackend } = parsed.data;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const denied = await terraformExecutionDenied(identity.userId, orgId, identity.email);
    if (denied) {
      await recordTerraformAudit({ action: 'plan', outcome: 'denied', orgId, projectId, userId: identity.userId, detail: denied });
      return forbidden(denied);
    }
    // A plan runs terraform on the server; keep it from being used as a resource-exhaustion lever.
    const { limit, windowMs } = planLimit();
    const rl = await checkRateLimit(planRateKey(identity.userId), limit, windowMs);
    if (!rl.allowed) {
      await recordTerraformAudit({ action: 'plan', outcome: 'denied', orgId, projectId, userId: identity.userId, detail: 'rate limited' });
      return tooManyRequests(rl.retryAfterSeconds);
    }

    const ctx = await resolveArchitecture(projectId, orgId, environment);
    if ('error' in ctx) {
      if (ctx.error === 'project_not_found') return notFound('Project');
      if (ctx.error === 'architecture_not_found') return badRequest('No saved architecture to plan for this environment');
      return notFound('Environment');
    }
    const { arch, project } = ctx;

    const user = {
      id: identity.userId,
      email: identity.email ?? 'admin@cloudcraft.io',
      name: 'Cloud Administrator',
      role: identity.role,
    };

    try {
      const record = await generatePlan({
        projectId,
        orgId,
        environment,
        cloudAccountId,
        stateBackend: stateBackend as TerraformStateBackendConfig,
        user,
        resources: arch.resources,
        connections: arch.connections,
        architectureId: arch.id,
        projectName: project.name.replace(/\s+/g, '-').toLowerCase(),
      });

      await recordTerraformAudit({ action: 'plan', outcome: 'succeeded', orgId, projectId, userId: identity.userId, planId: record.planId, planHash: record.planHash, detail: `${record.summary.toAdd} to add, ${record.summary.toChange} to change` });
      return ok({
        planId: record.planId,
        planHash: record.planHash,
        summary: record.summary,
        expiresAt: record.expiresAt,
      });
    } catch (err) {
      if (err instanceof PlanGuardrailError) {
        await recordTerraformAudit({ action: 'plan', outcome: 'blocked', orgId, projectId, userId: identity.userId, detail: err.message });
        return badRequest(err.message, { guardrails: err.report });
      }
      if (err instanceof PlanBlockedError) {
        await recordTerraformAudit({ action: 'plan', outcome: 'blocked', orgId, projectId, userId: identity.userId, detail: err.message });
        return badRequest(err.message);
      }
      if (err instanceof TerraformNotInstalledError) return internalError(err.message);
      const statusCode = (err as { statusCode?: number })?.statusCode;
      const message = err instanceof Error ? err.message : 'Plan generation failed';
      if (statusCode === 403) return forbidden(message);
      if (statusCode === 404) return notFound(message);
      if (statusCode) return badRequest(message);
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Terraform plan generation failed';
    console.error('[POST /api/projects/:id/terraform/plan]', message);
    return badRequest(message);
  }
}
