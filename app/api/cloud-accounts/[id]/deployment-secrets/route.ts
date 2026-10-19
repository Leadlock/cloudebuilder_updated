/**
 * GET /api/cloud-accounts/[id]/deployment-secrets — the database / admin passwords CloudBuilder generated for this account's
 * deployments, so an owner or admin can connect to what was created. Passwords the operator set in the server environment are not
 * included (CloudBuilder does not hold them). Never cached; every read is logged (who and which account, never the values).
 */
import { refuseRestrictedFeature } from '@/lib/api/restrictedFeatureGuard';
import { NextRequest, NextResponse } from 'next/server';
import { ok, notFound, forbidden, unauthorized, internalError } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { generatedSecretsFor } from '@/lib/terraform/execution/deploymentSecrets';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<Record<string, string>> }) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const closed = refuseRestrictedFeature(identity.email);
    if (closed) return closed;

    const { id } = await ctx.params;
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return forbidden();
    const role = await getOrgRole(identity.userId, orgId);
    if (role !== 'owner' && role !== 'admin') return forbidden('Only owners and admins can read deployment passwords');

    if (!(await cloudAccountRepository.belongsToOrg(id, orgId))) return notFound('CloudAccount');

    const secrets = await generatedSecretsFor(orgId, id);
    console.info(`[deployment-secrets] read for account ${id} in org ${orgId} by user ${identity.userId}`);
    const res: NextResponse = ok({ secrets });
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (err) {
    console.error('[GET /api/cloud-accounts/[id]/deployment-secrets]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
