import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, badRequest, internalError, ok, parseBody } from '@/lib/api/response';
import { CognitoService } from '@/lib/auth/cognitoService';
import { AuthService } from '@/lib/api/authService';
import { orgRepository } from '@/lib/repositories/orgRepository';
import { clearLoginFailures, limitAuthAttempt } from '@/lib/api/authRateLimit';

export const dynamic = 'force-dynamic';

const ResetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().min(1, 'Verification code is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, ResetPasswordSchema);
    if (!parsed.ok) return parsed.response;

    const { email, code, newPassword } = parsed.data;

    // Rate limiting: per IP and per (IP, email) attempt pairs
    const limited = await limitAuthAttempt(req, 'reset-password', email);
    if (limited) return limited;

    try {
      await CognitoService.confirmForgotPassword({
        email,
        code,
        newPassword,
      });
    } catch (cognitoErr: any) {
      const name = cognitoErr?.name;
      if (name === 'CodeMismatchException') {
        return badRequest('Invalid verification code. Please check and try again.');
      }
      if (name === 'ExpiredCodeException') {
        return badRequest('Verification code has expired. Please request a new code.');
      }
      if (name === 'InvalidPasswordException') {
        return badRequest('Password does not meet the security requirements (min 8 characters).');
      }
      if (name === 'UserNotFoundException') {
        return badRequest('No account found with this email address.');
      }
      if (name === 'LimitExceededException' || name === 'TooManyRequestsException') {
        return apiError('TOO_MANY_REQUESTS', 'Attempt limit exceeded. Please wait a few minutes before trying again.', 429);
      }

      console.error('[POST /api/auth/reset-password] Cognito confirmForgotPassword error:', name, cognitoErr?.message);
      return badRequest('Failed to reset password. Please check your verification code and try again.');
    }

    // If account exists in local PostgreSQL database, update the local password hash as well
    try {
      const passwordHash = await AuthService.hashPassword(newPassword);
      await orgRepository.updatePassword(email, passwordHash);
    } catch (dbErr) {
      console.warn('[POST /api/auth/reset-password] Local password sync note:', dbErr);
    }

    // Reset login lockouts if any
    await clearLoginFailures(req, email);

    return ok({
      success: true,
      message: 'Password has been reset successfully! You can now sign in with your new password.',
    });
  } catch (err) {
    console.error('[POST /api/auth/reset-password]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
