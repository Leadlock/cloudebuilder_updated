/**
 * POST /api/projects/[id]/cost-estimates
 * Run a real cost estimate against the persisted architecture.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, notFound, forbidden, unauthorized, internalError, badRequest, parseBody, tooManyRequests } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { costEstimator } from '@/lib/engines/cost/CostEstimator';
import { db } from '@/src/prisma/db';
import { randomUUID } from 'crypto';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';

export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  env:       z.string().optional().default('production'),
  versionId: z.string().optional(),
  currency:  z.string().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const rl = checkRateLimit(`${identity.userId}:cost-estimates`, RATE_LIMITS.ANALYSIS.limit, RATE_LIMITS.ANALYSIS.windowMs);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const { id: projectId } = await params;

    const parsed = await parseBody(req, RequestSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const queryCurrency = req.nextUrl.searchParams.get('currency');
    const targetCurrency = (body.currency || queryCurrency || 'USD').toUpperCase();

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const ctx = await resolveArchitecture(projectId, orgId, body.env);
    if ('error' in ctx) {
      if (ctx.error === 'project_not_found') return notFound('Project');
      if (ctx.error === 'architecture_not_found') return ok({
        items: [], totalMonthlyUsd: 0, totalHourlyUsd: 0,
        currency: targetCurrency, estimateId: null,
        message: 'No architecture saved yet.',
      });
      return notFound('Environment');
    }

    const { arch, project } = ctx;

    // Run real estimation with currency conversion
    const result = await costEstimator.estimateAsync({
      architectureId: arch.id,
      projectId,
      versionId: body.versionId,
      resources: arch.resources,
      defaultRegion: project.region,
      targetCurrency,
    }, 'REAL');

    const now = new Date().toISOString();
    const estimateId = randomUUID();

    // Persist estimate record (graceful offline fallback if DB is unavailable)
    try {
      await db.orm.public.CostEstimate.create({
        id: estimateId,
        projectId,
        architectureId: arch.id,
        versionId: body.versionId ?? null,
        currency: result.currency,
        totalMonthly: result.totalMonthlyConverted ?? result.totalMonthlyUsd,
        totalHourly: result.totalHourlyConverted ?? result.totalHourlyUsd,
        itemsJson: JSON.stringify(result.items),
        assumptionsJson: JSON.stringify(result.assumptions),
        pricingSource: result.pricingSource,
        confidence: result.confidence,
        createdAt: now,
      });
    } catch {
      // Continue gracefully in offline/in-memory mode
    }

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
