import { NextRequest } from 'next/server';
import { z } from 'zod';
import { internalError, parseBody, ok, apiError } from '@/lib/api/response';
import { CognitoService } from '@/lib/auth/cognitoService';
import { limitAuthAttempt } from '@/lib/api/authRateLimit';

export const dynamic = 'force-dynamic';

const ForgotPasswordSchema = z.object({
  email: z.string().email(),
});

/** Generic response whether or not the account exists, to prevent user enumeration attacks */
const GENERIC_RESPONSE = 'If an account exists with this email address, a password reset verification code has been sent.';

/** Cognito errors that mean "no action needed / user unknown / invalid" — answered with generic success */
const QUIET_ERRORS = new Set(['UserNotFoundException', 'InvalidParameterException', 'NotAuthorizedException']);

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, ForgotPasswordSchema);
    if (!parsed.ok) return parsed.response;

    const { email } = parsed.data;

    // Rate limiting: per IP and per (IP, email)
    const limited = await limitAuthAttempt(req, 'forgot-password', email);
    if (limited) return limited;

    try {
      await CognitoService.forgotPassword(email);
      return ok({
        success: true,
        message: GENERIC_RESPONSE,
        email,
      });
    } catch (cognitoErr: any) {
      const name = cognitoErr?.name;
      if (name && QUIET_ERRORS.has(name)) {
        return ok({
          success: true,
          message: GENERIC_RESPONSE,
          email,
        });
      }

      if (name === 'LimitExceededException' || name === 'TooManyRequestsException') {
        return apiError('TOO_MANY_REQUESTS', 'Attempt limit exceeded. Please wait a few minutes before trying again.', 429);
      }

      console.error('[POST /api/auth/forgot-password] Cognito error:', name, cognitoErr?.message);
      return apiError('SERVICE_UNAVAILABLE', 'Could not initiate password reset right now. Please try again in a few minutes.', 503);
    }
  } catch (err) {
    console.error('[POST /api/auth/forgot-password]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
