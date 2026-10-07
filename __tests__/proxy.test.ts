/**
 * proxy.ts: a NUL character in an API URL is a 400, never a 500 from the database.
 */
import { NextRequest } from 'next/server';
import { proxy, config } from '@/proxy';

const call = (path: string) => proxy(new NextRequest(`http://localhost${path}`));

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
