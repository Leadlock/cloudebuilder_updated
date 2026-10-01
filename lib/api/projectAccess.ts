/**
 * "May this caller touch this project?" — the check every project-scoped route must make.
 *
 * A project id in a URL proves nothing: anyone can paste any id. The caller must belong to the organisation that OWNS the
 * project, and an administrative action needs an owner/admin role IN THAT organisation (not merely the `admin` flag the
 * session carries, which every self-registered user gets for their own new organisation).
 */
import type { NextRequest, NextResponse } from 'next/server';
import { badRequest, forbidden, notFound } from '@/lib/api/response';
import { getOrgRole } from '@/lib/api/auth';
import { resolveOrgId, resolveArchitecture } from '@/lib/api/phase2d';

const ADMIN_ROLES = new Set(['owner', 'admin']);

export interface ProjectAccess { orgId: string; role: string }

/** Returns the caller's organisation and role, or the HTTP response to send instead (400 / 403 / 404). */
export async function requireProjectAccess(
  req: NextRequest,
  userId: string,
  projectId: string,
  options: { adminOnly?: boolean } = {},
): Promise<ProjectAccess | { response: NextResponse }> {
  const orgId = await resolveOrgId(req, userId);
  if (!orgId) return { response: badRequest('orgId required') };
  const role = await getOrgRole(userId, orgId);
  if (!role) return { response: forbidden('You are not a member of this organization.') };
  if (options.adminOnly && !ADMIN_ROLES.has(role)) return { response: forbidden('Only an owner or admin of the organization can do this.') };
  // The project must belong to THIS organisation. "Not found" rather than "forbidden", so ids of other orgs' projects are not confirmed.
  const ctx = await resolveArchitecture(projectId, orgId, 'production');
  if ('error' in ctx && ctx.error === 'project_not_found') return { response: notFound('Project') };
  return { orgId, role };
}
