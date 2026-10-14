import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { badRequest, unauthorized, internalError, apiError, parseBody } from '@/lib/api/response';
import { AuthService } from '@/lib/api/authService';
import { CognitoService } from '@/lib/auth/cognitoService';
import { fromPublicMethod, toPublicMethod, VERIFICATION_METHODS, type VerificationMethod } from '@/lib/auth/challengeMethods';
import { clearLoginFailures, limitAuthAttempt, loginLocked, recordLoginFailure } from '@/lib/api/authRateLimit';

export const dynamic = 'force-dynamic';

const MfaVerifySchema = z.object({
  email: z.string().email(),
  session: z.string().min(1),
  method: z.enum(VERIFICATION_METHODS as [VerificationMethod, ...VerificationMethod[]]),
  code: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, MfaVerifySchema);
    if (!parsed.ok) return parsed.response;

    const { email, session, method, code } = parsed.data;

    // Rate limits: per client address, and per (address, email) for failed attempts
    const limited = await limitAuthAttempt(req, 'login', email) ?? await loginLocked(req, email);
    if (limited) return limited;

    try {
      const cognitoRes = await CognitoService.respondToMfaChallenge({
        email,
        session,
        challengeName: fromPublicMethod(method),
        code,
      });

      if ('challenge' in cognitoRes && cognitoRes.challenge) {
        return NextResponse.json({
          success: false,
          requiresMfa: true,
          method: toPublicMethod(cognitoRes.challengeName),
          session: cognitoRes.session,
          email: cognitoRes.email,
          message: 'Additional verification step required.',
        }, { status: 200 });
      }

      const user = await AuthService.syncCognitoUser({
        id: cognitoRes.sub,
        email: cognitoRes.email,
        name: cognitoRes.name,
      });

      await clearLoginFailures(req, email);
      const appSession = AuthService.createSession(user);

      const response = NextResponse.json({
        success: true,
        user,
        expiresAt: appSession.expiresAt,
      });

      response.cookies.set({
        name: 'cloudcraft_session',
        value: appSession.token,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 24 * 60 * 60,
      });

      return response;
    } catch (cognitoErr: any) {
      if (
        cognitoErr.name === 'CodeMismatchException' ||
        cognitoErr.name === 'EnableSoftwareTokenMFAException'
      ) {
        await recordLoginFailure(req, email);
        return badRequest('Invalid verification code. Please check your authenticator and try again.');
      }

      if (cognitoErr.name === 'ExpiredCodeException') {
        return badRequest('Verification code has expired. Please sign in again.');
      }

      if (cognitoErr.name === 'NotAuthorizedException') {
        return unauthorized('The session has expired or is invalid. Please sign in again.');
      }

      console.error('[POST /api/auth/mfa/verify] Cognito error:', cognitoErr?.name, cognitoErr?.message);
      return apiError('SERVICE_UNAVAILABLE', 'Verification is temporarily unavailable. Please try again.', 503);
    }
  } catch (err) {
    console.error('[POST /api/auth/mfa/verify]', err);
    return internalError();
  }
}
