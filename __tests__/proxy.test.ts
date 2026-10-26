/**
 * proxy.ts: a NUL character in an API URL is a 400, never a 500 from the database.
 */
import { NextRequest } from 'next/server';
import { proxy, config } from '@/proxy';

const call = (path: string) => proxy(new NextRequest(`http://localhost${path}`));

const send = (method: string, headers: Record<string, string> = {}, path = '/api/projects/p1/versions') => proxy(new NextRequest(`https://app.example.com${path}`, { method, headers: { host: 'app.example.com', ...headers } }));
const blocked = (r: Response) => r.status === 403;

describe('writes from another website', () => {
  test('are refused when the browser says the request is cross-site, whatever the Origin says', async () => {
    const res = send('POST', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(blocked(res)).toBe(true);
    expect(await res.json()).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'This request came from another website, so it was refused.' } });
    expect(blocked(send('DELETE', { 'sec-fetch-site': 'cross-site', origin: 'https://app.example.com' }))).toBe(true);   // the header is the browser's word, not the page's
    for (const m of ['PUT', 'PATCH']) expect(blocked(send(m, { 'sec-fetch-site': 'cross-site' }))).toBe(true);
  });

  test('the normal use of the app is never refused: same-origin, typed address, and no dependence on how the host name arrives', () => {
    expect(blocked(send('POST', { 'sec-fetch-site': 'same-origin', origin: 'https://app.example.com' }))).toBe(false);
    expect(blocked(send('POST', { 'sec-fetch-site': 'same-origin', origin: 'https://something-else-behind-a-proxy' }))).toBe(false);
    expect(blocked(send('POST', { 'sec-fetch-site': 'none' }))).toBe(false);
  });

  test('a sibling subdomain (same-site) is refused unless its Origin is this site or is listed', () => {
    expect(blocked(send('POST', { 'sec-fetch-site': 'same-site', origin: 'https://other.example.com' }))).toBe(true);
    expect(blocked(send('POST', { 'sec-fetch-site': 'same-site', origin: 'https://app.example.com' }))).toBe(false);
    process.env['CLOUDBUILDER_ALLOWED_ORIGINS'] = 'https://tools.example.com, other.example.com';
    try {
      expect(blocked(send('POST', { 'sec-fetch-site': 'same-site', origin: 'https://other.example.com' }))).toBe(false);
      expect(blocked(send('POST', { 'sec-fetch-site': 'same-site', origin: 'https://tools.example.com' }))).toBe(false);
      expect(blocked(send('POST', { 'sec-fetch-site': 'same-site', origin: 'https://evil.example' }))).toBe(true);
    } finally { delete process.env['CLOUDBUILDER_ALLOWED_ORIGINS']; }
  });

  test('an older browser (no Sec-Fetch-Site) is judged by its Origin; no Origin means not a web page', () => {
    expect(blocked(send('POST', { origin: 'https://evil.example' }))).toBe(true);
    expect(blocked(send('POST', { origin: 'null' }))).toBe(true);
    expect(blocked(send('POST', { origin: 'not a url' }))).toBe(true);
    expect(blocked(send('POST', { origin: 'https://app.example.com' }))).toBe(false);
    expect(blocked(send('POST', { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example, app.example.com' }))).toBe(false);   // behind a proxy
    expect(blocked(send('POST'))).toBe(false);                                                                                         // curl, a script
  });

  test('requests with their own credential, and reads, are not touched', () => {
    expect(blocked(send('POST', { 'sec-fetch-site': 'cross-site', authorization: 'Bearer cb_x' }))).toBe(false);
    expect(blocked(send('POST', { 'sec-fetch-site': 'cross-site', 'x-api-key': 'cb_x' }))).toBe(false);
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(blocked(send(m, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }))).toBe(false);
  });
});

describe('proxy', () => {
  test.each([
    '/api/projects/%00',
    '/api/projects/abc%00def/canvas',
    '/api/projects/p1/canvas?env=%00',
    '/api/resources/r1/findings?architectureId=%00',
    '/api/cloud-accounts/%00/regions',
    '/api/projects/%00%00',
    '/api/projects/%2500x%00',
  ])('%s is a 400 in the standard error shape', async (path) => {
    const res = call(path);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: { code: 'BAD_REQUEST', message: 'The request URL contains an invalid character.' } });
  });

  test.each([
    '/api/projects',
    '/api/projects/74366a7c-9371-4c7d-bd6c-6dc2c7a694c0/canvas?env=production',
    '/api/resources/node-1/findings?architectureId=a1',
    '/api/projects/p1/cost-comparison?currency=INR',
  ])('%s passes through untouched', (path) => {
    const res = call(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1'); // NextResponse.next(): carry on to the route
  });

  test('applies to API routes only', () => {
    expect(config.matcher).toBe('/api/:path*');
  });
});
