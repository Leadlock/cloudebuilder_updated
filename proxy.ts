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
  if (isCrossSiteWrite(request)) {
    return NextResponse.json(
      { ok: false, error: { code: 'FORBIDDEN', message: 'This request came from another website, so it was refused.' } },
      { status: 403 },
    );
  }
  return NextResponse.next();
}

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * A web page on another site can make a signed-in person's browser send a request to this one. The session cookie is SameSite=Lax, which already stops the
 * ordinary form attack; this is the second layer, for browsers and set-ups where Lax is not enough (a sibling subdomain, an older browser).
 *
 * Only writes made with the session cookie are looked at: a request with its own API key or bearer token cannot be forged by a web page, and a GET never changes anything.
 *  - the browser's own Sec-Fetch-Site says "cross-site": refused;
 *  - it says "same-site" (another subdomain of the same domain): refused unless the Origin is this site (or listed in CLOUDBUILDER_ALLOWED_ORIGINS);
 *  - a browser too old to send it: the Origin, when there is one, must be this site. No Origin at all means not a browser page (curl, a script): allowed.
 * "same-origin" and "none" (typed address, bookmark) always pass, so the normal use of the app never depends on how a reverse proxy passes the host name on.
 */
export function isCrossSiteWrite(request: NextRequest): boolean {
  if (!WRITES.has(request.method)) return false;
  const h = request.headers;
  if (h.get('authorization') || h.get('x-api-key')) return false;
  const site = h.get('sec-fetch-site');
  if (site === 'cross-site') return true;
  if (site === 'same-origin' || site === 'none') return false;
  const origin = h.get('origin');
  if (!origin) return false;
  if (origin === 'null') return true;
  let originHost: string;
  try { originHost = new URL(origin).host.toLowerCase(); } catch { return true; }
  const own = [h.get('x-forwarded-host'), h.get('host'), request.nextUrl.host]
    .flatMap((v) => (v ? v.split(',') : []))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const allowed = (process.env['CLOUDBUILDER_ALLOWED_ORIGINS'] ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)
    .map((v) => { try { return new URL(v).host; } catch { return v; } });
  return !own.includes(originHost) && !allowed.includes(originHost);
}

export const config = {
  matcher: '/api/:path*',
};
