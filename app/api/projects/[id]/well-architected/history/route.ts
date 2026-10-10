/**
 * GET /api/projects/[id]/well-architected/history?env=production
 *
 * The saved reviews of this architecture, newest first and with identical re-runs collapsed, plus what changed between the latest
 * review and the one before it (score movement per pillar, findings that appeared, findings that were fixed).
 *
 * Auth: extractIdentity + getOrgRole (same as all other project routes)
 */
import { NextRequest } from 'next/server';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { wellArchitectedRepository } from '@/lib/repositories/wellArchitectedRepository';
import { buildHistory } from '@/lib/engines/wellArchitected/history';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId } = await params;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const env = req.nextUrl.searchParams.get('env') ?? 'production';
    const ctx = await resolveArchitecture(projectId, orgId, env);
    if ('error' in ctx) {
      if (ctx.error === 'project_not_found') return notFound('Project');
      if (ctx.error === 'architecture_not_found') return ok({ history: { entries: [], changes: null } });
      return notFound('Environment');
    }

    const reviews = await wellArchitectedRepository.listByArchitecture(ctx.arch.id);
    return ok({ history: buildHistory(reviews) });
  } catch (err) {
    console.error('[GET /api/projects/:id/well-architected/history]', err instanceof Error ? err.message : err);
    return internalError();
  }
}
