import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Runs before every /api request. A NUL character (%00) in the URL is never valid and the database refuses it, which used to surface as a
 * 500 "Internal server error" from ten different routes (an id such as /api/projects/%00, or ?env=%00). It is answered here, once, with a
 * clear 400 in the same shape every other API error has, before any route or query runs.
 */
export function proxy(request: NextRequest) {
  if (/%00|\u0000/i.test(request.url)) {
    return NextResponse.json(
      { ok: false, error: { code: 'BAD_REQUEST', message: 'The request URL contains an invalid character.' } },
      { status: 400 },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
