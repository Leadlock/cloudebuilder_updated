import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, unauthorized, forbidden, badRequest, notFound, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { requireProjectAccess } from '@/lib/api/projectAccess';
import { ArchitectureReviewService } from '@/lib/services/ArchitectureReviewService';

export const dynamic = 'force-dynamic';

const RejectSchema = z.object({
  comments: z.string().min(1, 'Rejection comments are required'),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; reviewId: string }> }
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized('Authentication required');

    if (identity.role !== 'admin') {
      return forbidden('Access denied: Only Administrators can reject architecture reviews.');
    }

    const { id: projectId, reviewId } = await params;
    const access = await requireProjectAccess(req, identity.userId, projectId, { adminOnly: true });
    if ('response' in access) return access.response;
    // The review must belong to THIS project: a review id alone must never let a caller act on another project's review.
    if (!ArchitectureReviewService.listReviews(projectId).some((r) => r.id === reviewId)) return notFound('Review');
    const parsed = await parseBody(req, RejectSchema);
    if (!parsed.ok) return parsed.response;

    const adminUser = {
      id: identity.userId,
      email: identity.email ?? 'admin@cloudcraft.io',
      name: 'Cloud Administrator',
    };

    const updatedReview = ArchitectureReviewService.rejectReview(reviewId, adminUser, parsed.data.comments);
    return ok(updatedReview);
  } catch (err: any) {
    return badRequest(err.message || 'Failed to reject review');
  }
}
