/**
 * Rate limits for the sign-in routes (login, sign-up, verification-code resend and confirm, invite accept).
 *
 * Two kinds of limit work together:
 *  - per client address: stops one machine hammering the routes;
 *  - per (client address, email) pair: stops guessing one account's password or verification code.
 *
 * Failed logins are counted against the (address, email) pair rather than the email alone, so a stranger cannot lock a
 * real user out of their own account just by failing logins for that email from somewhere else. Cognito additionally
 * throttles repeated failures per user on its side.
 *
 * Counters live in this server process (see rateLimit.ts), so a deployment with several instances multiplies each limit
 * by the number of instances; a shared store would be needed for an exact global limit.
 *
 * The client address comes from X-Forwarded-For, but only the part a trusted proxy wrote: each proxy appends the address
 * it received the request from, so the entries on the LEFT are whatever the caller chose to send and are worthless. With
 * CLOUDBUILDER_TRUSTED_PROXY_HOPS proxies in front (default 1, e.g. a load balancer), the real client is that many entries
 * from the RIGHT. Set it to 2 behind a CDN plus a load balancer, and to 0 when the app is exposed directly (the header is
 * then ignored and everyone shares one address bucket — the per-email limits still apply).
 */
import type { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, resetRateLimit } from './rateLimit';
import { apiError, tooManyRequests } from './response';
import { NOW_MS, sharedDb, sharedStoreEnabled, warnSharedStore } from './sharedStore';

const MIN = 60_000;
export const LOCKOUT_TIER_1_MS = 2 * MIN; // First lockout duration: 2 minutes
export const LOCKOUT_TIER_2_MS = 5 * MIN; // Repeated lockout duration: 5 minutes

export const AUTH_LIMITS = {
  loginIp:         { limit: 30, windowMs: 15 * MIN },
  loginFailures:   { limit: 5,  windowMs: 2 * MIN },   // failed attempts per (address, email) before lockout
  signupIp:        { limit: 5,  windowMs: 60 * MIN },
  signupEmail:     { limit: 3,  windowMs: 60 * MIN },
  resendIp:        { limit: 10, windowMs: 60 * MIN },
  resendEmail:     { limit: 3,  windowMs: 10 * MIN },
  confirmIp:           { limit: 20, windowMs: 15 * MIN },
  confirmAttempts:     { limit: 5,  windowMs: 10 * MIN },   // code guesses per (address, email)
  inviteIp:            { limit: 20, windowMs: 15 * MIN },
  forgotPasswordIp:    { limit: 10, windowMs: 60 * MIN },
  forgotPasswordEmail: { limit: 3,  windowMs: 15 * MIN },
  resetPasswordIp:     { limit: 15, windowMs: 15 * MIN },
  resetPasswordPair:   { limit: 5,  windowMs: 15 * MIN },
} as const;

export function trustedProxyHops(): number {
  const raw = process.env.CLOUDBUILDER_TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === '') return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}

