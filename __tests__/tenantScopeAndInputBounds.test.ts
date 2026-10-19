/**
 * Ids and sizes that arrive in a request body must be checked:
 *  - an environment / architecture id from another organisation must never let a caller read or write its data;
 *  - what is sent to the AI routes and the export renderer is bounded.
 */
const mockIdentity = jest.fn();
const mockOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockOrgRole(...a) }));
const mockResolveOrg = jest.fn();
// resolveArchitecture is what the findings route falls back to when the id is a project id (the properties panel sends one): an id that is not a project of the caller's organization is "not found".
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockResolveOrg(...a), resolveArchitecture: async () => ({ error: 'project_not_found' }) }));

// One organisation (org-A) owns project pA → environment eA → architecture aA. Nothing else exists.
jest.mock('@/lib/repositories/projectRepository', () => ({
  projectRepository: { findById: jest.fn(async (id: string, org: string) => (id === 'pA' && org === 'org-A' ? { id: 'pA' } : null)) },
  environmentRepository: {
    findById: jest.fn(async (id: string) => (id === 'eA' ? { id: 'eA', projectId: 'pA', envKey: 'production' } : null)),
    findByKey: jest.fn(async (pid: string) => (pid === 'pA' ? { id: 'eA', projectId: 'pA', envKey: 'production' } : null)),
  },
}));
jest.mock('@/lib/repositories/architectureRepository', () => ({
  architectureRepository: {
    environmentIdOf: jest.fn(async (id: string) => (id === 'aA' ? 'eA' : null)),
    findByEnvironment: jest.fn(async (env: string) => (env === 'eA' ? { id: 'aA', resources: [], connections: [] } : null)),
  },
  toCanvas: () => ({ nodes: [], edges: [] }),
}));
jest.mock('@/lib/repositories/cloudAccountRepository', () => ({
  cloudAccountRepository: {
    findById: jest.fn(async () => ({ id: 'acct', provider: 'aws' })),
    getCredentials: jest.fn(async () => JSON.stringify({ provider: 'aws' })),
  },
}));
const importRun = jest.fn();
jest.mock('@/lib/repositories/discoveryRepository', () => ({ discoveryRepository: { findById: jest.fn(async () => ({ id: 'run1', cloudAccountId: 'acct', status: 'completed' })) } }));
jest.mock('@/lib/services/DiscoveryImportService', () => ({ discoveryImportService: { importRun: (...a: unknown[]) => importRun(...a) } }));
const refresh = jest.fn();
jest.mock('@/lib/cloud/sync/InfrastructureSyncService', () => ({ infrastructureSyncService: { refresh: (...a: unknown[]) => refresh(...a) } }));
const findingsByResource = jest.fn();
jest.mock('@/lib/repositories/wellArchitectedRepository', () => ({ wellArchitectedRepository: { findingsByResource: (...a: unknown[]) => findingsByResource(...a) } }));
const generate = jest.fn();
jest.mock('@/lib/services/AiGeneratorService', () => ({ AiGeneratorService: { generateValidatedArchitecture: (...a: unknown[]) => generate(...a), generateQuestionnaire: jest.fn(async () => ({ questions: [] })) } }));
const mockSession = jest.fn();
jest.mock('@/lib/api/authService', () => ({ AuthService: { getSession: (...a: unknown[]) => mockSession(...a) } }));
jest.mock('@/lib/ai/serviceCoverage', () => ({ describeNotices: () => [] }));
jest.mock('@/lib/ai/specSanitizer', () => ({ describeSanitized: () => [] }));
const exportFile = jest.fn();
jest.mock('@/lib/services/ExportService', () => ({ ExportService: { export: (...a: unknown[]) => exportFile(...a) } }));
const listOrgMembers = jest.fn();
jest.mock('@/lib/repositories/orgRepository', () => ({ orgRepository: { listOrgMembers: (...a: unknown[]) => listOrgMembers(...a) } }));

import { NextRequest } from 'next/server';
import { resolveEnvironmentInOrg, architectureInOrg } from '@/lib/api/tenantScope';
import { checkText, checkOptionalText, checkAnswers, normalizeProvider, AI_INPUT_LIMITS } from '@/lib/ai/inputGuard';
import { sanitizeExportInput, EXPORT_LIMITS } from '@/lib/services/exportInput';
import { resetRateLimit } from '@/lib/api/rateLimit';
import { POST as importPost } from '@/app/api/cloud-accounts/[id]/discovery/import/route';
import { POST as syncPost } from '@/app/api/cloud-accounts/[id]/sync/route';
import { GET as findingsGet } from '@/app/api/resources/[id]/findings/route';
import { POST as generatePost } from '@/app/api/ai/generate/route';
import { POST as questionnairePost } from '@/app/api/ai/questionnaire/route';
import { POST as exportPost } from '@/app/api/export/route';
import { GET as adminUsersGet } from '@/app/api/admin/users/route';

