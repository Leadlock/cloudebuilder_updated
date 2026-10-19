const mockIdentity = jest.fn();
const mockOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockOrgRole(...a) }));
const mockResolveOrg = jest.fn();
const mockResolveArch = jest.fn();
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockResolveOrg(...a), resolveArchitecture: (...a: unknown[]) => mockResolveArch(...a) }));
const mockInspect = jest.fn();
const mockRelease = jest.fn();
jest.mock('@/lib/terraform/execution/lockRelease', () => ({ inspectStateLock: (...a: unknown[]) => mockInspect(...a), releaseStateLock: (...a: unknown[]) => mockRelease(...a) }));
const mockAudit = jest.fn();
jest.mock('@/lib/terraform/execution/audit', () => ({ recordTerraformAudit: (...a: unknown[]) => mockAudit(...a) }));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/projects/[id]/terraform/unlock/route';

const env = process.env as Record<string, string | undefined>;
const saved = env.CLOUDBUILDER_TERRAFORM_ORG_IDS;
const backend = { provider: 'azure', resourceGroupName: 'rg', storageAccountName: 'cloudbuilder', containerName: 'tfstate', key: 'k.tfstate' };
const LOCK_ID = 'b62dca92-6904-8aff-9c92-38241bd68610';
const call = (b: unknown) => POST(new NextRequest('http://localhost/api/projects/proj-1/terraform/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }), { params: Promise.resolve({ id: 'proj-1' }) });
let u = 0;

beforeEach(() => {
  [mockIdentity, mockOrgRole, mockResolveOrg, mockResolveArch, mockInspect, mockRelease, mockAudit].forEach((m) => m.mockReset());
  env.CLOUDBUILDER_TERRAFORM_ORG_IDS = 'org-1';
  mockIdentity.mockReturnValue({ userId: `unlock-user-${++u}`, role: 'admin', orgIds: [] });
  mockResolveOrg.mockResolvedValue('org-1'); mockOrgRole.mockResolvedValue('owner'); mockResolveArch.mockResolvedValue({ arch: {}, project: {} });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { if (saved === undefined) delete env.CLOUDBUILDER_TERRAFORM_ORG_IDS; else env.CLOUDBUILDER_TERRAFORM_ORG_IDS = saved; });

describe('POST /api/projects/[id]/terraform/unlock', () => {
  it('inspect returns what the check found and audits it, changing nothing', async () => {
    mockInspect.mockResolvedValue({ locked: true, lock: { id: LOCK_ID, who: 'H\\u@H', ageMinutes: 5 }, releasable: true });
    const res = await call({ action: 'inspect', cloudAccountId: 'acct-1', stateBackend: backend });
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { releasable: boolean } }).data.releasable).toBe(true);
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'unlock', outcome: 'requested' }));
  });

  it('release passes the lock id through, and audits success', async () => {
    mockRelease.mockResolvedValue({ released: true });
    const res = await call({ action: 'release', cloudAccountId: 'acct-1', stateBackend: backend, lockId: LOCK_ID });
    expect(res.status).toBe(200);
    expect(mockRelease).toHaveBeenCalledWith(expect.objectContaining({ lockId: LOCK_ID, projectId: 'proj-1', orgId: 'org-1' }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'unlock', outcome: 'succeeded' }));
  });

  it('a refusal from the safety check is a 409 that explains why, and is audited as blocked', async () => {
    mockRelease.mockRejectedValue(Object.assign(new Error('The lock was taken by TANMAY, not by this server.'), { statusCode: 409 }));
    const res = await call({ action: 'release', cloudAccountId: 'acct-1', stateBackend: backend, lockId: LOCK_ID });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('TANMAY');
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'unlock', outcome: 'blocked' }));
  });

  it('requires a valid lock id for release, and a signed-in administrator', async () => {
    expect((await call({ action: 'release', cloudAccountId: 'acct-1', stateBackend: backend, lockId: 'x; rm -rf' })).status).toBe(400);
    expect((await call({ action: 'release', cloudAccountId: 'acct-1', stateBackend: backend })).status).toBe(400);
    mockIdentity.mockReturnValue({ userId: 'plain', role: 'user', orgIds: [] });
    expect((await call({ action: 'inspect', cloudAccountId: 'acct-1', stateBackend: backend })).status).toBe(403);
    mockIdentity.mockReturnValue(null);
    expect((await call({ action: 'inspect', cloudAccountId: 'acct-1', stateBackend: backend })).status).toBe(401);
    expect(mockInspect).not.toHaveBeenCalled(); expect(mockRelease).not.toHaveBeenCalled();
  });

  it('is behind the same access gate as plan/apply/destroy', async () => {
    delete env.CLOUDBUILDER_TERRAFORM_ORG_IDS;
    expect((await call({ action: 'inspect', cloudAccountId: 'acct-1', stateBackend: backend })).status).toBe(403);
    expect(mockInspect).not.toHaveBeenCalled();
  });
});
