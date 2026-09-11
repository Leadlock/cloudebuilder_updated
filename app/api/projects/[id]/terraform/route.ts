/**
 * POST /api/projects/[id]/terraform  — generate Terraform from persisted architecture
 * GET  /api/projects/[id]/terraform/[generationId] — retrieve a saved generation
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, notFound, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';
import { terraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import { db } from '@/src/prisma/db';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  env:         z.string().optional().default('production'),
  versionId:   z.string().optional(),
  projectName: z.string().optional(),
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
        files: [{ filename: 'main.tf', content: '# No architecture saved yet.\n', provider: 'all' }],
        warnings: [], resourceMap: {}, generationId: null,
      });
      return notFound('Environment');
    }

    const { arch, project } = ctx;

    // Generate Terraform
    const result = terraformGenerator.generate({
      architectureId: arch.id,
      projectId,
      versionId: body.versionId,
      resources: arch.resources,
      connections: arch.connections,
      projectName: body.projectName ?? project.name.replace(/\s+/g, '-').toLowerCase(),
    });

    const now = new Date().toISOString();
    const generationId = randomUUID();

    // Convert files to Record<filename, content>
    const filesRecord: Record<string, string> = {};
    for (const f of result.files) {
      filesRecord[f.filename] = f.content;
    }

    // Persist generation record (graceful offline fallback if DB is unavailable)
    try {
      await db.orm.public.TerraformGeneration.create({
        id: generationId,
        projectId,
        architectureId: arch.id,
        versionId: body.versionId ?? null,
        filesJson: JSON.stringify(filesRecord),
        warningsJson: JSON.stringify(result.warnings),
        resourceMapJson: JSON.stringify(result.resourceMap),
        createdAt: now,
      });
    } catch {
      // Continue gracefully in offline/in-memory mode
    }

    return created({
      generationId,
      architectureId: arch.id,
      files: result.files,
      warnings: result.warnings,
      resourceMap: result.resourceMap,
      providers: result.providers,
      createdAt: now,
    });
  } catch (err) {
    console.error('[POST /api/projects/:id/terraform]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
