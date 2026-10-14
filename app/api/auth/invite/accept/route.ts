/**
 * POST /api/auth/invite/accept — accept an org invite by token.
 *
 * If the invitee already has an account, only membership is added (the
 * invite token itself is the proof of access — no password re-entry needed,
 * same as a typical email magic-link flow). If they don't have an account
 * yet, `password` and `name` are required to create one in the same request.
 */
import { refuseDisallowedEmail } from '@/lib/auth/emailDomains';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, badRequest, internalError, parseBody } from '@/lib/api/response';
import { AuthService } from '@/lib/api/authService';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { isPasswordStrongEnough } from '@/lib/crypto/password';
import { limitAuthAttempt } from '@/lib/api/authRateLimit';

export const dynamic = 'force-dynamic';

const AcceptSchema = z.object({
  token: z.string().min(1),
  password: z.string().optional(),
  name: z.string().min(1).max(120).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, AcceptSchema);
    if (!parsed.ok) return parsed.response;
    const { token, password, name } = parsed.data;

    // Invite tokens are random, but the route also sets passwords: keep guessing and scripted use in check.
    const limited = await limitAuthAttempt(req, 'invite');
    if (limited) return limited;

    const invite = await orgRepository.findInviteByToken(token);
    if (!invite) return badRequest('Invalid or unknown invite link');
    if (invite.acceptedAt) return apiError('CONFLICT', 'This invite has already been accepted', 409);
    if (new Date(invite.expiresAt).getTime() < Date.now()) {
      return apiError('CONFLICT', 'This invite has expired', 409);
    }

    const notAllowed = refuseDisallowedEmail(invite.email);
    if (notAllowed) return notAllowed;

    let dbUser = await orgRepository.findUserByEmailForAuth(invite.email);

    if (!dbUser) {
      if (!password || !name) {
        return badRequest('New accounts must provide a name and password to accept an invite');
      }
      if (!isPasswordStrongEnough(password)) {
        return badRequest('Password must be at least 8 characters');
      }
      const passwordHash = await AuthService.hashPassword(password);
      dbUser = { ...(await orgRepository.createUserWithPassword({ email: invite.email, name, passwordHash })), passwordHash };
    }

    await orgRepository.addMember(invite.orgId, dbUser.id, invite.role);
    await orgRepository.markInviteAccepted(token);

    const authUser = await AuthService.getUserById(dbUser.id);
    if (!authUser) return internalError();

    const session = AuthService.createSession(authUser);

    const response = NextResponse.json({
      success: true,
      user: authUser,
      expiresAt: session.expiresAt,
    });

    response.cookies.set({
      name: 'cloudcraft_session',
      value: session.token,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 24 * 60 * 60,
    });

    return response;
  } catch (err) {
    console.error('[POST /api/auth/invite/accept]', err);
    return internalError();
  }
}
