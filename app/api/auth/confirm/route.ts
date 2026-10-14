import { refuseDisallowedEmail } from '@/lib/auth/emailDomains';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError, badRequest, internalError, parseBody } from '@/lib/api/response';
import { AuthService } from '@/lib/api/authService';
import { CognitoService } from '@/lib/auth/cognitoService';
import { limitAuthAttempt } from '@/lib/api/authRateLimit';

export const dynamic = 'force-dynamic';

const ConfirmSchema = z.object({
  email: z.string().email(),
  code: z.string().min(1, 'Verification code is required'),
  name: z.string().optional(),
  orgName: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, ConfirmSchema);
    if (!parsed.ok) return parsed.response;

    const { email, code, name, orgName } = parsed.data;
    const notAllowed = refuseDisallowedEmail(email);
    if (notAllowed) return notAllowed;

    // A verification code is short: limit guesses per (address, email) so it cannot be brute-forced.
    const limited = await limitAuthAttempt(req, 'confirm', email);
    if (limited) return limited;

    try {
      await CognitoService.confirmSignUp(email, code);
    } catch (cognitoErr: any) {
      if (cognitoErr.name === 'CodeMismatchException') {
        return badRequest('Invalid verification code. Please check and try again.');
      }
      if (cognitoErr.name === 'ExpiredCodeException') {
        return badRequest('Verification code has expired. Please request a new code.');
      }
      if (cognitoErr.name === 'NotAuthorizedException' && cognitoErr.message?.includes('already confirmed')) {
        // User already confirmed
      } else {
        console.error('[POST /api/auth/confirm] Cognito confirm error:', cognitoErr?.name, cognitoErr?.message);
        return badRequest('Failed to verify the code. Please check it and try again.');
      }
    }

    // Sync user into PostgreSQL database
    const user = await AuthService.syncCognitoUser({
      email,
      name: name || email.split('@')[0],
      orgName: orgName || `${name || email.split('@')[0]}'s Workspace`,
    });

    const session = AuthService.createSession(user);

    const response = NextResponse.json({
      success: true,
      message: 'Account successfully verified!',
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
  } catch (err) {
    console.error('[POST /api/auth/confirm]', err);
    return internalError();
  }
}
