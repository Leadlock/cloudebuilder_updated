import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { badRequest, internalError, apiError, parseBody } from '@/lib/api/response';
import { CognitoService } from '@/lib/auth/cognitoService';

export const dynamic = 'force-dynamic';

const MfaSetupSchema = z.object({
  session: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseBody(req, MfaSetupSchema);
    if (!parsed.ok) return parsed.response;

    const { session } = parsed.data;

    try {
      const res = await CognitoService.associateSoftwareToken(session);
      return NextResponse.json({
        success: true,
        secretCode: res.secretCode,
        session: res.session,
      });
    } catch (cognitoErr: any) {
      console.error('[POST /api/auth/mfa/setup] Cognito error:', cognitoErr?.name, cognitoErr?.message);
      return apiError('MFA_SETUP_FAILED', 'Failed to initialize authenticator setup. Please try signing in again.', 400);
    }
  } catch (err) {
    console.error('[POST /api/auth/mfa/setup]', err);
    return internalError();
  }
}
