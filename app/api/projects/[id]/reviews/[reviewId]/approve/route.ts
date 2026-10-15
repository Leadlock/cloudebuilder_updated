import { mayDecideReviews, reviewDecisionMessage } from '@/lib/auth/superAdmins';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, unauthorized, forbidden, badRequest, notFound, internalError, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { requireProjectAccess } from '@/lib/api/projectAccess';
import { ArchitectureReviewService } from '@/lib/services/ArchitectureReviewService';

export const dynamic = 'force-dynamic';

const ApproveSchema = z.object({
  comments: z.string().optional().default('Approved for deployment'),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; reviewId: string }> }
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized('Authentication required');

    // Strict RBAC: the super administrator when there is one, otherwise an Administrator
    if (!mayDecideReviews(identity.email, identity.role)) {
      return forbidden(reviewDecisionMessage());
    }

    const { id: projectId, reviewId } = await params;
    const access = await requireProjectAccess(req, identity.userId, projectId, { adminOnly: true });
    if ('response' in access) return access.response;
    // The review must belong to THIS project: a review id alone must never let a caller act on another project's review.
    if (!ArchitectureReviewService.listReviews(projectId).some((r) => r.id === reviewId)) return notFound('Review');
    const parsed = await parseBody(req, ApproveSchema);
    const comments = parsed.ok ? parsed.data.comments : 'Approved for deployment';

    const adminUser = {
      id: identity.userId,
      email: identity.email ?? 'admin@cloudcraft.io',
      name: 'Cloud Administrator',
    };

    const updatedReview = ArchitectureReviewService.approveReview(reviewId, adminUser, comments);
    return ok(updatedReview);
  } catch (err: any) {
    console.error('[POST /api/projects/:id/reviews/:reviewId/approve]', err);
    return badRequest(err.message || 'Failed to approve review');
  }
}