const req = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const acct = { params: Promise.resolve({ id: 'acct' }) };
const asUser = (userId: string, orgId: string, role = 'owner') => {
  mockIdentity.mockReturnValue({ userId, role: 'admin', email: `${userId}@x.io`, orgIds: [orgId] });
  mockSession.mockReturnValue({ user: { id: userId } });
  mockResolveOrg.mockResolvedValue(orgId);
  mockOrgRole.mockResolvedValue(role);
};
beforeEach(() => {
  [mockIdentity, mockOrgRole, mockResolveOrg, mockSession, importRun, refresh, findingsByResource, generate, exportFile, listOrgMembers].forEach((m) => m.mockReset());
  importRun.mockResolvedValue({ resourceCount: 0, summary: {}, nodes: [], edges: [] });
  refresh.mockResolvedValue({ driftReport: { scannedAt: 'now', summary: {}, items: [] } });
  findingsByResource.mockResolvedValue([]);
  generate.mockResolvedValue({ ok: true, graph: { nodes: [], edges: [] }, notices: { unsupported: [] }, sanitized: {}, deploymentInputs: [], attempts: [], historyId: '' });
  exportFile.mockResolvedValue({ buffer: Buffer.from('x'), contentType: 'image/svg+xml', filename: 'a.svg' });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  for (const u of ['user-A', 'user-B']) { resetRateLimit(u + ':ai-generate'); resetRateLimit(u + ':ai-questionnaire'); }   // 10 model calls a minute per user
});

describe('tenantScope', () => {
  it('resolves an environment id, or a project id (its production environment), only inside the owning organisation', async () => {
    expect(await resolveEnvironmentInOrg('eA', 'org-A')).toEqual({ environmentId: 'eA', projectId: 'pA' });
    expect(await resolveEnvironmentInOrg('pA', 'org-A')).toEqual({ environmentId: 'eA', projectId: 'pA' });
    expect(await resolveEnvironmentInOrg('eA', 'org-B')).toBeNull();
    expect(await resolveEnvironmentInOrg('pA', 'org-B')).toBeNull();
    expect(await resolveEnvironmentInOrg('nope', 'org-A')).toBeNull();
    expect(await resolveEnvironmentInOrg(undefined as unknown as string, 'org-A')).toBeNull();
  });
  it('knows which organisation an architecture belongs to', async () => {
    expect(await architectureInOrg('aA', 'org-A')).toBe(true);
    expect(await architectureInOrg('aA', 'org-B')).toBe(false);
    expect(await architectureInOrg('missing', 'org-A')).toBe(false);
  });
});

describe('POST /api/cloud-accounts/[id]/discovery/import', () => {
  const body = (environmentId: string) => ({ runId: 'run1', environmentId, merge: false });
  it('cannot overwrite the canvas of another organisation (by environment id or by project id)', async () => {
    asUser('user-B', 'org-B');
    for (const target of ['eA', 'pA']) expect((await importPost(req('/x', body(target)), acct)).status).toBe(404);
    expect(importRun).not.toHaveBeenCalled();
  });
  it('imports into the caller\'s own environment, resolving a project id to its production environment', async () => {
    asUser('user-A', 'org-A');
    expect((await importPost(req('/x', body('pA')), acct)).status).toBe(200);
    expect(importRun).toHaveBeenCalledWith('run1', 'eA', false);
  });
});

describe('POST /api/cloud-accounts/[id]/sync', () => {
  it('cannot read the canvas of another organisation', async () => {
    asUser('user-B', 'org-B');
    expect((await syncPost(req('/x', { environmentId: 'eA' }), acct)).status).toBe(404);
    expect(refresh).not.toHaveBeenCalled();
  });
  it('works for the caller\'s own environment', async () => {
    asUser('user-A', 'org-A');
    expect((await syncPost(req('/x', { environmentId: 'eA' }), acct)).status).toBe(200);
    expect(refresh).toHaveBeenCalled();
  });
});

describe('GET /api/resources/[id]/findings', () => {
  const call = () => findingsGet(req('/api/resources/r1/findings?architectureId=aA'), { params: Promise.resolve({ id: 'r1' }) });
  it('cannot read findings of another organisation\'s architecture', async () => {
    asUser('user-B', 'org-B');
    expect((await call()).status).toBe(404);
    expect(findingsByResource).not.toHaveBeenCalled();
  });
  it('works for the caller\'s own architecture', async () => {
    asUser('user-A', 'org-A');
    expect((await call()).status).toBe(200);
    expect(findingsByResource).toHaveBeenCalledWith('r1', 'aA');
  });
});

