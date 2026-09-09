/**
 * GET /api/projects/[id]/security-scans/[scanId]
 * Retrieve a previously run security scan.
 */
import { NextRequest } from 'next/server';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { db } from '@/src/prisma/db';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; scanId: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const { id: projectId, scanId } = await params;

    const orgId = await resolveOrgId(req);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const project = await projectRepository.findById(projectId, orgId);
    if (!project) return notFound('Project');

    const scan = await db.orm.public.SecurityScan
      .where({ id: scanId, projectId })
      .select('id', 'projectId', 'architectureId', 'versionId', 'status', 'score', 'findingsJson', 'createdAt', 'completedAt')
      .first();

    if (!scan) return notFound('SecurityScan');

    let findings: unknown[];
    try { findings = JSON.parse(scan.findingsJson) as unknown[]; }
    catch { findings = []; }

    return ok({
      scanId: scan.id,
      architectureId: scan.architectureId,
      versionId: scan.versionId,
      status: scan.status,
      score: scan.score,
      findings,
      findingCount: (findings as unknown[]).length,
      createdAt: scan.createdAt,
      completedAt: scan.completedAt,
    });
  } catch (err) {
    console.error('[GET /api/projects/:id/security-scans/:scanId]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
