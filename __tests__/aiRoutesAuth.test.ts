/**
 * The AI routes accept only a real session. A request header (x-user-id) or an environment flag must never stand in for a login:
 * both routes spend LLM budget, and a header-based identity would also let a caller dodge the per-user rate limit by rotating it.
 */
jest.mock('@/src/prisma/db', () => ({ db: {}, rawTransaction: jest.fn(), rawExec: jest.fn() }));

import { NextRequest } from 'next/server';
import { POST as generate } from '@/app/api/ai/generate/route';
import { POST as questionnaire } from '@/app/api/ai/questionnaire/route';

type Route = (req: NextRequest) => Promise<Response>;

const call = (route: Route, headers: Record<string, string> = {}) =>
  route(new NextRequest('http://localhost:3000/api/ai/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ prompt: 'a small web app on AWS' }),
  }));

describe.each([['generate', generate], ['questionnaire', questionnaire]])('POST /api/ai/%s', (_name, route) => {
  const original = process.env['CLOUDBUILDER_ALLOW_LOCAL_SIGNUP'];
  afterEach(() => {
    if (original === undefined) delete process.env['CLOUDBUILDER_ALLOW_LOCAL_SIGNUP'];
    else process.env['CLOUDBUILDER_ALLOW_LOCAL_SIGNUP'] = original;
  });

  it('refuses a request with no session', async () => {
    expect((await call(route)).status).toBe(401);
  });

  it('refuses an x-user-id header with no session (it is not an identity)', async () => {
    expect((await call(route, { 'x-user-id': 'anyone' })).status).toBe(401);
    expect((await call(route, { 'x-user-id': 'anyone', 'x-user-role': 'admin' })).status).toBe(401);
  });

  it('refuses a made-up bearer token', async () => {
    expect((await call(route, { Authorization: 'Bearer not-a-real-session' })).status).toBe(401);
  });

  it('is not unlocked by running under next dev: no login, no stand-in admin', async () => {
    const env = process.env as Record<string, string | undefined>;
    const before = env['NODE_ENV'];
    env['NODE_ENV'] = 'development';
    try {
      expect((await call(route)).status).toBe(401);
      expect((await call(route, { 'x-user-id': 'dev-user-id' })).status).toBe(401);
      process.env['CLOUDBUILDER_ALLOW_LOCAL_SIGNUP'] = '1';
      expect((await call(route)).status).toBe(401);
    } finally {
      if (before === undefined) delete env['NODE_ENV']; else env['NODE_ENV'] = before;
    }
  });

  it('is not unlocked by CLOUDBUILDER_ALLOW_LOCAL_SIGNUP', async () => {
    process.env['CLOUDBUILDER_ALLOW_LOCAL_SIGNUP'] = '1';
    expect((await call(route)).status).toBe(401);
    expect((await call(route, { 'x-user-id': 'anyone' })).status).toBe(401);
  });
});
