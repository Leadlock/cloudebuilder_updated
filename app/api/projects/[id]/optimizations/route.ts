/**
 * POST /api/projects/[id]/optimizations  — run architecture advisor analysis
 * GET  /api/projects/[id]/optimizations  — list saved optimization analyses
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, notFound, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { architectureAdvisor } from '@/lib/engines/advisor/ArchitectureAdvisor';
import { projectRepository } from '@/lib/repositories/projectRepository';
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
        recommendations: [], score: { overall: 0, reliability: 0, security: 0, performance: 0, cost: 0, scalability: 0 },
        optimizationId: null, message: 'No architecture saved yet.',
      });
      return notFound('Environment');
    }

    const { arch } = ctx;

    // Run the analysis
    const result = architectureAdvisor.analyze({
      architectureId: arch.id,
      projectId,
      versionId: body.versionId,
      resources: arch.resources,
      connections: arch.connections,
    });

    const now = new Date().toISOString();
    const optimizationId = randomUUID();

    // Persist optimization record (graceful offline fallback if DB is unavailable)
    try {
      await db.orm.public.ArchOptimization.create({
        id: optimizationId,
        projectId,
        architectureId: arch.id,
        versionId: body.versionId ?? null,
        recommendationsJson: JSON.stringify(result.recommendations),
        scoreJson: JSON.stringify(result.score),
        createdAt: now,
      });
    } catch {
      // Continue gracefully in offline/in-memory mode
    }

    return created({
      optimizationId,
      architectureId: arch.id,
      recommendations: result.recommendations,
      score: result.score,
      createdAt: now,
    });
  } catch (err) {
    console.error('[POST /api/projects/:id/optimizations]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

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

    const project = await projectRepository.findById(projectId, orgId);
    if (!project) return notFound('Project');

    const rows = await db.orm.public.ArchOptimization
      .where({ projectId })
      .select('id', 'projectId', 'architectureId', 'versionId', 'recommendationsJson', 'scoreJson', 'createdAt')
      .all();

    return ok(rows.map((r) => {
      let recommendations: unknown[] = [];
      let score: unknown = {};
      try { recommendations = JSON.parse(r.recommendationsJson) as unknown[]; } catch { /* empty */ }
      try { score = JSON.parse(r.scoreJson); } catch { /* empty */ }
      return {
        optimizationId: r.id,
        architectureId: r.architectureId,
        versionId: r.versionId,
        recommendations,
        score,
        createdAt: r.createdAt,
      };
    }));
  } catch (err) {
    console.error('[GET /api/projects/:id/optimizations]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

