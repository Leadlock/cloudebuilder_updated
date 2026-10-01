/**
 * CloudCraft Authentication & Session Service
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
 * would have expired anyway. This is held in this server process: with several instances, a revocation takes effect on
 * the instance that handled it (and on all of them once the token expires, at most 24 hours later). Making it global needs
 * a shared store; the check is synchronous on purpose because every request path calls getSession.
 */
const revokedTokens = new Map<string, number>();            // sha256(token) → token expiry (ms)
const revokedBefore = new Map<string, number>();            // userId → sessions issued before this time are invalid
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
  const role: AuthUser['role'] = orgIds[0] && ADMIN_ORG_ROLES.has(orgIds[0].role) ? 'admin' : 'user';
  return { id: user.id, email: user.email, name: user.name ?? user.email, role, orgId };
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
    if (revokedTokens.has(tokenKey(token))) return null;
    const cutoff = revokedBefore.get(payload.sub);
    if (cutoff !== undefined && payload.iat <= cutoff) return null;

    return {
      token,
      user: {
        id: payload.sub, email: payload.email, name: payload.name,
        role: payload.role, orgId: payload.orgId, avatarUrl: payload.avatarUrl,
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
    revokedTokens.set(tokenKey(token), typeof payload.exp === 'number' ? payload.exp : now + SESSION_TTL_MS);
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
