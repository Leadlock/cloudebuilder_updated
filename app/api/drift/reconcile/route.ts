/**
 * /api/drift/reconcile
 * POST - Executes drift reconciliation (align cloud or import to canvas)
 */

import { NextRequest } from 'next/server';
import { ok, internalError, badRequest } from '@/lib/api/response';
import { reconciler } from '@/lib/drift/reconciler';
import type { CanvasNode } from '@/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { projectId, environment, mode, resourceIds, nodes } = body;

    if (!projectId) return badRequest('projectId is required');
    if (!mode) return badRequest('mode is required (align_cloud_to_canvas | import_drift_to_canvas)');

    const result = await reconciler.reconcile(
      {
        projectId,
        environment: environment || 'development',
        mode,
        resourceIds,
      },
      (nodes as CanvasNode[]) || [],
    );

    return ok(result);
  } catch (err) {
    console.error('[POST /api/drift/reconcile]', err);
    return internalError();
  }
}
