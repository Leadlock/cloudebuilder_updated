/**
 * GET /api/cloud-accounts/server-identity — which AWS identity is the CloudCraft server running as?
 *
 * The connect-account screen uses it to say, before anything is typed, whether the server can assume customer roles at all, and
 * which identity the role's trust policy has to name. Returns the account id and the identity's ARN, or why there is none.
 * Anyone who may connect an account (not a viewer) can ask. ?fresh=1 skips the 60-second cache (the "Check again" button).
 */
import { NextRequest } from 'next/server';
import { ok, forbidden, unauthorized, badRequest, internalError } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { getServerAwsIdentity } from '@/lib/cloud/serverIdentity';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return badRequest('orgId required');
    const role = await getOrgRole(identity.userId, orgId);
    if (!role || role === 'viewer') return forbidden();

    return ok(await getServerAwsIdentity({ fresh: req.nextUrl.searchParams.get('fresh') === '1' }));
  } catch (err) {
    console.error('[GET /api/cloud-accounts/server-identity]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
