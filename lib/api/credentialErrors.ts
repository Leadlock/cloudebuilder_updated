import type { NextResponse } from 'next/server';
import { apiError } from '@/lib/api/response';
import { CredentialsExpiredError } from '@/lib/cloud/credentialLifetime';

/**
 * A request that needs credentials whose time is up gets a plain "expired, connect again" answer (HTTP 410 Gone), not a 500.
 * Returns null for any other error, so a route's own handling carries on.
 */
export function credentialsExpiredResponse(err: unknown): NextResponse | null {
  if (!(err instanceof CredentialsExpiredError)) return null;
  return apiError('CREDENTIALS_EXPIRED', err.message, 410);
}