export function clientIp(req: NextRequest): string {
  const hops = trustedProxyHops();
  if (hops === 0) return 'unknown';
  const chain = (req.headers.get('x-forwarded-for') ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  // Fewer entries than trusted proxies means the header did not come through them all: do not trust it.
  const forwarded = chain.length >= hops ? chain[chain.length - hops] : undefined;
  return forwarded || (hops >= 1 ? req.headers.get('x-real-ip')?.trim() : undefined) || 'unknown';
}

const norm = (email: string) => email.trim().toLowerCase();

type Limit = { limit: number; windowMs: number };
async function consume(entries: [string, Limit][]): Promise<NextResponse | null> {
  for (const [key, l] of entries) {
    const r = await checkRateLimit(key, l.limit, l.windowMs);
    if (!r.allowed) return tooManyRequests(r.retryAfterSeconds);
  }
  return null;
}

export type AuthAction = 'login' | 'signup' | 'resend' | 'confirm' | 'invite' | 'forgot-password' | 'reset-password';

/** Spends one attempt from the limits for this action. Returns the 429 response to send, or null when allowed. */
export async function limitAuthAttempt(req: NextRequest, action: AuthAction, email?: string): Promise<NextResponse | null> {
  const ip = clientIp(req);
  const e = email ? norm(email) : '';
  switch (action) {
    case 'login':           return consume([[`auth:login:ip:${ip}`, AUTH_LIMITS.loginIp]]);
    case 'signup':          return consume([[`auth:signup:ip:${ip}`, AUTH_LIMITS.signupIp], [`auth:signup:email:${e}`, AUTH_LIMITS.signupEmail]]);
    case 'resend':          return consume([[`auth:resend:ip:${ip}`, AUTH_LIMITS.resendIp], [`auth:resend:email:${e}`, AUTH_LIMITS.resendEmail]]);
    case 'confirm':         return consume([[`auth:confirm:ip:${ip}`, AUTH_LIMITS.confirmIp], [`auth:confirm:pair:${ip}:${e}`, AUTH_LIMITS.confirmAttempts]]);
    case 'invite':          return consume([[`auth:invite:ip:${ip}`, AUTH_LIMITS.inviteIp]]);
    case 'forgot-password': return consume([[`auth:forgot:ip:${ip}`, AUTH_LIMITS.forgotPasswordIp], [`auth:forgot:email:${e}`, AUTH_LIMITS.forgotPasswordEmail]]);
    case 'reset-password':  return consume([[`auth:reset:ip:${ip}`, AUTH_LIMITS.resetPasswordIp], [`auth:reset:pair:${ip}:${e}`, AUTH_LIMITS.resetPasswordPair]]);
  }
}

// ─── Tiered Account Lockout ───────────────────────────────────────────────────

interface LockoutState {
  failures: number;
  lastFailureMs: number;
  lockedUntilMs: number;
  tier: number; // 0: no prior lockout, 1: locked once (2 mins), 2: locked repeatedly (5 mins)
}

const memoryLockouts = new Map<string, LockoutState>();

export function _resetLockoutForTests(): void {
  memoryLockouts.clear();
}

const failureKey = (req: NextRequest, email: string) => `auth:login-fail:${clientIp(req)}:${norm(email)}`;
const lockoutBaseKey = (req: NextRequest, email: string) => `${clientIp(req)}:${norm(email)}`;

export interface LockoutInfo {
  locked: boolean;
  remainingSeconds: number;
  tier: number;
}

export async function getLockoutStatus(baseKey: string): Promise<LockoutInfo> {
  const now = Date.now();
  const mem = memoryLockouts.get(baseKey);

  if (mem && mem.lockedUntilMs > now) {
    const remainingSeconds = Math.max(1, Math.ceil((mem.lockedUntilMs - now) / 1000));
    return { locked: true, remainingSeconds, tier: mem.tier };
  }

  if (sharedStoreEnabled()) {
    try {
      const lockKey = `auth:login-lock:${baseKey}`;
      const { rows } = await sharedDb().query(
        `SELECT "count", "expiresAtMs", ${NOW_MS} AS "nowMs" FROM "rateLimitBucket" WHERE "key" = $1`,
        [lockKey],
      );
      const row = rows[0];
      if (row) {
        const expiresAtMs = Number(row['expiresAtMs']);
        const nowMs = Number(row['nowMs']);
        if (expiresAtMs > nowMs) {
          const remainingSeconds = Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1000));
          const tier = Number(row['count']) || 1;
          return { locked: true, remainingSeconds, tier };
        }
      }
    } catch (err) {
      warnSharedStore('login lockout status', err);
    }
  }

  return { locked: false, remainingSeconds: 0, tier: mem?.tier ?? 0 };
}

/** Check before trying a password: blocks if account is currently locked due to failed attempts. */
export async function loginLocked(req: NextRequest, email: string): Promise<NextResponse | null> {
  const baseKey = lockoutBaseKey(req, email);
  const status = await getLockoutStatus(baseKey);

  if (status.locked) {
    const mins = Math.ceil(status.remainingSeconds / 60);
    const timePhrase = status.remainingSeconds > 60
      ? `${mins} minute${mins > 1 ? 's' : ''}`
      : `${status.remainingSeconds} second${status.remainingSeconds !== 1 ? 's' : ''}`;
    const reason = status.tier >= 2 ? 'repeated' : 'multiple';
    const message = `Account is temporarily locked due to ${reason} failed login attempts. Please try again in ${timePhrase}.`;

    const res = apiError('ACCOUNT_LOCKED', message, 429, {
      remainingSeconds: status.remainingSeconds,
      retryAfter: status.remainingSeconds,
      tier: status.tier,
    });
    res.headers.set('Retry-After', String(status.remainingSeconds));
    return res;
  }

  return null;
}

