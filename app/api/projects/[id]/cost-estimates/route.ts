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

const LiveResourceSchema = z.object({
  id:           z.string(),
  resourceType: z.string(),
  provider:     z.string(),
  label:        z.string(),
  region:       z.string().nullable().optional(),
  config:       z.record(z.string(), z.unknown()).optional(),
});

const RequestSchema = z.object({
  env:       z.string().optional().default('production'),
  versionId: z.string().optional(),
  currency:  z.string().optional(),
  // Optional live snapshot of the canvas's current nodes. When present, cost
  // is computed from THIS instead of the persisted architecture — the canvas
  // (e.g. a scale-profile change from AdaptiveScaleEngine) can be edited and
  // not yet autosaved, and the estimate must reflect what's on screen right
  // now, not race the debounced autosave for whichever lands first. Without
  // this, "change expected users, cost doesn't change" was reproducible any
  // time the cost re-fetch beat the 800ms autosave to the server.
  resources: z.array(LiveResourceSchema).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const rl = await checkRateLimit(`${identity.userId}:cost-estimates`, RATE_LIMITS.ANALYSIS.limit, RATE_LIMITS.ANALYSIS.windowMs);
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

    // Prefer the live canvas snapshot the client sent (current, possibly
    // unsaved, node configs) over the persisted architecture — see
    // RequestSchema.resources above for why.
    const resources = body.resources && body.resources.length > 0
      ? body.resources.map((r) => ({
          id: r.id,
          resourceType: r.resourceType,
          provider: r.provider,
          label: r.label,
          positionX: 0,
          positionY: 0,
          configJson: JSON.stringify(r.config ?? {}),
          region: r.region ?? null,
          groupId: null,
          locked: false,
          architectureId: arch.id,
        }))
      : arch.resources;

    // Run real estimation with currency conversion
    const result = await costEstimator.estimateAsync({
      architectureId: arch.id,
      projectId,
      versionId: body.versionId,
      resources,
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
