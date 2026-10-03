/**
 * POST /api/projects/[id]/well-architected/analyze
 *
 * Explicit re-analysis endpoint (separate from the combined GET/POST in route.ts).
 * Always runs a fresh analysis regardless of cache state.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest, parseBody, tooManyRequests } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { wellArchitectedFrameworkService } from '@/lib/engines/wellArchitected/WellArchitectedFrameworkService';
import { wellArchitectedRepository } from '@/lib/repositories/wellArchitectedRepository';
import { checkRateLimit, RATE_LIMITS } from '@/lib/api/rateLimit';

export const dynamic = 'force-dynamic';

const AnalyzeSchema = z.object({
  env: z.string().optional().default('production'),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const rl = await checkRateLimit(`${identity.userId}:well-architected-analyze`, RATE_LIMITS.ANALYSIS.limit, RATE_LIMITS.ANALYSIS.windowMs);
    if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);

    const { id: projectId } = await params;

    const parsed = await parseBody(req, AnalyzeSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const ctx = await resolveArchitecture(projectId, orgId, body.env);
    if ('error' in ctx) {
      if (ctx.error === 'project_not_found') return notFound('Project');
      if (ctx.error === 'architecture_not_found') {
        return ok({ assessment: null, message: 'No architecture saved yet.' });
      }
      return notFound('Environment');
    }

    const { arch } = ctx;

    // Always run fresh analysis
    const assessment = await wellArchitectedFrameworkService.analyzeDesignTime({
      architectureId: arch.id,
      projectId,
      resources: arch.resources,
      connections: arch.connections,
    });

    const assessmentId = await wellArchitectedRepository.createAssessment(assessment);

    return ok({
      assessmentId,
      assessment,
      isStale: false,
      analyzedAt: assessment.evaluatedAt,
      findingCount: assessment.findings.length,
      criticalCount: assessment.findings.filter((f) => f.severity === 'critical').length,
      highCount: assessment.findings.filter((f) => f.severity === 'high').length,
    });
  } catch (err) {
    console.error('[POST /api/projects/:id/well-architected/analyze]', err instanceof Error ? err.message : err);
    return internalError();
  }
}
