import { newDb } from 'pg-mem';
import { _setSharedDbForTests, type Queryable } from '@/lib/api/sharedStore';
import { base32Decode, base32Encode, totpCode, totpStep, verifyTotp, otpauthUri, generateTotpSecret } from '@/lib/crypto/totp';
import { beginTotpSetup, enableTotp, verifyTotpCode, totpEnabled, totpStatus, disableTotp } from '@/lib/api/totpStore';
import { confirmWithPassword, type PasswordCheckDeps } from '@/lib/terraform/execution/passwordConfirm';
import { hashPassword, verifyPassword } from '@/lib/crypto/password';

const buckets = new Map<string, number>();
jest.mock('@/lib/api/rateLimit', () => ({
  peekRateLimit: async (k: string, limit: number) => ({ limit, remaining: Math.max(0, limit - (buckets.get(k) ?? 0)), used: buckets.get(k) ?? 0, resetsInSeconds: 600 }),
  checkRateLimit: async (k: string, limit: number) => { const n = (buckets.get(k) ?? 0) + 1; buckets.set(k, n); return { allowed: n <= limit, remaining: Math.max(0, limit - n), retryAfterSeconds: 600 }; },
  resetRateLimit: async (k: string) => { buckets.delete(k); },
}));

describe('RFC 6238', () => {
  // The standard test secret "12345678901234567890", HMAC-SHA1, 8 digits in the RFC; the last 6 digits are what a 6-digit code is.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']])('code at %i seconds is %s', (t, expected) => {
    expect(totpCode(secret, totpStep(t * 1000))).toBe(expected);
  });

  it('base32 round-trips', () => {
    const s = generateTotpSecret();
    expect(base32Encode(base32Decode(s))).toBe(s);
    expect(() => base32Decode('not*base32')).toThrow();
  });

  it('accepts the current step and one either side, rejects others, and rejects a step already used', () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(secret, totpCode(secret, step), now)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), now)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), now, step)).toBeNull();        // replay
    expect(verifyTotp(secret, `${totpCode(secret, step).slice(0, 3)} ${totpCode(secret, step).slice(3)}`, now)).toBe(step);   // spaces are ignored
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('builds the link an authenticator app understands', () => {
    expect(otpauthUri('ABC', 'a@b.c')).toBe('otpauth://totp/CloudCraft%3Aa%40b.c?secret=ABC&issuer=CloudCraft&algorithm=SHA1&digits=6&period=30');
  });
});

describe('totpStore', () => {
  let mem: ReturnType<typeof newDb>;
  beforeEach(() => {
    mem = newDb();
    mem.public.none(`CREATE TABLE "userTotp" ("userId" text PRIMARY KEY, "secretEnc" text NOT NULL, "enabled" boolean NOT NULL DEFAULT false,
      "lastStep" double precision NOT NULL DEFAULT 0, "recoveryJson" text NOT NULL DEFAULT '[]', "createdAt" text NOT NULL)`);
    const { Pool } = mem.adapters.createPg();
    _setSharedDbForTests(new Pool() as unknown as Queryable);
    process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  });
  afterEach(() => { _setSharedDbForTests(null); });

  it('is off until a correct code proves the app works, and the secret is not stored in the clear', async () => {
    const { secret } = await beginTotpSetup('u1', 'u1@x.io');
    expect(await totpEnabled('u1')).toBe(false);
    expect(JSON.stringify(mem.public.many('SELECT * FROM "userTotp"'))).not.toContain(secret);

    const now = Date.now();
    expect((await enableTotp('u1', '000000', now))).toMatchObject({ ok: false });
    expect(await totpEnabled('u1')).toBe(false);
    const on = await enableTotp('u1', totpCode(secret, totpStep(now)), now);
    expect(on.ok && on.recoveryCodes).toHaveLength(8);
    expect(await totpEnabled('u1')).toBe(true);
    expect(await totpStatus('u1')).toEqual({ enabled: true, recoveryCodesLeft: 8 });
    expect(JSON.stringify(mem.public.many('SELECT * FROM "userTotp"'))).not.toContain((on as { recoveryCodes: string[] }).recoveryCodes[0]);   // only hashes
  });

  async function enabled(): Promise<{ secret: string; codes: string[]; now: number }> {
    const { secret } = await beginTotpSetup('u1', 'u1@x.io');
    const now = Date.now();
    const on = await enableTotp('u1', totpCode(secret, totpStep(now)), now);
    return { secret, codes: (on as { recoveryCodes: string[] }).recoveryCodes, now };
  }

  it('a code works once, even within its 30 seconds', async () => {
    const { secret, now } = await enabled();
    const next = now + 31_000;     // the step after the one used to turn it on
    const code = totpCode(secret, totpStep(next));
    expect(await verifyTotpCode('u1', code, next)).toBe(true);
    expect(await verifyTotpCode('u1', code, next)).toBe(false);
  });

  it('a recovery code works once', async () => {
    const { codes } = await enabled();
    expect(await verifyTotpCode('u1', codes[0]!)).toBe(true);
    expect(await verifyTotpCode('u1', codes[0]!)).toBe(false);
    expect(await verifyTotpCode('u1', codes[1]!.toLowerCase().replace('-', ' '))).toBe(true);   // case, dash and spaces do not matter
    expect((await totpStatus('u1')).recoveryCodesLeft).toBe(6);
  });

  it('cannot be set up again while on, and turning off removes it', async () => {
    await enabled();
    await expect(beginTotpSetup('u1', 'u1@x.io')).rejects.toThrow(/already on/);
    await disableTotp('u1');
    expect(await totpEnabled('u1')).toBe(false);
  });
});

