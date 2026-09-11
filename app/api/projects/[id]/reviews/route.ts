import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, unauthorized, badRequest, internalError, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { ArchitectureReviewService } from '@/lib/services/ArchitectureReviewService';
import type { CanvasNode, CanvasEdge } from '@/types';

export const dynamic = 'force-dynamic';

const SubmitReviewSchema = z.object({
  environment: z.enum(['development', 'staging', 'production']).default('production'),
  nodes: z.array(z.any()),
  edges: z.array(z.any()),
  summary: z.object({
    nodeCount: z.number().default(0),
    edgeCount: z.number().default(0),
    criticalIssuesCount: z.number().default(0),
    estimatedMonthlyCost: z.number().default(0),
  }),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized('Authentication required');

    const { id: projectId } = await params;
    const env = req.nextUrl.searchParams.get('env') ?? undefined;

    const reviews = ArchitectureReviewService.listReviews(projectId, env);
    const latest = ArchitectureReviewService.getLatestReview(projectId, env);

    return ok({
      reviews,
      latest,
    });
  } catch (err) {
    console.error('[GET /api/projects/:id/reviews]', err);
    return internalError();
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized('Authentication required');

    const { id: projectId } = await params;
    const parsed = await parseBody(req, SubmitReviewSchema);
    if (!parsed.ok) return parsed.response;

    const { environment, nodes, edges, summary } = parsed.data;

    const user = {
      id: identity.userId,
      email: identity.email ?? 'user@cloudcraft.io',
      name: identity.role === 'admin' ? 'Cloud Administrator' : 'DevOps Engineer',
    };

    const review = ArchitectureReviewService.submitReview(
      projectId,
      environment,
      nodes as CanvasNode[],
      edges as CanvasEdge[],
      user,
      summary
    );

    return created(review);
  } catch (err) {
    console.error('[POST /api/projects/:id/reviews]', err);
    return internalError();
  }
}
