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
 * by the number of instances; a shared store would be needed for an exact global limit. The client address comes from
 * X-Forwarded-For, which is only trustworthy behind a proxy that sets it — the per-pair limits do not depend on it.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, peekRateLimit, resetRateLimit } from './rateLimit';
import { tooManyRequests } from './response';

const MIN = 60_000;
export const AUTH_LIMITS = {
  loginIp:         { limit: 30, windowMs: 15 * MIN },
  loginFailures:   { limit: 5,  windowMs: 15 * MIN },   // failed attempts per (address, email)
  signupIp:        { limit: 5,  windowMs: 60 * MIN },
  signupEmail:     { limit: 3,  windowMs: 60 * MIN },
  resendIp:        { limit: 10, windowMs: 60 * MIN },
  resendEmail:     { limit: 3,  windowMs: 10 * MIN },
  confirmIp:       { limit: 20, windowMs: 15 * MIN },
  confirmAttempts: { limit: 5,  windowMs: 10 * MIN },   // code guesses per (address, email)
  inviteIp:        { limit: 20, windowMs: 15 * MIN },
} as const;

export function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || req.headers.get('x-real-ip')?.trim() || 'unknown';
}

const norm = (email: string) => email.trim().toLowerCase();

type Limit = { limit: number; windowMs: number };
function consume(entries: [string, Limit][]): NextResponse | null {
  for (const [key, l] of entries) {
    const r = checkRateLimit(key, l.limit, l.windowMs);
    if (!r.allowed) return tooManyRequests(r.retryAfterSeconds);
  }
  return null;
}

export type AuthAction = 'login' | 'signup' | 'resend' | 'confirm' | 'invite';

/** Spends one attempt from the limits for this action. Returns the 429 response to send, or null when allowed. */
export function limitAuthAttempt(req: NextRequest, action: AuthAction, email?: string): NextResponse | null {
  const ip = clientIp(req);
  const e = email ? norm(email) : '';
  switch (action) {
    case 'login':   return consume([[`auth:login:ip:${ip}`, AUTH_LIMITS.loginIp]]);
    case 'signup':  return consume([[`auth:signup:ip:${ip}`, AUTH_LIMITS.signupIp], [`auth:signup:email:${e}`, AUTH_LIMITS.signupEmail]]);
    case 'resend':  return consume([[`auth:resend:ip:${ip}`, AUTH_LIMITS.resendIp], [`auth:resend:email:${e}`, AUTH_LIMITS.resendEmail]]);
    case 'confirm': return consume([[`auth:confirm:ip:${ip}`, AUTH_LIMITS.confirmIp], [`auth:confirm:pair:${ip}:${e}`, AUTH_LIMITS.confirmAttempts]]);
    case 'invite':  return consume([[`auth:invite:ip:${ip}`, AUTH_LIMITS.inviteIp]]);
  }
}

const failureKey = (req: NextRequest, email: string) => `auth:login-fail:${clientIp(req)}:${norm(email)}`;

/** True-ish check before trying a password: refuses when this address has already failed too often for this email. */
export function loginLocked(req: NextRequest, email: string): NextResponse | null {
  const { limit, windowMs } = AUTH_LIMITS.loginFailures;
  const p = peekRateLimit(failureKey(req, email), limit, windowMs);
  return p.remaining === 0 ? tooManyRequests(p.resetsInSeconds) : null;
}

export function recordLoginFailure(req: NextRequest, email: string): void {
  const { limit, windowMs } = AUTH_LIMITS.loginFailures;
  checkRateLimit(failureKey(req, email), limit, windowMs);
}

export function clearLoginFailures(req: NextRequest, email: string): void {
  resetRateLimit(failureKey(req, email));
}
