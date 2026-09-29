/**
 * GET    /api/projects/[id]   — get a single project
 * PUT    /api/projects/[id]   — update project metadata
 * DELETE /api/projects/[id]   — delete a project
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, notFound, forbidden, unauthorized, internalError, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole, resolveOrgIds } from '@/lib/api/auth';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { orgRepository } from '@/lib/repositories/orgRepository';
import type { Region } from '@/types';

export const dynamic = 'force-dynamic';

const UpdateProjectSchema = z.object({
  name:        z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  tags:        z.array(z.string()).optional(),
  region:      z.string().min(1).optional(),
});

async function resolveOrgId(req: NextRequest, userId: string): Promise<string | null> {
  const orgId = req.nextUrl.searchParams.get('orgId') ?? '';
  if (orgId) return orgId;
  const memberOrgIds = await resolveOrgIds(userId);
  if (memberOrgIds[0]) return memberOrgIds[0];
  if (process.env.NODE_ENV === 'development') {
    try {
      const ctx = await orgRepository.ensureDevContext();
      return ctx.orgId;
    } catch {
      return 'dev-org-id';
    }
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
    const { id } = await params;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return forbidden('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const project = await projectRepository.findById(id, orgId);
    if (!project) return notFound('Project');
    return ok(project);
  } catch (err) {
    console.error('[GET /api/projects/:id]', err);
    return internalError();
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id } = await params;

    const parsed = await parseBody(req, UpdateProjectSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return forbidden('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role || role === 'viewer') return forbidden();

    const updated = await projectRepository.update(id, orgId, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.tags !== undefined && { tags: body.tags }),
      ...(body.region !== undefined && { region: body.region as Region }),
    });
    if (!updated) return notFound('Project');
    return ok(updated);
  } catch (err) {
    console.error('[PUT /api/projects/:id]', err);
    return internalError();
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const { id } = await params;

    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return forbidden('orgId required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role || !['owner', 'admin'].includes(role)) {
      return forbidden('Only organization administrators can delete projects');
    }

    const deleted = await projectRepository.delete(id, orgId);
    if (!deleted) return notFound('Project');
    return ok({ deleted: true });
  } catch (err) {
    console.error('[DELETE /api/projects/:id]', err);
    return internalError();
  }
}
