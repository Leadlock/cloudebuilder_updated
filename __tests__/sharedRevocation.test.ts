/**
 * A logout (or "sign out everywhere") on one server instance must take effect on the others. Two "instances" here are two
 * isolated copies of the modules (each with its own in-memory state) sharing one database — an in-memory Postgres (pg-mem)
 * with the same table shape as the migration.
 */
process.env['SESSION_SECRET'] = 'a-test-secret-that-is-at-least-32-chars-long';
process.env['CLOUDBUILDER_REVOCATION_SYNC_MS'] = '250';          // the smallest allowed, so the tests do not wait long

jest.mock('@/src/prisma/db', () => ({ db: {} }));

import { createHash } from 'crypto';
import { newDb } from 'pg-mem';
import type { AuthService as AuthServiceType, AuthUser } from '@/lib/api/authService';
import type { Queryable } from '@/lib/api/sharedStore';

const user: AuthUser = { id: 'user-1', email: 'u@example.com', name: 'U', role: 'admin', orgId: 'org-1' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

function freshDb() {
  const mem = newDb();
  mem.public.none('CREATE TABLE "revokedSession" ("id" text PRIMARY KEY, "kind" text NOT NULL, "userId" text, "revokedAtMs" double precision NOT NULL, "expiresAtMs" double precision NOT NULL)');
  const { Pool } = mem.adapters.createPg();
  const queries: { sql: string; params: unknown[] }[] = [];
  const real = new Pool() as unknown as Queryable;
  const pool: Queryable = { query: async (sql, params) => { queries.push({ sql, params: params ?? [] }); return real.query(sql, params); } };
  return { mem, pool, queries };
}

function instance(pool: Queryable | null): typeof AuthServiceType {
  let svc!: typeof AuthServiceType;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const store = require('@/lib/api/sharedStore');
    store._setSharedDbForTests(pool);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    svc = require('@/lib/api/authService').AuthService;
  });
  return svc;
}

/** Another request on this instance: the first call after the interval starts a refresh, which completes shortly after. */
async function afterSync(svc: typeof AuthServiceType, token: string) {
  await sleep(300);
  svc.getSession(token);          // triggers the refresh (this call may still see the old list)
  await sleep(150);               // the refresh completes
  return svc.getSession(token);
}

afterEach(() => jest.restoreAllMocks());

describe('logout reaches every server instance', () => {
  it('a token revoked on A is refused by B within the sync interval — not 24 hours later', async () => {
    const { pool } = freshDb();
    const a = instance(pool); const b = instance(pool);
    const token = a.createSession(user).token;
    expect(b.getSession(token)).not.toBeNull();                 // valid everywhere (and this call makes B take its first look)

    expect(a.revokeSession(token)).toBe(true);
    await a.flushRevocations();                                 // what the logout request awaits before answering
    expect(a.getSession(token)).toBeNull();                     // immediately on the instance that handled it
    expect(await afterSync(b, token)).toBeNull();               // and on the other instance shortly after
  });

  it('other users\' sessions are untouched', async () => {
    const { pool } = freshDb();
    const a = instance(pool); const b = instance(pool);
    const mine = a.createSession(user).token;
    const theirs = a.createSession({ ...user, id: 'user-2', email: 'v@example.com' }).token;
    a.revokeSession(mine); await a.flushRevocations();
    expect(await afterSync(b, mine)).toBeNull();
    expect(b.getSession(theirs)).not.toBeNull();
  });

  it('a new instance picks up revocations made before it started', async () => {
    const { pool } = freshDb();
    const a = instance(pool);
    const token = a.createSession(user).token;
    a.revokeSession(token); await a.flushRevocations();
    const fresh = instance(pool);
    expect(await afterSync(fresh, token)).toBeNull();
  });

  it('"sign out everywhere" ends the user\'s existing sessions on every instance but not a session issued afterwards', async () => {
    const { pool } = freshDb();
    const a = instance(pool); const b = instance(pool);
    const before = a.createSession(user).token;
    await sleep(1100);                                          // (pg-mem's clock has whole-second resolution)
    a.revokeAllSessionsForUser(user.id); await a.flushRevocations();
    await sleep(1100);
    const after = a.createSession(user).token;
    expect(a.getSession(before)).toBeNull();
    expect(await afterSync(b, before)).toBeNull();
    expect(b.getSession(after)).not.toBeNull();
  }, 15_000);

  it('only new rows are read on later pulls (a long list is not re-read every few seconds)', async () => {
    const { pool, queries } = freshDb();
    const b = instance(pool);
    const token = b.createSession(user).token;
    b.getSession(token); await sleep(150);                      // first pull: everything (since = 0)
    await sleep(300); b.getSession(token); await sleep(150);    // second pull: only recent rows
    const pulls = queries.filter((q) => q.sql.includes('SELECT "id", "kind"'));
    expect(pulls.length).toBeGreaterThanOrEqual(2);
    expect(pulls[0]!.params[0]).toBe(0);
    expect(Number(pulls[1]!.params[0])).toBeGreaterThan(1_000_000_000_000);   // a recent epoch-ms time, not 0
  });

  it('a revocation that has already expired is ignored (the token could not be used anyway)', async () => {
    const { pool, mem } = freshDb();
    const b = instance(pool);
    const token = b.createSession(user).token;
    mem.public.none(`INSERT INTO "revokedSession" VALUES ('${hash(token)}', 'token', NULL, ${Date.now()}, ${Date.now() - 5000})`);
    expect(await afterSync(b, token)).not.toBeNull();
  });
});

describe('when the shared store cannot be used', () => {
  it('a database failure never breaks logout: the instance still revokes locally and the request still completes', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const a = instance({ query: async () => { throw new Error('connection refused'); } });
    const token = a.createSession(user).token;
    expect(a.revokeSession(token)).toBe(true);
    await expect(a.flushRevocations()).resolves.toBeUndefined();
    expect(a.getSession(token)).toBeNull();
    await sleep(100);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/\[shared-store\]/);
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/INSERT|revokedSession/);     // never logs SQL
  });

  it('without the shared store (development, single instance) it behaves as before and touches no database', async () => {
    const a = instance(null);
    const token = a.createSession(user).token;
    a.revokeSession(token);
    await a.flushRevocations();
    expect(a.getSession(token)).toBeNull();
  });
});