describe('POST /api/ai/generate', () => {
  const call = (b: object) => generatePost(req('/api/ai/generate', { prompt: 'a web app on aws', projectId: 'pA', environmentId: 'eA', ...b }, 'POST', { cookie: 'cloudbuilder_session=t' }));
  it('records the generation only into a project of the caller\'s own organisation', async () => {
    asUser('user-A', 'org-A');
    expect((await call({})).status).toBe(200);
    expect(generate.mock.calls[0]!.slice(1, 3)).toEqual(['pA', 'eA']);
  });
  it('still generates for another organisation\'s ids, but writes nothing there — and answers exactly the same', async () => {
    asUser('user-A', 'org-A');
    const own = await (await call({})).json();
    generate.mockClear();
    asUser('user-B', 'org-B');
    const res = await call({});
    expect(res.status).toBe(200);
    expect(generate.mock.calls[0]!.slice(1, 3)).toEqual(['draft-project', '']);
    expect(Object.keys(await res.json()).sort()).toEqual(Object.keys(own).sort());
  });
  it('does not record when the environment belongs to a different project than the one named', async () => {
    asUser('user-A', 'org-A');
    await call({ projectId: 'some-other-project' });
    expect(generate.mock.calls[0]!.slice(1, 3)).toEqual(['draft-project', '']);
  });
  it('an unsaved draft (or an environment key like "production") generates without recording', async () => {
    asUser('user-A', 'org-A');
    await call({ projectId: 'draft-project', environmentId: 'production' });
    expect(generate.mock.calls[0]!.slice(1, 3)).toEqual(['draft-project', '']);
  });
  it('rejects oversized or malformed input before the model is called', async () => {
    asUser('user-A', 'org-A');
    expect((await call({ prompt: 'x'.repeat(AI_INPUT_LIMITS.prompt + 1) })).status).toBe(400);
    expect((await call({ prompt: '   ' })).status).toBe(400);
    expect((await call({ prompt: { $gt: '' } })).status).toBe(400);
    expect((await call({ requirementsSummary: 'x'.repeat(AI_INPUT_LIMITS.requirements + 1) })).status).toBe(400);
    expect((await call({ answers: ['a'] })).status).toBe(400);
    expect((await call({ answers: { q: 'x'.repeat(AI_INPUT_LIMITS.answerValue + 1) } })).status).toBe(400);
    expect((await call({ projectId: 42 })).status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });
  it('treats any provider other than azure as aws, and requires sign-in', async () => {
    asUser('user-A', 'org-A');
    await call({ provider: 'gcp; DROP TABLE' });
    expect(generate.mock.calls[0]![3]).toBe('aws');
    mockSession.mockReturnValue(null);
    expect((await call({})).status).toBe(401);
  });
  it('does not return internal error text', async () => {
    asUser('user-A', 'org-A');
    generate.mockRejectedValue(new Error('Azure AI Foundry is not configured — endpoint https://secret.example'));
    const res = await call({});
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret|Foundry/);
  });
});

describe('POST /api/ai/questionnaire', () => {
  const call = (b: object) => questionnairePost(req('/api/ai/questionnaire', b, 'POST', { cookie: 'cloudbuilder_session=t' }));
  it('bounds the prompt', async () => {
    asUser('user-A', 'org-A');
    expect((await call({ prompt: 'a web app' })).status).toBe(200);
    expect((await call({ prompt: 'x'.repeat(AI_INPUT_LIMITS.prompt + 1) })).status).toBe(400);
    expect((await call({ prompt: 5 })).status).toBe(400);
  });
});

describe('inputGuard', () => {
  it('checks text, optional text and answers', () => {
    expect(checkText('hi', 'p', 5)).toEqual({ ok: true, value: 'hi' });
    expect(checkText('toolong', 'p', 5).ok).toBe(false);
    expect(checkText(undefined, 'p', 5).ok).toBe(false);
    expect(checkOptionalText(undefined, 'p', 5)).toEqual({ ok: true, value: undefined });
    expect(checkOptionalText(12, 'p', 5).ok).toBe(false);
    expect(checkAnswers({ a: 'b' })).toEqual({ ok: true, value: { a: 'b' } });
    expect(checkAnswers({})).toEqual({ ok: true, value: undefined });
    expect(checkAnswers(Object.fromEntries(Array.from({ length: AI_INPUT_LIMITS.answers + 1 }, (_, i) => [`q${i}`, 'a']))).ok).toBe(false);
    expect(checkAnswers({ a: 5 }).ok).toBe(false);
    expect(normalizeProvider('azure')).toBe('azure');
    expect(normalizeProvider('anything')).toBe('aws');
  });
});

