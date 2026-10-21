/**
 * Authenticates a request that carries an API key. Every failure (no key, a malformed one, an unknown one, a revoked or expired one) gets the same
 * 401, so a caller learns nothing about which keys exist. Failed attempts are limited per address; a working key is limited per key.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { apiError, tooManyRequests } from '@/lib/api/response';
import { checkRateLimit } from '@/lib/api/rateLimit';
import { clientIp } from '@/lib/api/authRateLimit';
import { hashKey, keyFromHeaders, keyUsable, type ApiKeyRecord } from './keys';
import type { PgApiKeyStore } from './store';

export const FAILED_PER_MINUTE = 30;
export const REQUESTS_PER_MINUTE = 120;

export type KeyAuth = { ok: true; key: ApiKeyRecord } | { ok: false; response: NextResponse };

const unauthorized = () => apiError('UNAUTHORIZED', 'A valid API key is required.', 401);

export async function authenticateApiKey(req: NextRequest, scope: string, store: Pick<PgApiKeyStore, 'findByHash' | 'touch'>): Promise<KeyAuth> {
  const ip = clientIp(req);
  // Failed attempts are counted before the lookup, so guessing is limited whether or not a key exists.
  const found = keyFromHeaders(req.headers);
  const record = found ? await store.findByHash(hashKey(found)) : null;
  if (!record || !keyUsable(record) || record.scope !== scope) {
    const rl = await checkRateLimit(`apikey-fail:${ip}`, FAILED_PER_MINUTE, 60_000);
    return { ok: false, response: rl.allowed ? unauthorized() : tooManyRequests(rl.retryAfterSeconds) };
  }
  const rl = await checkRateLimit(`apikey:${record.id}`, REQUESTS_PER_MINUTE, 60_000);
  if (!rl.allowed) return { ok: false, response: tooManyRequests(rl.retryAfterSeconds) };
  void store.touch(record.id).catch(() => undefined);
  return { ok: true, key: record };
}
