/**
 * Shared store (rate limits + revoked sessions) against a REAL PostgreSQL — the properties that unit tests with an in-memory
 * database cannot prove, above all that the rate-limit upsert is atomic under genuinely concurrent requests.
 *
 * Runs via:  node --experimental-vm-modules node_modules/.bin/jest --config jest.integration.mjs integration/sharedStore
 * Needs the tables from migration 20261003T1807_add_shared_store (`npm run db:update`); skips itself if they are missing.
 * Uses unique keys and removes its own rows.
 */
import * as dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '.env') });

import { Client } from 'pg';

const url = process.env['DATABASE_URL'];
const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
let ready = false;
let admin: Client;

beforeAll(async () => {
  if (!url) return;
  process.env['CLOUDCRAFT_SHARED_STORE'] = 'db';
  admin = new Client({ connectionString: url });
  await admin.connect();
  const r = await admin.query(`SELECT to_regclass('"public"."rateLimitBucket"') IS NOT NULL AND to_regclass('"public"."revokedSession"') IS NOT NULL AS ok`);
  ready = r.rows[0]?.ok === true;
  if (!ready) console.warn('[sharedStore integration] tables not found — run `npm run db:update` first; skipping');
});

afterAll(async () => {
  if (admin) {
    if (ready) {
      await admin.query(`DELETE FROM "rateLimitBucket" WHERE "key" LIKE $1`, [`it-${run}%`]);
      await admin.query(`DELETE FROM "revokedSession" WHERE "id" LIKE $1 OR "userId" LIKE $1`, [`%it-${run}%`]);
    }
    await admin.end();
  }
  const { sharedDb } = await import('@/lib/api/sharedStore');
  await (sharedDb() as unknown as { end(): Promise<void> }).end?.();
});

const maybe = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!ready) return; await fn(); });

describe('rate limit on real Postgres', () => {
  maybe('under real concurrency exactly `limit` of N simultaneous requests are allowed (no lost or double counts)', async () => {
    const { checkRateLimit } = await import('@/lib/api/rateLimit');
    const key = `it-${run}-concurrent`;
    const results = await Promise.all(Array.from({ length: 40 }, () => checkRateLimit(key, 10, 60_000)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed)).toHaveLength(30);
    expect(results.filter((r) => !r.allowed).every((r) => (r.retryAfterSeconds ?? 0) > 0)).toBe(true);
  });

  maybe('a new window starts once the old one is over, and peek/reset agree with check', async () => {
    const { checkRateLimit, peekRateLimit, resetRateLimit } = await import('@/lib/api/rateLimit');
    const key = `it-${run}-window`;
    expect((await checkRateLimit(key, 1, 1_000)).allowed).toBe(true);
    expect((await checkRateLimit(key, 1, 1_000)).allowed).toBe(false);
    expect((await peekRateLimit(key, 1, 1_000)).remaining).toBe(0);
    await new Promise((r) => setTimeout(r, 1_200));
    expect((await peekRateLimit(key, 1, 1_000)).remaining).toBe(1);
    expect((await checkRateLimit(key, 1, 1_000)).allowed).toBe(true);
    await resetRateLimit(key);
    expect((await peekRateLimit(key, 1, 1_000)).used).toBe(0);
  });
});

describe('revoked sessions on real Postgres', () => {
  maybe('a revoked token and a user cutoff are stored once, pulled by other instances, and expired rows are not returned', async () => {
    const { saveTokenRevocation, saveUserRevocation, pullRevocations } = await import('@/lib/api/revocationStore');
    const id = `it-${run}-tok`; const userId = `it-${run}-user`;
    await saveTokenRevocation(id, Date.now() + 60_000);
    await saveTokenRevocation(id, Date.now() + 60_000);                       // saving twice is harmless
    await saveUserRevocation(userId, 60_000);
    await admin.query(`INSERT INTO "revokedSession" ("id", "kind", "userId", "revokedAtMs", "expiresAtMs") VALUES ($1, 'token', NULL, extract(epoch from now()) * 1000, extract(epoch from now()) * 1000 - 5000)`, [`it-${run}-expired`]);
    const pulled = await pullRevocations(0);
    expect(pulled.tokens.filter((t) => t.id === id)).toHaveLength(1);
    expect(pulled.tokens.some((t) => t.id === `it-${run}-expired`)).toBe(false);
    expect(pulled.users.some((u) => u.userId === userId)).toBe(true);
    const later = await pullRevocations(pulled.nowMs + 1_000);               // nothing newer
    expect(later.tokens.some((t) => t.id === id)).toBe(false);
  });
});
