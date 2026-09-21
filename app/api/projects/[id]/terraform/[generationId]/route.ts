/**
 * GET /api/projects/[id]/terraform/[generationId]
 * Retrieve a previously generated Terraform output.
 */
import { NextRequest } from 'next/server';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { db } from '@/src/prisma/db';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; generationId: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const { id: projectId, generationId } = await params;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const project = await projectRepository.findById(projectId, orgId);
    if (!project) return notFound('Project');

    const gen = await db.orm.public.TerraformGeneration
      .where({ id: generationId, projectId })
      .select('id', 'projectId', 'architectureId', 'versionId', 'filesJson', 'warningsJson', 'resourceMapJson', 'createdAt')
      .first();

    if (!gen) return notFound('TerraformGeneration');

    let filesRecord: Record<string, string> = {};
    let warnings: string[] = [];
    let resourceMap: Record<string, string> = {};

    try { filesRecord  = JSON.parse(gen.filesJson) as Record<string, string>; } catch { /* empty */ }
    try { warnings     = JSON.parse(gen.warningsJson) as string[]; } catch { /* empty */ }
    try { resourceMap  = JSON.parse(gen.resourceMapJson) as Record<string, string>; } catch { /* empty */ }

    // Convert Record back to TerraformFile array
    const files = Object.entries(filesRecord).map(([filename, content]) => ({
      filename, content, provider: 'all',
    }));

    return ok({
      generationId: gen.id,
      architectureId: gen.architectureId,
      versionId: gen.versionId,
      files,
      warnings,
      resourceMap,
      createdAt: gen.createdAt,
    });
  } catch (err) {
    console.error('[GET /api/projects/:id/terraform/:generationId]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
