/**
 * Marketplace listings against a REAL PostgreSQL: written, read back, replaced, scoped to one organization, a damaged row skipped, and deleted.
 *
 * Runs via:  node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.integration.mjs integration/templateListing
 * Needs the table from migration add_template_listing (`npm run db:migrate`); skips itself if it is missing.
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
  ready = (await admin.query(`SELECT to_regclass('"public"."templateListing"') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  if (!ready) console.warn('[listing integration] table not found — run `npm run db:migrate` first; skipping');
});
afterAll(async () => {
  if (admin) { if (ready) await admin.query(`DELETE FROM "templateListing" WHERE "orgId" = ANY($1)`, [[orgA, orgB]]); await admin.end(); }
  const { sharedDb } = await import('@/lib/api/sharedStore');
  await (sharedDb() as unknown as { end(): Promise<void> }).end?.();
});
const maybe = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!ready) return; await fn(); });

describe('template listings on real Postgres', () => {
  maybe('a listing is written, read back, replaced and deleted', async () => {
    const { PgListingStore } = await import('@/lib/marketplace/listingStore');
    const s = new PgListingStore();
    await s.put(orgA, 't1', { challenges: 'First', startingPrice: 100 }, 'a@x.com');
    expect((await s.get(orgA, 't1'))?.listing).toEqual({ challenges: 'First', startingPrice: 100 });
    await s.put(orgA, 't1', { challenges: 'Second' }, 'b@x.com');
    const second = await s.get(orgA, 't1');
    expect(second).toMatchObject({ listing: { challenges: 'Second' }, updatedBy: 'b@x.com' });
    expect((await s.forOrg(orgA)).get('t1')).toEqual({ challenges: 'Second' });
    expect(await s.delete(orgA, 't1')).toBe(true);
    expect(await s.delete(orgA, 't1')).toBe(false);
    expect(await s.get(orgA, 't1')).toBeNull();
  });

  maybe('one organization never sees or deletes another\'s listing', async () => {
    const { PgListingStore } = await import('@/lib/marketplace/listingStore');
    const s = new PgListingStore();
    await s.put(orgA, 'shared-id', { challenges: 'A\'s' }, 'a');
    await s.put(orgB, 'shared-id', { challenges: 'B\'s' }, 'b');
    expect((await s.get(orgA, 'shared-id'))?.listing.challenges).toBe('A\'s');
    expect((await s.forOrg(orgB)).get('shared-id')?.challenges).toBe('B\'s');
    expect(await s.delete(orgB, 'shared-id')).toBe(true);
    expect((await s.get(orgA, 'shared-id'))?.listing.challenges).toBe('A\'s');
  });

  maybe('a damaged or no-longer-valid row is skipped, not fatal', async () => {
    const { PgListingStore } = await import('@/lib/marketplace/listingStore');
    const s = new PgListingStore();
    await admin.query(`INSERT INTO "templateListing" ("id","orgId","templateId","listingJson","updatedBy","updatedAt") VALUES ($1,$2,'bad','not json','x','now'), ($3,$2,'old','{"audience":["Astronaut"]}','x','now')`, [`${orgA}:bad`, orgA, `${orgA}:old`]);
    await s.put(orgA, 'good', { startingPrice: 5 }, 'a');
    const m = await s.forOrg(orgA);
    expect([...m.keys()]).toContain('good');
    expect(m.has('bad')).toBe(false);
    expect(m.has('old')).toBe(false);
    expect(await s.get(orgA, 'bad')).toBeNull();
  });
});
