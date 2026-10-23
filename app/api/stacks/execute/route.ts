/**
 * /api/stacks/execute
 * POST - Trigger multi-stack DAG planning or applying across tiers
 * GET - Poll pipeline run progress
 */

import { NextRequest } from 'next/server';
import { ok, internalError, badRequest } from '@/lib/api/response';
import { multiStackOrchestrator } from '@/lib/stacks/multiStackOrchestrator';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { projectId, environment, action } = body;

    if (!projectId) return badRequest('projectId is required');
    if (action !== 'plan' && action !== 'apply') {
      return badRequest('action must be "plan" or "apply"');
    }

    const progress = await multiStackOrchestrator.executePipeline(projectId, environment || 'development', action);
    return ok(progress);
  } catch (err) {
    console.error('[POST /api/stacks/execute]', err);
    return internalError(err instanceof Error ? err.message : 'Pipeline execution failed');
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const runId = searchParams.get('runId');

    if (!runId) return badRequest('runId is required');

    const progress = multiStackOrchestrator.getRunProgress(runId);
    return ok({ progress });
  } catch (err) {
    console.error('[GET /api/stacks/execute]', err);
    return internalError();
  }
}
