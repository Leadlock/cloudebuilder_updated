/**
 * GET /api/cloud-accounts/[id]/discovery — get discovery runs for a cloud account
 *
 * Returns a list of discovery runs (most recent first) with resources and summary.
 * Credentials are NEVER included in the response.
 */
import { NextRequest } from 'next/server';
import {
  ok, notFound, forbidden, unauthorized, internalError,
} from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { discoveryRepository } from '@/lib/repositories/discoveryRepository';

export const dynamic = 'force-dynamic';

async function resolveOrgId(req: NextRequest): Promise<string> {
  const orgId = req.nextUrl.searchParams.get('orgId') ?? '';
  if (orgId) return orgId;
  if (process.env.NODE_ENV === 'development') {
    const ctx = await orgRepository.ensureDevContext();
    return ctx.orgId;
  }
  return '';
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const { id } = await ctx.params;
    const orgId = await resolveOrgId(req);
    if (!orgId) return forbidden();

    // Authorization: verify org membership
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    // Verify cloud account belongs to this org (isolation)
    const account = await cloudAccountRepository.findById(id, orgId);
    if (!account) return notFound('CloudAccount');

    // Optional: return only a single run by runId
    const runId = req.nextUrl.searchParams.get('runId');
    if (runId) {
      const run = await discoveryRepository.findById(runId);
      if (!run || run.cloudAccountId !== id) return notFound('DiscoveryRun');
      return ok(run);
    }

    // Return all runs for this account
    const runs = await discoveryRepository.findByAccount(id);
    return ok(runs);
  } catch (err) {
    console.error(
      '[GET /api/cloud-accounts/[id]/discovery]',
      err instanceof Error ? err.message : String(err),
    );
    return internalError();
  }
}
