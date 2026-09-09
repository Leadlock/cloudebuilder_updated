/**
 * GET  /api/projects         — list projects for the authenticated org
 * POST /api/projects         — create a new project
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, badRequest, forbidden, unauthorized, internalError, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { orgRepository } from '@/lib/repositories/orgRepository';
import type { CloudProvider, Region } from '@/types';

export const dynamic = 'force-dynamic';

const CreateProjectSchema = z.object({
  name:        z.string().min(1).max(120),
  provider:    z.enum(['aws', 'azure', 'multi']),
  region:      z.string().min(1),
  description: z.string().max(500).optional(),
  tags:        z.array(z.string()).optional(),
  orgId:       z.string().min(1).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    // In dev mode auto-provision org context
    let orgId = req.nextUrl.searchParams.get('orgId') ?? '';
    if (!orgId && process.env.NODE_ENV === 'development') {
      const ctx = await orgRepository.ensureDevContext();
      orgId = ctx.orgId;
    }
    if (!orgId) return badRequest('orgId query parameter is required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const projects = await projectRepository.list(orgId);
    return ok(projects);
  } catch (err) {
    console.error('[GET /api/projects]', err);
    return internalError();
  }
}

export async function POST(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const parsed = await parseBody(req, CreateProjectSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    // Resolve orgId
    let orgId = body.orgId ?? '';
    if (!orgId && process.env.NODE_ENV === 'development') {
      const ctx = await orgRepository.ensureDevContext();
      orgId = ctx.orgId;
    }
    if (!orgId) return badRequest('orgId is required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();
    if (!['owner', 'admin', 'member'].includes(role)) return forbidden('Insufficient permissions');

    const project = await projectRepository.create({
      name: body.name,
      provider: body.provider as CloudProvider,
      region: body.region as Region,
      description: body.description,
      tags: body.tags,
      orgId,
      ownerId: identity.userId,
    });
    return created(project);
  } catch (err) {
    console.error('[POST /api/projects]', err);
    return internalError();
  }
}
