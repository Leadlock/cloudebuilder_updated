/**
 * @jest-environment node
 */
/** The auditor's read-only access: who can make a link, what a link can and cannot reach, and that every refusal looks the same. */
import { NextRequest } from 'next/server';
import { fixtureReport, fixtureInput } from './helpers/complianceFixture';

const guard = jest.fn(); const build = jest.fn(); const rate = jest.fn();
const R = {
  findAuditorAccess: jest.fn(), touchAuditorAccess: jest.fn(), evidence: jest.fn(), evidenceById: jest.fn(), evidenceFile: jest.fn(),
  auditorAccesses: jest.fn(), createAuditorAccess: jest.fn(), revokeAuditorAccess: jest.fn(),
};
jest.mock('@/lib/compliance/routeGuard', () => ({ guardReadiness: (...a: unknown[]) => guard(...a) }));
jest.mock('@/lib/compliance/service', () => ({ buildProjectReport: (...a: unknown[]) => build(...a) }));
jest.mock('@/lib/api/rateLimit', () => ({ checkRateLimit: (...a: unknown[]) => rate(...a) }));
jest.mock('@/lib/api/authRateLimit', () => ({ clientIp: () => '203.0.113.9' }));
jest.mock('@/src/prisma/db', () => ({ db: { orm: { public: { Project: { where: () => ({ select: () => ({ first: async () => ({ orgId: 'o1' }) }) }) } } } } }));
jest.mock('@/lib/repositories/readinessRepository', () => ({ readinessRepository: R }));

import * as view from '@/app/api/auditor/view/route';
import * as evidenceRoute from '@/app/api/auditor/evidence/[evidenceId]/route';
import * as accessRoute from '@/app/api/projects/[id]/readiness/[framework]/auditor-access/route';
import * as revokeRoute from '@/app/api/projects/[id]/readiness/[framework]/auditor-access/[accessId]/route';

