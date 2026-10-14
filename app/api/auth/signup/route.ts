/**
 * POST /api/auth/signup — create a new account and a new organization owned by it.
 *
 * Joining an existing org happens through an invite (see /api/auth/invite/accept),
 * not through signup — signup always creates a fresh org with the new user as owner.
 */
import { refuseDisallowedEmail } from '@/lib/auth/emailDomains';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, badRequest, internalError, parseBody } from '@/lib/api/response';
import { AuthService } from '@/lib/api/authService';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { isPasswordStrongEnough } from '@/lib/crypto/password';
import { CognitoService } from '@/lib/auth/cognitoService';
import { hideVendorNames } from '@/lib/api/vendorNames';
import { localSignupAllowed } from '@/lib/auth/localFallback';
import { limitAuthAttempt } from '@/lib/api/authRateLimit';

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
    const notAllowed = refuseDisallowedEmail(email);
    if (notAllowed) return notAllowed;

    const limited = await limitAuthAttempt(req, 'signup', email);
    if (limited) return limited;

    if (!isPasswordStrongEnough(password)) {
      return badRequest('Password must be at least 8 characters');
    }

    // 1. Try registering with AWS Cognito
    try {
      const cognitoRes = await CognitoService.signUp({ email, password, name });

      if (!cognitoRes.isConfirmed) {
        return NextResponse.json({
          success: true,
          requiresConfirmation: true,
          email,
          name,
          orgName,
          message: 'Verification code sent to your email address.',
        });
      }

      // If automatically confirmed:
      const user = await AuthService.syncCognitoUser({
        id: cognitoRes.userSub,
        email,
        name,
        orgName,
      });

      const session = AuthService.createSession(user);

      const response = NextResponse.json({
        success: true,
        user,
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
    } catch (cognitoErr: any) {
      if (cognitoErr.name === 'UsernameExistsException') {
        return apiError('CONFLICT', 'An account with this email already exists', 409);
      }
      if (cognitoErr.name === 'InvalidPasswordException') {
        return badRequest(hideVendorNames(cognitoErr.message || 'Password does not meet the password requirements'));
      }

      // Never fall back to an unverified local account: that would let anyone register an email address they do not own.
      console.error('[POST /api/auth/signup] Cognito error:', cognitoErr?.name, cognitoErr?.message);
      if (!localSignupAllowed()) {
        return apiError('SERVICE_UNAVAILABLE', 'Sign-up is temporarily unavailable. Please try again in a few minutes.', 503);
      }

      // Local fallback if Cognito fails
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
    }
  } catch (err) {
    console.error('[POST /api/auth/signup]', err);
    return internalError();
  }
}
