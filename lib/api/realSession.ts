/**
 * The session behind a request, or null. Only a real login counts: a valid session cookie or `Authorization: Bearer` token that
 * AuthService knows. There is no stand-in identity in any environment (not under `next dev`, not for a header such as `x-user-id`, not for an
 * environment flag): a stand-in made every unauthenticated caller an admin of a shared "dev" user, who could then spend the LLM budget
 * and write into the dev organization.
 */
import type { NextRequest } from 'next/server';
import { AuthService } from './authService';

export function realSession(req: NextRequest) {
  const cookieToken = req.cookies.get('cloudcraft_session')?.value;
  const authHeader = req.headers.get('authorization');
  const bearerToken = authHeader?.toLowerCase().startsWith('bearer ') ? authHeader.substring(7).trim() : null;
  const token = cookieToken || bearerToken;
  const found = token ? AuthService.getSession(token) : null;
  return found?.user?.id ? found : null;
}
