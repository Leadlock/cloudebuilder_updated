/**
 * CloudCraft Authentication & Session Service
 *
 * Implements session-based and token-based authentication with RBAC (User vs Admin).
 * Pre-configured accounts for testing & production:
 * - Admin: admin@cloudcraft.io / Admin123! (Role: admin)
 * - User:  user@cloudcraft.io  / User123!  (Role: user)
 */

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

const PRESET_USERS: (AuthUser & { passwordHash: string })[] = [
  {
    id: 'usr-admin-1',
    email: 'admin@cloudcraft.io',
    name: 'Cloud Administrator',
    role: 'admin',
    orgId: 'org-cloudcraft-prod',
    // Demo password: Admin123!
    passwordHash: 'Admin123!',
  },
  {
    id: 'usr-user-1',
    email: 'user@cloudcraft.io',
    name: 'DevOps Engineer',
    role: 'user',
    orgId: 'org-cloudcraft-prod',
    // Demo password: User123!
    passwordHash: 'User123!',
  },
];

// In-memory active session registry (attached to globalThis to survive Next.js dev rebuilds)
const globalForAuth = globalThis as unknown as {
  __cloudcraft_sessions?: Map<string, UserSession>;
};
const SESSIONS = globalForAuth.__cloudcraft_sessions ?? new Map<string, UserSession>();
if (process.env.NODE_ENV !== 'production') {
  globalForAuth.__cloudcraft_sessions = SESSIONS;
}
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class AuthService {
  /**
   * Validate credentials and return AuthUser if correct
   */
  static authenticate(email: string, password: string): AuthUser | null {
    const normalized = email.trim().toLowerCase();
    const found = PRESET_USERS.find((u) => u.email.toLowerCase() === normalized);
    if (!found) return null;
    if (found.passwordHash !== password) return null;

    const { passwordHash: _, ...safeUser } = found;
    return safeUser;
  }

  /**
   * Create a new session for an authenticated user
   */
  static createSession(user: AuthUser): UserSession {
    const token = `cc_sess_${Buffer.from(`${user.id}:${Date.now()}:${Math.random().toString(36).substring(2)}`).toString('base64url')}`;
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
   * Resolve session by token, validating expiration and self-recovering across server reloads
   */
  static getSession(token: string): UserSession | null {
    let session = SESSIONS.get(token);
    if (!session && token.startsWith('cc_sess_')) {
      try {
        const raw = token.slice('cc_sess_'.length);
        const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
        const [userId, createdAtStr] = decoded.split(':');
        const createdAt = parseInt(createdAtStr, 10);
        if (userId && !isNaN(createdAt) && Date.now() - createdAt < SESSION_TTL_MS) {
          const user = AuthService.getUserById(userId);
          if (user) {
            session = {
              token,
              user,
              createdAt,
              expiresAt: createdAt + SESSION_TTL_MS,
            };
            SESSIONS.set(token, session);
          }
        }
      } catch {
        // ignore invalid token format
      }
    }
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      SESSIONS.delete(token);
      return null;
    }
    return session;
  }

  /**
   * Revoke an existing session
   */
  static revokeSession(token: string): boolean {
    return SESSIONS.delete(token);
  }

  /**
   * Get user by ID
   */
  static getUserById(id: string): AuthUser | null {
    const found = PRESET_USERS.find((u) => u.id === id);
    if (!found) return null;
    const { passwordHash: _, ...safeUser } = found;
    return safeUser;
  }

  /**
   * List users (Admin only)
   */
  static listUsers(): AuthUser[] {
    return PRESET_USERS.map(({ passwordHash: _, ...safeUser }) => safeUser);
  }
}
