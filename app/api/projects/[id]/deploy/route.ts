import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, unauthorized, forbidden, badRequest, internalError, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { requireProjectAccess } from '@/lib/api/projectAccess';
import { ArchitectureReviewService } from '@/lib/services/ArchitectureReviewService';
import type { CanvasNode, CanvasEdge } from '@/types';

export const dynamic = 'force-dynamic';

const DeploySchema = z.object({
  environment: z.enum(['development', 'staging', 'production']).default('production'),
  nodes: z.array(z.any()),
  edges: z.array(z.any()),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) {
      return unauthorized('Authentication required to trigger infrastructure deployment');
    }

    // 1. Strict RBAC Gate: Standard users are blocked with 403
    if (identity.role !== 'admin') {
      return forbidden('Access denied: Infrastructure deployment is strictly restricted to Administrators.');
    }

    const { id: projectId } = await params;
    const access = await requireProjectAccess(req, identity.userId, projectId, { adminOnly: true });
    if ('response' in access) return access.response;
    const parsed = await parseBody(req, DeploySchema);
    if (!parsed.ok) return parsed.response;

    const { environment, nodes, edges } = parsed.data;

    const user = {
      id: identity.userId,
      email: identity.email ?? 'admin@cloudcraft.io',
      name: 'Cloud Administrator',
      role: identity.role,
    };

    try {
      const record = await ArchitectureReviewService.executeDeployment(
        projectId,
        environment,
        user,
        nodes as CanvasNode[],
        edges as CanvasEdge[]
      );

      return ok(record);
    } catch (deployErr: any) {
      const statusCode = deployErr.statusCode ?? 400;
      if (statusCode === 403) return forbidden(deployErr.message);
      return badRequest(deployErr.message);
    }
  } catch (err: any) {
    console.error('[POST /api/projects/:id/deploy]', err);
    return internalError(err.message || 'Deployment execution failed');
  }
}
