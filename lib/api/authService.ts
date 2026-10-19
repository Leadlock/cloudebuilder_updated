/**
 * CloudBuilder Authentication & Session Service
 *
 * Accounts are real, DB-backed rows (see orgRepository) — either a local
 * scrypt-hashed password (lib/crypto/password.ts) or an AWS Cognito
 * identity synced in via syncCognitoUser, see lib/auth/cognitoService.ts.
 *
 * Sessions are stateless, HMAC-signed tokens (lib/crypto/sessionToken.ts) —
 * NOT a server-side store. Previously this held active sessions in an
 * in-memory Map, which only works for a single long-running process; this
 * app now ships a production ECS/Docker deployment target (see
 * Dockerfile), and a Map-backed session doesn't survive across multiple
 * task instances or a restart — it "works" in dev (one process) and then
 * randomly logs users out in production the moment there's more than one
 * instance. A signed, self-contained token needs no shared state at all:
 * any instance holding the same SESSION_SECRET can verify a token no
 * matter which instance minted it.
 */
import { isSuperAdmin, mayDecideReviews } from '@/lib/auth/superAdmins';
import { canUseRestrictedFeatures } from '@/lib/auth/restrictedFeatures';
import { emailAllowed } from '@/lib/auth/emailDomains';
import { isOperatorEmail } from '@/lib/terraform/access/operators';
import { sharedStoreEnabled, warnSharedStore } from './sharedStore';
import { pullRevocations, saveTokenRevocation, saveUserRevocation, PULL_OVERLAP_MS } from './revocationStore';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { hashPassword, verifyPassword } from '@/lib/crypto/password';
import { encodeSessionToken, decodeSessionToken } from '@/lib/crypto/sessionToken';
import { createHash } from 'crypto';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  orgId: string;
  avatarUrl?: string;
  /** Shown in the interface only (the Operator page). Every server check recomputes it from the email: this field is never trusted. */
  operator?: boolean;
  /** Shown in the interface only (whether the Deploy and AI Generator tabs are open). Every server check recomputes it from the email. */
  restrictedFeatures?: boolean;
  /** Shown in the interface only: this person is a super administrator. */
  superAdmin?: boolean;
  /** Shown in the interface only: this person may approve, reject or send back architecture reviews. Every server check recomputes it. */
  canDecideReviews?: boolean;
}

export interface UserSession {
  token: string;
  user: AuthUser;
  createdAt: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Revoked sessions. Tokens are stateless, so "logout" and "sign out everywhere" are remembered here until the token
 * would have expired anyway.
 *
 * The check in getSession is synchronous on purpose (every request path calls it), so it reads these in-memory maps. When
 * the shared store is on (production by default — see sharedStore.ts) they are a copy of the `revokedSession` table:
 * a revocation is written through to the database, and every instance pulls what the others wrote every few seconds
 * (CLOUDBUILDER_REVOCATION_SYNC_MS, default 5000). So a logout reaches all instances within seconds, not "at most 24 hours later".
 * Two honest limits: that delay of a few seconds, and an instance that has only just started answers its very first requests
 * before its first pull completes. If the database is unreachable the maps still work for the revocations this instance
 * knows about, and the problem is logged.
 */
const revokedTokens = new Map<string, number>();            // sha256(token) → token expiry (ms)
const revokedBefore = new Map<string, number>();            // userId → sessions issued before this time are invalid
let lastPullAttempt = 0;
let pulledUntil = 0;                                        // database-clock time of the last successful pull
let pullInFlight = false;
const pendingWrites = new Set<Promise<void>>();
const syncIntervalMs = () => { const n = Number(process.env['CLOUDBUILDER_REVOCATION_SYNC_MS']); return Number.isFinite(n) && n >= 250 ? n : 5_000; };

/** Starts a refresh from the shared store if the last one is old enough. Never blocks and never throws. */
function refreshRevocations(): void {
  if (!sharedStoreEnabled() || pullInFlight) return;
  const now = Date.now();
  if (now - lastPullAttempt < syncIntervalMs()) return;
  lastPullAttempt = now; pullInFlight = true;
  pullRevocations(Math.max(0, pulledUntil - PULL_OVERLAP_MS))
    .then((r) => {
      for (const t of r.tokens) revokedTokens.set(t.id, t.expiresAtMs);
      for (const u of r.users) revokedBefore.set(u.userId, Math.max(revokedBefore.get(u.userId) ?? 0, u.revokedAtMs));
      pulledUntil = r.nowMs;
    })
    .catch((err) => warnSharedStore('session revocations', err))
    .finally(() => { pullInFlight = false; });
}

/** Writes a revocation to the shared store; tracked so the request that caused it can wait for it (flushRevocations). */
function persist(write: () => Promise<void>): void {
  if (!sharedStoreEnabled()) return;
  const p = write().catch((err) => warnSharedStore('saving a session revocation', err)).finally(() => pendingWrites.delete(p));
  pendingWrites.add(p);
}
const tokenKey = (token: string) => createHash('sha256').update(token).digest('hex');
function pruneRevocations(now: number): void {
  for (const [k, exp] of revokedTokens) if (exp < now) revokedTokens.delete(k);
  for (const [u, at] of revokedBefore) if (at + SESSION_TTL_MS < now) revokedBefore.delete(u);
}

/** The shape actually encoded into the signed token — kept minimal and flat. */
interface SessionTokenPayload {
  sub: string;
  email: string;
  name: string;
  role: AuthUser['role'];
  orgId: string;
  avatarUrl?: string;
  iat: number;
  exp: number;
}

/** Org-member roles that grant "admin" in this app's simpler admin/user model. */
const ADMIN_ORG_ROLES = new Set(['owner', 'admin']);

async function toAuthUser(user: { id: string; email: string; name: string | null }): Promise<AuthUser> {
  const orgIds = await orgRepository_resolveOrgIds(user.id);
  const orgId = orgIds[0]?.orgId ?? '';
  // A super administrator is an administrator of the organization they belong to.
  const role: AuthUser['role'] = isSuperAdmin(user.email) || (orgIds[0] && ADMIN_ORG_ROLES.has(orgIds[0].role)) ? 'admin' : 'user';
  return { id: user.id, email: user.email, name: user.name ?? user.email, role, orgId, operator: await isOperatorEmail(user.email), restrictedFeatures: canUseRestrictedFeatures(user.email), superAdmin: isSuperAdmin(user.email), canDecideReviews: mayDecideReviews(user.email, role) };
}

// Lazily imported to avoid a hard dependency cycle at module init.
async function orgRepository_resolveOrgIds(userId: string): Promise<{ orgId: string; role: string }[]> {
  const { db } = await import('@/src/prisma/db');
  const rows = await db.orm.public.OrgMember.where({ userId }).select('orgId', 'role').all();
  return rows;
}

export class AuthService {
  /**
   * Validate credentials against the DB and return the AuthUser if correct.
   * Always runs verifyPassword (even for a nonexistent user, against a dummy
   * hash) so the response time doesn't reveal whether the email exists.
   */
  static async authenticate(email: string, password: string): Promise<AuthUser | null> {
    const found = await orgRepository.findUserByEmailForAuth(email);
    const stored = found?.passwordHash ?? DUMMY_HASH;
    const valid = await verifyPassword(password, stored);
    if (!found || !found.passwordHash || !valid) return null;

    return toAuthUser(found);
  }

