/**
 * POST /api/cloud-accounts/[id]/validate — validate a cloud account connection
 *
 * Security:
 * - Credentials are loaded server-side from DB; never passed through request body.
 * - Validation result returned to client contains identity info only (no credentials).
 * - Org membership is checked before any credential access.
 */
import { refuseRestrictedFeature } from '@/lib/api/restrictedFeatureGuard';
import { NextRequest } from 'next/server';
import {
  ok, notFound, forbidden, unauthorized, internalError,
} from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { credentialsExpiredResponse } from '@/lib/api/credentialErrors';
import { createDiscoveryProvider } from '@/lib/cloud/provider';
import { authMethodOf, type CloudCredentials } from '@/lib/cloud/types';
import { connectionHintOf } from '@/lib/cloud/connectionHint';
import { lifetimeMirror } from '@/lib/cloud/credentialLifetime';
import { explainValidationFailure } from '@/lib/cloud/validationExplain';
import { getServerAwsIdentity } from '@/lib/cloud/serverIdentity';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();
    const closed = refuseRestrictedFeature(identity.email);
    if (closed) return closed;

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
    // When it fails, keep the reason (in plain words) with the account so the list can show it without checking again.
    const why = validationResult.valid ? null : explainValidationFailure(account.provider, validationResult.error, validationResult.missingPermissions ?? [], authMethodOf(credentials));
    if (why && authMethodOf(credentials) === 'role' && /refused to let CloudBuilder assume/i.test(why.reason)) {
      // The usual cause is a trust policy that names a different identity — so say which one the server really is.
      const server = await getServerAwsIdentity();
      if (server.configured) why.fix += ` The CloudBuilder server is signed in as ${server.arn} — the role must trust that identity.`;
    }
    const identityJson = JSON.stringify({
      ...(validationResult.identity ?? {}),
      authMethod: authMethodOf(credentials),
      connection: connectionHintOf(credentials),
      ...lifetimeMirror(credentials),
      ...(why ? { validationReason: why.reason, validationFix: why.fix } : {}),
    });

    await cloudAccountRepository.updateStatus(id, orgId, newStatus, identityJson);

    // Return sanitised validation result — no credentials included
    return ok({
      valid: validationResult.valid,
      identity: validationResult.identity ?? null,
      permissionsOk: validationResult.permissionsOk,
      missingPermissions: validationResult.missingPermissions,
      error: validationResult.error ?? null,
      reason: why?.reason ?? null,
      fix: why?.fix ?? null,
    });
  } catch (err) {
    const expired = credentialsExpiredResponse(err);
    if (expired) return expired;
    console.error(
      '[POST /api/cloud-accounts/[id]/validate]',
      err instanceof Error ? err.message : String(err),
    );
    return internalError();
  }
}
