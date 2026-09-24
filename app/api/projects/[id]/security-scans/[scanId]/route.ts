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
import { SNAPSHOT_SCHEMA, type AssessmentSnapshot } from '@/lib/services/AssessmentSnapshotService';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; scanId: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const { id: projectId, scanId } = await params;

    const orgId = await resolveOrgId(req, identity.userId);
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

    // v1 snapshots store the full immutable assessment envelope; older scans
    // stored a bare findings array.
    let parsed: unknown;
    try { parsed = JSON.parse(scan.findingsJson); } catch { parsed = []; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as { schema?: string }).schema === SNAPSHOT_SCHEMA) {
      const snap = parsed as AssessmentSnapshot;
      return ok({
        scanId: scan.id,
        architectureId: scan.architectureId,
        architectureRevision: snap.architecture.revision,
        graphHash: snap.architecture.graphHash,
        rulesetVersion: snap.assessment.rulesetVersion,
        status: scan.status,
        score: snap.assessment.securityScore.score,
        securityScore: snap.assessment.securityScore,
        findings: snap.assessment.findings,
        findingCount: snap.assessment.findings.length,
        assessment: snap.assessment,
        createdAt: scan.createdAt,
        completedAt: scan.completedAt,
      });
    }
    const findings: unknown[] = Array.isArray(parsed) ? parsed : [];

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
