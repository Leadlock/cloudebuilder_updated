/**
 * CloudCraft Authentication & Session Service
 *
 * Accounts are real, DB-backed rows (see orgRepository) with scrypt-hashed
 * passwords — see lib/crypto/password.ts. Sessions are opaque random tokens
 * held in an in-memory registry (attached to globalThis so they survive
 * Next.js dev rebuilds); they do not survive a process restart, which is an
 * accepted tradeoff at this stage — see lib/repositories/orgRepository.ts
 * for the durable data these sessions merely authenticate access to.
 *
 * Session tokens are cryptographically random (32 bytes) and are never
 * derivable from a user id — unlike an earlier version of this file, a
 * cache-miss on a token does NOT reconstruct a session from the token's own
 * bytes, since that made sessions forgeable by anyone who could guess or
 * enumerate a user id.
 */
import { randomBytes } from 'crypto';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { hashPassword, verifyPassword } from '@/lib/crypto/password';

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

// In-memory active session registry (attached to globalThis to survive Next.js dev rebuilds)
const globalForAuth = globalThis as unknown as {
  __cloudcraft_sessions?: Map<string, UserSession>;
};
const SESSIONS = globalForAuth.__cloudcraft_sessions ?? new Map<string, UserSession>();
if (process.env.NODE_ENV !== 'production') {
  globalForAuth.__cloudcraft_sessions = SESSIONS;
}
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
   * Create a new session for an authenticated user.
   */
  static createSession(user: AuthUser): UserSession {
    const token = `cc_sess_${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    const session: UserSession = {
      token,
      user,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    SESSIONS.set(token, session);
    return session;
  }

  /**
   * Resolve session by token, validating expiration. Unknown tokens
   * (including forged ones) simply miss — no fallback reconstruction.
   */
  static getSession(token: string): UserSession | null {
    const session = SESSIONS.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      SESSIONS.delete(token);
      return null;
    }
    return session;
  }

  /**
   * Revoke an existing session.
   */
  static revokeSession(token: string): boolean {
    return SESSIONS.delete(token);
  }

  /**
   * Revoke every active session belonging to a user (e.g. on password change).
   */
  static revokeAllSessionsForUser(userId: string): void {
    for (const [token, session] of SESSIONS) {
      if (session.user.id === userId) SESSIONS.delete(token);
    }
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
