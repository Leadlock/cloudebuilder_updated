const mockIdentity = jest.fn();
const mockOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockOrgRole(...a) }));
const mockResolveOrg = jest.fn();
const mockResolveArch = jest.fn();
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockResolveOrg(...a), resolveArchitecture: (...a: unknown[]) => mockResolveArch(...a) }));
const mockDestroy = jest.fn();
jest.mock('@/lib/terraform/execution/TerraformExecutionService', () => ({ executeDestroy: (...a: unknown[]) => mockDestroy(...a), PlanBlockedError: class extends Error {} }));
jest.mock('@/lib/repositories/orgRepository', () => ({ orgRepository: {} }));   // AuthService only needs it for DB-backed lookups
const mockAudit = jest.fn();
jest.mock('@/lib/terraform/execution/audit', () => ({ recordTerraformAudit: (...a: unknown[]) => mockAudit(...a) }));

import { NextRequest } from 'next/server';
import { POST as destroyPost } from '@/app/api/projects/[id]/terraform/destroy/route';
import { consumeDestroyConfirmation, issueDestroyConfirmation, DESTROY_CONFIRM_TTL_MS, type DestroyBinding } from '@/lib/terraform/execution/destroyConfirmation';
import { AuthService } from '@/lib/api/authService';

const binding: DestroyBinding = {
  userId: 'u1', orgId: 'org-1', projectId: 'proj-1', environment: 'production', cloudAccountId: 'acct-1',
  stateBackend: { provider: 'aws', bucket: 'tf-state', key: 'a/b.tfstate', region: 'us-east-1' },
  resources: [{ id: 'r1', resourceType: 'aws_vpc' }, { id: 'r2', resourceType: 'aws_instance' }],
};

describe('destroy confirmation token', () => {
  it('is accepted once for exactly what was previewed, and never again', () => {
    const { token } = issueDestroyConfirmation(binding);
    expect(consumeDestroyConfirmation(token, binding)).toEqual({ ok: true });
    const replay = consumeDestroyConfirmation(token, binding);
    expect(replay.ok).toBe(false);
    expect((replay as { reason: string }).reason).toMatch(/already been used/i);
  });

  it('does not depend on the order resources were listed in', () => {
    const { token } = issueDestroyConfirmation(binding);
    expect(consumeDestroyConfirmation(token, { ...binding, resources: [...binding.resources].reverse() }).ok).toBe(true);
  });

  it.each([
    ['another user', { userId: 'someone-else' }],
    ['another organisation', { orgId: 'org-2' }],
    ['another project', { projectId: 'proj-2' }],
    ['another environment', { environment: 'staging' }],
    ['another cloud account', { cloudAccountId: 'acct-2' }],
    ['another state backend', { stateBackend: { provider: 'aws', bucket: 'other', key: 'a/b.tfstate', region: 'us-east-1' } }],
    ['a resource added since the preview', { resources: [...binding.resources, { id: 'r3', resourceType: 'aws_rds' }] }],
    ['a resource removed since the preview', { resources: binding.resources.slice(1) }],
  ])('is refused for %s', (_n, patch) => {
    const { token } = issueDestroyConfirmation(binding);
    expect(consumeDestroyConfirmation(token, { ...binding, ...patch } as DestroyBinding).ok).toBe(false);
    // and a refused attempt does not use the token up
    expect(consumeDestroyConfirmation(token, binding).ok).toBe(true);
  });

  it('expires after five minutes', () => {
    const { token } = issueDestroyConfirmation(binding);
    const real = Date.now;
    try {
      Date.now = () => real() + DESTROY_CONFIRM_TTL_MS + 1000;
      const r = consumeDestroyConfirmation(token, binding);
      expect(r.ok).toBe(false);
      expect((r as { reason: string }).reason).toMatch(/expired/i);
    } finally { Date.now = real; }
  });

  it('rejects garbage, a tampered token, and a login session token', () => {
    expect(consumeDestroyConfirmation('garbage', binding).ok).toBe(false);
    const { token } = issueDestroyConfirmation(binding);
    expect(consumeDestroyConfirmation(`${token}x`, binding).ok).toBe(false);
    const session = AuthService.createSession({ id: 'u1', email: 'a@example.com', name: 'A', role: 'admin', orgId: 'org-1' });
    expect(consumeDestroyConfirmation(session.token, binding).ok).toBe(false);
    // and a confirmation token is not a login session
    expect(AuthService.getSession(token)).toBeNull();
  });
});

