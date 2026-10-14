/**
 * The closed features on the server: the AI routes and every Terraform execution route refuse anyone who is not listed.
 */
jest.mock('@/src/prisma/db', () => ({ db: {}, pool: {} }));
jest.mock('@/lib/repositories/orgRepository', () => ({ orgRepository: {} }));
const mockSession = jest.fn();
jest.mock('@/lib/api/realSession', () => ({ realSession: (...a: unknown[]) => mockSession(...a) }));
const mockIdentity = jest.fn();
jest.mock('@/lib/api/auth', () => ({ ...jest.requireActual('@/lib/api/auth'), extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: async () => 'owner' }));
jest.mock('@/lib/services/AiGeneratorService', () => ({ AiGeneratorService: {} }));

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { NextRequest } from 'next/server';
import { terraformExecutionDenied } from '@/lib/api/terraformAccess';
import { RESTRICTED_FEATURE_MESSAGE } from '@/lib/auth/restrictedFeatures';
import { POST as generate } from '@/app/api/ai/generate/route';
import { POST as questionnaire } from '@/app/api/ai/questionnaire/route';
import { POST as review } from '@/app/api/ai/review/route';

const OLD = process.env['RESTRICTED_FEATURES_ALLOWED_EMAILS'];
beforeEach(() => { process.env['RESTRICTED_FEATURES_ALLOWED_EMAILS'] = 'ajinkya@neozaar.com'; mockSession.mockReset(); mockIdentity.mockReset(); });
afterAll(() => { if (OLD === undefined) delete process.env['RESTRICTED_FEATURES_ALLOWED_EMAILS']; else process.env['RESTRICTED_FEATURES_ALLOWED_EMAILS'] = OLD; });

const post = (path: string, body: unknown = {}) => new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('AI routes', () => {
  test.each([
    ['generate', generate],
    ['questionnaire', questionnaire],
  ])('%s refuses another account with 403', async (_n, handler) => {
    mockSession.mockReturnValue({ user: { id: 'u2', email: 'someone@neozaar.com' } });
    const res = await handler(post('/api/ai/x'));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain(RESTRICTED_FEATURE_MESSAGE);
  });

  test('review refuses another account with 403', async () => {
    mockIdentity.mockReturnValue({ userId: 'u2', email: 'someone@neozaar.com', role: 'admin', orgIds: ['o1'] });
    expect((await review(post('/api/ai/review'))).status).toBe(403);
  });

  test.each([['generate', generate], ['questionnaire', questionnaire]])('%s lets the listed account through the lock', async (_n, handler) => {
    mockSession.mockReturnValue({ user: { id: 'u1', email: 'Ajinkya@neozaar.com' } });
    const res = await handler(post('/api/ai/x', {}));
    expect(res.status).not.toBe(403);
  });
});

describe('Terraform execution', () => {
  test('another account is refused before any other check', async () => {
    expect(await terraformExecutionDenied('u2', 'o1', 'someone@neozaar.com')).toBe(RESTRICTED_FEATURE_MESSAGE);
    expect(await terraformExecutionDenied('u2', 'o1', undefined)).toBe(RESTRICTED_FEATURE_MESSAGE);
  });

  test('the listed account is not refused by this lock (the other checks still apply)', async () => {
    expect(await terraformExecutionDenied('u1', 'o1', 'ajinkya@neozaar.com')).not.toBe(RESTRICTED_FEATURE_MESSAGE);
  });

  test('without the setting nothing changes', async () => {
    delete process.env['RESTRICTED_FEATURES_ALLOWED_EMAILS'];
    expect(await terraformExecutionDenied('u2', 'o1', 'someone@neozaar.com')).not.toBe(RESTRICTED_FEATURE_MESSAGE);
  });

  test('every route that runs Terraform passes the caller\'s email to the check, so none can be added without the lock', () => {
    const root = join(__dirname, '..', 'app', 'api');
    const files: string[] = [];
    (function walk(d: string) { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (e === 'route.ts') files.push(p); } })(root);
    const calling = files.filter((f) => readFileSync(f, 'utf8').includes('terraformExecutionDenied('));
    expect(calling.length).toBeGreaterThanOrEqual(10);
    for (const f of calling) {
      for (const call of readFileSync(f, 'utf8').match(/terraformExecutionDenied\([^)]*\)/g) ?? []) {
        expect({ f: f.replace(root, ''), call }).toEqual({ f: f.replace(root, ''), call: expect.stringContaining('.email') });
      }
    }
  });
});
