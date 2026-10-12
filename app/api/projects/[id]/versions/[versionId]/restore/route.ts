/**
 * POST /api/projects/[id]/versions/[versionId]/restore
 *   — restore canvas from a version snapshot
 */
import { devShortcutsEnabled } from '@/lib/dev/shortcuts';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { projectRepository, environmentRepository } from '@/lib/repositories/projectRepository';
import { architectureRepository } from '@/lib/repositories/architectureRepository';
import { orgRepository } from '@/lib/repositories/orgRepository';
import type { Environment } from '@/types';

export const dynamic = 'force-dynamic';

const RestoreSchema = z.object({
  env: z.enum(['development', 'staging', 'production']).optional().default('production'),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId, versionId } = await params;

    const parsed = await parseBody(req, RestoreSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    let orgId = req.nextUrl.searchParams.get('orgId') ?? '';
    if (!orgId && devShortcutsEnabled()) {
      const ctx = await orgRepository.ensureDevContext();
      orgId = ctx.orgId;
    }
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role || role === 'viewer') return forbidden();

    const project = await projectRepository.findById(projectId, orgId);
    if (!project) return notFound('Project');

    const envKey = body.env as Environment;
    const env = await environmentRepository.findByKey(projectId, envKey);
    if (!env) return notFound('Environment');

    const result = await architectureRepository.restoreVersion(versionId, projectId, env.id);
    if (!result) return notFound('Version');

    return ok({ restored: true, nodes: result.nodes, edges: result.edges });
  } catch (err) {
    console.error('[POST /api/projects/:id/versions/:versionId/restore]', err);
    return internalError();
  }
}
