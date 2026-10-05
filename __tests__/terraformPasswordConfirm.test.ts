/**
 * Confirming a deploy or teardown with the person's own password (lib/terraform/execution/passwordConfirm.ts), against an in-memory
 * Postgres with the approval table, so the single-use and plan-binding behaviour is the real one.
 */
import { newDb } from 'pg-mem';
import { _setSharedDbForTests, type Queryable } from '@/lib/api/sharedStore';
import { consumeApproval, PASSWORD_CONFIRM_TTL_MS } from '@/lib/terraform/execution/approvals';
import { confirmWithPassword, PASSWORD_TRIES, type PasswordCheckDeps } from '@/lib/terraform/execution/passwordConfirm';
import { hashPassword, verifyPassword } from '@/lib/crypto/password';

// Counters in memory: the real limiter is exercised, without a database table for it.
const buckets = new Map<string, number>();
jest.mock('@/lib/api/rateLimit', () => ({
  peekRateLimit: async (k: string, limit: number) => ({ limit, remaining: Math.max(0, limit - (buckets.get(k) ?? 0)), used: buckets.get(k) ?? 0, resetsInSeconds: 600 }),
  checkRateLimit: async (k: string, limit: number) => { const n = (buckets.get(k) ?? 0) + 1; buckets.set(k, n); return { allowed: n <= limit, remaining: Math.max(0, limit - n), retryAfterSeconds: 600 }; },
  resetRateLimit: async (k: string) => { buckets.delete(k); },
}));

let mem: ReturnType<typeof newDb>;
beforeEach(() => {
  buckets.clear();
  mem = newDb();
  mem.public.none(`CREATE TABLE "terraformApproval" ("id" text PRIMARY KEY, "createdAt" text NOT NULL, "orgId" text NOT NULL, "projectId" text NOT NULL,
    "action" text NOT NULL, "planId" text NOT NULL, "planHash" text NOT NULL, "summary" text, "requestedBy" text NOT NULL, "status" text NOT NULL,
    "decidedBy" text, "decidedAt" text, "comment" text, "expiresAtMs" double precision NOT NULL, "usedAt" text)`);
  const { Pool } = mem.adapters.createPg();
  _setSharedDbForTests(new Pool() as unknown as Queryable);
});
afterEach(() => { _setSharedDbForTests(null); });

const PLAN = { orgId: 'org-1', projectId: 'proj-1', action: 'apply' as const, planId: 'plan-1', planHash: 'hash-1' };
const input = (password: string, over: Partial<typeof PLAN> = {}) => ({ ...PLAN, ...over, userId: 'alice', summary: '3 to add, 0 to change, 0 to destroy', password });

let deps: PasswordCheckDeps;
beforeAll(async () => {
  const hash = await hashPassword('correct horse battery');
  deps = { checkPassword: async (id, pw) => (id !== 'alice' ? 'none' : (await verifyPassword(pw, hash)) ? 'ok' : 'wrong') };
});

describe('confirmWithPassword', () => {
  it('records an approval for exactly this plan when the password is right, and running it spends it', async () => {
    const r = await confirmWithPassword(input('correct horse battery'), deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.approval.status).toBe('approved');
      expect(r.approval.decidedBy).toBe('alice');
      expect(Date.parse(r.approval.expiresAt) - Date.now()).toBeLessThanOrEqual(PASSWORD_CONFIRM_TTL_MS + 1000);
    }
    expect((await consumeApproval(PLAN)).ok).toBe(true);
    expect((await consumeApproval(PLAN)).ok).toBe(false);          // single use
  });

  it('does not carry over to a different plan', async () => {
    await confirmWithPassword(input('correct horse battery'), deps);
    expect((await consumeApproval({ ...PLAN, planHash: 'other' })).ok).toBe(false);
    expect((await consumeApproval({ ...PLAN, planId: 'plan-2' })).ok).toBe(false);
  });

  it('refuses a wrong password, says how many tries are left, and records nothing', async () => {
    const r = await confirmWithPassword(input('nope'), deps);
    expect(r).toMatchObject({ ok: false, code: 'wrong_password', triesLeft: PASSWORD_TRIES.limit - 1 });
    expect((await consumeApproval(PLAN)).ok).toBe(false);
  });

  it('locks out after too many wrong passwords, even for the right one, and a right one earlier clears the count', async () => {
    for (let i = 0; i < PASSWORD_TRIES.limit; i++) await confirmWithPassword(input('nope'), deps);
    const locked = await confirmWithPassword(input('correct horse battery'), deps);
    expect(locked).toMatchObject({ ok: false, code: 'locked' });

    buckets.clear();
    await confirmWithPassword(input('nope'), deps);
    expect((await confirmWithPassword(input('correct horse battery'), deps)).ok).toBe(true);
    expect(buckets.size).toBe(0);     // the right password cleared the failures
  });

  it('says so when the account has no password', async () => {
    const r = await confirmWithPassword({ ...input('anything'), userId: 'dev-user-id' }, deps);
    expect(r).toMatchObject({ ok: false, code: 'no_password' });
  });

  it('confirming again while a confirmation is still valid does not create a second one', async () => {
    const a = await confirmWithPassword(input('correct horse battery'), deps);
    const b = await confirmWithPassword(input('correct horse battery'), deps);
    expect(a.ok && b.ok && a.approval.id === b.approval.id).toBe(true);
  });

  it('never puts the password in the stored record', async () => {
    await confirmWithPassword(input('correct horse battery'), deps);
    const rows = mem.public.many('SELECT * FROM "terraformApproval"');
    expect(JSON.stringify(rows)).not.toContain('correct horse battery');
  });
});
