/**
 * POST /api/projects/[id]/cost-insights — AI explanation and savings ideas for the project's cost comparison.
 *
 * Runs only when the user asks for it (a button), because every call is a paid model request. The comparison is recomputed here from the
 * resources, never taken from the browser, and every figure in the answer comes from the estimator (see lib/cost/ai/insights.ts).
 */
import { NextRequest } from 'next/server';
import { createHash } from 'crypto';
import { z } from 'zod';
import { ok, notFound, forbidden, unauthorized, badRequest, parseBody, tooManyRequests, serviceUnavailable } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';
import { costEstimator } from '@/lib/engines/cost/CostEstimator';
import { runCostComparison } from '@/lib/engines/comparison/runCostComparison';
import { aiCostAvailable, askFoundryJson } from '@/lib/cost/ai/askModel';
import { buildCostInsights, type CostInsights } from '@/lib/cost/ai/insights';

export const dynamic = 'force-dynamic';

const LiveResourceSchema = z.object({
  id: z.string(), resourceType: z.string(), provider: z.string(), label: z.string(),
  region: z.string().nullable().optional(), config: z.record(z.string(), z.unknown()).optional(),
});
const RequestSchema = z.object({
  env: z.string().optional().default('production'),
  currency: z.string().optional(),
  resources: z.array(LiveResourceSchema).max(300).optional(),
});

// The same architecture asked about again within the hour gets the same answer without another paid call.
const CACHE_MS = 60 * 60_000;
const cache = new Map<string, { at: number; insights: CostInsights }>();

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    if (!aiCostAvailable()) return serviceUnavailable('AI cost insights are not available: no AI model is configured on this server.');

    const rl = await checkRateLimit(`${identity.userId}:cost-insights`, RATE_LIMITS.AI_GENERATE.limit, RATE_LIMITS.AI_GENERATE.windowMs);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const { id: projectId } = await params;
    const parsed = await parseBody(req, RequestSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

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

    const resources = body.resources && body.resources.length > 0
      ? body.resources.map((r) => ({
          id: r.id, resourceType: r.resourceType, provider: r.provider, label: r.label, positionX: 0, positionY: 0,
          configJson: JSON.stringify(r.config ?? {}), region: r.region ?? null, groupId: null, locked: false, architectureId: arch.id,
        }))
      : arch.resources;
    if (resources.length === 0) return badRequest('There are no resources to analyse.');

    // Scoped by project and org so one organisation can never be served another's cached answer.
    const key = createHash('sha256').update(JSON.stringify([orgId, projectId, project.region, resources.map((r) => [r.id, r.resourceType, r.provider, r.region, r.configJson])])).digest('hex');
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return ok(hit.insights);

    const run = await runCostComparison({
      architectureId: arch.id, projectId, resources, projectRegion: project.region, targetCurrency: 'USD', aiMatching: true,
    });
    const insights = await buildCostInsights({
      currentProvider: run.currentProvider, targetProvider: run.targetProvider,
      current: run.current, translated: run.translated, resources,
      estimateInput: { architectureId: arch.id, projectId, defaultRegion: project.region, targetCurrency: 'USD' },
      estimator: costEstimator, ask: askFoundryJson,
    });

    if (cache.size >= 200) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: Date.now(), insights });
    return ok(insights);
  } catch (err) {
    console.error('[POST /api/projects/:id/cost-insights]', err instanceof Error ? err.message : String(err));
    return badRequest('Could not generate cost insights right now.');
  }
}
