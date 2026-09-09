/**
 * POST /api/projects/[id]/environments/clone
 *   — copy nodes+edges from one environment into another
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, notFound, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { projectRepository, environmentRepository } from '@/lib/repositories/projectRepository';
import { architectureRepository } from '@/lib/repositories/architectureRepository';
import { orgRepository } from '@/lib/repositories/orgRepository';
import type { Environment } from '@/types';

export const dynamic = 'force-dynamic';

const CloneSchema = z.object({
  from: z.enum(['development', 'staging', 'production']),
  to:   z.enum(['development', 'staging', 'production']),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id: projectId } = await params;

    const parsed = await parseBody(req, CloneSchema);
    if (!parsed.ok) return parsed.response;
    const { from, to } = parsed.data;

    if (from === to) return badRequest('Source and target environments must be different');

    let orgId = req.nextUrl.searchParams.get('orgId') ?? '';
    if (!orgId && process.env.NODE_ENV === 'development') {
      const ctx = await orgRepository.ensureDevContext();
      orgId = ctx.orgId;
    }
    if (!orgId) return badRequest('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role || role === 'viewer') return forbidden();

    const project = await projectRepository.findById(projectId, orgId);
    if (!project) return notFound('Project');

    const srcEnv = await environmentRepository.findByKey(projectId, from as Environment);
    const dstEnv = await environmentRepository.findByKey(projectId, to as Environment);
    if (!srcEnv || !dstEnv) return notFound('Environment');

    const clonedArch = await architectureRepository.copyArchitecture(srcEnv.id, dstEnv.id);
    return ok({ cloned: true, from, to, nodeCount: clonedArch.resources.length });
  } catch (err) {
    console.error('[POST /api/projects/:id/environments/clone]', err);
    return internalError();
  }
}