describe('POST /api/projects/[id]/terraform/destroy — two steps', () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = env.CLOUDCRAFT_TERRAFORM_ORG_IDS;
  const body = (extra: object = {}) => ({
    environment: 'production', cloudAccountId: 'acct-1',
    stateBackend: { provider: 'aws', bucket: 'tf-state', key: 'a/b.tfstate', region: 'us-east-1' }, ...extra,
  });
  const call = (b: unknown, projectId = 'proj-1') => destroyPost(
    new NextRequest(`http://localhost/api/projects/${projectId}/terraform/destroy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }),
    { params: Promise.resolve({ id: projectId }) });

  beforeEach(() => {
    [mockIdentity, mockOrgRole, mockResolveOrg, mockResolveArch, mockDestroy, mockAudit].forEach((m) => m.mockReset());
    env.CLOUDCRAFT_TERRAFORM_ORG_IDS = 'org-1';
    mockIdentity.mockReturnValue({ userId: 'u1', role: 'admin', email: 'a@example.com', orgIds: [] });
    mockResolveOrg.mockResolvedValue('org-1'); mockOrgRole.mockResolvedValue('owner');
    mockResolveArch.mockResolvedValue({ arch: { id: 'arch-1', resources: binding.resources.map((r) => ({ ...r, label: `res ${r.id}` })) }, project: { name: 'Demo' } });
    mockDestroy.mockResolvedValue({ message: 'destroyed', outputTail: '' });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { if (saved === undefined) delete env.CLOUDCRAFT_TERRAFORM_ORG_IDS; else env.CLOUDCRAFT_TERRAFORM_ORG_IDS = saved; });

  type Preview = { data: { status: string; confirmationToken: string; resourceCount: number; resources: { label: string }[] } };

  it('the first request only previews — it destroys nothing — and the second runs the destroy', async () => {
    const preview = await call(body());
    expect(preview.status).toBe(200);
    const p = await preview.json() as Preview;
    expect(p.data.status).toBe('confirmation_required');
    expect(p.data.resourceCount).toBe(2);
    expect(p.data.resources.map((r) => r.label)).toEqual(['res r1', 'res r2']);
    expect(mockDestroy).not.toHaveBeenCalled();

    const done = await call(body({ confirmationToken: p.data.confirmationToken }));
    expect(done.status).toBe(200);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'destroy', outcome: 'succeeded' }));
  });

  it('a token cannot be replayed, and a made-up token destroys nothing', async () => {
    const p = await (await call(body())).json() as Preview;
    expect((await call(body({ confirmationToken: p.data.confirmationToken }))).status).toBe(200);
    mockDestroy.mockClear();
    expect((await call(body({ confirmationToken: p.data.confirmationToken }))).status).toBe(400);
    expect((await call(body({ confirmationToken: 'this-is-not-a-real-token' }))).status).toBe(400);
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'destroy', outcome: 'blocked' }));
  });

  it('refuses when the architecture changed between the preview and the confirmation', async () => {
    const p = await (await call(body())).json() as Preview;
    mockResolveArch.mockResolvedValue({ arch: { id: 'arch-1', resources: [...binding.resources, { id: 'r9', resourceType: 'aws_rds' }].map((r) => ({ ...r, label: r.id })) }, project: { name: 'Demo' } });
    const res = await call(body({ confirmationToken: p.data.confirmationToken }));
    expect(res.status).toBe(400);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('refuses a token issued for a different state backend', async () => {
    const p = await (await call(body())).json() as Preview;
    const other = body({ confirmationToken: p.data.confirmationToken, stateBackend: { provider: 'aws', bucket: 'a-different-bucket', key: 'a/b.tfstate', region: 'us-east-1' } });
    expect((await call(other)).status).toBe(400);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('is still behind the access gate: not enabled → 403 and no preview', async () => {
    delete env.CLOUDCRAFT_TERRAFORM_ORG_IDS;
    expect((await call(body())).status).toBe(403);
    expect(mockDestroy).not.toHaveBeenCalled();
  });
});
