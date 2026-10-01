/**
 * GET /api/projects/[id]/terraform/status — what the Terraform panel shows next to its buttons:
 * whether execution is available to this caller, how many plans they have left in the current window (with the
 * seconds until it renews), and whether an apply is already running for this project.
 *
 * Read-only: looking at the numbers never uses any of the budget.
 */
import { NextRequest } from 'next/server';
import { ok, unauthorized, forbidden, notFound, badRequest, internalError } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { terraformExecutionDenied } from '@/lib/api/terraformAccess';
import { peekRateLimit } from '@/lib/api/rateLimit';
import { planLimit, planRateKey } from '@/lib/terraform/execution/limits';
import { isProjectLocked } from '@/lib/terraform/execution/projectLock';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId } = await params;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    if (!(await getOrgRole(identity.userId, orgId))) return forbidden();
    const ctx = await resolveArchitecture(projectId, orgId, new URL(req.url).searchParams.get('env') ?? 'production');
    if ('error' in ctx && ctx.error === 'project_not_found') return notFound('Project');

    const denied = await terraformExecutionDenied(identity.userId, orgId);
    const { limit, windowMs, windowMinutes } = planLimit();
    const budget = peekRateLimit(planRateKey(identity.userId), limit, windowMs);

    return ok({
      enabled: denied === null,
      ...(denied ? { reason: denied } : {}),
      plans: { limit, remaining: budget.remaining, resetsInSeconds: budget.resetsInSeconds, windowMinutes },
      applyRunning: isProjectLocked(projectId),
    });
  } catch (err) {
    console.error('[GET /api/projects/:id/terraform/status]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
