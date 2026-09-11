import { NextRequest } from 'next/server';
import { ok, unauthorized, internalError } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { ArchitectureReviewService } from '@/lib/services/ArchitectureReviewService';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized('Authentication required');

    const { id: projectId } = await params;
    const env = req.nextUrl.searchParams.get('env') ?? undefined;

    const deployments = ArchitectureReviewService.listDeployments(projectId, env);
    return ok({ deployments });
  } catch (err) {
    console.error('[GET /api/projects/:id/deployments]', err);
    return internalError();
  }
}
