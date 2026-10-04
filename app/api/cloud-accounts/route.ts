/**
 * GET  /api/cloud-accounts        — list org's cloud accounts (no credentials)
 * POST /api/cloud-accounts        — connect a new cloud account
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  ok, created, badRequest, forbidden, unauthorized, internalError,
} from '@/lib/api/response';
import { extractIdentity, getOrgRole, resolveOrgIds } from '@/lib/api/auth';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { authMethodOf, isAwsCredentials, type CloudCredentials } from '@/lib/cloud/types';
import { CloudCredentialsSchema, explainCredentialsProblem } from '@/lib/cloud/credentialSchemas';
import { connectionHintOf } from '@/lib/cloud/connectionHint';

export const dynamic = 'force-dynamic';

const CreateCloudAccountSchema = z.object({
  orgId:       z.string().min(1).optional(),
  provider:    z.enum(['aws', 'azure']),
  name:        z.string().min(1).max(120),
  credentials: CloudCredentialsSchema,
});

// ─── Route handlers ───────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    let orgId = req.nextUrl.searchParams.get('orgId') ?? '';
    if (!orgId) {
      const memberOrgIds = await resolveOrgIds(identity.userId);
      orgId = memberOrgIds[0] ?? '';
    }
    if (!orgId && process.env.NODE_ENV === 'development') {
      try {
        const ctx = await orgRepository.ensureDevContext();
        orgId = ctx.orgId;
      } catch {
        orgId = 'dev-org-id';
      }
    }
    if (!orgId) return badRequest('orgId query parameter is required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role) return forbidden();

    const accounts = await cloudAccountRepository.list(orgId);
    // Double-check: credentials are never included in mapAccount output
    return ok(accounts);
  } catch (err) {
    console.error('[GET /api/cloud-accounts]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function POST(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized();

    let raw: unknown;
    try { raw = await req.json(); } catch { return badRequest('Invalid JSON body'); }
    const parsed = CreateCloudAccountSchema.safeParse(raw);
    if (!parsed.success) {
      return badRequest(explainCredentialsProblem((raw as { credentials?: unknown } | null)?.credentials) ?? 'Validation failed', parsed.error.flatten());
    }
    const body = parsed.data;

    let orgId = body.orgId ?? '';
    if (!orgId) {
      const memberOrgIds = await resolveOrgIds(identity.userId);
      orgId = memberOrgIds[0] ?? '';
    }
    if (!orgId && process.env.NODE_ENV === 'development') {
      try {
        const ctx = await orgRepository.ensureDevContext();
        orgId = ctx.orgId;
      } catch {
        orgId = 'dev-org-id';
      }
    }
    if (!orgId) return badRequest('orgId is required');

    const role = await getOrgRole(identity.userId, orgId);
    if (!role || role === 'viewer') return forbidden();

    // The credentials must belong to the cloud they are saved under.
    const creds = body.credentials as CloudCredentials;
    if ((body.provider === 'aws') !== isAwsCredentials(creds)) return badRequest('The credentials do not match the selected cloud provider.');

    // Serialize credentials for storage — never log this value
    const credentialsJson = JSON.stringify(body.credentials);

    const account = await cloudAccountRepository.create({
      orgId,
      provider: body.provider,
      name: body.name,
      credentialsJson,
      identityJson: JSON.stringify({ authMethod: authMethodOf(creds), connection: connectionHintOf(creds) }),   // how it signs in and what it points at — never a secret; the list and the Edit screen show them
    });

    // account is the safe shape — credentials are not included
    return created(account);
  } catch (err) {
    console.error('[POST /api/cloud-accounts]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
