/**
 * GET /api/projects/[id]/cost-estimates/[estimateId]
 * Retrieve a previously run cost estimate.
 */
import { NextRequest } from 'next/server';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { db } from '@/src/prisma/db';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; estimateId: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const { id: projectId, estimateId } = await params;

    const orgId = await resolveOrgId(req);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const project = await projectRepository.findById(projectId, orgId);
    if (!project) return notFound('Project');

    const est = await db.orm.public.CostEstimate
      .where({ id: estimateId, projectId })
      .select('id', 'projectId', 'architectureId', 'versionId', 'currency', 'totalMonthly', 'totalHourly', 'itemsJson', 'assumptionsJson', 'pricingSource', 'confidence', 'createdAt')
      .first();

    if (!est) return notFound('CostEstimate');

    let items: unknown[] = [];
    let assumptions: unknown[] = [];
    try { items      = JSON.parse(est.itemsJson) as unknown[]; } catch { /* empty */ }
    try { assumptions = JSON.parse(est.assumptionsJson) as unknown[]; } catch { /* empty */ }

    return ok({
      estimateId: est.id,
      architectureId: est.architectureId,
      versionId: est.versionId,
      currency: est.currency,
      totalMonthlyUsd: est.totalMonthly,
      totalHourlyUsd: est.totalHourly,
      items,
      assumptions,
      pricingSource: est.pricingSource,
      confidence: est.confidence,
      createdAt: est.createdAt,
    });
  } catch (err) {
    console.error('[GET /api/projects/:id/cost-estimates/:estimateId]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
