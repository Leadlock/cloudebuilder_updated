import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, notFound, forbidden, unauthorized, internalError, badRequest, parseBody, tooManyRequests } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { runCostComparison } from '@/lib/engines/comparison/runCostComparison';
import { aiCostAvailable } from '@/lib/cost/ai/askModel';
import { db } from '@/src/prisma/db';
import { randomUUID } from 'crypto';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';
import { assessResult, oldestPriceTime } from '@/lib/cost/quality/priceQuality';
import { ensureAwsPricingAccess } from '@/lib/cloud/pricing/awsPricingAccess';
import { pricingCache } from '@/lib/cloud/pricing/PricingCache';
import { awsPricingDeniedRecently } from '@/lib/cloud/pricing/AwsPricingProvider';

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
  // Discard every saved price first, so each one is fetched from the official list again.
  refresh:   z.boolean().optional(),
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

    if (body.refresh) pricingCache.clear();
    await ensureAwsPricingAccess(orgId);

    const run = await runCostComparison({
      architectureId: arch.id,
      projectId,
      versionId: body.versionId,
      resources,
      projectRegion: project.region,
      targetCurrency,
      aiMatching: aiCostAvailable(),
    });

    return ok({
      currentProvider: run.currentProvider,
      targetProvider: run.targetProvider,
      current: run.current,
      translated: run.translated,
      targetCurrency,
      aiMatches: run.aiMatches,
      anomalies: run.anomalies,
      // Said on screen so an AWS line priced from the built-in table is never an unexplained estimate.
      notices: awsPricingDeniedRecently()
        ? ['AWS refused the official price list to your connected role. Add the read-only permission pricing:GetProducts to that role (it is in the policy on the Deploy tab) and AWS prices will come from the official list.']
        : [],
      quality: {
        current: { ...assessResult(run.current.items), oldestPriceAt: oldestPriceTime(run.current.items) },
        translated: { ...assessResult(run.translated.items), oldestPriceAt: oldestPriceTime(run.translated.items) },
      },
    });

  } catch (err) {
    console.error('[POST /api/projects/:id/cost-comparison]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
