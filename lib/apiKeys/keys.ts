/**
 * Read-only API keys. A key is `cb_` and 43 random characters (256 bits). Only its SHA-256 hash is stored: a key with that much randomness cannot be
 * guessed from its hash, so no slow hash is needed, and a lookup by hash needs no comparison that could leak timing.
 */
import { createHash, randomBytes } from 'crypto';

export const KEY_PREFIX = 'cb_';
/** What a key may do. One scope for now: read the organization's architecture templates. */
export const SCOPE_TEMPLATES_READ = 'templates:read';
export const MAX_KEYS_PER_ORG = 20;
export const MAX_KEY_DAYS = 365;

export function generateKey(): { key: string; prefix: string; hash: string } {
  const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, KEY_PREFIX.length + 6), hash: hashKey(key) };
}

export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

const SHAPE = /^cb_[A-Za-z0-9_-]{43}$/;
export const looksLikeKey = (s: string): boolean => SHAPE.test(s);

/** The key a request carries: `Authorization: Bearer cb_…` or `X-API-Key: cb_…`. Null when there is none, or it cannot be one of ours (nothing is looked up for it). */
export function keyFromHeaders(h: { get(name: string): string | null }): string | null {
  const auth = h.get('authorization');
  const bearer = auth && /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : null;
  const candidate = bearer?.startsWith(KEY_PREFIX) ? bearer : h.get('x-api-key')?.trim() ?? null;
  return candidate && looksLikeKey(candidate) ? candidate : null;
}

export interface ApiKeyRecord {
  id: string; orgId: string; name: string; keyPrefix: string; scope: string; includeBuiltin: boolean; includeOwn: boolean;
  createdBy: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null;
}

/** Whether a key may be used now: not revoked, not past its end date. */
export function keyUsable(k: Pick<ApiKeyRecord, 'revokedAt' | 'expiresAt'>, now = Date.now()): boolean {
  if (k.revokedAt) return false;
  if (k.expiresAt && Date.parse(k.expiresAt) <= now) return false;
  return true;
}
