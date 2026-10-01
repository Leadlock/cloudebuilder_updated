import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ok, badRequest, unauthorized, internalError, apiError, parseBody } from '@/lib/api/response';
import { AuthService } from '@/lib/api/authService';
import { CognitoService } from '@/lib/auth/cognitoService';
import { localLoginFallbackAllowed } from '@/lib/auth/localFallback';
import { clearLoginFailures, limitAuthAttempt, loginLocked, recordLoginFailure } from '@/lib/api/authRateLimit';

export const dynamic = 'force-dynamic';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, LoginSchema);
    if (!parsed.ok) return parsed.response;

    const { email, password } = parsed.data;

    // Rate limits: per client address, and per (address, email) for failed attempts.
    const limited = limitAuthAttempt(req, 'login', email) ?? loginLocked(req, email);
    if (limited) return limited;

    // 1. Try AWS Cognito first
    try {
      const cognitoAuth = await CognitoService.signIn(email, password);
      const user = await AuthService.syncCognitoUser({
        id: cognitoAuth.sub,
        email: cognitoAuth.email,
        name: cognitoAuth.name,
      });

      clearLoginFailures(req, email);
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
      if (cognitoErr.name === 'UserNotConfirmedException') {
        return NextResponse.json({
          success: false,
          requiresConfirmation: true,
          email,
          message: 'Your email is not verified yet. Please enter the verification code sent to your email.',
        }, { status: 200 });
      }

      // Legacy accounts that predate Cognito: tried only when Cognito says it does not know this user or the password
      // is wrong — never because Cognito is down or throttling.
      const user = localLoginFallbackAllowed(cognitoErr?.name) ? await AuthService.authenticate(email, password) : null;
      if (user) {
        clearLoginFailures(req, email);
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

      if (cognitoErr.name === 'NotAuthorizedException' || cognitoErr.name === 'UserNotFoundException') {
        recordLoginFailure(req, email);
        return unauthorized('Invalid email or password');
      }

      // Anything else is a Cognito/service problem: log it, but do not hand its message to the caller.
      console.error('[POST /api/auth/login] Cognito sign-in error:', cognitoErr?.name, cognitoErr?.message);
      return apiError('SERVICE_UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again in a few minutes.', 503);
    }
  } catch (err) {
    console.error('[POST /api/auth/login]', err);
    return internalError();
  }
}
