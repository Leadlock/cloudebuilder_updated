/**
 * /api/stacks
 * GET - Retrieve project stacks & computed DAG tiers
 * POST - Save stacks or auto-cluster stacks from canvas
 */

import { NextRequest } from 'next/server';
import { ok, internalError, badRequest } from '@/lib/api/response';
import { multiStackOrchestrator } from '@/lib/stacks/multiStackOrchestrator';
import { dagEngine } from '@/lib/stacks/dagEngine';
import type { CanvasNode } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get('projectId');
    const environment = searchParams.get('environment') || 'development';

    if (!projectId) return badRequest('projectId is required');

    const graph = multiStackOrchestrator.getOrCreateGraph(projectId, environment, []);
    return ok(graph);
  } catch (err) {
    console.error('[GET /api/stacks]', err);
    return internalError();
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { projectId, environment, action, nodes, stacks } = body;

    if (!projectId) return badRequest('projectId is required');

    if (action === 'auto_cluster') {
      const clustered = dagEngine.autoClusterStacks((nodes as CanvasNode[]) || []);
      const result = multiStackOrchestrator.updateStacks(projectId, environment || 'development', clustered);
      return ok(result);
    }

    if (stacks) {
      const result = multiStackOrchestrator.updateStacks(projectId, environment || 'development', stacks);
      return ok(result);
    }

    const graph = multiStackOrchestrator.getOrCreateGraph(projectId, environment || 'development', (nodes as CanvasNode[]) || []);
    return ok({ graph });
  } catch (err) {
    console.error('[POST /api/stacks]', err);
    return internalError();
  }
}
