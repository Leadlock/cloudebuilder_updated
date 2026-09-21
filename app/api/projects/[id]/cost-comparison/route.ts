import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, notFound, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { costEstimator } from '@/lib/engines/cost/CostEstimator';
import { CloudCostComparisonService } from '@/lib/engines/comparison/CloudCostComparisonService';
import { db } from '@/src/prisma/db';
import { randomUUID } from 'crypto';

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

    // Determine current provider from the first resource, defaulting to aws
    const currentProvider = arch.resources.length > 0 ? arch.resources[0].provider : 'aws';
    const targetProvider = currentProvider === 'aws' ? 'azure' : 'aws';

    // Translate resources
    const translatedResources = CloudCostComparisonService.translateResources(arch.resources, targetProvider);

    // Run real estimation for current provider
    const currentResult = await costEstimator.estimateAsync({
      architectureId: arch.id,
      projectId,
      versionId: body.versionId,
      resources: arch.resources,
      defaultRegion: project.region,
      targetCurrency,
    }, 'REAL');

    // Run real estimation for target provider
    const translatedResult = await costEstimator.estimateAsync({
      architectureId: arch.id,
      projectId,
      versionId: body.versionId,
      resources: translatedResources,
      defaultRegion: targetProvider === 'aws' ? 'us-east-1' : 'eastus', // Default fallback region mapping
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
