/**
 * GET  /api/cloud-accounts        — list org's cloud accounts (no credentials)
 * POST /api/cloud-accounts        — connect a new cloud account
 */
import { devShortcutsEnabled } from '@/lib/dev/shortcuts';
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
import { lifetimeFromRequest } from '@/lib/cloud/credentialLifetime';

export const dynamic = 'force-dynamic';

const CreateCloudAccountSchema = z.object({
  orgId:       z.string().min(1).optional(),
  provider:    z.enum(['aws', 'azure']),
  name:        z.string().min(1).max(120),
  credentials: CloudCredentialsSchema,
  /** How long CloudCraft may keep this key, and whether to forget it after a deployment. Turned into a deadline here, by the server's clock. */
  lifetime: z.object({
    hours: z.number().positive().max(24 * 30).nullable().optional(),
    forgetAfterDeploy: z.boolean().optional(),
  }).strict().optional(),
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
    if (!orgId && devShortcutsEnabled()) {
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

    await cloudAccountRepository.expireDue(orgId).catch(() => 0);     // credentials past their time are erased before anyone sees the list
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
    if (!orgId && devShortcutsEnabled()) {
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

    // The deadline is decided here, not by the browser: any expiry the request carried inside the credentials is discarded.
    const { expiresAt: _ignoredExpiry, forgetAfterDeploy: _ignoredForget, ...sent } = body.credentials as Record<string, unknown>;
    void _ignoredExpiry; void _ignoredForget;
    const temporary = typeof sent['accessKeyId'] === 'string' && sent['accessKeyId'].startsWith('ASIA');
    if (temporary && !(body.lifetime?.hours && body.lifetime.hours > 0)) {
      return badRequest('These are temporary credentials: say how long they are valid for, so CloudCraft stops using them when AWS does.');
    }
    if (temporary && (body.lifetime?.hours ?? 0) > 36) return badRequest('AWS temporary credentials last at most 36 hours.');
    const lifetime = lifetimeFromRequest(body.lifetime, temporary);
    const stored: Record<string, unknown> = { ...sent, ...(lifetime.expiresAt ? { expiresAt: lifetime.expiresAt } : {}), ...(lifetime.forgetAfterDeploy ? { forgetAfterDeploy: true } : {}) };
    if (CloudCredentialsSchema.safeParse(stored).success !== true) return badRequest('The credentials are not valid.');

    // Serialize credentials for storage — never log this value
    const credentialsJson = JSON.stringify(stored);

    const account = await cloudAccountRepository.create({
      orgId,
      provider: body.provider,
      name: body.name,
      credentialsJson,
      identityJson: JSON.stringify({ authMethod: authMethodOf(stored as unknown as CloudCredentials), connection: connectionHintOf(stored as unknown as CloudCredentials), ...(Object.keys(lifetime).length > 0 ? { lifetime } : {}) }),   // how it signs in and what it points at — never a secret; the list and the Edit screen show them
    });

    // account is the safe shape — credentials are not included
    return created(account);
  } catch (err) {
    console.error('[POST /api/cloud-accounts]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
