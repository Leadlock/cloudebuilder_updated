/**
 * GET  /api/auth/invite — list the caller's org's pending invites (admin only)
 * POST /api/auth/invite — invite a teammate by email (admin only)
 *
 * There is no outbound email integration yet, so POST returns the accept
 * link directly in the response for the admin to share manually.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, created, badRequest, unauthorized, forbidden, internalError, parseBody } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { orgRepository } from '@/lib/repositories/orgRepository';

export const dynamic = 'force-dynamic';

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']).default('member'),
});

function acceptUrl(req: NextRequest, token: string): string {
  return new URL(`/invite/accept?token=${token}`, req.nextUrl.origin).toString();
}

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized('Authentication required');
    if (identity.role !== 'admin') return forbidden('Administrator role required');

    const orgId = identity.orgIds[0];
    if (!orgId) return ok({ invites: [] });

    const invites = await orgRepository.listPendingOrgInvites(orgId);
    return ok({ invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt })) });
  } catch (err) {
    console.error('[GET /api/auth/invite]', err);
    return internalError();
  }
}

export async function POST(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized('Authentication required');
    if (identity.role !== 'admin') return forbidden('Administrator role required');

    const orgId = identity.orgIds[0];
    if (!orgId) return badRequest('No organization found for the current user');

    const parsed = await parseBody(req, InviteSchema);
    if (!parsed.ok) return parsed.response;

    const invite = await orgRepository.createInvite({
      orgId,
      email: parsed.data.email,
      role: parsed.data.role,
      invitedByUserId: identity.userId,
    });

    return created({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
      acceptUrl: acceptUrl(req, invite.token),
    });
  } catch (err) {
    console.error('[POST /api/auth/invite]', err);
    return internalError();
  }
}
