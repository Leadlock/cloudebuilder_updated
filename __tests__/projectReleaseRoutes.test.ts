/**
 * The routes that deploy a project from inside CloudCraft: the gates in front of every one, planning (what is generated and where), running (only with
 * an approval for exactly this plan), the secrets form (names in, values straight to the vault, none kept) and cancelling.
 */
const mockIdentity = jest.fn();
const mockOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockOrgRole(...a) }));
const mockResolveOrg = jest.fn();
const mockResolveArch = jest.fn();
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockResolveOrg(...a), resolveArchitecture: (...a: unknown[]) => mockResolveArch(...a) }));
const mockDenied = jest.fn();
jest.mock('@/lib/api/terraformAccess', () => ({ terraformExecutionDenied: (...a: unknown[]) => mockDenied(...a) }));
const mockAudit = jest.fn();
jest.mock('@/lib/terraform/execution/audit', () => ({ recordTerraformAudit: (...a: unknown[]) => mockAudit(...a) }));
const mockRate = jest.fn();
jest.mock('@/lib/api/rateLimit', () => ({ checkRateLimit: (...a: unknown[]) => mockRate(...a) }));
const A = { consume: jest.fn(), giveBack: jest.fn() };
jest.mock('@/lib/terraform/execution/approvals', () => ({ consumeApproval: (...a: unknown[]) => A.consume(...a), returnApproval: (...a: unknown[]) => A.giveBack(...a) }));
const mockVerify = jest.fn();
class FakePlanBlocked extends Error {}
const mockPrepareDestroy = jest.fn();
const mockStartDestroy = jest.fn();
jest.mock('@/lib/terraform/execution/TerraformExecutionService', () => ({ verifyPlanForApply: (...a: unknown[]) => mockVerify(...a), PlanBlockedError: FakePlanBlocked, prepareDestroy: (...a: unknown[]) => mockPrepareDestroy(...a), startDestroyRun: (...a: unknown[]) => mockStartDestroy(...a) }));
const mockPeekDestroy = jest.fn();
jest.mock('@/lib/terraform/execution/destroyPlans', () => ({ peekPreparedDestroy: (...a: unknown[]) => mockPeekDestroy(...a) }));
jest.mock('@/lib/terraform/execution/cli', () => ({ TerraformNotInstalledError: class extends Error {} }));
const mockEnqueue = jest.fn();
jest.mock('@/lib/jobs/projectReleaseJob', () => ({ enqueueReleaseJob: (...a: unknown[]) => mockEnqueue(...a) }));
const mockPlanRelease = jest.fn();
jest.mock('@/lib/deploy/project/infra', () => ({ planRelease: (...a: unknown[]) => mockPlanRelease(...a), terraformFiles: (b: unknown) => jest.requireActual('@/lib/deploy/project/infra').terraformFiles(b), throwawayPublicKey: () => 'ssh-ed25519 AAAATEST' }));
const mockOpsFor = jest.fn();
jest.mock('@/lib/deploy/project/accountOps', () => ({ releaseDriverFor: async (r: { orgId: string; cloudAccountId: string }) => jest.requireActual('@/lib/deploy/project/driver').azureDriver(await mockOpsFor(r.orgId, r.cloudAccountId)), AccountError: class AccountError extends Error { constructor(m: string, public status = 400) { super(m); } } }));
jest.mock('@/lib/terraform/execution/applyProgress', () => ({ APPLY_WORKER: 'apply', workerStatus: () => ({ running: true }) }));
jest.mock('@/lib/deploy/project/pgReleaseStore', () => {
  const { InMemoryReleaseStore } = jest.requireActual('@/lib/deploy/project/releaseStore');
  const g = globalThis as unknown as { __relStore?: InstanceType<typeof InMemoryReleaseStore> };
  g.__relStore ??= new InMemoryReleaseStore();
  return { PgReleaseStore: class { get(id: string) { return g.__relStore!.get(id); } save(r: unknown) { return g.__relStore!.save(r); } latestSucceeded(p: string, e: string) { return g.__relStore!.latestSucceeded(p, e); } async list(p: string, e: string) { return [...(g.__relStore as unknown as { rows: Map<string, { projectId: string; environment: string }> }).rows.values()].filter((r) => r.projectId === p && r.environment === e); } } };
});

jest.mock('@/lib/deploy/project/sourceStore', () => {
  const actual = jest.requireActual('@/lib/deploy/project/sourceStore');
  const g = globalThis as unknown as { __srcStore?: InstanceType<typeof actual.InMemorySourceStore> };
  g.__srcStore ??= new actual.InMemorySourceStore();
  return { ...actual, PgSourceStore: class { put(x: unknown) { return g.__srcStore!.put(x as never); } get(id: string) { return g.__srcStore!.get(id); } prune() { return g.__srcStore!.prune(); } } };
});

import { NextRequest } from 'next/server';
import { POST as sourcePost } from '@/app/api/projects/[id]/releases/sources/route';
import { GET as listGet, POST as planPost } from '@/app/api/projects/[id]/releases/route';
import { GET as oneGet } from '@/app/api/projects/[id]/releases/[rid]/route';
import { POST as runPost } from '@/app/api/projects/[id]/releases/[rid]/run/route';
import { POST as secretsPost } from '@/app/api/projects/[id]/releases/[rid]/secrets/route';
import { POST as cancelPost } from '@/app/api/projects/[id]/releases/[rid]/cancel/route';
import { POST as rollbackPost } from '@/app/api/projects/[id]/releases/[rid]/rollback/route';
import { POST as destroyPost } from '@/app/api/projects/[id]/releases/[rid]/destroy/route';
import { acquireProjectLock, isProjectLocked, releaseProjectLock } from '@/lib/terraform/execution/projectLock';
import { buildAzureVmBundle } from '@/lib/deploy/project/bundle';
import { newRelease } from '@/lib/deploy/project/orchestrator';
import { defaultProject, LAYERS, type StackProject } from '@/lib/engines/containers/stackProject';
import type { AzureOps } from '@/lib/deploy/project/azureOps';
import type { Release } from '@/lib/deploy/project/types';
import { PgReleaseStore } from '@/lib/deploy/project/pgReleaseStore';
import { PgSourceStore } from '@/lib/deploy/project/sourceStore';
import { deflateRawSync } from 'zlib';
import { crc32 } from '@/lib/deploy/project/zip';

