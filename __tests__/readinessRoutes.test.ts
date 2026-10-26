/**
 * @jest-environment node
 */
/** The readiness routes: what they refuse, what they store, and that every change ends the sign-offs. The database and the report builder are mocked. */
import { NextRequest } from 'next/server';
import { fixtureReport, fixtureInput } from './helpers/complianceFixture';

const guard = jest.fn();
const R = {
  controls: jest.fn(), saveControl: jest.fn(), clearSignoffs: jest.fn(), evidence: jest.fn(), evidenceById: jest.fn(), addEvidence: jest.fn(), evidenceFile: jest.fn(),
  removeEvidence: jest.fn(), setEvidenceControls: jest.fn(), findings: jest.fn(), saveFinding: jest.fn(), signoffs: jest.fn(), sign: jest.fn(), saveSettings: jest.fn(),
  recordReport: jest.fn(), reports: jest.fn(), settings: jest.fn(),
};
const build = jest.fn();
jest.mock('@/lib/compliance/routeGuard', () => ({ guardReadiness: (...a: unknown[]) => guard(...a) }));
jest.mock('@/lib/repositories/readinessRepository', () => ({ readinessRepository: R, evidenceControls: () => [], controlKey: (f: string, c: string) => `${f}:${c}` }));
jest.mock('@/lib/compliance/service', () => ({ buildProjectReport: (...a: unknown[]) => build(...a), loadScope: async () => ({ categories: ['security'], exclusions: {} }) }));
jest.mock('@/lib/repositories/orgRepository', () => ({ orgRepository: { findUser: async () => ({ name: 'Dana Li' }) } }));

import * as controlRoute from '@/app/api/projects/[id]/readiness/[framework]/controls/[controlId]/route';
import * as evidenceRoute from '@/app/api/projects/[id]/readiness/[framework]/evidence/route';
import * as evidenceOne from '@/app/api/projects/[id]/readiness/[framework]/evidence/[evidenceId]/route';
import * as signoffRoute from '@/app/api/projects/[id]/readiness/[framework]/signoff/route';
import * as reportRoute from '@/app/api/projects/[id]/readiness/[framework]/report/route';
import * as scopeRoute from '@/app/api/projects/[id]/readiness/[framework]/scope/route';

