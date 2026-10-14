/**
 * GET  /api/cloud-accounts/encryption — how this organisation's stored credentials are protected (which key, how many are on the
 *                                       current key, whether the configured key is acceptable). No secrets.
 * POST /api/cloud-accounts/encryption
 *   { action: 'reencrypt' }  re-encrypt this organisation's credentials with the ACTIVE key (after the key was changed in the server
 *                            environment, or to upgrade the older format)
 *   { action: 'generate' }   a new random key to put in ENCRYPTION_KEY. It is only returned here, never stored.
 *
 * Only an owner or admin. The active key itself lives in the server environment (ENCRYPTION_KEY) and is changed there: a web page
 * must not be able to change what protects every stored secret.
 */
import { refuseRestrictedFeature } from '@/lib/api/restrictedFeatureGuard';
import { NextRequest } from 'next/server';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { ok, forbidden, unauthorized, internalError, badRequest } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { cloudAccountRepository, credentialContext } from '@/lib/repositories/cloudAccountRepository';
import { assessEncryptionKey, loadKeyring } from '@/lib/crypto/credentials';
import { rotateCredentials, type RotationRepo } from '@/lib/crypto/rotateCredentials';

export const dynamic = 'force-dynamic';

const Body = z.object({ action: z.enum(['reencrypt', 'generate']) }).strict();

async function authorize(req: NextRequest): Promise<{ orgId: string; userId: string } | Response> {
  const identity = extractIdentity(req);
  if (!identity) return unauthorized();
  const closed = refuseRestrictedFeature(identity.email);
  if (closed) return closed;
  const orgId = await resolveOrgId(req, identity.userId);
  if (!orgId) return forbidden();
  const role = await getOrgRole(identity.userId, orgId);
  if (role !== 'owner' && role !== 'admin') return forbidden('Only owners and admins can manage credential encryption');
  return { orgId, userId: identity.userId };
}

/** Only this organisation's credentials: another organisation's are never read, counted or changed from here. */
function orgRepo(orgId: string): RotationRepo {
  return {
    listForRotation: async () => (await cloudAccountRepository.listForRotation(orgId)).filter((r) => r.orgId === orgId),
    replaceEncrypted: (id, org, json) => cloudAccountRepository.replaceEncrypted(id, org, json),
  };
}

export async function GET(req: NextRequest) {
  try {
    const who = await authorize(req);
    if (who instanceof Response) return who;

    const production = process.env['NODE_ENV'] === 'production';
    const verdict = assessEncryptionKey(process.env['ENCRYPTION_KEY'], production);
    let keyId: string | null = null;
    let previousKeys = 0;
    try { const ring = loadKeyring(); keyId = ring.active.id; previousKeys = ring.all.length - 1; } catch { /* reported through `problem` */ }

    const report = keyId ? await rotateCredentials(orgRepo(who.orgId), { dryRun: true, contextOf: credentialContext }) : null;
    return ok({
      activeKeyId: keyId,
      previousKeys,
      problem: verdict.ok ? null : `ENCRYPTION_KEY ${verdict.problem}.`,
      warning: verdict.ok ? verdict.warning ?? null : null,
      total: report?.total ?? 0,
      onActiveKey: report?.alreadyCurrent ?? 0,
      needsReencrypt: report?.rotated ?? 0,
      cannotOpen: report?.failed.length ?? 0,
      cannotOpenReasons: [...new Set((report?.failed ?? []).map((f) => f.reason))],
    });
  } catch (err) {
    console.error('[GET /api/cloud-accounts/encryption]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function POST(req: NextRequest) {
  try {
    const who = await authorize(req);
    if (who instanceof Response) return who;

    let raw: unknown;
    try { raw = await req.json(); } catch { return badRequest('Invalid JSON body'); }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) return badRequest('Choose an action: reencrypt or generate.');

    if (parsed.data.action === 'generate') {
      console.info(`[credential-encryption] new key generated for org ${who.orgId} by user ${who.userId}`);   // the key itself is never logged
      return ok({ key: randomBytes(32).toString('hex') });
    }

    const report = await rotateCredentials(orgRepo(who.orgId), { contextOf: credentialContext });
    console.info(`[credential-encryption] re-encrypted ${report.rotated} credential(s) in org ${who.orgId} by user ${who.userId}; ${report.failed.length} could not be opened`);
    return ok({ rotated: report.rotated, alreadyCurrent: report.alreadyCurrent, cannotOpen: report.failed.length, cannotOpenReasons: [...new Set(report.failed.map((f) => f.reason))] });
  } catch (err) {
    console.error('[POST /api/cloud-accounts/encryption]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
