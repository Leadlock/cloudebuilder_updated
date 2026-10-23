/**
 * /api/drift/detect
 * POST - Runs automated drift detection for a project and environment
 */

import { NextRequest } from 'next/server';
import { ok, internalError, badRequest } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { driftDetector } from '@/lib/drift/driftDetector';
import type { CanvasNode } from '@/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    const body = await req.json().catch(() => ({}));
    const { projectId, environment, provider, nodes, liveCloudData } = body;

    if (!projectId) return badRequest('projectId is required');

    const report = await driftDetector.detectDrift({
      projectId,
      environment: environment || 'development',
      provider: provider || 'aws',
      nodes: (nodes as CanvasNode[]) || [],
      liveCloudData,
    });

    return ok(report);
  } catch (err) {
    console.error('[POST /api/drift/detect]', err);
    return internalError();
  }
}
