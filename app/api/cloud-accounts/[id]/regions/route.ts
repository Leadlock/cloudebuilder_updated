/**
 * GET /api/cloud-accounts/[id]/regions — discover accessible regions for a cloud account
 *
 * Security:
 * - Credentials are loaded server-side and never returned to the caller.
 * - Org isolation and membership authorization enforced.
 */
import { NextRequest } from 'next/server';
import {
  ok, notFound, forbidden, unauthorized, internalError,
} from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { credentialsExpiredResponse } from '@/lib/api/credentialErrors';
import { createDiscoveryProvider } from '@/lib/cloud/provider';
import type { CloudCredentials } from '@/lib/cloud/types';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const { id } = await ctx.params;
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return forbidden();

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const account = await cloudAccountRepository.findById(id, orgId);
    if (!account) return notFound('CloudAccount');

    const credentialsJson = await cloudAccountRepository.getCredentials(id, orgId);
    if (!credentialsJson) return notFound('CloudAccount credentials');

    let credentials: CloudCredentials;
    try {
      credentials = JSON.parse(credentialsJson) as CloudCredentials;
    } catch {
      return internalError('Stored credentials are malformed');
    }

    const provider = await createDiscoveryProvider(credentials);
    try {
      let regions: string[] = [];
      if (typeof provider.discoverRegions === 'function') {
        regions = await provider.discoverRegions();
      } else {
        const baseRegion = 'region' in credentials ? credentials.region : 'eastus';
        regions = [baseRegion];
      }
      return ok({ regions, provider: account.provider });
    } finally {
      await provider.dispose();
    }
  } catch (err) {
    const expired = credentialsExpiredResponse(err);
    if (expired) return expired;
    console.error(
      '[GET /api/cloud-accounts/[id]/regions]',
      err instanceof Error ? err.message : String(err),
    );
    return internalError();
  }
}