let n = 0;
let projectId = '';
const store = () => new PgReleaseStore();
const PLAN = { planId: 'plan-1', planHash: 'h'.repeat(64) };
const BACKEND = { provider: 'azure', resourceGroupName: 'rg', storageAccountName: 'tfstateacct', containerName: 'tfstate', key: 'k.tfstate' };
const project = (over?: (p: StackProject) => void) => { const p = defaultProject(); p.name = 'shop'; for (const l of LAYERS) p.layers[l].enabled = ['backend', 'api'].includes(l); p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }]; p.deploy.target = 'azure-vm'; over?.(p); return p; };
const req = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => new NextRequest(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ctx = (rid?: string) => ({ params: Promise.resolve(rid ? { id: projectId, rid } : { id: projectId }) }) as never;
const signedIn = (userId = 'alice', role = 'owner') => { mockIdentity.mockReturnValue({ userId, role: 'admin', email: `${userId}@x.io`, orgIds: ['org-1'] }); mockOrgRole.mockResolvedValue(role); };
const json = async (res: Response) => (await res.json()) as { data?: Record<string, any>; error?: { code: string; message: string; details?: unknown } };   // eslint-disable-line @typescript-eslint/no-explicit-any

async function seed(over: Partial<Release> = {}, id = `rel-${n}`): Promise<Release> {
  const p = project();
  const r = { ...newRelease({ id, orgId: 'org-1', projectId, environment: 'production', cloudAccountId: 'acct-1', project: p, bundle: buildAzureVmBundle(p), createdBy: 'alice', previousReleaseId: null, planId: PLAN.planId, planHash: PLAN.planHash, now: 1 }), ...over };
  await store().save(r);
  return r;
}
const fakeOps = (vault: string[] = []): AzureOps & { put: Array<[string, string]> } => {
  const have = new Set(vault);
  const put: Array<[string, string]> = [];
  return { put, secretExists: async (_v, name) => have.has(name), putSecret: async (_v, name, value) => { have.add(name); put.push([name, value]); }, acrBuild: async () => undefined, setVmTag: async () => undefined, runShell: async () => '', httpOk: async () => true, resourceGroupExists: async () => true };
};
function zipOf(files: Record<string, string>): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const data = Buffer.from(text); const comp = deflateRawSync(data); const name = Buffer.from(path);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(crc32(data), 14); l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26);
    parts.push(l, name, comp);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE((0o100644 << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, name); offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central); const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length / 2, 8); e.writeUInt16LE(central.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, e]);
}
const form = (layer: string, zip: Buffer | null, name = 'code.zip') => {
  const fd = new FormData();
  fd.set('layer', layer);
  if (zip) fd.set('file', new File([new Uint8Array(zip)], name, { type: 'application/zip' }));
  return new NextRequest(`http://localhost/api/projects/${projectId}/releases/sources`, { method: 'POST', body: fd });
};
const OUT = { resourceGroup: 'rg-shop', vmName: 'vm-shop', acrName: 'acrshop', vaultName: 'kvshop', url: 'http://203.0.113.9:8080/' };

