/**
 * PUT /api/projects/[id]/readiness/soc2/scope   (owner or admin)
 *
 * Which SOC 2 trust services categories are in scope. Security is always in. A category left out needs a written reason, which the report shows.
 */
import { NextRequest } from 'next/server';
import { ok, badRequest, notFound, internalError, parseBody } from '@/lib/api/response';
import { guardReadiness } from '@/lib/compliance/routeGuard';
import { checkScope, ScopeSchema } from '@/lib/compliance/rules';
import { readinessRepository } from '@/lib/repositories/readinessRepository';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; framework: string }> }) {
  try {
    const caller = await guardReadiness(req, await params, { adminOnly: true });
    if ('response' in caller) return caller.response;
    if (caller.framework !== 'soc2') return notFound('Scope for this framework');
    const parsed = await parseBody(req, ScopeSchema);
    if (!parsed.ok) return parsed.response;
    const scope = checkScope(parsed.data);
    if (!scope.ok) return badRequest(scope.message);
    await readinessRepository.updateSettings(caller.projectId, 'soc2', { categories: scope.categories, exclusions: scope.exclusions }, caller.email);
    await readinessRepository.clearSignoffs(caller.projectId, 'soc2');
    return ok({ categories: scope.categories, exclusions: scope.exclusions, signoffsCleared: true });
  } catch (err) {
    console.error('[PUT readiness scope]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