describe('export input', () => {
  const node = (i: number, extra: object = {}) => ({ id: `n${i}`, resourceType: 'aws_s3', provider: 'aws', label: `Bucket ${i}`, position: { x: i, y: i }, ...extra });
  it('accepts a normal canvas and keeps what the renderer reads', () => {
    const r = sanitizeExportInput({ nodes: [node(1), node(2)], edges: [{ id: 'e1', source: 'n1', target: 'n2', label: 'uses' }], title: 'My design', theme: 'dark' });
    expect(r.ok && r.input.nodes).toHaveLength(2);
    expect(r.ok && r.input.edges).toHaveLength(1);
    expect(r.ok && r.input.theme).toBe('dark');
  });
  it('refuses an empty, non-array or oversized design', () => {
    expect(sanitizeExportInput({ nodes: [] }).ok).toBe(false);
    expect(sanitizeExportInput({ nodes: 'x' }).ok).toBe(false);
    expect(sanitizeExportInput({ nodes: Array.from({ length: EXPORT_LIMITS.nodes + 1 }, (_, i) => node(i)) }).ok).toBe(false);
    expect(sanitizeExportInput({ nodes: [node(1)], edges: Array.from({ length: EXPORT_LIMITS.edges + 1 }, () => ({})) }).ok).toBe(false);
    expect(sanitizeExportInput({ nodes: [{ label: 'no id' }] }).ok).toBe(false);
  });
  it('clamps coordinates and turns non-numbers into numbers, so values written into SVG attributes are always plain numbers', () => {
    const r = sanitizeExportInput({ nodes: [node(1, { position: { x: 1e12, y: -1e12 } }), node(2, { position: { x: '1)"><script>alert(1)</script>', y: {} } })] });
    if (!r.ok) throw new Error('expected ok');
    const [a, b] = r.input.nodes as unknown as { position: { x: number; y: number } }[];
    expect(a!.position).toEqual({ x: EXPORT_LIMITS.coordinate, y: -EXPORT_LIMITS.coordinate });
    expect(b!.position).toEqual({ x: 0, y: 0 });
  });
  it('cuts long text and drops connections to nodes that are not in the design', () => {
    const r = sanitizeExportInput({ nodes: [node(1, { label: 'x'.repeat(5000) }), node(2)], edges: [{ id: 'e', source: 'n1', target: 'ghost' }, { id: 'f', source: 'n1', target: 'n2' }], title: 't'.repeat(5000) });
    if (!r.ok) throw new Error('expected ok');
    expect(r.input.nodes[0]!.label.length).toBe(EXPORT_LIMITS.label);
    expect(r.input.title.length).toBe(EXPORT_LIMITS.title);
    expect(r.input.edges.map((e) => e.id)).toEqual(['f']);
  });
});

describe('POST /api/export', () => {
  const call = (b: object) => exportPost(req('/api/export', b, 'POST', { cookie: 'cloudbuilder_session=t' }));
  const good = { format: 'svg', nodes: [{ id: 'n1', resourceType: 'aws_s3', label: 'B', position: { x: 1, y: 1 } }], edges: [] };
  beforeEach(() => resetRateLimit('export-user:export'));
  it('is bounded and rate limited, and hides internal errors', async () => {
    asUser('export-user', 'org-A');
    expect((await call(good)).status).toBe(200);
    expect((await call({ ...good, nodes: Array.from({ length: EXPORT_LIMITS.nodes + 1 }, (_, i) => ({ id: `n${i}` })) })).status).toBe(400);
    expect((await call({ ...good, format: 'exe' })).status).toBe(400);
    exportFile.mockRejectedValueOnce(new Error('/srv/app/secret/path failed'));
    const failed = await call(good);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toMatch(/secret|srv/);
    let limited = 0;
    for (let i = 0; i < 30; i++) if ((await call(good)).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
  it('requires sign-in', async () => {
    mockSession.mockReturnValue(null);
    expect((await call(good)).status).toBe(401);
  });
});

describe('GET /api/admin/users', () => {
  it('needs owner/admin in the organisation itself — the session\'s admin flag (every self-registered user has it) is not enough', async () => {
    listOrgMembers.mockResolvedValue([{ id: 'u1' }]);
    asUser('member-user', 'org-A', 'member');
    expect((await adminUsersGet(req('/api/admin/users'))).status).toBe(403);
    expect(listOrgMembers).not.toHaveBeenCalled();
    asUser('owner-user', 'org-A', 'owner');
    expect((await adminUsersGet(req('/api/admin/users'))).status).toBe(200);
    asUser('admin-user', 'org-A', 'admin');
    expect((await adminUsersGet(req('/api/admin/users'))).status).toBe(200);
  });
});
