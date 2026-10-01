import { NextRequest } from 'next/server';
import { z } from 'zod';
import { internalError, parseBody, ok, apiError } from '@/lib/api/response';
import { CognitoService } from '@/lib/auth/cognitoService';
import { limitAuthAttempt } from '@/lib/api/authRateLimit';

export const dynamic = 'force-dynamic';

const ResendSchema = z.object({
  email: z.string().email(),
});

/** Same answer whether or not the address is registered, so this route cannot be used to find out who has an account. */
const GENERIC = 'If this email address is waiting for verification, a new code has been sent.';
/** Cognito errors that only mean "nothing to resend for this address" — answered with the generic message. */
const QUIET_ERRORS = new Set(['UserNotFoundException', 'InvalidParameterException', 'NotAuthorizedException']);

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, ResendSchema);
    if (!parsed.ok) return parsed.response;

    const { email } = parsed.data;
    const limited = limitAuthAttempt(req, 'resend', email);
    if (limited) return limited;

    try {
      await CognitoService.resendConfirmationCode(email);
      return ok({ success: true, message: GENERIC });
    } catch (cognitoErr) {
      const name = (cognitoErr as { name?: string })?.name;
      if (name && QUIET_ERRORS.has(name)) return ok({ success: true, message: GENERIC });
      // Log the cause; do not hand Cognito's wording to the caller.
      console.error('[POST /api/auth/resend-code]', name, (cognitoErr as Error)?.message);
      return apiError('SERVICE_UNAVAILABLE', 'Could not send a new code right now. Please try again in a few minutes.', 503);
    }
  } catch (err) {
    console.error('[POST /api/auth/resend-code]', err instanceof Error ? err.message : String(err));
    return internalError();
  }
}