const TOKEN = `ca_${'A'.repeat(43)}`;
const access = (over: Record<string, unknown> = {}) => ({ id: 'a1', projectId: 'p1', framework: 'soc2', name: 'Dana Auditor', email: 'd@cpa.example', tokenPrefix: 'ca_AAAAAA', createdBy: 'x', createdAt: 't', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), revokedAt: null, lastUsedAt: null, useCount: 0, ...over });
const withToken = (url: string, token: string | null = TOKEN) => new NextRequest(`http://localhost${url}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
type H = (r: NextRequest, c?: any) => Promise<Response>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  jest.clearAllMocks();
  rate.mockResolvedValue({ allowed: true });
  R.findAuditorAccess.mockResolvedValue(access()); R.touchAuditorAccess.mockResolvedValue(undefined);
  build.mockResolvedValue({ ok: true, report: fixtureReport('soc2'), input: fixtureInput('soc2') });
  R.evidence.mockResolvedValue([{ id: 'e1', title: 'Policy', description: '', kind: 'file', origin: 'manual', collectedAt: '2026-10-01', validUntil: null, url: null, fileName: 'p.pdf', sizeBytes: 3, sha256: 'x', controlsJson: JSON.stringify(['soc2:CTL-01']), deletedAt: null },
    { id: 'e2', title: 'AWS only', description: '', kind: 'file', origin: 'manual', collectedAt: '2026-10-01', validUntil: null, url: null, fileName: 'a.pdf', sizeBytes: 3, sha256: 'y', controlsJson: JSON.stringify(['aws-waf:SEC 1']), deletedAt: null }]);
});

describe('what an auditor link can reach', () => {
  it('refuses a missing, malformed, unknown, expired or revoked token with the same answer', async () => {
    const bodies: string[] = [];
    for (const [t, row] of [[null, access()], ['ca_short', access()], [TOKEN, null], [TOKEN, access({ expiresAt: '2020-01-01T00:00:00Z' })], [TOKEN, access({ revokedAt: '2026-10-01T00:00:00Z' })]] as const) {
      R.findAuditorAccess.mockResolvedValue(row);
      const res = await (view.GET as H)(withToken('/api/auditor/view', t));
      expect(res.status).toBe(401);
      bodies.push(JSON.stringify(await res.json()));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(build).not.toHaveBeenCalled();
  });

  it('a valid link shows the report for its framework and only the evidence linked to it', async () => {
    const res = await (view.GET as H)(withToken('/api/auditor/view'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.report.framework).toBe('soc2');
    expect(body.data.evidence.map((e: { id: string }) => e.id)).toEqual(['e1']);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', framework: 'soc2', orgId: 'o1' }));
    expect(R.touchAuditorAccess).toHaveBeenCalled();
  });

  it('cannot download evidence that belongs to another framework, or any that does not exist', async () => {
    R.evidenceById.mockImplementation(async (_p: string, id: string) => (id === 'e1' ? { id, kind: 'file', fileName: 'p.pdf', sha256: 'x', controlsJson: JSON.stringify(['soc2:CTL-01']), deletedAt: null } : id === 'e2' ? { id, kind: 'file', fileName: 'a.pdf', controlsJson: JSON.stringify(['aws-waf:SEC 1']), deletedAt: null } : null));
    R.evidenceFile.mockResolvedValue(Buffer.from('abc'));
    const ctx = (id: string) => ({ params: Promise.resolve({ evidenceId: id }) });
    expect((await (evidenceRoute.GET as H)(withToken('/x'), ctx('e2'))).status).toBe(404);
    expect((await (evidenceRoute.GET as H)(withToken('/x'), ctx('nope'))).status).toBe(404);
    const ok = await (evidenceRoute.GET as H)(withToken('/x'), ctx('e1'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-disposition')).toContain('attachment');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('is rate limited per address and per token', async () => {
    rate.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 });
    expect((await (view.GET as H)(withToken('/api/auditor/view'))).status).toBe(429);
    rate.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 5 });
    expect((await (view.GET as H)(withToken('/api/auditor/view'))).status).toBe(429);
  });

  it('there is nothing to write: the auditor routes export only GET', () => {
    for (const m of [view, evidenceRoute]) expect(Object.keys(m).filter((k) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(k))).toEqual([]);
  });
});

describe('making and revoking a link', () => {
  const json = (body: unknown) => new NextRequest('http://localhost/api/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const ctx = { params: Promise.resolve({ id: 'p1', framework: 'soc2' }) };
  beforeEach(() => { guard.mockResolvedValue({ userId: 'u', email: 'a@x.com', orgId: 'o1', isAdmin: true, projectId: 'p1', framework: 'soc2', env: 'production' }); R.auditorAccesses.mockResolvedValue([]); });

  it('returns the link once, with the token after a # so it never reaches a log, and never in a listing', async () => {
    R.createAuditorAccess.mockResolvedValue({ row: access(), token: TOKEN });
    const res = await (accessRoute.POST as H)(json({ name: 'Dana Auditor', email: 'D@CPA.example', days: 30 }), ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.link).toBe(`http://localhost/auditor#${TOKEN}`);
    expect(R.createAuditorAccess).toHaveBeenCalledWith('p1', 'soc2', expect.objectContaining({ email: 'd@cpa.example' }));
    const expires = Date.parse(R.createAuditorAccess.mock.calls[0][2].expiresAt);
    expect(Math.round((expires - Date.now()) / 86_400_000)).toBe(30);
    R.auditorAccesses.mockResolvedValue([access()]);
    expect(JSON.stringify(await (await (accessRoute.GET as H)(new NextRequest('http://localhost/x'), ctx)).json())).not.toContain(TOKEN);
  });

  it('refuses more than 90 days, a bad email, and an eleventh active link', async () => {
    expect((await (accessRoute.POST as H)(json({ name: 'Dana', email: 'd@cpa.example', days: 91 }), ctx)).status).toBe(400);
    expect((await (accessRoute.POST as H)(json({ name: 'Dana', email: 'nope', days: 5 }), ctx)).status).toBe(400);
    R.auditorAccesses.mockResolvedValue(Array.from({ length: 10 }, (_, i) => access({ id: `a${i}` })));
    expect((await (accessRoute.POST as H)(json({ name: 'Dana', email: 'd@cpa.example', days: 5 }), ctx)).status).toBe(400);
    expect(R.createAuditorAccess).not.toHaveBeenCalled();
  });

  it('only an owner or admin may make or list links (the guard is asked for admin)', async () => {
    await (accessRoute.POST as H)(json({ name: 'Dana', email: 'd@cpa.example', days: 5 }), ctx);
    await (accessRoute.GET as H)(new NextRequest('http://localhost/x'), ctx);
    for (const call of guard.mock.calls) expect(call[2]).toMatchObject({ adminOnly: true });
  });

  it('revokes a link of this project, and 404s for one that is not', async () => {
    R.auditorAccesses.mockResolvedValue([access()]);
    const c = (id: string) => ({ params: Promise.resolve({ id: 'p1', framework: 'soc2', accessId: id }) });
    expect((await (revokeRoute.DELETE as H)(new NextRequest('http://localhost/x', { method: 'DELETE' }), c('a1'))).status).toBe(200);
    expect(R.revokeAuditorAccess).toHaveBeenCalledWith('p1', 'a1');
    expect((await (revokeRoute.DELETE as H)(new NextRequest('http://localhost/x', { method: 'DELETE' }), c('other'))).status).toBe(404);
  });
});
