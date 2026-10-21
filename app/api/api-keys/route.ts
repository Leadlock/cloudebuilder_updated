/**
 * /api/api-keys — the read-only API keys of the caller's organization. Administrators and owners only.
 *
 * GET  — the keys (name, first characters, what each may see, when it was last used, whether it is revoked). Never a key.
 * POST — make a key: { name, includeBuiltin?, includeOwn?, expiresInDays? }. The key is in the answer ONCE; only its hash is kept.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, forbidden, unauthorized, internalError, badRequest, parseBody } from '@/lib/api/response';
import { extractIdentity, getOrgRole } from '@/lib/api/auth';
import { resolveOrgId } from '@/lib/api/phase2d';
import { generateKey, MAX_KEY_DAYS, MAX_KEYS_PER_ORG, SCOPE_TEMPLATES_READ } from '@/lib/apiKeys/keys';
import { PgApiKeyStore } from '@/lib/apiKeys/store';

export const dynamic = 'force-dynamic';

const store = new PgApiKeyStore();
const ADMIN = new Set(['owner', 'admin']);
const Body = z.object({
  name: z.string().trim().min(1).max(80),
  includeBuiltin: z.boolean().default(true),
  includeOwn: z.boolean().default(true),
  expiresInDays: z.number().int().min(1).max(MAX_KEY_DAYS).optional(),
}).refine((b) => b.includeBuiltin || b.includeOwn, { message: 'Choose at least one kind of template for the key to read.' });

async function admin(req: NextRequest) {
  const identity = extractIdentity(req);
  if (!identity) return { response: unauthorized() };
  const orgId = await resolveOrgId(req, identity.userId);
  if (!orgId) return { response: badRequest('orgId required') };
  const role = await getOrgRole(identity.userId, orgId);
  if (!role || !ADMIN.has(role)) return { response: forbidden('Only an administrator can manage API keys.') };
  return { identity, orgId };
}

export async function GET(req: NextRequest) {
  try {
    const a = await admin(req);
    if ('response' in a) return a.response;
    return ok({ keys: await store.list(a.orgId) });
  } catch (err) {
    console.error('[GET api-keys]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}

export async function POST(req: NextRequest) {
  try {
    const a = await admin(req);
    if ('response' in a) return a.response;
    const parsed = await parseBody(req, Body);
    if (!parsed.ok) return parsed.response;
    if ((await store.countActive(a.orgId)) >= MAX_KEYS_PER_ORG) return badRequest(`An organization can have ${MAX_KEYS_PER_ORG} active keys. Revoke one first.`);
    const k = generateKey();
    const expiresAt = parsed.data.expiresInDays ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000).toISOString() : null;
    const record = await store.create({
      orgId: a.orgId, name: parsed.data.name, prefix: k.prefix, hash: k.hash, scope: SCOPE_TEMPLATES_READ,
      includeBuiltin: parsed.data.includeBuiltin, includeOwn: parsed.data.includeOwn, createdBy: a.identity.email ?? a.identity.userId, expiresAt,
    });
    const res = created({ key: k.key, record });
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (err) {
    console.error('[POST api-keys]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