const caller = (over: Record<string, unknown> = {}) => ({ userId: 'u1', email: 'dana@x.com', orgId: 'o1', role: 'member', isAdmin: false, projectId: 'p1', framework: 'soc2', env: 'production', ...over });
const ctx = (extra: Record<string, string> = {}, framework = 'soc2') => ({ params: Promise.resolve({ id: 'p1', framework, ...extra }) });
const json = (url: string, method: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const upload = (name: string, bytes: Buffer, fields: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.set('file', new File([new Uint8Array(bytes)], name));
  for (const [k, v] of Object.entries({ title: 'Access review export', collectedAt: '2026-10-01', origin: 'system', controls: JSON.stringify(['soc2:CTL-01']), ...fields })) fd.set(k, v);
  return new NextRequest('http://localhost/api/projects/p1/readiness/soc2/evidence', { method: 'POST', body: fd });
};

beforeEach(() => {
  jest.clearAllMocks();
  guard.mockResolvedValue(caller());
  R.controls.mockResolvedValue({}); R.findings.mockResolvedValue({}); R.signoffs.mockResolvedValue([]); R.clearSignoffs.mockResolvedValue(undefined);
  R.addEvidence.mockImplementation(async (_p: string, e: Record<string, unknown>) => ({ id: 'e1', projectId: 'p1', ...e, controlsJson: '[]', createdAt: 't', deletedAt: null, deletedBy: null, sizeBytes: 3, sha256: 'x' }));
  build.mockResolvedValue({ ok: true, report: fixtureReport('soc2'), input: fixtureInput('soc2') });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type H = (r: NextRequest, c: { params: Promise<any> }) => Promise<Response>;

describe('control answers', () => {
  const PUT = controlRoute.PUT as H;
  it('an unknown control is a 404; "not applicable" without a reason a 400', async () => {
    expect((await PUT(json('/x', 'PUT', { status: 'implemented' }), ctx({ controlId: 'NOPE' }))).status).toBe(404);
    expect((await PUT(json('/x', 'PUT', { status: 'not_applicable' }), ctx({ controlId: 'CTL-01' }))).status).toBe(400);
    expect(R.saveControl).not.toHaveBeenCalled();
  });
  it('a saved answer is recorded under the caller and ends the sign-offs', async () => {
    const res = await PUT(json('/x', 'PUT', { status: 'implemented', owner: 'Priya Nair' }), ctx({ controlId: 'CTL-01' }));
    expect(res.status).toBe(200);
    expect(R.saveControl).toHaveBeenCalledWith('p1', 'soc2', expect.objectContaining({ controlId: 'CTL-01', status: 'implemented', owner: 'Priya Nair' }), 'dana@x.com');
    expect(R.clearSignoffs).toHaveBeenCalledWith('p1', 'soc2');
  });
  it('the owner cannot review their own control', async () => {
    R.controls.mockResolvedValue({ 'CTL-01': { controlId: 'CTL-01', status: 'implemented', owner: 'dana@x.com', note: '', naReason: '', reviewer: '' } });
    expect((await PUT(json('/x', 'PUT', { markReviewed: true }), ctx({ controlId: 'CTL-01' }))).status).toBe(400);
  });
});

describe('evidence', () => {
  const POST = evidenceRoute.POST as H;
  it('stores a file with its hash, linked to the controls, and ends the sign-offs', async () => {
    const res = await POST(upload('export.pdf', Buffer.from('hello')), ctx());
    expect(res.status).toBe(201);
    const arg = R.addEvidence.mock.calls[0][1];
    expect(arg.file.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(arg).toMatchObject({ kind: 'file', fileName: 'export.pdf', origin: 'system', controls: ['soc2:CTL-01'], uploadedBy: 'dana@x.com' });
    expect(R.clearSignoffs).toHaveBeenCalled();
  });
  it.each([
    ['a file a browser would run', () => upload('x.html', Buffer.from('<script>')), 'not accepted'],
    ['an empty file', () => upload('x.pdf', Buffer.alloc(0)), 'empty'],
    ['a file over 5 MB', () => upload('x.pdf', Buffer.alloc(5 * 1024 * 1024 + 1)), '5 MB'],
    ['a date in the future', () => upload('x.pdf', Buffer.from('a'), { collectedAt: '2999-01-01' }), 'future'],
    ['a control that does not exist', () => upload('x.pdf', Buffer.from('a'), { controls: JSON.stringify(['soc2:NOPE']) }), 'not a control'],
  ])('refuses %s', async (_n, mk, text) => {
    const res = await POST(mk(), ctx());
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(text);
    expect(R.addEvidence).not.toHaveBeenCalled();
  });
  it('a link must be https and a note must say something', async () => {
    const base = { title: 'Policy page', collectedAt: '2026-10-01', controls: [] };
    expect((await POST(json('/x', 'POST', { ...base, kind: 'link', url: 'http://example.com/p' }), ctx())).status).toBe(400);
    expect((await POST(json('/x', 'POST', { ...base, kind: 'link', url: 'https://example.com/p' }), ctx())).status).toBe(201);
    expect((await POST(json('/x', 'POST', { ...base, kind: 'note', description: 'too short' }), ctx())).status).toBe(400);
  });
  it('a file is downloaded as an attachment that the browser may not sniff or render', async () => {
    R.evidenceById.mockResolvedValue({ id: 'e1', kind: 'file', fileName: 'a.pdf', sha256: 'abc', deletedAt: null });
    R.evidenceFile.mockResolvedValue(Buffer.from('data'));
    const res = await (evidenceOne.GET as H)(new NextRequest('http://localhost/x'), ctx({ evidenceId: 'e1' }));
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });
  it('only the person who added it, or an admin, removes evidence', async () => {
    R.evidenceById.mockResolvedValue({ id: 'e1', uploadedBy: 'someone@else.com', deletedAt: null });
    expect((await (evidenceOne.DELETE as H)(new NextRequest('http://localhost/x', { method: 'DELETE' }), ctx({ evidenceId: 'e1' }))).status).toBe(403);
    guard.mockResolvedValue(caller({ isAdmin: true, role: 'admin' }));
    expect((await (evidenceOne.DELETE as H)(new NextRequest('http://localhost/x', { method: 'DELETE' }), ctx({ evidenceId: 'e1' }))).status).toBe(200);
    expect(R.removeEvidence).toHaveBeenCalledWith('p1', 'e1', 'dana@x.com');
  });
});

describe('sign-off', () => {
  const POST = signoffRoute.POST as H;
  it('a reviewer cannot be the preparer', async () => {
    guard.mockResolvedValue(caller({ isAdmin: true, role: 'admin' }));
    R.signoffs.mockResolvedValue([{ role: 'preparer', name: 'D', email: 'dana@x.com', signedAt: 't' }]);
    expect((await POST(json('/x', 'POST', { role: 'reviewer' }), ctx())).status).toBe(400);
    expect(R.sign).not.toHaveBeenCalled();
  });
  it('signs the report as it stands', async () => {
    R.sign.mockImplementation(async (_p: string, _f: string, s: object) => ({ ...s, signedAt: 't' }));
    const res = await POST(json('/x', 'POST', { role: 'preparer' }), ctx());
    expect(res.status).toBe(200);
    expect(R.sign).toHaveBeenCalledWith('p1', 'soc2', expect.objectContaining({ role: 'preparer', email: 'dana@x.com', reportHash: expect.stringMatching(/^S2-/) }));
  });
});

describe('scope and reports', () => {
  it('scope is for SOC 2 only', async () => {
    guard.mockResolvedValue(caller({ framework: 'aws-waf', isAdmin: true }));
    expect((await (scopeRoute.PUT as H)(json('/x', 'PUT', { categories: ['security'] }), ctx({}, 'aws-waf'))).status).toBe(404);
  });
  it('SOC 2 is a Word file and AWS a PDF; the wrong format is refused', async () => {
    const docx = await (reportRoute.GET as H)(new NextRequest('http://localhost/x?format=docx'), ctx());
    expect(docx.status).toBe(200);
    expect(docx.headers.get('content-disposition')).toMatch(/\.docx"$/);
    expect(docx.headers.get('content-disposition')).toContain('-draft');
    expect(Buffer.from(await docx.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');
    expect((await (reportRoute.GET as H)(new NextRequest('http://localhost/x?format=pdf'), ctx())).status).toBe(400);
    guard.mockResolvedValue(caller({ framework: 'aws-waf' }));
    build.mockResolvedValue({ ok: true, report: fixtureReport('aws-waf'), input: fixtureInput('aws-waf') });
    const pdf = await (reportRoute.GET as H)(new NextRequest('http://localhost/x'), ctx({}, 'aws-waf'));
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await (reportRoute.GET as H)(new NextRequest('http://localhost/x?format=docx'), ctx({}, 'aws-waf'))).status).toBe(400);
  });
  it('a draft is not recorded; issuing records the version', async () => {
    await (reportRoute.GET as H)(new NextRequest('http://localhost/x?format=json'), ctx());
    expect(R.recordReport).not.toHaveBeenCalled();
    const res = await (reportRoute.POST as H)(json('/x', 'POST', { format: 'docx' }), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).not.toContain('draft');
    expect(R.recordReport).toHaveBeenCalledWith('p1', 'soc2', expect.objectContaining({ version: 2, reportId: expect.stringMatching(/^S2-/) }));
  });
});
