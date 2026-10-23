/**
 * /api/drift/status
 * GET - Retrieves latest drift report for a project and environment
 */

import { NextRequest } from 'next/server';
import { ok, internalError, badRequest } from '@/lib/api/response';
import { driftDetector } from '@/lib/drift/driftDetector';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get('projectId');
    const environment = searchParams.get('environment') || 'development';

    if (!projectId) return badRequest('projectId is required');

    const report = driftDetector.getLatestReport(projectId, environment);
    return ok({ report });
  } catch (err) {
    console.error('[GET /api/drift/status]', err);
    return internalError();
  }
}
