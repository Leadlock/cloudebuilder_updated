import { NextRequest } from 'next/server';
import { ok, unauthorized, forbidden, internalError } from '@/lib/api/response';
import { extractIdentity } from '@/lib/api/auth';
import { AuthService } from '@/lib/api/authService';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const identity = extractIdentity(req);
    if (!identity) return unauthorized('Authentication required');

    if (identity.role !== 'admin') {
      return forbidden('Access denied. Administrator role required.');
    }

    const users = AuthService.listUsers();
    return ok({ users });
  } catch (err) {
    console.error('[GET /api/admin/users]', err);
    return internalError();
  }
}
