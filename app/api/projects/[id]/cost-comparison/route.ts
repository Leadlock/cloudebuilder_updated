import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, notFound, forbidden, unauthorized, internalError, badRequest, parseBody, tooManyRequests } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { costEstimator } from '@/lib/engines/cost/CostEstimator';
import { CloudCostComparisonService } from '@/lib/engines/comparison/CloudCostComparisonService';
import { translateRegion } from '@/lib/cloud/regions/regionEquivalence';
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
  // See cost-estimates/route.ts's RequestSchema.resources — same reasoning:
  // use the live canvas snapshot when the client has one instead of racing
  // the debounced autosave.
  resources: z.array(LiveResourceSchema).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    // This route runs TWO full cost estimations per call (current + translated
    // provider) — twice the cost of /cost-estimates, which already rate-limits.
    const rl = await checkRateLimit(`${identity.userId}:cost-comparison`, RATE_LIMITS.ANALYSIS.limit, RATE_LIMITS.ANALYSIS.windowMs);
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
      if (ctx.error === 'architecture_not_found') return notFound('Architecture');
      return notFound('Environment');
    }

    const { arch, project } = ctx;

    // Prefer the live canvas snapshot the client sent over the persisted
    // architecture — see RequestSchema.resources above.
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

    // Determine current provider from the first resource, defaulting to aws
    const currentProvider = resources.length > 0 ? resources[0].provider : 'aws';
    const targetProvider = currentProvider === 'aws' ? 'azure' : 'aws';

    // Translate resources
    const translatedResources = CloudCostComparisonService.translateResources(resources, targetProvider);

    // Run real estimation for current provider
    const currentResult = await costEstimator.estimateAsync({
      architectureId: arch.id,
      projectId,
      versionId: body.versionId,
      resources,
      defaultRegion: project.region,
      targetCurrency,
    }, 'REAL');

    // Run real estimation for target provider
    const translatedResult = await costEstimator.estimateAsync({
      architectureId: arch.id,
      projectId,
      versionId: body.versionId,
      resources: translatedResources,
      // The translated side's default region must be the geographic
      // equivalent of THIS project's own region — not an unconditional
      // us-east-1/eastus — otherwise the two sides of the comparison can
      // silently price against different geographies even before any
      // per-resource region is considered.
      defaultRegion: translateRegion(project.region, currentProvider as 'aws' | 'azure', targetProvider),
      targetCurrency,
    }, 'REAL');

    return ok({
      currentProvider,
      targetProvider,
      current: currentResult,
      translated: translatedResult,
      targetCurrency
    });

  } catch (err) {
    console.error('[POST /api/projects/:id/cost-comparison]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