beforeEach(() => {
  [mockIdentity, mockOrgRole, mockResolveOrg, mockResolveArch, mockDenied, mockAudit, mockRate, mockVerify, mockEnqueue, mockPlanRelease, mockOpsFor, mockPrepareDestroy, mockStartDestroy, mockPeekDestroy, ...Object.values(A)].forEach((m) => m.mockReset());
  process.env['CLOUDCRAFT_PROJECT_RELEASES'] = '1';
  projectId = `proj-rel-${++n}`;
  mockResolveOrg.mockResolvedValue('org-1'); mockResolveArch.mockResolvedValue({ arch: {}, project: {} });
  mockDenied.mockResolvedValue(null);
  mockRate.mockResolvedValue({ allowed: true });
  signedIn();
  mockVerify.mockImplementation(() => ({ planId: PLAN.planId, planHash: PLAN.planHash, projectId, orgId: 'org-1', cloudAccountId: 'acct-1', summary: { toAdd: 9, toChange: 0, toDestroy: 0 } }));
  mockEnqueue.mockResolvedValue('job-1');
  A.consume.mockResolvedValue({ ok: true, approval: { id: 'appr-1', decidedBy: 'bob' } });
  A.giveBack.mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { releaseProjectLock(projectId); delete process.env['CLOUDCRAFT_PROJECT_RELEASES']; });

describe('the gates in front of every release route', () => {
  const calls: Array<[string, () => Promise<Response>]> = [
    ['plan', () => planPost(req(`/api/projects/${projectId}/releases`, { cloudAccountId: 'a', stateBackend: BACKEND, project: project() }), ctx())],
    ['list', () => listGet(req(`/api/projects/${projectId}/releases`), ctx())],
    ['one', () => oneGet(req(`/api/projects/${projectId}/releases/x`), ctx('x'))],
    ['run', () => runPost(req(`/api/projects/${projectId}/releases/x/run`, {}), ctx('x'))],
    ['secrets', () => secretsPost(req(`/api/projects/${projectId}/releases/x/secrets`, { values: { A: 'b' } }), ctx('x'))],
    ['cancel', () => cancelPost(req(`/api/projects/${projectId}/releases/x/cancel`, {}), ctx('x'))],
    ['source upload', () => sourcePost(form('api', zipOf({ 'a.js': 'x' })), ctx())],
    ['rollback', () => rollbackPost(req(`/api/projects/${projectId}/releases/x/rollback`, { confirm: true }), ctx('x'))],
    ['destroy', () => destroyPost(req(`/api/projects/${projectId}/releases/x/destroy`, { stateBackend: BACKEND }), ctx('x'))],
  ];

  test.each(calls)('%s: switched off by default', async (_n, call) => {
    delete process.env['CLOUDCRAFT_PROJECT_RELEASES'];
    expect((await call()).status).toBe(503);
    expect(mockPlanRelease).not.toHaveBeenCalled();
  });
  test.each(calls)('%s: needs a signed-in caller', async (_n, call) => { mockIdentity.mockReturnValue(null); expect((await call()).status).toBe(401); });
  test.each(calls)('%s: needs an owner or admin of the organization', async (_n, call) => { mockOrgRole.mockResolvedValue('member'); expect((await call()).status).toBe(403); });
  test.each(calls)('%s: needs access to the project (another organization\'s is not found)', async (_n, call) => { mockResolveArch.mockResolvedValue({ error: 'project_not_found' }); expect((await call()).status).toBe(404); });
  test.each(calls)('%s: refused to anyone outside the restricted-features list, and audited', async (_n, call) => {
    mockDenied.mockResolvedValue('This feature is not accessible for your account.');
    const res = await call();
    expect(res.status).toBe(403);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'release', outcome: 'denied', userId: 'alice' }));
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

describe('POST /releases (plan)', () => {
  const plan = (body: Record<string, unknown> = {}) => planPost(req(`/api/projects/${projectId}/releases`, { cloudAccountId: 'acct-1', stateBackend: BACKEND, project: project(), ...body }), ctx());
  const planned = () => {
    mockPlanRelease.mockImplementation(async (i: { project: StackProject }) => ({ bundle: buildAzureVmBundle(i.project), plan: { planId: PLAN.planId, planHash: PLAN.planHash, expiresAt: 'later', summary: { toAdd: 9, toChange: 0, toDestroy: 0, resourceChanges: [] } } }));
  };

  test('plans on the server from the settings, stores a planned release and says what it needs, without the files or the compose file', async () => {
    planned();
    const res = await plan();
    expect(res.status).toBe(201);
    const b = (await json(res)).data!;
    expect(b['release']).toMatchObject({ status: 'planned', project: 'shop', environment: 'production', secrets: ['JWT_SECRET'], built: ['backend', 'api'], planId: PLAN.planId });
    expect(b['plan']).toMatchObject({ planId: PLAN.planId, planHash: PLAN.planHash });
    expect(b['cost']).toEqual({ monthlyUsd: expect.any(Number) });
    expect(JSON.stringify(b)).not.toMatch(/compose|settings|cloudAccountId|acct-1/);
    const saved = (await store().get(b['release']['id']))!;
    expect(saved.cloudAccountId).toBe('acct-1');
    expect(saved.status).toBe('planned');
    expect(mockPlanRelease.mock.calls[0]![0]).toMatchObject({ projectId, orgId: 'org-1', environment: 'production', cloudAccountId: 'acct-1', stateBackend: BACKEND });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'release', outcome: 'requested', planId: PLAN.planId }));
  });

  test('the new release points at the one that is running now, so it can be put back', async () => {
    planned();
    const prev = await seed({ status: 'succeeded', updatedAt: 5 }, `prev-${n}`);
    const b = (await json(await plan())).data!;
    expect((await store().get(b['release']['id']))!.previousReleaseId).toBe(prev.id);
  });

  test('the settings are rebuilt from the project\'s own, so extra keys and secret values do not get in', async () => {
    planned();
    const p = project(); (p.layers.backend.config.env as unknown[]) = [{ key: 'JWT_SECRET', value: 'sneaked-in', secret: true }];
    const res = await plan({ project: p });
    expect(res.status).toBe(400);
    expect((await json(res)).error!.message).toMatch(/a secret has no value here/);
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('sneaked-in');
    expect(mockPlanRelease).not.toHaveBeenCalled();
    const ok = await plan({ project: { ...project(), evil: { x: 1 } } });
    expect(ok.status).toBe(201);
    expect(JSON.stringify(await store().get((await json(ok)).data!['release']['id']))).not.toContain('evil');
  });

  test.each([
    ['no account', { cloudAccountId: '' }], ['a state backend of nothing', { stateBackend: {} }], ['project not an object', { project: 'x' }], ['a wrong type', { project: { ...project(), name: 5 } }],
  ])('%s is a 400 and plans nothing', async (_n, body) => {
    planned();
    expect((await plan(body)).status).toBe(400);
    expect(mockPlanRelease).not.toHaveBeenCalled();
  });

  test('a project that cannot be deployed says why', async () => {
    const { BundleError } = jest.requireActual('@/lib/deploy/project/bundle');
    mockPlanRelease.mockRejectedValue(new BundleError(['Frontend: Port must be 1-65535']));
    const res = await plan();
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ message: expect.stringContaining('Port must be'), details: { errors: ['Frontend: Port must be 1-65535'] } });
  });

  test('a plan that destroys something is refused and audited', async () => {
    mockPlanRelease.mockRejectedValue(new FakePlanBlocked('Plan blocked: contains 1 resource destroy action'));
    const res = await plan();
    expect(res.status).toBe(400);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'blocked' }));
  });

  test('plans are limited per user', async () => {
    planned(); mockRate.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    expect((await plan()).status).toBe(429);
    expect(mockPlanRelease).not.toHaveBeenCalled();
  });

  test('a status error from the planner is passed on as such', async () => {
    mockPlanRelease.mockRejectedValue(Object.assign(new Error('Forbidden: Only Administrators'), { statusCode: 403 }));
    expect((await plan()).status).toBe(403);
    mockPlanRelease.mockRejectedValue(new Error('boom'));
    expect((await plan()).status).toBe(500);
  });
});

