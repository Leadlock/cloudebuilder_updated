/**
 * GET    /api/cloud-accounts/[id]   — get a single cloud account (no credentials)
 * PATCH  /api/cloud-accounts/[id]   — edit an account: its name and/or credentials (owner/admin only)
 * DELETE /api/cloud-accounts/[id]   — disconnect/remove a cloud account
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  ok, notFound, forbidden, unauthorized, internalError, badRequest,
} from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { credentialsExpiredResponse } from '@/lib/api/credentialErrors';
import { CloudCredentialsSchema, explainCredentialsProblem, mergeCredentialEdit } from '@/lib/cloud/credentialSchemas';
import { authMethodOf, isAwsCredentials, type CloudCredentials } from '@/lib/cloud/types';
import { connectionHintOf } from '@/lib/cloud/connectionHint';
import { lifetimeMirror } from '@/lib/cloud/credentialLifetime';

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

    return ok(account);
  } catch (err) {
    console.error('[GET /api/cloud-accounts/[id]]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

/** Same credentials regardless of key order. */
function sameCredentials(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const sorted = (o: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y))));
  return sorted(a) === sorted(b);
}

const EditSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  // Only the fields to change. A blank value keeps the current one (except externalId, where blank removes it).
  credentials: z.record(z.string(), z.string().max(2048).nullable()).optional(),
}).strict().refine((b) => b.name !== undefined || b.credentials !== undefined, { message: 'Send a name or credentials to change.' });

/**
 * Edit an account. Credentials are write-only: this never returns them, and a secret left blank keeps the stored one. The edited
 * credentials replace the old ones only if the result is a complete, valid set for the account's cloud; the account is then
 * "pending" until it is checked again. Only an owner or admin may do this — it changes what the organisation's Terraform runs against.
 */
export async function PATCH(
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
    if (!['owner', 'admin'].includes(role)) return forbidden('Only owners and admins can edit cloud accounts');

    const account = await cloudAccountRepository.findById(id, orgId);
    if (!account) return notFound('CloudAccount');

    let raw: unknown;
    try { raw = await req.json(); } catch { return badRequest('Invalid JSON body'); }
    const parsed = EditSchema.safeParse(raw);
    if (!parsed.success) return badRequest(parsed.error.issues.map((i) => i.message).join('; ') || 'Validation failed');
    const { name, credentials: patch } = parsed.data;

    let credentialsJson: string | undefined;
    let identityJson: string | undefined;
    if (patch) {
      const storedJson = await cloudAccountRepository.getCredentials(id, orgId);
      if (!storedJson) return notFound('CloudAccount credentials');
      let stored: Record<string, unknown>;
      try { stored = JSON.parse(storedJson) as Record<string, unknown>; } catch { return internalError('Stored credentials are malformed'); }

      const merged = mergeCredentialEdit(stored, patch);
      const checked = CloudCredentialsSchema.safeParse(merged);
      if (!checked.success) return badRequest(explainCredentialsProblem(merged) ?? 'The edited credentials are not valid.');
      const creds = checked.data as CloudCredentials;
      if ((account.provider === 'aws') !== isAwsCredentials(creds)) return badRequest('The credentials do not match this account\'s cloud provider.');

      // Nothing actually changed (for example only blanks were sent): leave the stored credentials and the last check as they are.
      if (!sameCredentials(stored, merged)) {
        credentialsJson = JSON.stringify(checked.data);     // never logged, never returned
        identityJson = JSON.stringify({ authMethod: authMethodOf(creds), connection: connectionHintOf(creds), ...lifetimeMirror(creds) });   // the old check result no longer applies
      }
    }

    const updated = await cloudAccountRepository.update(id, orgId, { name, credentialsJson, identityJson });
    if (!updated) return notFound('CloudAccount');
    console.info(`[cloud-account] edited ${id} in org ${orgId} by user ${identity.userId}${credentialsJson ? ' (credentials changed)' : ''}`);   // ids only, never credentials
    return ok(updated);
  } catch (err) {
    console.error('[PATCH /api/cloud-accounts/[id]]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function DELETE(
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
    if (!['owner', 'admin'].includes(role)) return forbidden('Only owners and admins can remove cloud accounts');

    const deleted = await cloudAccountRepository.delete(id, orgId);
    if (!deleted) return notFound('CloudAccount');
    console.info(`[cloud-account] removed ${id} from org ${orgId} by user ${identity.userId}`);   // ids only, never credentials

    return ok({ deleted: true });
  } catch (err) {
    const expired = credentialsExpiredResponse(err);
    if (expired) return expired;
    console.error('[DELETE /api/cloud-accounts/[id]]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
