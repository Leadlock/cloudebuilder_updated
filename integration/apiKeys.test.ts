/**
 * API keys against a REAL PostgreSQL: only a hash is stored, a key is found by its hash, one organization sees only its own keys and cannot revoke
 * another's, a revoked key stays listed, and a use is noted at most once a minute.
 *
 * Runs via:  node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.integration.mjs integration/apiKeys
 * Needs the table from migration add_api_keys (`npm run db:migrate`); skips itself if it is missing.
 */
import * as dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '.env') });

import { Client } from 'pg';

const url = process.env['DATABASE_URL'];
const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const orgA = `it-${run}-a`; const orgB = `it-${run}-b`;
let ready = false; let admin: Client;

beforeAll(async () => {
  if (!url) return;
  admin = new Client({ connectionString: url });
  await admin.connect();
  ready = (await admin.query(`SELECT to_regclass('"public"."apiKey"') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  if (!ready) console.warn('[api keys integration] table not found — run `npm run db:migrate` first; skipping');
});
afterAll(async () => {
  if (admin) { if (ready) await admin.query(`DELETE FROM "apiKey" WHERE "orgId" = ANY($1)`, [[orgA, orgB]]); await admin.end(); }
  const { sharedDb } = await import('@/lib/api/sharedStore');
  await (sharedDb() as unknown as { end(): Promise<void> }).end?.();
});
const maybe = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!ready) return; await fn(); });

describe('API keys on real Postgres', () => {
  maybe('a key is stored as its hash, found by that hash, and never by the key', async () => {
    const { PgApiKeyStore } = await import('@/lib/apiKeys/store');
    const { generateKey } = await import('@/lib/apiKeys/keys');
    const store = new PgApiKeyStore();
    const k = generateKey();
    const rec = await store.create({ orgId: orgA, name: 'Marketplace', prefix: k.prefix, hash: k.hash, scope: 'templates:read', includeBuiltin: true, includeOwn: false, createdBy: 'a@x.com', expiresAt: null });
    expect(rec).toMatchObject({ orgId: orgA, name: 'Marketplace', keyPrefix: k.prefix, includeBuiltin: true, includeOwn: false, revokedAt: null });
    expect((await store.findByHash(k.hash))?.id).toBe(rec.id);
    expect(await store.findByHash(k.key)).toBeNull();
    const raw = await admin.query(`SELECT * FROM "apiKey" WHERE "id" = $1`, [rec.id]);
    expect(JSON.stringify(raw.rows[0])).not.toContain(k.key);
    await expect(store.create({ orgId: orgA, name: 'dup', prefix: k.prefix, hash: k.hash, scope: 'templates:read', includeBuiltin: true, includeOwn: true, createdBy: 'a', expiresAt: null })).rejects.toThrow();   // a hash is unique
  });

  maybe('an organization lists only its own keys and cannot revoke another\'s; a revoked key stays listed', async () => {
    const { PgApiKeyStore } = await import('@/lib/apiKeys/store');
    const { generateKey } = await import('@/lib/apiKeys/keys');
    const store = new PgApiKeyStore();
    const b = generateKey();
    const recB = await store.create({ orgId: orgB, name: 'Theirs', prefix: b.prefix, hash: b.hash, scope: 'templates:read', includeBuiltin: true, includeOwn: true, createdBy: 'b@x.com', expiresAt: null });
    const [aKey] = await store.list(orgA);
    expect((await store.list(orgA)).some((x) => x.id === recB.id)).toBe(false);
    expect(await store.revoke(orgA, recB.id)).toBe(false);                 // not this organization's
    expect((await store.findByHash(b.hash))?.revokedAt).toBeNull();
    expect(await store.countActive(orgA)).toBe(1);
    expect(await store.revoke(orgA, aKey!.id)).toBe(true);
    expect(await store.revoke(orgA, aKey!.id)).toBe(false);                // already revoked
    expect(await store.countActive(orgA)).toBe(0);
    const listed = await store.list(orgA);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.revokedAt).not.toBeNull();
  });

  maybe('a use is noted, but not again within a minute', async () => {
    const { PgApiKeyStore } = await import('@/lib/apiKeys/store');
    const { generateKey } = await import('@/lib/apiKeys/keys');
    const store = new PgApiKeyStore();
    const k = generateKey();
    const rec = await store.create({ orgId: orgA, name: 'Used', prefix: k.prefix, hash: k.hash, scope: 'templates:read', includeBuiltin: true, includeOwn: true, createdBy: 'a', expiresAt: null });
    expect(rec.lastUsedAt).toBeNull();
    await store.touch(rec.id);
    const first = (await store.findByHash(k.hash))!.lastUsedAt;
    expect(first).not.toBeNull();
    await store.touch(rec.id);
    expect((await store.findByHash(k.hash))!.lastUsedAt).toBe(first);
  });
});
