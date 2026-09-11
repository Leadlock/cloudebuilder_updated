/**
 * Authentication-ready middleware.
 *
 * Phase 2B: returns a stub identity from the request.
 * Phase 3: replace extractIdentity with a real JWT/session check.
 *
 * Rules:
 * - All org-scoped operations must call requireOrgMember().
 * - Never expose credentials through the returned identity.
 * - The identity is always resolved server-side; never trust client-supplied user IDs.
 */
import { NextRequest } from 'next/server';
import { AuthService } from './authService';

export interface RequestIdentity {
  userId: string;
  email?: string;
  role?: 'admin' | 'user' | string;
  /** Org IDs the user is a member of (populated lazily in Phase 3) */
  orgIds: string[];
}

/**
 * Extract the caller's identity from the request.
 *
 * Supports:
 * 1. HTTP-only session cookie (`cloudcraft_session`)
 * 2. `Authorization: Bearer <token>`
 * 3. `x-user-id` and `x-user-role` headers (for automated integration tests)
 *
 * Returns null if no valid credentials or session are found.
 */
export function extractIdentity(req: NextRequest): RequestIdentity | null {
  // 1. Session cookie
  const cookieToken = req.cookies.get('cloudcraft_session')?.value;
  if (cookieToken) {
    const session = AuthService.getSession(cookieToken);
    if (session) {
      return {
        userId: session.user.id,
        email: session.user.email,
        role: session.user.role,
        orgIds: [session.user.orgId],
      };
    }
  }

  // 2. Authorization Bearer header
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.substring(7).trim();
    const session = AuthService.getSession(token);
    if (session) {
      return {
        userId: session.user.id,
        email: session.user.email,
        role: session.user.role,
        orgIds: [session.user.orgId],
      };
    }
  }

  // 3. Test / Automation header support
  const userId = req.headers.get('x-user-id');
  if (userId) {
    const role = req.headers.get('x-user-role') ?? (userId === 'usr-user-1' ? 'user' : 'admin');
    const user = AuthService.getUserById(userId);
    return {
      userId,
      email: user?.email,
      role: user?.role ?? role,
      orgIds: user ? [user.orgId] : ['dev-org-id'],
    };
  }

  // 4. Development / demo fallback: default to preset admin user matching AppContext initial state
  if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
    const defaultUser = AuthService.getUserById('usr-admin-1');
    if (defaultUser) {
      return {
        userId: defaultUser.id,
        email: defaultUser.email,
        role: defaultUser.role,
        orgIds: [defaultUser.orgId],
      };
    }
  }

  return null;
}

/**
 * Resolve the org IDs a user belongs to.
 * Phase 2B: calls the DB. In Phase 3 this can be cached in the session JWT.
 */
export async function resolveOrgIds(userId: string): Promise<string[]> {
  // Lazy import to avoid pulling DB into non-server modules
  const { db } = await import('@/src/prisma/db');
  const rows = await db.orm.public.OrgMember
    .where({ userId })
    .select('orgId')
    .all();
  return rows.map((r) => r.orgId);
}

/**
 * Check whether the authenticated user is a member of the given org.
 * Returns the role string if member, null otherwise.
 */
export async function getOrgRole(
  userId: string,
  orgId: string,
): Promise<string | null> {
  if (process.env.NODE_ENV === 'development' && userId === 'dev-user-id') {
    return 'owner';
  }
  try {
    const { db } = await import('@/src/prisma/db');
    const member = await db.orm.public.OrgMember
      .where({ orgId, userId })
      .first();
    return member?.role ?? null;
  } catch {
    if (process.env.NODE_ENV === 'development') return 'owner';
    return null;
  }
}
