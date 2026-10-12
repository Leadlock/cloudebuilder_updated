/**
 * GET  /api/projects         — list projects for the authenticated org
 * POST /api/projects         — create a new project
 */
import { devShortcutsEnabled } from '@/lib/dev/shortcuts';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, badRequest, forbidden, unauthorized, internalError, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole, resolveOrgIds } from '@/lib/api/auth';
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

import { mockProjects } from '@/lib/mockData';

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    // Prefer an explicit orgId, then the caller's own org membership — never
    // assume an unrelated caller belongs to the shared dev-mode org below.
    let orgId = req.nextUrl.searchParams.get('orgId') ?? '';
    if (!orgId) {
      const memberOrgIds = await resolveOrgIds(identity.userId);
      orgId = memberOrgIds[0] ?? '';
    }
    if (!orgId && devShortcutsEnabled()) {
      try {
        const ctx = await orgRepository.ensureDevContext();
        orgId = ctx.orgId;
      } catch {
        orgId = 'dev-org-id';
      }
    }
    if (!orgId) return badRequest('orgId query parameter is required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    try {
      const projects = await projectRepository.list(orgId);
      return ok(projects);
    } catch (dbErr) {
      console.error('[GET /api/projects] projectRepository.list failed:', dbErr instanceof Error ? dbErr.stack ?? dbErr.message : dbErr);
      if (devShortcutsEnabled()) {
        return ok(mockProjects);
      }
      throw dbErr;
    }
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

    // Resolve orgId: prefer an explicit orgId, then the caller's own org membership.
    let orgId = body.orgId ?? '';
    if (!orgId) {
      const memberOrgIds = await resolveOrgIds(identity.userId);
      orgId = memberOrgIds[0] ?? '';
    }
    if (!orgId && devShortcutsEnabled()) {
      try {
        const ctx = await orgRepository.ensureDevContext();
        orgId = ctx.orgId;
      } catch {
        orgId = 'dev-org-id';
      }
    }
    if (!orgId) return badRequest('orgId is required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();
    if (!['owner', 'admin', 'member'].includes(role)) return forbidden('Insufficient permissions');

    try {
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
    } catch (dbErr) {
      console.error('[POST /api/projects] projectRepository.create failed:', dbErr instanceof Error ? dbErr.stack ?? dbErr.message : dbErr);
      if (devShortcutsEnabled()) {
        const fallbackProject = {
          id: `proj-${Date.now()}`,
          name: body.name,
          provider: body.provider,
          region: body.region,
          description: body.description ?? '',
          tags: body.tags ?? [],
          orgId,
          ownerId: identity.userId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          environments: [],
        };
        return created(fallbackProject);
      }
      throw dbErr;
    }
  } catch (err) {
    console.error('[POST /api/projects]', err);
    return internalError();
  }
}
