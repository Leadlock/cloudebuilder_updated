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

export interface RequestIdentity {
  userId: string;
  /** Org IDs the user is a member of (populated lazily in Phase 3) */
  orgIds: string[];
}

/**
 * Extract the caller's identity from the request.
 *
 * Phase 2B stub: reads a `x-user-id` header so the API is exercisable
 * without a full auth stack. Replace the body with a real session check before
 * going to production.
 */
export function extractIdentity(req: NextRequest): RequestIdentity | null {
  // Phase 2B: accept a dev header to simulate authenticated users.
  // In production this header must be removed by the edge/gateway.
  const userId =
    req.headers.get('x-user-id') ??
    // Fall back to a well-known dev user so the frontend stays functional.
    (process.env.NODE_ENV === 'development' ? 'dev-user-id' : null);

  if (!userId) return null;
  return { userId, orgIds: [] };
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
