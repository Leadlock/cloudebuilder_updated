/**
 * POST /api/projects/[id]/cost-estimates
 * Run a real cost estimate against the persisted architecture.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, notFound, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { costEstimator } from '@/lib/engines/cost/CostEstimator';
import { db } from '@/src/prisma/db';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  env:       z.string().optional().default('production'),
  versionId: z.string().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const { id: projectId } = await params;

    const parsed = await parseBody(req, RequestSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const orgId = await resolveOrgId(req);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const ctx = await resolveArchitecture(projectId, orgId, body.env);
    if ('error' in ctx) {
      if (ctx.error === 'project_not_found') return notFound('Project');
      if (ctx.error === 'architecture_not_found') return ok({
        items: [], totalMonthlyUsd: 0, totalHourlyUsd: 0,
        currency: 'USD', estimateId: null,
        message: 'No architecture saved yet.',
      });
      return notFound('Environment');
    }

    const { arch, project } = ctx;

    // Run the estimation
    const result = costEstimator.estimate({
      architectureId: arch.id,
      projectId,
      versionId: body.versionId,
      resources: arch.resources,
      defaultRegion: project.region,
    });

    const now = new Date().toISOString();
    const estimateId = randomUUID();

    // Persist estimate record
    await db.orm.public.CostEstimate.create({
      id: estimateId,
      projectId,
      architectureId: arch.id,
      versionId: body.versionId ?? null,
      currency: result.currency,
      totalMonthly: result.totalMonthlyUsd,
      totalHourly: result.totalHourlyUsd,
      itemsJson: JSON.stringify(result.items),
      assumptionsJson: JSON.stringify(result.assumptions),
      pricingSource: result.pricingSource,
      confidence: result.confidence,
      createdAt: now,
    });

    return created({
      estimateId,
      architectureId: arch.id,
      ...result,
      createdAt: now,
    });
  } catch (err) {
    console.error('[POST /api/projects/:id/cost-estimates]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
