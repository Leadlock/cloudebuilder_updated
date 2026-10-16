/**
 * Project releases against a REAL PostgreSQL: they are stored and read back whole, only a succeeded one is "what is running", and above all a cancel
 * is never written over by a worker that is still running a step.
 *
 * Runs via:  node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.integration.mjs integration/projectReleases
 * Needs the table from migration 20261016T0837_add_project_releases (`npm run db:migrate`); skips itself if it is missing.
 */
import * as dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '.env') });

import { Client } from 'pg';

const url = process.env['DATABASE_URL'];
const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const orgId = `it-${run}-org`;
const projectId = `it-${run}-proj`;
let ready = false;
let admin: Client;

beforeAll(async () => {
  if (!url) return;
  admin = new Client({ connectionString: url });
  await admin.connect();
  const r = await admin.query(`SELECT to_regclass('"public"."projectRelease"') IS NOT NULL AS ok`);
  ready = r.rows[0]?.ok === true;
  if (!ready) console.warn('[releases integration] table not found — run `npm run db:migrate` first; skipping');
});

afterAll(async () => {
  if (admin) {
    if (ready) await admin.query(`DELETE FROM "projectRelease" WHERE "orgId" = $1`, [orgId]);
    await admin.end();
  }
  const { sharedDb } = await import('@/lib/api/sharedStore');
  await (sharedDb() as unknown as { end(): Promise<void> }).end?.();
});

const maybe = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!ready) return; await fn(); });

const release = (id: string, over: Record<string, unknown> = {}) => ({
  id, orgId, projectId, environment: 'production', cloudAccountId: 'acct-1', target: 'azure-vm', bundleHash: 'b'.repeat(64), planId: 'plan', planHash: 'p'.repeat(64), project: 'shop', settings: { name: 'shop' },
  imageTag: 'v1', compose: 'services: {}\n', built: ['api'], secrets: ['JWT_SECRET'], status: 'planned', steps: [{ name: 'infrastructure', state: 'pending' }], outputs: null,
  previousReleaseId: null, createdBy: 'u1', createdAt: 1000, updatedAt: 1000, error: null, ...over,
});

describe('project releases on real Postgres', () => {
  maybe('a release is stored and read back whole, and saving again replaces it', async () => {
    const { PgReleaseStore } = await import('@/lib/deploy/project/pgReleaseStore');
    const store = new PgReleaseStore();
    const r = release(`it-${run}-1`);
    await store.save(r as never);
    expect(await store.get(r.id)).toEqual(r);
    await store.save({ ...r, status: 'approved', updatedAt: 2000 } as never);
    expect((await store.get(r.id))!.status).toBe('approved');
    expect(await store.get('does-not-exist')).toBeNull();
  });

  maybe('only a succeeded release is what is running, and the newest one wins', async () => {
    const { PgReleaseStore } = await import('@/lib/deploy/project/pgReleaseStore');
    const store = new PgReleaseStore();
    await store.save(release(`it-${run}-a`, { status: 'succeeded', imageTag: 'v1', updatedAt: 3000 }) as never);
    await store.save(release(`it-${run}-b`, { status: 'failed', imageTag: 'v2', updatedAt: 4000 }) as never);
    await store.save(release(`it-${run}-c`, { status: 'succeeded', imageTag: 'v3', updatedAt: 5000 }) as never);
    await store.save(release(`it-${run}-d`, { status: 'succeeded', imageTag: 'other', updatedAt: 6000, environment: 'staging' }) as never);
    expect((await store.latestSucceeded(projectId, 'production'))!.imageTag).toBe('v3');
    expect((await store.latestSucceeded(projectId, 'staging'))!.imageTag).toBe('other');
    expect(await store.latestSucceeded(projectId, 'nowhere')).toBeNull();
    const list = await store.list(projectId, 'production', 10);
    expect(list.map((x) => x.imageTag)).toEqual(['v3', 'v2', 'v1', 'v1']);
  });

  maybe('a cancel is never written over, however the two writes arrive', async () => {
    const { PgReleaseStore } = await import('@/lib/deploy/project/pgReleaseStore');
    const store = new PgReleaseStore();
    const r = release(`it-${run}-x`, { status: 'running', updatedAt: 7000 });
    await store.save(r as never);
    await store.save({ ...r, status: 'cancelled', updatedAt: 7100 } as never);
    // The worker, still inside a step, saves its own view of the release.
    await store.save({ ...r, status: 'running', updatedAt: 7200 } as never);
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.save({ ...r, status: 'running', updatedAt: 7300 + i } as never)));
    expect((await store.get(r.id))!.status).toBe('cancelled');
    // A cancel always lands, also over a running one.
    const y = release(`it-${run}-y`, { status: 'running' });
    await store.save(y as never);
    await store.save({ ...y, status: 'cancelled' } as never);
    expect((await store.get(y.id))!.status).toBe('cancelled');
  });

  maybe('the secrets of a release are names, never values: nothing in the row can hold one the form did not put there', async () => {
    const { PgReleaseStore } = await import('@/lib/deploy/project/pgReleaseStore');
    const store = new PgReleaseStore();
    const r = release(`it-${run}-s`);
    await store.save(r as never);
    const raw = await admin.query(`SELECT * FROM "projectRelease" WHERE "id" = $1`, [r.id]);
    expect(JSON.stringify(raw.rows[0])).not.toMatch(/password|BEGIN PRIVATE|client_?secret/i);
    expect(raw.rows[0]!.dataJson).toContain('JWT_SECRET');
  });
});
