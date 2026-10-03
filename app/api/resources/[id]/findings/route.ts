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
import { resolveOrgId } from '@/lib/api/phase2d';
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

    if (!(await architectureInOrg(architectureId, orgId))) return notFound('Architecture');

    const findings = await wellArchitectedRepository.findingsByResource(resourceId, architectureId);

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
