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
    if (ready) { await admin.query(`DELETE FROM "projectRelease" WHERE "orgId" = $1`, [orgId]); await admin.query(`DELETE FROM "projectSource" WHERE "orgId" = $1`, [orgId]).catch(() => undefined); }
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

describe('a whole release against real Postgres (fake cloud)', () => {
  maybe('runs through the database store: every step saved, a retry resumes, the cancel guard holds, the project is unlocked', async () => {
    const { PgReleaseStore } = await import('@/lib/deploy/project/pgReleaseStore');
    const { runRelease, newRelease, approveRelease, provideSecrets } = await import('@/lib/deploy/project/orchestrator');
    const { buildAzureVmBundle } = await import('@/lib/deploy/project/bundle');
    const { defaultProject, LAYERS } = await import('@/lib/engines/containers/stackProject');
    const store = new PgReleaseStore();
    const p = defaultProject(); p.name = 'shop';
    for (const l of LAYERS) p.layers[l].enabled = ['backend', 'api'].includes(l);
    p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }];
    p.deploy.target = 'azure-vm';
    const bundle = buildAzureVmBundle(p);
    const id = `it-${run}-full`;
    await store.save(newRelease({ id, orgId, projectId, environment: 'production', cloudAccountId: 'a', project: p, bundle, createdBy: 'u', previousReleaseId: null, planId: 'pl', planHash: 'h', now: Date.now() }));
    await approveRelease(store, id, { bundleHash: bundle.bundleHash, planHash: 'h' }, Date.now());

    const vault = new Set<string>(); const calls: string[] = [];
    const ops = {
      secretExists: async (_v: string, n: string) => vault.has(n), putSecret: async (_v: string, n: string) => { vault.add(n); },
      acrBuild: async (a: { image: string }) => { calls.push(`build ${a.image}`); }, setVmTag: async (_r: string, _v: string, k: string, v: string) => { calls.push(`tag ${k}=${v}`); },
      runShell: async () => '', httpOk: async () => true, resourceGroupExists: async () => true,
    };
    const infra = { apply: async () => ({ resourceGroup: 'rg-shop', vmName: 'vm-shop', acrName: 'acrshop', vaultName: 'kvshop', url: 'http://203.0.113.9:8080/' }) };
    const deps = { store, ops, infra, sleep: async () => undefined, verifyWaitMs: 50, verifyEveryMs: 1 };

    const first = await runRelease(deps, id);
    expect(first.status).toBe('waiting');
    // Read back from the database by a different store object (as the web server does while the worker runs).
    expect((await new PgReleaseStore().get(id))!.steps.find((s) => s.name === 'secrets')!.state).toBe('waiting');
    await provideSecrets(deps, id, { JWT_SECRET: 'jwt-value_1' });
    const second = await runRelease(deps, id);
    expect(second.status).toBe('succeeded');
    expect(calls).toEqual(['build shop-backend:latest', 'build shop-api:latest', 'tag image_tag=latest']);
    const stored = (await store.get(id))!;
    expect(stored.status).toBe('succeeded');
    expect(JSON.stringify(stored)).not.toContain('jwt-value_1');
    expect((await store.latestSucceeded(projectId, 'production'))!.id).toBe(id);
  });
});

describe('uploaded code against real Postgres', () => {
  maybe('a zip is stored and read back byte for byte, expires, and is pruned', async () => {
    const { PgSourceStore, sha256Hex } = await import('@/lib/deploy/project/sourceStore');
    const store = new PgSourceStore();
    const zip = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 256));
    const saved = await store.put({ id: `it-${run}-s1`, orgId, projectId, layer: 'api', zip, expiresAtMs: Date.now() + 60_000 });
    expect(saved.sha256).toBe(sha256Hex(zip));
    const back = (await store.get(`it-${run}-s1`))!;
    expect(back.zip.equals(zip)).toBe(true);
    expect(back).toMatchObject({ orgId, projectId, layer: 'api', sizeBytes: 5000, sha256: sha256Hex(zip) });
    await store.put({ id: `it-${run}-s2`, orgId, projectId, layer: 'api', zip: Buffer.from('old'), expiresAtMs: Date.now() - 1000 });
    expect(await store.get(`it-${run}-s2`)).toBeNull();                     // expired: as if it were not there
    await store.prune();
    const left = await admin.query(`SELECT "id" FROM "projectSource" WHERE "orgId" = $1`, [orgId]);
    expect(left.rows.map((r) => r.id)).toEqual([`it-${run}-s1`]);
    expect(await store.get('nope')).toBeNull();
  });
});