describe('GET releases', () => {
  test('lists this project\'s releases of one organization and environment, without the internals', async () => {
    await seed({}, `a-${n}`); await seed({ orgId: 'org-2' }, `b-${n}`); await seed({ environment: 'staging' }, `c-${n}`);
    const list = (await json(await listGet(req(`/api/projects/${projectId}/releases`), ctx()))).data!['releases'] as Array<{ id: string }>;
    expect(list.map((r) => r.id)).toEqual([`a-${n}`]);
  });

  test('one release; one of another project or organization is not found', async () => {
    const r = await seed();
    const res = await oneGet(req(`/api/projects/${projectId}/releases/${r.id}`), ctx(r.id));
    expect(res.status).toBe(200);
    expect(JSON.stringify(await json(res))).not.toMatch(/"compose"|"settings"|acct-1/);
    const other = await seed({ orgId: 'org-2' }, `o-${n}`);
    expect((await oneGet(req(`/api/projects/${projectId}/releases/${other.id}`), ctx(other.id))).status).toBe(404);
    const elsewhere = await seed({ projectId: 'other-project' }, `e-${n}`);
    expect((await oneGet(req(`/api/projects/${projectId}/releases/${elsewhere.id}`), ctx(elsewhere.id))).status).toBe(404);
    expect((await oneGet(req(`/api/projects/${projectId}/releases/nope`), ctx('nope'))).status).toBe(404);
  });

  test('a waiting release lists the secrets still missing (names), and says null when that cannot be read', async () => {
    const r = await seed({ status: 'waiting', outputs: OUT, steps: buildAzureVmBundle(project()) && (await seed()).steps.map((s) => (s.name === 'secrets' ? { ...s, state: 'waiting' as const } : s)) });
    mockOpsFor.mockResolvedValue(fakeOps(['JWT-SECRET']));
    expect((await json(await oneGet(req(`/api/projects/${projectId}/releases/${r.id}`), ctx(r.id)))).data!['missing']).toEqual([]);
    mockOpsFor.mockResolvedValue(fakeOps());
    expect((await json(await oneGet(req(`/api/projects/${projectId}/releases/${r.id}`), ctx(r.id)))).data!['missing']).toEqual(['JWT_SECRET']);
    mockOpsFor.mockRejectedValue(new Error('azure down'));
    expect((await json(await oneGet(req(`/api/projects/${projectId}/releases/${r.id}`), ctx(r.id)))).data!['missing']).toBeNull();
  });
});

