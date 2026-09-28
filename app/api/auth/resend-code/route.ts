import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { badRequest, internalError, parseBody, ok } from '@/lib/api/response';
import { CognitoService } from '@/lib/auth/cognitoService';

export const dynamic = 'force-dynamic';

const ResendSchema = z.object({
  email: z.string().email(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, ResendSchema);
    if (!parsed.ok) return parsed.response;

    const { email } = parsed.data;

    try {
      await CognitoService.resendConfirmationCode(email);
      return ok({ success: true, message: 'Verification code resent successfully.' });
    } catch (cognitoErr: any) {
      console.error('[POST /api/auth/resend-code] Error:', cognitoErr);
      return badRequest(cognitoErr.message || 'Failed to resend verification code.');
    }
  } catch (err) {
    console.error('[POST /api/auth/resend-code]', err);
    return internalError();
  }
}
