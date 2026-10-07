/**
 * GET /api/resources/[id]/findings
 *
 * Returns Well-Architected findings for a specific architecture resource.
 * Used by PropertiesPanel > Well-Architected tab.
 *
 * Query params:
 *   architectureId (required) — the parent architecture ID
 *   orgId (optional in dev) — org scoping
 */
import { NextRequest } from 'next/server';
import { ok, forbidden, unauthorized, internalError, badRequest, notFound } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { architectureInOrg } from '@/lib/api/tenantScope';
import { wellArchitectedRepository } from '@/lib/repositories/wellArchitectedRepository';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const { id: resourceId } = await params;
    const architectureId = req.nextUrl.searchParams.get('architectureId');

    if (!architectureId) {
      return badRequest('architectureId query param required');
    }

    // The properties panel only knows the PROJECT id, not the architecture's own id, so it sends the project id. Accept either: an
    // architecture id of this organization as is, otherwise treat the value as a project of this organization and use its architecture.
    // (Before, every lookup from the panel was a 404 that the panel swallowed, so a resource's findings never appeared.)
    let resolvedArchitectureId = architectureId;
    if (!(await architectureInOrg(architectureId, orgId))) {
      const ctx = await resolveArchitecture(architectureId, orgId, req.nextUrl.searchParams.get('env') ?? 'production');
      if ('error' in ctx) return notFound('Architecture');
      resolvedArchitectureId = ctx.arch.id;
    }

    const findings = await wellArchitectedRepository.findingsByResource(resourceId, resolvedArchitectureId);

    return ok({
      resourceId,
      findings,
      findingCount: findings.length,
    });
  } catch (err) {
    console.error('[GET /api/resources/:id/findings]', err instanceof Error ? err.message : err);
    return internalError();
  }
}