describe('POST run', () => {
  const run = (r: Release) => runPost(req(`/api/projects/${projectId}/releases/${r.id}/run`, {}), ctx(r.id));

  test('a planned release runs with an approval for exactly its plan: spent for this organization, project, plan and hash, then queued', async () => {
    const r = await seed();
    const res = await run(r);
    expect(res.status).toBe(201);
    expect(A.consume).toHaveBeenCalledWith({ orgId: 'org-1', projectId, action: 'apply', planId: PLAN.planId, planHash: PLAN.planHash, userId: 'alice' });
    expect(mockEnqueue).toHaveBeenCalledWith({ releaseId: r.id, orgId: 'org-1', projectId, requestedBy: 'alice' });
    expect((await store().get(r.id))!.status).toBe('approved');
    expect(isProjectLocked(projectId)).toBe(true);        // the worker releases it
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'allowed', detail: expect.stringContaining('approved by bob') }));
  });

  test('without an approval nothing is queued, the project is unlocked and the release stays planned', async () => {
    A.consume.mockResolvedValue({ ok: false, code: 'needs_approval', reason: 'This plan has to be approved before it can run.' });
    const r = await seed();
    const res = await run(r);
    expect(res.status).toBe(403);
    expect((await json(res)).error!.code).toBe('APPROVAL_REQUIRED');
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(isProjectLocked(projectId)).toBe(false);
    expect((await store().get(r.id))!.status).toBe('planned');
  });

  test('a plan that has expired or changed is not run', async () => {
    mockVerify.mockImplementation(() => { throw Object.assign(new Error('Plan not found or has expired — generate a new plan.'), { statusCode: 404 }); });
    const r = await seed();
    expect((await run(r)).status).toBe(404);
    expect(A.consume).not.toHaveBeenCalled();
  });

  test('a plan of another project is not run', async () => {
    mockVerify.mockImplementation(() => ({ planId: PLAN.planId, planHash: PLAN.planHash, projectId: 'someone-elses', orgId: 'org-1' }));
    expect((await run(await seed())).status).toBe(403);
    expect(A.consume).not.toHaveBeenCalled();
  });

  test('one run at a time per project', async () => {
    const r = await seed();
    expect(acquireProjectLock(projectId)).toBe(true);
    const res = await run(r);
    expect(res.status).toBe(409);
    expect(A.consume).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('when queueing fails the approval is given back, the project is unlocked and the release is planned again', async () => {
    mockEnqueue.mockRejectedValue(new Error('queue down'));
    const r = await seed();
    expect((await run(r)).status).toBe(500);
    expect(A.giveBack).toHaveBeenCalledWith('appr-1');
    expect(isProjectLocked(projectId)).toBe(false);
    expect((await store().get(r.id))!.status).toBe('planned');
  });

  test('a release waiting for secrets, or failed after its infrastructure, continues without a new approval', async () => {
    const r = await seed();
    const done = r.steps.map((s) => (s.name === 'infrastructure' ? { ...s, state: 'done' as const } : s));
    for (const status of ['waiting', 'failed'] as const) {
      releaseProjectLock(projectId); mockEnqueue.mockClear(); A.consume.mockClear();
      await store().save({ ...r, status, steps: done, outputs: OUT });
      const res = await run(r);
      expect(res.status).toBe(201);
      expect(A.consume).not.toHaveBeenCalled();
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
    }
  });

  test('a release that failed before its infrastructure existed has to be planned again', async () => {
    const r = await seed({ status: 'failed' });
    const res = await run(r);
    expect(res.status).toBe(409);
    expect((await json(res)).error!.message).toMatch(/Plan the release again/);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test.each(['running', 'succeeded', 'rolled_back', 'cancelled', 'approved'] as const)('a %s release cannot be run', async (status) => {
    const r = await seed({ status });
    expect((await run(r)).status).toBe(409);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('a release of another organization is not found', async () => {
    const r = await seed({ orgId: 'org-2' });
    expect((await run(r)).status).toBe(404);
  });
});

describe('POST secrets', () => {
  const waiting = async () => {
    const r = await seed();
    const steps = r.steps.map((s) => (s.name === 'infrastructure' ? { ...s, state: 'done' as const } : s.name === 'secrets' ? { ...s, state: 'waiting' as const } : s));
    await store().save({ ...r, status: 'waiting', steps, outputs: OUT });
    return r;
  };
  const send = (r: Release, values: Record<string, string>, extra: Record<string, unknown> = {}) => secretsPost(req(`/api/projects/${projectId}/releases/${r.id}/secrets`, { values, ...extra }), ctx(r.id));

  test('stores each value in the vault, lists nothing but names, never audits a value, and continues the release when none is missing', async () => {
    const r = await waiting();
    const ops = fakeOps(); mockOpsFor.mockResolvedValue(ops);
    const res = await send(r, { JWT_SECRET: 'jwt-value_1' });
    expect(res.status).toBe(201);
    expect(ops.put).toEqual([['JWT-SECRET', 'jwt-value_1']]);
    const text = await res.text();
    expect(JSON.parse(text).data).toMatchObject({ missing: [], continued: true, jobId: 'job-1' });
    expect(JSON.stringify([mockAudit.mock.calls, text, await store().get(r.id)])).not.toContain('jwt-value_1');
    expect(mockEnqueue).toHaveBeenCalledWith({ releaseId: r.id, orgId: 'org-1', projectId, requestedBy: 'alice' });
  });

  test('values that leave some missing do not continue the release', async () => {
    const p = project(); p.layers.api.config.env = [{ key: 'STRIPE_KEY', value: '', secret: true }];
    const base = await seed({}, `two-${n}`);
    const bundle = buildAzureVmBundle(p);
    await store().save({ ...base, settings: p, bundleHash: bundle.bundleHash, secrets: ['JWT_SECRET', 'STRIPE_KEY'], status: 'waiting', steps: base.steps.map((s) => (s.name === 'secrets' ? { ...s, state: 'waiting' as const } : s)), outputs: OUT });
    mockOpsFor.mockResolvedValue(fakeOps());
    const res = await send(base, { JWT_SECRET: 'abc-123' });
    expect((await json(res)).data).toMatchObject({ missing: ['STRIPE_KEY'], continued: false });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test.each([
    ['an unknown name', { OTHER: 'abcdef' }, /not a secret this release is waiting for/],
    ['a value with a space', { JWT_SECRET: 'a b' }, /may use only letters, digits/],
  ])('%s is a 400 and nothing is stored', async (_n, values, why) => {
    const r = await waiting(); const ops = fakeOps(); mockOpsFor.mockResolvedValue(ops);
    const res = await send(r, values);
    expect(res.status).toBe(400);
    expect((await json(res)).error!.message).toMatch(why);
    expect(ops.put).toEqual([]);
  });

  test('anything but { values } is refused, and so is an empty or oversized list', async () => {
    const r = await waiting(); mockOpsFor.mockResolvedValue(fakeOps());
    expect((await send(r, { JWT_SECRET: 'abcdef' }, { password: 'x' })).status).toBe(400);
    expect((await send(r, {})).status).toBe(400);
    expect((await send(r, Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`K${i}`, 'abcdef'])))).status).toBe(400);
  });

  test('a release that is not waiting for secrets refuses them', async () => {
    const r = await seed(); mockOpsFor.mockResolvedValue(fakeOps());
    expect((await send(r, { JWT_SECRET: 'abcdef' })).status).toBe(409);
  });

  test('an account that is not Azure, or Azure refusing, is reported without the value', async () => {
    const r = await waiting();
    const { AccountError } = jest.requireMock('@/lib/deploy/project/accountOps');
    mockOpsFor.mockRejectedValue(new AccountError('A deployment to an Azure VM needs an Azure account.'));
    expect((await send(r, { JWT_SECRET: 'abcdef' })).status).toBe(400);
    const { AzureError } = jest.requireActual('@/lib/deploy/project/azureOps');
    const ops = fakeOps(); ops.putSecret = async () => { throw new AzureError('Could not store secret JWT-SECRET: Forbidden'); };
    mockOpsFor.mockResolvedValue(ops);
    const res = await send(r, { JWT_SECRET: 'abcdef' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await json(res))).not.toContain('abcdef');
  });

  test('an unexpected error is logged without the request, which holds the values', async () => {
    const r = await waiting();
    mockOpsFor.mockRejectedValue(new Error('something odd'));
    const res = await send(r, { JWT_SECRET: 'super-secret-value' });
    expect(res.status).toBe(500);
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('super-secret-value');
  });
});

describe('POST cancel', () => {
  test('stops a release that has not finished and audits it; a finished one cannot be cancelled', async () => {
    const r = await seed();
    const res = await cancelPost(req(`/api/projects/${projectId}/releases/${r.id}/cancel`, {}), ctx(r.id));
    expect(res.status).toBe(200);
    expect((await store().get(r.id))!.status).toBe('cancelled');
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('cancelled') }));
    expect((await cancelPost(req(`/api/projects/${projectId}/releases/${r.id}/cancel`, {}), ctx(r.id))).status).toBe(409);
    const other = await seed({ orgId: 'org-2' }, `x-${n}`);
    expect((await cancelPost(req(`/api/projects/${projectId}/releases/${other.id}/cancel`, {}), ctx(other.id))).status).toBe(404);
  });
});

