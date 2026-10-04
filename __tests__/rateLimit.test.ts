/**
 * lib/api/rateLimit.ts — in-process counters (development, single instance, and the fallback) and the shared database-backed
 * counters (production), the latter run against an in-memory Postgres (pg-mem) with the same table shape as the migration.
 */
import { newDb } from 'pg-mem';
import { checkRateLimit, peekRateLimit, resetRateLimit } from '@/lib/api/rateLimit';
import { _setSharedDbForTests, sharedStoreEnabled, type Queryable } from '@/lib/api/sharedStore';

const env = process.env as Record<string, string | undefined>;
const saved = { mode: env['CLOUDCRAFT_SHARED_STORE'], url: env['DATABASE_URL'], node: env['NODE_ENV'] };
afterEach(() => {
  _setSharedDbForTests(null);
  for (const [k, v] of [['CLOUDCRAFT_SHARED_STORE', saved.mode], ['DATABASE_URL', saved.url], ['NODE_ENV', saved.node]] as const) { if (v === undefined) delete env[k]; else env[k] = v; }
});

describe('checkRateLimit (in-process)', () => {
  it('allows requests under the limit', async () => {
    const key = `test-under-${Date.now()}`;
    const r1 = await checkRateLimit(key, 3, 60_000);
    const r2 = await checkRateLimit(key, 3, 60_000);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);
  });

  it('blocks requests once the limit is reached, with a retryAfterSeconds hint', async () => {
    const key = `test-blocked-${Date.now()}`;
    await checkRateLimit(key, 2, 60_000);
    await checkRateLimit(key, 2, 60_000);
    const blocked = await checkRateLimit(key, 2, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('resets the window after windowMs elapses', async () => {
    const key = `test-reset-${Date.now()}`;
    await checkRateLimit(key, 1, 50);
    expect((await checkRateLimit(key, 1, 50)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect((await checkRateLimit(key, 1, 50)).allowed).toBe(true);
  });

  it('tracks distinct keys independently (per-user, per-route isolation)', async () => {
    const keyA = `test-iso-a-${Date.now()}`;
    const keyB = `test-iso-b-${Date.now()}`;
    await checkRateLimit(keyA, 1, 60_000);
    expect((await checkRateLimit(keyA, 1, 60_000)).allowed).toBe(false);
    expect((await checkRateLimit(keyB, 1, 60_000)).allowed).toBe(true);
  });
});

describe('sharedStoreEnabled', () => {
  it('is off in development and tests, on in production, and follows CLOUDCRAFT_SHARED_STORE', () => {
    env['DATABASE_URL'] = 'postgres://x/y';
    delete env['CLOUDCRAFT_SHARED_STORE'];
    env['NODE_ENV'] = 'test'; expect(sharedStoreEnabled()).toBe(false);
    env['NODE_ENV'] = 'development'; expect(sharedStoreEnabled()).toBe(false);
    env['NODE_ENV'] = 'production'; expect(sharedStoreEnabled()).toBe(true);
    env['CLOUDCRAFT_SHARED_STORE'] = 'memory'; expect(sharedStoreEnabled()).toBe(false);
    env['NODE_ENV'] = 'development'; env['CLOUDCRAFT_SHARED_STORE'] = 'db'; expect(sharedStoreEnabled()).toBe(true);
    delete env['DATABASE_URL']; expect(sharedStoreEnabled()).toBe(false);          // nothing to connect to
  });
});

describe('checkRateLimit (shared database store)', () => {
  async function freshDb() {
    const mem = newDb();
    mem.public.none('CREATE TABLE "rateLimitBucket" ("key" text PRIMARY KEY, "count" integer NOT NULL, "windowStartMs" double precision NOT NULL, "expiresAtMs" double precision NOT NULL)');
    const { Pool } = mem.adapters.createPg();
    const pool = new Pool();
    return { mem, pool: pool as unknown as Queryable };
  }
  /** A second "server": its own copy of the modules (its own in-process state), the same database. */
  function otherInstance(pool: Queryable): { checkRateLimit: typeof checkRateLimit; peekRateLimit: typeof peekRateLimit } {
    let m!: { checkRateLimit: typeof checkRateLimit; peekRateLimit: typeof peekRateLimit };
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@/lib/api/sharedStore')._setSharedDbForTests(pool);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      m = require('@/lib/api/rateLimit');
    });
    return m;
  }

  it('counts and blocks through the database, with a retry hint', async () => {
    const { pool } = await freshDb(); _setSharedDbForTests(pool);
    expect((await checkRateLimit('k', 2, 60_000)).remaining).toBe(1);
    expect((await checkRateLimit('k', 2, 60_000)).remaining).toBe(0);
    const blocked = await checkRateLimit('k', 2, 60_000);
    expect(blocked).toMatchObject({ allowed: false, remaining: 0 });
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('is GLOBAL: two server instances spend one budget', async () => {
    const { pool } = await freshDb();
    const a = otherInstance(pool); const b = otherInstance(pool);
    expect((await a.checkRateLimit('login:ip', 3, 60_000)).allowed).toBe(true);
    expect((await b.checkRateLimit('login:ip', 3, 60_000)).allowed).toBe(true);
    expect((await a.checkRateLimit('login:ip', 3, 60_000)).allowed).toBe(true);
    expect((await b.checkRateLimit('login:ip', 3, 60_000)).allowed).toBe(false);   // 4th request, whichever server it lands on
    expect((await a.checkRateLimit('login:ip', 3, 60_000)).allowed).toBe(false);
  });

  it('keeps keys apart, and starts a new window once the old one is over', async () => {
    const { mem, pool } = await freshDb(); _setSharedDbForTests(pool);
    await checkRateLimit('a', 1, 60_000);
    expect((await checkRateLimit('a', 1, 60_000)).allowed).toBe(false);
    expect((await checkRateLimit('b', 1, 60_000)).allowed).toBe(true);
    mem.public.none('UPDATE "rateLimitBucket" SET "windowStartMs" = "windowStartMs" - 120000, "expiresAtMs" = "expiresAtMs" - 120000');   // two minutes pass
    expect((await checkRateLimit('a', 1, 60_000)).allowed).toBe(true);
    expect((await checkRateLimit('a', 1, 60_000)).allowed).toBe(false);
  });

  it('peek reports what is left without spending any, and agrees with check', async () => {
    const { pool } = await freshDb(); _setSharedDbForTests(pool);
    expect(await peekRateLimit('p', 5, 60_000)).toEqual({ limit: 5, remaining: 5, used: 0, resetsInSeconds: 0 });
    await checkRateLimit('p', 5, 60_000); await checkRateLimit('p', 5, 60_000);
    for (let i = 0; i < 4; i++) expect((await peekRateLimit('p', 5, 60_000)).remaining).toBe(3);
    const p = await peekRateLimit('p', 5, 60_000);
    expect(p.used).toBe(2);
    expect(p.resetsInSeconds).toBeGreaterThan(55);
    expect(p.resetsInSeconds).toBeLessThanOrEqual(60);
  });

  it('reset forgets the counter in the database too', async () => {
    const { pool } = await freshDb(); _setSharedDbForTests(pool);
    await checkRateLimit('r', 1, 60_000);
    expect((await checkRateLimit('r', 1, 60_000)).allowed).toBe(false);
    await resetRateLimit('r');
    expect((await checkRateLimit('r', 1, 60_000)).allowed).toBe(true);
  });

  it('if the database fails MID-WAY (say a burst exhausts the pool) the fallback continues from the real count instead of handing out a second budget', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { pool } = await freshDb();
    let broken = false;
    _setSharedDbForTests({ query: async (sql, params) => { if (broken) throw new Error('timeout exceeded when trying to connect'); return pool.query(sql, params); } });
    const key = `midway-${Date.now()}`;
    expect((await checkRateLimit(key, 3, 60_000)).allowed).toBe(true);
    expect((await checkRateLimit(key, 3, 60_000)).allowed).toBe(true);
    expect((await checkRateLimit(key, 3, 60_000)).allowed).toBe(true);        // the budget of 3 is spent through the database
    broken = true;
    expect((await checkRateLimit(key, 3, 60_000)).allowed).toBe(false);       // the 4th is refused — not allowed "3 more" from a fresh local count
    warn.mockRestore();
  });

  it('if the database is unreachable it falls back to counting in-process: degraded, never open and never an error', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    _setSharedDbForTests({ query: async () => { throw new Error('connection refused'); } });
    const key = `fallback-${Date.now()}`;
    expect((await checkRateLimit(key, 2, 60_000)).allowed).toBe(true);
    expect((await checkRateLimit(key, 2, 60_000)).allowed).toBe(true);
    expect((await checkRateLimit(key, 2, 60_000)).allowed).toBe(false);            // the limit still holds on this instance
    expect((await peekRateLimit(key, 2, 60_000)).remaining).toBe(0);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[shared-store]')).length).toBeGreaterThan(0);
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/INSERT|rateLimitBucket/);    // never logs SQL
    warn.mockRestore();
  });
});
