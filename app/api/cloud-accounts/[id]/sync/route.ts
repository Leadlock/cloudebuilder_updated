/**
 * POST /api/cloud-accounts/[id]/sync — detect drift/changes between live cloud and canvas architecture
 *
 * Security:
 * - Credentials are loaded server-side and never returned to the caller.
 * - Org isolation and membership authorization enforced.
 * - Read-only: does not modify or delete any cloud or canvas infrastructure.
 */
import { NextRequest } from 'next/server';
import {
  ok, notFound, forbidden, unauthorized, internalError, badRequest,
} from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { architectureRepository, toCanvas } from '@/lib/repositories/architectureRepository';
import { infrastructureSyncService } from '@/lib/cloud/sync/InfrastructureSyncService';
import type { CloudCredentials } from '@/lib/cloud/types';

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

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const { id } = await ctx.params;
    const orgId = await resolveOrgId(req);
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

    const body = await req.json().catch(() => ({}));
    const environmentId = body?.environmentId;
    if (!environmentId) {
      return badRequest('environmentId is required');
    }

    const arch = await architectureRepository.findByEnvironment(environmentId);
    if (!arch) {
      return notFound('ArchitectureEnvironment');
    }

    const { nodes } = toCanvas(arch.resources, arch.connections);
    const regions = Array.isArray(body?.regions) && body.regions.length > 0 ? body.regions : undefined;

    const { driftReport } = await infrastructureSyncService.refresh(credentials, nodes, { regions });

    return ok({
      accountId: id,
      provider: account.provider,
      scannedAt: driftReport.scannedAt,
      summary: driftReport.summary,
      items: driftReport.items,
    });
  } catch (err) {
    console.error(
      '[POST /api/cloud-accounts/[id]/sync]',
      err instanceof Error ? err.message : String(err),
    );
    return internalError();
  }
}