describe('POST sources (uploading the code of a service)', () => {
  const up = (layer: string, zip: Buffer | null, name?: string) => sourcePost(form(layer, zip, name), ctx());

  test('reads the zip, keeps it for this project and service, and says what it found, without returning it', async () => {
    const res = await up('api', zipOf({ 'app/package.json': '{}', 'app/server.js': 'x', 'app/Dockerfile': 'FROM evil', 'app/.DS_Store': 'j' }));
    expect(res.status).toBe(201);
    const d = (await json(res)).data!;
    expect(d).toMatchObject({ layer: 'api', files: 3, skipped: 1, replaced: ['Dockerfile'] });
    expect(d['sha256']).toMatch(/^[a-f0-9]{64}$/);
    const stored = (await new PgSourceStore().get(d['sourceId']))!;
    expect(stored).toMatchObject({ orgId: 'org-1', projectId, layer: 'api', sha256: d['sha256'] });
    expect(JSON.stringify(d)).not.toContain('FROM evil');
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'allowed', detail: expect.stringContaining('uploaded code for api: 3 files') }));
  });

  test.each([['a layer that is not buildable', 'database'], ['no layer', '']])('%s is refused', async (_n, layer) => {
    expect((await up(layer, zipOf({ 'a.js': 'x' }))).status).toBe(400);
  });
  test('no file is refused', async () => { expect((await up('api', null)).status).toBe(400); });
  test('something that is not a zip, or an unsafe zip, is refused with the reason, audited, and not kept', async () => {
    expect((await up('api', Buffer.from('not a zip'))).status).toBe(400);
    const res = await up('api', zipOf({ '../evil.sh': 'x' }));
    expect(res.status).toBe(400);
    expect((await json(res)).error!.message).toMatch(/path that is not allowed/);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'blocked', detail: expect.stringContaining('refused') }));
  });
  test('a zip over the size limit is refused before it is read', async () => {
    const res = await up('api', Buffer.alloc(5 * 1024 * 1024 + 1, 1));
    expect(res.status).toBe(413);
  });
  test('uploads are limited per user', async () => {
    mockRate.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    expect((await up('api', zipOf({ 'a.js': 'x' }))).status).toBe(429);
  });
});

