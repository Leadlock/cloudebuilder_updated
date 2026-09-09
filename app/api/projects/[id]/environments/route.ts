/**
 * GET  /api/projects/[id]/environments          — list environments
 * POST /api/projects/[id]/environments/clone    — clone one env into another
 * POST /api/projects/[id]/environments/promote  — promote one env into another
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

async function resolveOrgId(req: NextRequest): Promise<string | null> {
  const orgId = req.nextUrl.searchParams.get('orgId') ?? '';
  if (orgId) return orgId;
  if (process.env.NODE_ENV === 'development') {
    const ctx = await orgRepository.ensureDevContext();
    return ctx.orgId;
  }
  return null;
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

    const envs = await environmentRepository.findByProject(projectId);
    return ok(envs);
  } catch (err) {
    console.error('[GET /api/projects/:id/environments]', err);
    return internalError();
  }
}