  /**
   * Create a new session for an authenticated user — a signed, stateless
   * token; nothing is written to a store, so this never fails or blocks
   * on I/O.
   */
  static createSession(user: AuthUser): UserSession {
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    const payload: SessionTokenPayload = {
      sub: user.id, email: user.email, name: user.name, role: user.role,
      orgId: user.orgId, avatarUrl: user.avatarUrl,
      iat: now, exp: expiresAt,
    };
    const token = encodeSessionToken(payload as unknown as Record<string, unknown>);
    return { token, user, createdAt: now, expiresAt };
  }

  /**
   * Resolve session by token — verifies the HMAC signature and expiry.
   * Unknown/tampered/expired tokens simply miss; no store to consult, so
   * this is synchronous and needs no shared state across instances.
   */
  static getSession(token: string): UserSession | null {
    const payload = decodeSessionToken<SessionTokenPayload>(token);
    if (!payload) return null;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    if (!payload.sub || !payload.email) return null;
    refreshRevocations();
    if (revokedTokens.has(tokenKey(token))) return null;
    const cutoff = revokedBefore.get(payload.sub);
    if (cutoff !== undefined && payload.iat <= cutoff) return null;
    // A person who signed in before the allowed domains were set (or whose domain was removed) is signed out at once.
    if (!emailAllowed(payload.email)) return null;

    return {
      token,
      user: {
        id: payload.sub, email: payload.email, name: payload.name,
        role: isSuperAdmin(payload.email) ? 'admin' : payload.role, orgId: payload.orgId, avatarUrl: payload.avatarUrl,
      },
      createdAt: payload.iat,
      expiresAt: payload.exp,
    };
  }

  /**
   * Logout: remembers this token as revoked until it would have expired anyway, so a copied or stolen token stops working
   * too — not just the browser's cookie. Returns false for something that is not a valid session token.
   * The list is held in this server process (see `revokedTokens` above for the multi-instance caveat).
   */
  static revokeSession(token: string): boolean {
    const payload = decodeSessionToken<SessionTokenPayload>(token);
    if (!payload) return false;           // not a valid token: nothing to revoke
    const now = Date.now();
    pruneRevocations(now);
    const expiresAt = typeof payload.exp === 'number' ? payload.exp : now + SESSION_TTL_MS;
    revokedTokens.set(tokenKey(token), expiresAt);
    persist(() => saveTokenRevocation(tokenKey(token), expiresAt));
    return true;
  }

  /**
   * "Sign out everywhere": every session this user already has stops working, and only sessions issued after this call
   * are valid. Use after a password reset or a suspected account compromise. Same process-local caveat as revokeSession.
   */
  static revokeAllSessionsForUser(userId: string): void {
    const now = Date.now();
    pruneRevocations(now);
    revokedBefore.set(userId, now);       // every session issued up to now stops working
    persist(() => saveUserRevocation(userId, SESSION_TTL_MS));
  }

  /** Waits until revocations made so far are stored in the shared store (a logout request awaits this before it answers). */
  static async flushRevocations(): Promise<void> {
    await Promise.allSettled([...pendingWrites]);
  }

  /**
   * Get user by ID, DB-backed.
   */
  static async getUserById(id: string): Promise<AuthUser | null> {
    const user = await orgRepository.findUser(id);
    if (!user) return null;
    return toAuthUser(user);
  }

  /**
   * Sync a Cognito authenticated user into the local database and return the AuthUser profile.
   */
  static async syncCognitoUser(input: { id?: string; email: string; name?: string; orgName?: string }): Promise<AuthUser> {
    const dbUser = await orgRepository.syncCognitoUser(input);
    return toAuthUser(dbUser);
  }

  /**
   * Hash a new password for signup / invite-acceptance.
   */
  static async hashPassword(password: string): Promise<string> {
    return hashPassword(password);
  }
}

// A syntactically valid but unusable stored-hash shape, used as the compare
// target when the email doesn't exist — keeps authenticate()'s timing
// consistent between "no such user" and "wrong password".
const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;
