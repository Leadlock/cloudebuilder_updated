/**
 * Architecture templates against a REAL PostgreSQL: the built-in ones are written once (and again without change), an organization sees the built-in
 * templates and only its own, and one organization can never read or delete another's.
 *
 * Runs via:  node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.integration.mjs integration/architectureTemplates
 * Needs the table from migration add_architecture_templates (`npm run db:migrate`); skips itself if it is missing.
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
  ready = (await admin.query(`SELECT to_regclass('"public"."architectureTemplate"') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  if (!ready) console.warn('[templates integration] table not found — run `npm run db:migrate` first; skipping');
});
afterAll(async () => {
  if (admin) { if (ready) await admin.query(`DELETE FROM "architectureTemplate" WHERE "orgId" = ANY($1)`, [[orgA, orgB]]); await admin.end(); }
  const { sharedDb } = await import('@/lib/api/sharedStore');
  await (sharedDb() as unknown as { end(): Promise<void> }).end?.();
});
const maybe = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!ready) return; await fn(); });

const body = { name: 'Mine', description: 'd', provider: 'aws', category: 'Custom', tags: ['x'], nodes: [{ id: 'a', type: 't', label: 'A', position: { x: 0, y: 0 } }], edges: [] };

describe('architecture templates on real Postgres', () => {
  maybe('the built-in templates are written, and a second run changes nothing', async () => {
    const { PgTemplateStore } = await import('@/lib/templates/templateStore');
    const { syncBuiltInTemplates } = await import('@/lib/templates/sync');
    const { architectureTemplates } = await import('@/lib/templates');
    const store = new PgTemplateStore();
    await syncBuiltInTemplates(store);
    const again = await syncBuiltInTemplates(store);
    expect(again).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: architectureTemplates.length });
    const list = await store.list(orgA);
    expect(list.filter((t) => t.source === 'builtin')).toHaveLength(architectureTemplates.length);
    const one = await store.get(orgA, architectureTemplates[0]!.id);
    expect(one?.graph.nodes.length).toBeGreaterThan(0);
  });

  maybe('an organization sees the built-in templates and its own, never another\'s', async () => {
    const { PgTemplateStore } = await import('@/lib/templates/templateStore');
    const store = new PgTemplateStore();
    const a = await store.createOwn(orgA, 'a@x.com', body);
    const b = await store.createOwn(orgB, 'b@x.com', { ...body, name: 'Theirs' });
    const seenA = await store.list(orgA);
    expect(seenA.some((t) => t.id === a.id)).toBe(true);
    expect(seenA.some((t) => t.id === b.id)).toBe(false);
    expect(await store.get(orgA, b.id)).toBeNull();
    expect((await store.listOwn(orgA)).map((t) => t.id)).toEqual([a.id]);
    expect(await store.countOwn(orgA)).toBe(1);
    expect(a).toMatchObject({ source: 'org', orgId: orgA, createdBy: 'a@x.com', category: 'Custom', complexity: 'simple', resourceCount: 1 });
  });

  maybe('one organization cannot delete another\'s template, and a built-in one is never deleted', async () => {
    const { PgTemplateStore } = await import('@/lib/templates/templateStore');
    const { architectureTemplates } = await import('@/lib/templates');
    const store = new PgTemplateStore();
    const [a] = await store.listOwn(orgA);
    expect(await store.deleteOwn(orgB, a!.id)).toBe(false);
    expect(await store.deleteOwn(orgA, architectureTemplates[0]!.id)).toBe(false);
    expect(await store.ownerOf(orgA, architectureTemplates[0]!.id)).toBeUndefined();
    expect(await store.ownerOf(orgA, a!.id)).toBe('a@x.com');
    expect(await store.deleteOwn(orgA, a!.id)).toBe(true);
    expect(await store.get(orgA, architectureTemplates[0]!.id)).not.toBeNull();
  });
});
