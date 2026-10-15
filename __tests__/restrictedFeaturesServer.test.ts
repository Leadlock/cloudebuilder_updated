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
import { POST as deploy } from '@/app/api/projects/[id]/deploy/route';
import { GET as listDeployments } from '@/app/api/projects/[id]/deployments/route';
import { GET as listAccounts, POST as connectAccount } from '@/app/api/cloud-accounts/route';

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

describe('the older Deploy routes', () => {
  const projectCtx = { params: Promise.resolve({ id: 'p1' }) };

  test('another admin is refused by the deploy action and by the deployment history', async () => {
    mockIdentity.mockReturnValue({ userId: 'u2', email: 'someone@neozaar.com', role: 'admin', orgIds: ['o1'] });
    const d = await deploy(post('/api/projects/p1/deploy', { environment: 'production', nodes: [], edges: [] }), projectCtx);
    expect(d.status).toBe(403);
    expect(JSON.stringify(await d.json())).toContain(RESTRICTED_FEATURE_MESSAGE);
    const h = await listDeployments(new NextRequest('http://localhost/api/projects/p1/deployments'), projectCtx);
    expect(h.status).toBe(403);
    expect(JSON.stringify(await h.json())).toContain(RESTRICTED_FEATURE_MESSAGE);
  });

  test('the listed account is not stopped by the lock', async () => {
    mockIdentity.mockReturnValue({ userId: 'u1', email: 'ajinkya@neozaar.com', role: 'admin', orgIds: ['o1'] });
    const d = await deploy(post('/api/projects/p1/deploy', { environment: 'production', nodes: [], edges: [] }), projectCtx);
    expect(JSON.stringify(await d.json())).not.toContain(RESTRICTED_FEATURE_MESSAGE);
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

  test('the older Deploy routes check the lock too (the deploy action and the deployment history)', () => {
    const root = join(__dirname, '..', 'app', 'api', 'projects', '[id]');
    for (const f of [join(root, 'deploy', 'route.ts'), join(root, 'deployments', 'route.ts')]) {
      const text = readFileSync(f, 'utf8');
      expect({ f, identified: (text.match(/extractIdentity\(req\)/g) ?? []).length, guarded: (text.match(/refuseRestrictedFeature\(identity\.email\)/g) ?? []).length })
        .toEqual({ f, identified: 1, guarded: 1 });
    }
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

describe('Cloud Accounts', () => {
  test.each([
    ['list', () => listAccounts(new NextRequest('http://localhost/api/cloud-accounts'))],
    ['connect', () => connectAccount(post('/api/cloud-accounts', {}))],
  ])('%s refuses another account with 403', async (_n, call) => {
    mockIdentity.mockReturnValue({ userId: 'u2', email: 'someone@neozaar.com', role: 'admin', orgIds: ['o1'] });
    const res = await call();
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain(RESTRICTED_FEATURE_MESSAGE);
  });

  test('the listed account is not stopped by the lock', async () => {
    mockIdentity.mockReturnValue({ userId: 'u1', email: 'ajinkya@neozaar.com', role: 'admin', orgIds: [] });
    const res = await connectAccount(post('/api/cloud-accounts', {}));
    expect(res.status).not.toBe(403);
  });

  test('every handler of every route that reads or uses a connected account checks the lock, so none can be added without it', () => {
    const root = join(__dirname, '..', 'app', 'api');
    const files: string[] = [];
    (function walk(d: string) { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (e === 'route.ts') files.push(p); } })(join(root, 'cloud-accounts'));
    files.push(join(root, 'projects', '[id]', 'terraform', 'permissions', 'route.ts'), join(root, 'projects', '[id]', 'well-architected', 'account-controls', 'route.ts'));
    expect(files.length).toBeGreaterThanOrEqual(13);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const identified = (text.match(/extractIdentity\(req\)/g) ?? []).length;
      const guarded = (text.match(/refuseRestrictedFeature\(identity\.email\)/g) ?? []).length;
      expect({ f: f.replace(root, ''), identified, guarded }).toEqual({ f: f.replace(root, ''), identified, guarded: identified });
    }
  });
});