describe('confirming with password and code', () => {
  let deps: PasswordCheckDeps;
  let secret: string;
  const input = (password: string, code?: string) => ({ orgId: 'o', projectId: 'p', userId: 'u1', action: 'apply' as const, planId: 'plan', planHash: 'h', summary: 's', password, code });

  beforeEach(async () => {
    buckets.clear();
    const mem = newDb();
    mem.public.none(`CREATE TABLE "terraformApproval" ("id" text PRIMARY KEY, "createdAt" text NOT NULL, "orgId" text NOT NULL, "projectId" text NOT NULL,
      "action" text NOT NULL, "planId" text NOT NULL, "planHash" text NOT NULL, "summary" text, "requestedBy" text NOT NULL, "status" text NOT NULL,
      "decidedBy" text, "decidedAt" text, "comment" text, "expiresAtMs" double precision NOT NULL, "usedAt" text)`);
    const { Pool } = mem.adapters.createPg();
    _setSharedDbForTests(new Pool() as unknown as Queryable);
    secret = generateTotpSecret();
    const hash = await hashPassword('pw-correct');
    deps = {
      checkPassword: async (_u, pw) => ((await verifyPassword(pw, hash)) ? 'ok' : 'wrong'),
      totp: { enabled: async () => true, verify: async (_u, c) => c === totpCode(secret, totpStep(Date.now())) },
    };
  });
  afterEach(() => { _setSharedDbForTests(null); });

  it('needs the code as well as the password', async () => {
    expect(await confirmWithPassword(input('pw-correct'), deps)).toMatchObject({ ok: false, code: 'needs_code' });
    expect(await confirmWithPassword(input('pw-correct', '000000'), deps)).toMatchObject({ ok: false, code: 'wrong_password' });
    expect((await confirmWithPassword(input('pw-correct', totpCode(secret, totpStep(Date.now()))), deps)).ok).toBe(true);
  });

  it('a right code does not help with a wrong password', async () => {
    expect(await confirmWithPassword(input('wrong', totpCode(secret, totpStep(Date.now()))), deps)).toMatchObject({ ok: false, code: 'wrong_password' });
  });

  it('wrong codes count towards the lockout', async () => {
    for (let i = 0; i < 5; i++) await confirmWithPassword(input('pw-correct', '000000'), deps);
    expect(await confirmWithPassword(input('pw-correct', totpCode(secret, totpStep(Date.now()))), deps)).toMatchObject({ ok: false, code: 'locked' });
  });

  it('fails closed when whether the code is needed cannot be read', async () => {
    const broken: PasswordCheckDeps = { ...deps, totp: { enabled: async () => { throw new Error('db down'); }, verify: async () => true } };
    await expect(confirmWithPassword(input('pw-correct', '123456'), broken)).rejects.toThrow('db down');
  });
});
