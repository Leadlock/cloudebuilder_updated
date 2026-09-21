/**
 * POST /api/cloud-accounts/[id]/validate — validate a cloud account connection
 *
 * Security:
 * - Credentials are loaded server-side from DB; never passed through request body.
 * - Validation result returned to client contains identity info only (no credentials).
 * - Org membership is checked before any credential access.
 */
import { NextRequest } from 'next/server';
import {
  ok, notFound, forbidden, unauthorized, internalError,
} from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { createDiscoveryProvider } from '@/lib/cloud/provider';
import type { CloudCredentials } from '@/lib/cloud/types';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    const { id } = await ctx.params;
    const orgId = await resolveOrgId(req, identity.userId);
    if (!orgId) return forbidden();

    // Authorization: verify org membership before accessing credentials
    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    // Verify account belongs to this org
    const account = await cloudAccountRepository.findById(id, orgId);
    if (!account) return notFound('CloudAccount');

    // Load credentials server-side — never returned to client
    const credentialsJson = await cloudAccountRepository.getCredentials(id, orgId);
    if (!credentialsJson) return notFound('CloudAccount credentials');

    let credentials: CloudCredentials;
    try {
      credentials = JSON.parse(credentialsJson) as CloudCredentials;
    } catch {
      return internalError('Stored credentials are malformed');
    }

    // Perform validation via provider adapter
    const provider = await createDiscoveryProvider(credentials);
    let validationResult;
    try {
      validationResult = await provider.validateAccount();
    } finally {
      await provider.dispose();
    }

    // Persist validation outcome (status + identity, no credentials)
    const newStatus = validationResult.valid ? 'active' : 'invalid';
    const identityJson = validationResult.identity
      ? JSON.stringify(validationResult.identity)
      : '{}';

    await cloudAccountRepository.updateStatus(id, orgId, newStatus, identityJson);

    // Return sanitised validation result — no credentials included
    return ok({
      valid: validationResult.valid,
      identity: validationResult.identity ?? null,
      permissionsOk: validationResult.permissionsOk,
      missingPermissions: validationResult.missingPermissions,
      error: validationResult.error ?? null,
    });
  } catch (err) {
    console.error(
      '[POST /api/cloud-accounts/[id]/validate]',
      err instanceof Error ? err.message : String(err),
    );
    return internalError();
  }
}
