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
   * Stateless tokens can't be individually revoked server-side — there is
   * no store to remove an entry from, only the token's own expiry. This
   * matches how the Cognito ID tokens layered on top of this already
   * behave (see lib/auth/cognitoService.ts): both are bearer credentials
   * valid until they expire, not until something revokes them. Logout's
   * real effect is clearing the cookie so the browser stops sending it
   * (see app/api/auth/logout/route.ts) — a copied/stolen token would still
   * verify elsewhere until it naturally expires (≤24h), the standard
   * tradeoff for any stateless-token design without a revocation list.
   * Returns true unconditionally so existing call sites don't need to
   * change behavior on the return value.
   */
  static revokeSession(_token: string): boolean {
    return true;
  }

  /**
   * Same stateless-token caveat as revokeSession — there is no per-user
   * session set to walk and delete from. Not currently called anywhere;
   * kept as a documented no-op rather than removed, so a future caller
   * gets a clear explanation instead of a missing method.
   */
  static revokeAllSessionsForUser(_userId: string): void {
    // No-op — see revokeSession's doc comment for why.
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
