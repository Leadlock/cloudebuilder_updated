/**
 * DELETE /api/projects/[id]/finding-reviews/[reviewId] — revoke a review
 * decision (kept for audit history with revokedAt/revokedBy).
 */
import { NextRequest } from 'next/server';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { findingReviewRepository } from '@/lib/repositories/findingReviewRepository';

export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; reviewId: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId, reviewId } = await params;
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();
    const project = await projectRepository.findById(projectId, orgId);
    if (!project) return notFound('Project');
    const existing = await findingReviewRepository.findById(projectId, reviewId);
    if (!existing) return notFound('Review');
    if (existing.approvedBy !== (identity.email ?? identity.userId) && role !== 'owner' && role !== 'admin') {
      return forbidden('Only the approver or an organization owner/admin can revoke this review.');
    }
    await findingReviewRepository.revoke(projectId, reviewId, identity.email ?? identity.userId);
    return ok({ revoked: true });
  } catch (err) {
    console.error('[DELETE finding-review]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
