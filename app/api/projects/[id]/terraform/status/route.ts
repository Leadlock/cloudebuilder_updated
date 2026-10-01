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
import { TtlCache } from '@/lib/api/ttlCache';

export const dynamic = 'force-dynamic';

const accessCache = new TtlCache<{ denied: string | null }>(30_000, 1000);

/** For tests. */
export function _clearStatusAccessCacheForTests(): void { accessCache.clear(); }

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId } = await params;

    // The panel polls this every 20 seconds, and the access checks are several database round trips. They only change when
    // someone is added to or removed from an organisation, so a successful check is remembered for 30 seconds. A refusal is
    // never remembered. (The numbers below — plans left, apply running — are always read fresh.)
    const env = new URL(req.url).searchParams.get('env') ?? 'production';
    const key = `${identity.userId}:${projectId}:${env}:${new URL(req.url).searchParams.get('orgId') ?? ''}`;
    let access = accessCache.get(key);
    if (!access) {
      const orgId = await resolveOrgId(req, identity.userId);
      if (!orgId) return badRequest('orgId required');
      if (!(await getOrgRole(identity.userId, orgId))) return forbidden();
      const ctx = await resolveArchitecture(projectId, orgId, env);
      if ('error' in ctx && ctx.error === 'project_not_found') return notFound('Project');
      access = { denied: await terraformExecutionDenied(identity.userId, orgId) };
      accessCache.set(key, access);
    }
    const { denied } = access;
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