describe('planning with uploaded code', () => {
  const plan = (sources: Record<string, string>) => planPost(req(`/api/projects/${projectId}/releases`, { cloudAccountId: 'acct-1', stateBackend: BACKEND, project: project(), sources }), ctx());
  const uploaded = async (layer = 'api', over: Record<string, unknown> = {}) => {
    const { randomUUID } = await import('crypto');
    const id = randomUUID();
    await new PgSourceStore().put({ id, orgId: 'org-1', projectId, layer, zip: zipOf({ 'server.js': 'mine' }), expiresAtMs: Date.now() + 60_000, ...over });
    return id;
  };
  const planned = () => mockPlanRelease.mockImplementation(async (i: { project: StackProject; sources: Record<string, never> }) => ({ bundle: buildAzureVmBundle(i.project, i.sources), plan: { planId: PLAN.planId, planHash: PLAN.planHash, expiresAt: 'later', summary: { toAdd: 9, toChange: 0, toDestroy: 0, resourceChanges: [] } } }));

  test('the release records which code it was approved for, and the plan is made with it', async () => {
    planned();
    const id = await uploaded();
    const res = await plan({ api: id });
    expect(res.status).toBe(201);
    const b = (await json(res)).data!;
    expect(b['release'].ownCode).toEqual(['api']);
    const saved = (await store().get(b['release']['id']))!;
    expect(saved.sources['api']).toMatchObject({ id, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(Object.keys(mockPlanRelease.mock.calls[0]![0].sources)).toEqual(['api']);
    // The hash of what is approved is not the hash without the code.
    expect(saved.bundleHash).not.toBe(buildAzureVmBundle(project()).bundleHash);
  });

  test.each([
    ['code that does not exist', async () => 'nope'],
    ['code uploaded for another service', async () => uploaded('backend')],
    ['code of another project', async () => uploaded('api', { projectId: 'someone-elses' })],
    ['code of another organization', async () => uploaded('api', { orgId: 'org-2' })],
    ['code that has expired', async () => uploaded('api', { expiresAtMs: Date.now() - 1 })],
  ])('%s is refused and nothing is planned', async (_n, make) => {
    planned();
    const res = await plan({ api: await make() });
    expect(res.status).toBe(400);
    expect((await json(res)).error!.message).toMatch(/not found or has expired/);
    expect(mockPlanRelease).not.toHaveBeenCalled();
  });

  test('a service that is not built from source cannot have uploaded code', async () => {
    mockPlanRelease.mockRejectedValue(new (jest.requireActual('@/lib/deploy/project/bundle').BundleError)(['The frontend is not built from source, so it cannot have uploaded code.']));
    const res = await plan({ frontend: await uploaded('frontend') });
    expect(res.status).toBe(400);
  });

  test('only the three buildable services can be named', async () => {
    expect((await plan({ database: 'x' })).status).toBe(400);
  });
});

describe('POST rollback', () => {
  const infraDone = (r: Release) => r.steps.map((x) => (x.name === 'infrastructure' ? { ...x, state: 'done' as const } : x));
  const succeeded = (id: string, tag: string, at: number) => seed({ status: 'succeeded', imageTag: tag, updatedAt: at, outputs: OUT, steps: undefined as never }, id);
  const rb = (id: string, body: unknown = { confirm: true }) => rollbackPost(req(`/api/projects/${projectId}/releases/${id}/rollback`, body), ctx(id));

  test('queues a release that puts the earlier one back and says which it replaces', async () => {
    const old = await seed({ status: 'succeeded', imageTag: 'v1', updatedAt: 5, outputs: OUT }, `old-${n}`);
    await seed({ status: 'succeeded', imageTag: 'v2', updatedAt: 9, outputs: OUT }, `cur-${n}`);
    const res = await rb(old.id);
    expect(res.status).toBe(201);
    const d = (await json(res)).data!;
    expect(d['release']).toMatchObject({ status: 'approved', imageTag: 'v1', previousReleaseId: `cur-${n}` });
    expect(mockEnqueue).toHaveBeenCalledWith({ releaseId: d['release']['id'], orgId: 'org-1', projectId, requestedBy: 'alice' });
    expect((await store().get(d['release']['id']))!.rollbackOf).toBe(old.id);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining(`puts release ${old.id} (v1) back`) }));
    expect(isProjectLocked(projectId)).toBe(true);
  });

  test('needs an explicit confirm', async () => {
    const old = await seed({ status: 'succeeded', updatedAt: 5, outputs: OUT }, `old-${n}`);
    for (const body of [{}, { confirm: false }, { confirm: 'yes' }, { confirm: true, extra: 1 }]) expect((await rb(old.id, body)).status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('the running release, one that did not succeed, and another organization\'s are not put back, and the project is unlocked after', async () => {
    const cur = await seed({ status: 'succeeded', updatedAt: 9, outputs: OUT }, `cur-${n}`);
    expect((await rb(cur.id)).status).toBe(409);
    expect(isProjectLocked(projectId)).toBe(false);
    const failed = await seed({ status: 'failed', outputs: OUT }, `failed-${n}`);
    expect((await rb(failed.id)).status).toBe(409);
    const other = await seed({ orgId: 'org-2', status: 'succeeded', outputs: OUT }, `other-${n}`);
    expect((await rb(other.id)).status).toBe(404);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('one run at a time per project, and a queue that is down leaves the project unlocked', async () => {
    const old = await seed({ status: 'succeeded', updatedAt: 5, outputs: OUT }, `old-${n}`);
    await seed({ status: 'succeeded', updatedAt: 9, outputs: OUT }, `cur-${n}`);
    expect(acquireProjectLock(projectId)).toBe(true);
    expect((await rb(old.id)).status).toBe(409);
    releaseProjectLock(projectId);
    mockEnqueue.mockRejectedValue(new Error('queue down'));
    expect((await rb(old.id)).status).toBe(500);
    expect(isProjectLocked(projectId)).toBe(false);
  });
  void infraDone; void succeeded;
});

describe('POST destroy (tearing down what a release created)', () => {
  const FILES = ['cloud-init.sh', 'compose.deploy.yml', 'main.tf', 'outputs.tf', 'variables.tf'];
  const made = async (over: Partial<Release> = {}) => { const r = await seed({}, `d-${n}`); const steps = r.steps.map((x) => (x.name === 'infrastructure' ? { ...x, state: 'done' as const } : x)); const full = { ...r, status: 'succeeded' as const, steps, outputs: OUT, ...over }; await store().save(full); return full; };
  const call = (r: Release, body: Record<string, unknown> = {}) => destroyPost(req(`/api/projects/${projectId}/releases/${r.id}/destroy`, { stateBackend: BACKEND, ...body }), ctx(r.id));
  const PREPARED = { planId: 'destroy-plan-1234', planHash: 'd'.repeat(64), resources: [{ address: 'azurerm_resource_group.app', type: 'azurerm_resource_group' }, { address: 'azurerm_linux_virtual_machine.app', type: 'azurerm_linux_virtual_machine' }] };

  beforeEach(() => {
    mockPrepareDestroy.mockResolvedValue(PREPARED);
    mockPeekDestroy.mockReturnValue({ planId: PREPARED.planId, planHash: PREPARED.planHash, orgId: 'org-1', projectId, resources: PREPARED.resources });
    mockStartDestroy.mockResolvedValue({ runId: 'run-1' });
  });

  test('an AWS release previews with its EC2 Terraform and no SSH key', async () => {
    const r = await made();
    const settings = JSON.parse(JSON.stringify(r.settings)); settings.deploy.target = 'ec2';
    const ec2 = await made({ settings });
    const res = await call(ec2);
    expect(res.status).toBe(200);
    const input = mockPrepareDestroy.mock.calls.at(-1)![0];
    expect(input.bundleFiles.map((f: { filename: string }) => f.filename).sort()).toEqual(['compose.deploy.yml', 'main.tf', 'outputs.tf', 'user_data.sh', 'variables.tf']);
    expect(input.extraEnv).toBeUndefined();
  });

  test('an ECS release previews with its cluster Terraform and no SSH key', async () => {
    const r = await made();
    const settings = JSON.parse(JSON.stringify(r.settings)); settings.deploy.target = 'ecs';
    const ecs = await made({ settings });
    expect((await call(ecs)).status).toBe(200);
    const input = mockPrepareDestroy.mock.calls.at(-1)![0];
    expect(input.bundleFiles.map((f: { filename: string }) => f.filename).sort()).toEqual(['main.tf', 'outputs.tf', 'variables.tf']);
    expect(input.extraEnv).toBeUndefined();
  });

  test('previews with the release\'s own Terraform against its state, and lists what would go, with a token bound to that plan', async () => {
    const r = await made();
    const res = await call(r);
    expect(res.status).toBe(200);
    const d = (await json(res)).data!;
    expect(d).toMatchObject({ status: 'confirmation_required', planId: PREPARED.planId, planHash: PREPARED.planHash, resourceCount: 2, project: 'shop' });
    expect(d['confirmationToken']).toBeTruthy();
    const input = mockPrepareDestroy.mock.calls[0]![0];
    expect(input).toMatchObject({ projectId, orgId: 'org-1', environment: 'production', cloudAccountId: 'acct-1', stateBackend: BACKEND });
    expect(input.bundleFiles.map((f: { filename: string }) => f.filename).sort()).toEqual(FILES);
    expect(input.extraEnv).toEqual({ TF_VAR_admin_ssh_public_key: 'ssh-ed25519 AAAATEST' });
    expect(mockStartDestroy).not.toHaveBeenCalled();
  });

  test('a release that never created anything has nothing to tear down; nothing in the state says so', async () => {
    expect((await call(await seed())).status).toBe(409);
    mockPrepareDestroy.mockResolvedValue({ planId: null, planHash: null, resources: [] });
    expect((await json(await call(await made()))).data).toMatchObject({ status: 'nothing_to_destroy' });
  });

  async function preview(r: Release) { return (await json(await call(r))).data!; }

  test('runs exactly the previewed plan, only with its approval, the confirmation token and the project name typed', async () => {
    const r = await made();
    const p = await preview(r);
    const run = await call(r, { confirmationToken: p['confirmationToken'], planId: p['planId'], confirmName: 'shop' });
    expect(run.status).toBe(201);
    expect((await json(run)).data).toMatchObject({ status: 'started', runId: 'run-1' });
    expect(A.consume).toHaveBeenCalledWith({ orgId: 'org-1', projectId, action: 'destroy', planId: PREPARED.planId, planHash: PREPARED.planHash, userId: 'alice' });
    expect(mockStartDestroy).toHaveBeenCalledWith(expect.objectContaining({ planId: PREPARED.planId, planHash: PREPARED.planHash, orgId: 'org-1', projectId, cloudAccountId: 'acct-1' }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'destroy', outcome: 'allowed', detail: expect.stringContaining('approved by bob') }));
  });

  test('the token cannot be used twice', async () => {
    const r = await made();
    const p = await preview(r);
    const body = { confirmationToken: p['confirmationToken'], planId: p['planId'], confirmName: 'shop' };
    expect((await call(r, body)).status).toBe(201);
    expect((await call(r, body)).status).toBeGreaterThanOrEqual(400);
    expect(mockStartDestroy).toHaveBeenCalledTimes(1);
  });

  test('a wrong or missing project name stops it before anything is spent', async () => {
    const r = await made();
    const p = await preview(r);
    for (const confirmName of [undefined, '', 'Shop', 'other']) expect((await call(r, { confirmationToken: p['confirmationToken'], planId: p['planId'], ...(confirmName === undefined ? {} : { confirmName }) })).status).toBe(400);
    expect(A.consume).not.toHaveBeenCalled();
    expect(mockStartDestroy).not.toHaveBeenCalled();
  });

  test('without an approval nothing is run and the token is not used up', async () => {
    const r = await made();
    const p = await preview(r);
    A.consume.mockResolvedValue({ ok: false, code: 'needs_approval', reason: 'This teardown has to be approved before it can run.' });
    const body = { confirmationToken: p['confirmationToken'], planId: p['planId'], confirmName: 'shop' };
    const res = await call(r, body);
    expect(res.status).toBe(403);
    expect((await json(res)).error!.code).toBe('APPROVAL_REQUIRED');
    expect(mockStartDestroy).not.toHaveBeenCalled();
    A.consume.mockResolvedValue({ ok: true, approval: { id: 'appr-1', decidedBy: 'bob' } });
    expect((await call(r, body)).status).toBe(201);                    // the token was still good
  });

  test('a preview of another project or that has expired is not run, and a failed start gives the approval back', async () => {
    const r = await made();
    const p = await preview(r);
    mockPeekDestroy.mockReturnValue(null);
    expect((await call(r, { confirmationToken: p['confirmationToken'], planId: p['planId'], confirmName: 'shop' })).status).toBe(404);
    mockPeekDestroy.mockReturnValue({ planId: PREPARED.planId, planHash: PREPARED.planHash, orgId: 'org-1', projectId: 'other', resources: PREPARED.resources });
    expect((await call(r, { confirmationToken: p['confirmationToken'], planId: p['planId'], confirmName: 'shop' })).status).toBe(404);
    mockPeekDestroy.mockReturnValue({ planId: PREPARED.planId, planHash: PREPARED.planHash, orgId: 'org-1', projectId, resources: PREPARED.resources });
    mockStartDestroy.mockRejectedValue(Object.assign(new Error('Another Terraform apply or teardown is already running'), { statusCode: 409 }));
    const res = await call(r, { confirmationToken: p['confirmationToken'], planId: p['planId'], confirmName: 'shop' });
    expect(res.status).toBe(409);
    expect(A.giveBack).toHaveBeenCalledWith('appr-1');
  });

  test('previews are limited per user, and a state backend of nothing is refused', async () => {
    const r = await made();
    mockRate.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    expect((await call(r)).status).toBe(429);
    mockRate.mockResolvedValue({ allowed: true });
    expect((await call(r, { stateBackend: {} })).status).toBe(400);
    expect(mockPrepareDestroy).not.toHaveBeenCalled();
  });
});

describe('GET with reconcile (after a teardown)', () => {
  test('marks the releases of a resource group that is gone as destroyed, as Azure says', async () => {
    const r = await seed({ status: 'succeeded', outputs: OUT });
    const ops = fakeOps(); let exists = true;
    ops.resourceGroupExists = async () => exists;
    mockOpsFor.mockResolvedValue(ops);
    const ask = () => oneGet(req(`/api/projects/${projectId}/releases/${r.id}?reconcile=1`), ctx(r.id));
    expect((await json(await ask())).data!['release'].status).toBe('succeeded');
    exists = false;
    expect((await json(await ask())).data!['release'].status).toBe('destroyed');
    expect((await store().get(r.id))!.status).toBe('destroyed');
  });

  test('without the flag Azure is not asked, and a failing Azure leaves the release as it is', async () => {
    const r = await seed({ status: 'succeeded', outputs: OUT });
    await oneGet(req(`/api/projects/${projectId}/releases/${r.id}`), ctx(r.id));
    expect(mockOpsFor).not.toHaveBeenCalled();
    mockOpsFor.mockRejectedValue(new Error('azure down'));
    expect((await json(await oneGet(req(`/api/projects/${projectId}/releases/${r.id}?reconcile=1`), ctx(r.id)))).data!['release'].status).toBe('succeeded');
  });
});
