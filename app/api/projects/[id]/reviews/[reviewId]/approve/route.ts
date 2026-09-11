import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, unauthorized, forbidden, badRequest, internalError, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
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

    // Strict RBAC: Only Admin can approve
    if (identity.role !== 'admin') {
      return forbidden('Access denied: Only Administrators can approve architecture reviews.');
    }

    const { reviewId } = await params;
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
