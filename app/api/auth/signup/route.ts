/**
 * POST /api/auth/signup — create a new account and a new organization owned by it.
 *
 * Joining an existing org happens through an invite (see /api/auth/invite/accept),
 * not through signup — signup always creates a fresh org with the new user as owner.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, badRequest, internalError, parseBody } from '@/lib/api/response';
import { AuthService } from '@/lib/api/authService';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { isPasswordStrongEnough } from '@/lib/crypto/password';

export const dynamic = 'force-dynamic';

const SignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1).max(120),
  orgName: z.string().min(1).max(120),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, SignupSchema);
    if (!parsed.ok) return parsed.response;

    const { email, password, name, orgName } = parsed.data;

    if (!isPasswordStrongEnough(password)) {
      return badRequest('Password must be at least 8 characters');
    }

    const existing = await orgRepository.findUserByEmailForAuth(email);
    if (existing) {
      return apiError('CONFLICT', 'An account with this email already exists', 409);
    }

    const passwordHash = await AuthService.hashPassword(password);
    const dbUser = await orgRepository.createUserWithPassword({ email, name, passwordHash });
    const org = await orgRepository.createOrgForSignup(orgName);
    await orgRepository.addMember(org.id, dbUser.id, 'owner');

    const user = { id: dbUser.id, email: dbUser.email, name, role: 'admin' as const, orgId: org.id };
    const session = AuthService.createSession(user);

    const response = NextResponse.json({
      success: true,
      user,
      token: session.token,
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
    console.error('[POST /api/auth/signup]', err);
    return internalError();
  }
}
