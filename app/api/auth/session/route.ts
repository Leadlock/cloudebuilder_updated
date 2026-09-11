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

    const user = AuthService.getUserById(identity.userId) ?? {
      id: identity.userId,
      email: identity.email ?? 'user@cloudcraft.io',
      name: identity.role === 'admin' ? 'Cloud Administrator' : 'DevOps Engineer',
      role: (identity.role as 'admin' | 'user') ?? 'user',
      orgId: identity.orgIds[0] ?? 'org-cloudcraft-prod',
    };

    return ok({
      authenticated: true,
      user,
    });
  } catch (err) {
    console.error('[GET /api/auth/session]', err);
    return internalError();
  }
}
