import { NextRequest } from 'next/server';
import { ok, unauthorized, internalError } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { AuthService } from '@/lib/api/authService';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) {
      return unauthorized('No active session found');
    }

    const user = await AuthService.getUserById(identity.userId);
    if (!user) {
      return unauthorized('No active session found');
    }

    return ok({
      authenticated: true,
      user,
    });
  } catch (err) {
    console.error('[GET /api/auth/session]', err);
    return internalError();
  }
}
