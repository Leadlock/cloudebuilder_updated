/**
 * GET  /api/projects/[id]/well-architected         — get latest cached WA assessment
 * POST /api/projects/[id]/well-architected/analyze  — alias; triggers fresh analysis
 *
 * Auth: extractIdentity + getOrgRole (same as all other project routes)
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { wellArchitectedFrameworkService } from '@/lib/engines/wellArchitected/WellArchitectedFrameworkService';
import { wellArchitectedRepository } from '@/lib/repositories/wellArchitectedRepository';

export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  env:       z.string().optional().default('production'),
  versionId: z.string().optional(),
  forceRefresh: z.boolean().optional().default(false),
});

// ─── GET — return latest cached assessment ───────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId } = await params;

    const orgId = await resolveOrgId(req);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const env = req.nextUrl.searchParams.get('env') ?? 'production';
    const ctx = await resolveArchitecture(projectId, orgId, env);
    if ('error' in ctx) {
      if (ctx.error === 'project_not_found') return notFound('Project');
      if (ctx.error === 'architecture_not_found') {
        return ok({ assessment: null, message: 'No architecture saved yet.' });
      }
      return notFound('Environment');
    }

    const cached = await wellArchitectedRepository.findLatestByArchitecture(ctx.arch.id);
    return ok({ assessment: cached });
  } catch (err) {
    console.error('[GET /api/projects/:id/well-architected]', err instanceof Error ? err.message : err);
    return internalError();
  }
}

// ─── POST — trigger fresh design-time analysis ───────────────────────────────

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
      if (ctx.error === 'architecture_not_found') {
        return ok({
          assessment: null,
          message: 'No architecture saved yet. Add resources to the canvas first.',
        });
      }
      return notFound('Environment');
    }

    const { arch } = ctx;

    // Run design-time analysis
    const assessment = await wellArchitectedFrameworkService.analyzeDesignTime({
      architectureId: arch.id,
      projectId,
      resources: arch.resources,
      connections: arch.connections,
    });

    // Persist the assessment
    const assessmentId = await wellArchitectedRepository.createAssessment(assessment);

    return ok({
      assessmentId,
      assessment,
      message: `Design-time assessment complete. ${assessment.findings.length} findings.`,
    });
  } catch (err) {
    console.error('[POST /api/projects/:id/well-architected]', err instanceof Error ? err.message : err);
    return internalError();
  }
}
