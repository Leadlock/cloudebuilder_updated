import type { NextResponse } from 'next/server';
import { apiError } from '@/lib/api/response';
import { canUseRestrictedFeatures, RESTRICTED_FEATURE_MESSAGE } from '@/lib/auth/restrictedFeatures';

/** A 403 when this person may not use the Deploy tab or the AI Generator, otherwise null. Call it right after the caller is identified. */
export function refuseRestrictedFeature(email: unknown): NextResponse | null {
  return canUseRestrictedFeatures(email) ? null : apiError('FORBIDDEN', RESTRICTED_FEATURE_MESSAGE, 403);
}
