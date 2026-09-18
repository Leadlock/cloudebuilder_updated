import { NextRequest } from 'next/server';
import { ok, unauthorized, forbidden, internalError } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { orgRepository } from '@/lib/repositories/orgRepository';

export const dynamic = 'force-dynamic';

/**
 * Lists members of the caller's own org — NOT every user in the system.
 * Scoped this way (rather than a global user list) so one org can never see
 * another org's membership.
 */
export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized('Authentication required');

    if (identity.role !== 'admin') {
      return forbidden('Access denied. Administrator role required.');
    }

    const orgId = identity.orgIds[0];
    if (!orgId) return ok({ users: [] });

    const members = await orgRepository.listOrgMembers(orgId);
    return ok({ users: members });
  } catch (err) {
    console.error('[GET /api/admin/users]', err);
    return internalError();
  }
}