export interface RecordFailureResult {
  locked: boolean;
  remainingSeconds?: number;
  tier?: number;
  remainingAttempts?: number;
}

/** Record a failed password attempt and trigger 2-min (first) or 5-min (repeated) lockout if threshold reached. */
export async function recordLoginFailure(req: NextRequest, email: string): Promise<RecordFailureResult> {
  const baseKey = lockoutBaseKey(req, email);
  const limit = AUTH_LIMITS.loginFailures.limit;
  const now = Date.now();

  let mem = memoryLockouts.get(baseKey);
  if (!mem) {
    mem = { failures: 0, lastFailureMs: now, lockedUntilMs: 0, tier: 0 };
    memoryLockouts.set(baseKey, mem);
  }

  // Reset failures if more than 15 mins since last attempt and not currently locked
  if (now - mem.lastFailureMs > 15 * MIN && mem.lockedUntilMs <= now) {
    mem.failures = 0;
  }

  mem.failures += 1;
  mem.lastFailureMs = now;

  let isLocked = false;
  let lockoutDurationMs = 0;
  let nextTier = mem.tier;

  if (mem.failures >= limit) {
    isLocked = true;
    const isRepeated = mem.tier >= 1;
    lockoutDurationMs = isRepeated ? LOCKOUT_TIER_2_MS : LOCKOUT_TIER_1_MS;
    nextTier = isRepeated ? 2 : 1;
    mem.tier = nextTier;
    mem.lockedUntilMs = now + lockoutDurationMs;
    mem.failures = 0; // Fresh attempt budget for when the lockout expires
  }

  if (sharedStoreEnabled()) {
    try {
      const lockKey = `auth:login-lock:${baseKey}`;
      const tierKey = `auth:login-tier:${baseKey}`;
      if (isLocked) {
        await sharedDb().query(
          `INSERT INTO "rateLimitBucket" ("key", "count", "windowStartMs", "expiresAtMs")
           VALUES ($1, $2, ${NOW_MS}, ${NOW_MS} + $3::double precision)
           ON CONFLICT ("key") DO UPDATE SET "count" = $2, "windowStartMs" = ${NOW_MS}, "expiresAtMs" = ${NOW_MS} + $3::double precision`,
          [lockKey, nextTier, lockoutDurationMs],
        );
        await sharedDb().query(
          `INSERT INTO "rateLimitBucket" ("key", "count", "windowStartMs", "expiresAtMs")
           VALUES ($1, $2, ${NOW_MS}, ${NOW_MS} + 86400000::double precision)
           ON CONFLICT ("key") DO UPDATE SET "count" = $2, "windowStartMs" = ${NOW_MS}, "expiresAtMs" = ${NOW_MS} + 86400000::double precision`,
          [tierKey, nextTier],
        );
      }
    } catch (err) {
      warnSharedStore('record login failure', err);
    }
  }

  // Keep compatibility with rateLimit counters
  await checkRateLimit(failureKey(req, email), limit, isLocked ? lockoutDurationMs : AUTH_LIMITS.loginFailures.windowMs);

  if (isLocked) {
    return {
      locked: true,
      remainingSeconds: Math.ceil(lockoutDurationMs / 1000),
      tier: nextTier,
    };
  }

  return {
    locked: false,
    remainingSeconds: 0,
    tier: mem.tier,
    remainingAttempts: limit - mem.failures,
  };
}

/** Clear all failure counters and lockout tiers on successful sign-in. */
export async function clearLoginFailures(req: NextRequest, email: string): Promise<void> {
  const baseKey = lockoutBaseKey(req, email);
  memoryLockouts.delete(baseKey);
  await resetRateLimit(failureKey(req, email));

  if (sharedStoreEnabled()) {
    try {
      await sharedDb().query(
        `DELETE FROM "rateLimitBucket" WHERE "key" IN ($1, $2, $3)`,
        [`auth:login-fail:${baseKey}`, `auth:login-lock:${baseKey}`, `auth:login-tier:${baseKey}`],
      );
    } catch (err) {
      warnSharedStore('clear login failures', err);
    }
  }
}

