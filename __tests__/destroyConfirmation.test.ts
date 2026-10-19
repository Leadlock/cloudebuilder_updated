const mockIdentity = jest.fn();
const mockOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockOrgRole(...a) }));
const mockResolveOrg = jest.fn();
const mockResolveArch = jest.fn();
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockResolveOrg(...a), resolveArchitecture: (...a: unknown[]) => mockResolveArch(...a) }));
const mockPrepare = jest.fn();
const mockStart = jest.fn();
jest.mock('@/lib/terraform/execution/TerraformExecutionService', () => ({
  prepareDestroy: (...a: unknown[]) => mockPrepare(...a),
  startDestroyRun: (...a: unknown[]) => mockStart(...a),
  PlanBlockedError: class extends Error {},
}));
jest.mock('@/lib/repositories/orgRepository', () => ({ orgRepository: {} }));   // AuthService only needs it for DB-backed lookups
const mockConsumeApproval = jest.fn();
const mockReturnApproval = jest.fn();
jest.mock('@/lib/terraform/execution/approvals', () => ({
  consumeApproval: (...a: unknown[]) => mockConsumeApproval(...a),
  returnApproval: (...a: unknown[]) => mockReturnApproval(...a),
}));
const mockAudit = jest.fn();
jest.mock('@/lib/terraform/execution/audit', () => ({ recordTerraformAudit: (...a: unknown[]) => mockAudit(...a) }));

import { NextRequest } from 'next/server';
import { POST as destroyPost, GET as destroyGet } from '@/app/api/projects/[id]/terraform/destroy/route';
import { consumeDestroyConfirmation, issueDestroyConfirmation, DESTROY_CONFIRM_TTL_MS, type DestroyBinding } from '@/lib/terraform/execution/destroyConfirmation';
import { savePreparedDestroy, takePreparedDestroy, _clearDestroyPlansForTests } from '@/lib/terraform/execution/destroyPlans';
import { startRun, _clearRunsForTests } from '@/lib/terraform/execution/runRegistry';
import { AuthService } from '@/lib/api/authService';

const binding: DestroyBinding = {
  userId: 'u1', orgId: 'org-1', projectId: 'proj-1', environment: 'production', cloudAccountId: 'acct-1',
  stateBackend: { provider: 'aws', bucket: 'tf-state', key: 'a/b.tfstate', region: 'us-east-1' },
  resources: [{ id: 'aws_vpc.main', resourceType: 'aws_vpc' }, { id: 'aws_instance.web', resourceType: 'aws_instance' }],
  planHash: 'a'.repeat(64),
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
    ['a resource added since the preview', { resources: [...binding.resources, { id: 'aws_rds.db', resourceType: 'aws_rds' }] }],
    ['a resource removed since the preview', { resources: binding.resources.slice(1) }],
    ['a different saved plan', { planHash: 'b'.repeat(64) }],
    ['no plan at all', { planHash: undefined }],
  ])('is refused for %s', (_n, patch) => {
    const { token } = issueDestroyConfirmation(binding);
    expect(consumeDestroyConfirmation(token, { ...binding, ...patch } as DestroyBinding).ok).toBe(false);
    expect(consumeDestroyConfirmation(token, binding).ok).toBe(true);     // a refused attempt does not use the token up
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
    expect(AuthService.getSession(token)).toBeNull();                       // and a confirmation token is not a login session
  });
});

describe('/api/projects/[id]/terraform/destroy — preview, then run, then watch', () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = env.CLOUDBUILDER_TERRAFORM_ORG_IDS;
  const ARCH = { id: 'arch-1', resources: [{ id: 'r1', resourceType: 'aws_vpc', label: 'VPC' }] };
  const backend = { provider: 'aws', bucket: 'tf-state', key: 'a/b.tfstate', region: 'us-east-1' };
  const body = (extra: object = {}) => ({ environment: 'production', cloudAccountId: 'acct-1', stateBackend: backend, ...extra });
  const url = (projectId: string) => `http://localhost/api/projects/${projectId}/terraform/destroy`;
  const call = (b: unknown, projectId = 'proj-1') => destroyPost(new NextRequest(url(projectId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }), { params: Promise.resolve({ id: projectId }) });
  const status = (runId: string | null, projectId = 'proj-1') => destroyGet(new NextRequest(`${url(projectId)}${runId ? `?runId=${runId}` : ''}`), { params: Promise.resolve({ id: projectId }) });
  let user = 0;

  /** Registers a prepared plan the way the real prepareDestroy does, and returns what it returns. */
  const fakePrepare = async (resources = [{ address: 'aws_vpc.main', type: 'aws_vpc' }, { address: 'aws_instance.web', type: 'aws_instance' }]) => {
    const planId = `plan-${Math.random().toString(36).slice(2)}-0000`;
    const planHash = 'c'.repeat(64);
    await savePreparedDestroy({ planId, planHash, workDir: '/tmp/none', orgId: 'org-1', projectId: 'proj-1', userId: `destroy-user-${user}`, environment: 'production', cloudAccountId: 'acct-1', stateBackend: backend, resources });
    return { planId, planHash, resources };
  };

  beforeEach(async () => {
    [mockIdentity, mockOrgRole, mockResolveOrg, mockResolveArch, mockPrepare, mockStart, mockAudit, mockConsumeApproval, mockReturnApproval].forEach((m) => m.mockReset());
    mockConsumeApproval.mockResolvedValue({ ok: true, approval: { id: 'appr-1', decidedBy: 'approver-1' } });
    mockReturnApproval.mockResolvedValue(undefined);
    await _clearDestroyPlansForTests(); _clearRunsForTests();
    env.CLOUDBUILDER_TERRAFORM_ORG_IDS = 'org-1';
    mockIdentity.mockReturnValue({ userId: `destroy-user-${++user}`, role: 'admin', email: 'a@example.com', orgIds: [] });   // fresh user: its own plan budget
    mockResolveOrg.mockResolvedValue('org-1'); mockOrgRole.mockResolvedValue('owner');
    mockResolveArch.mockResolvedValue({ arch: ARCH, project: { name: 'Demo' } });
    mockPrepare.mockImplementation(() => fakePrepare());
    mockStart.mockImplementation(async (i: { planId: string }) => { takePreparedDestroy(i.planId); return { runId: 'run-123' }; });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { if (saved === undefined) delete env.CLOUDBUILDER_TERRAFORM_ORG_IDS; else env.CLOUDBUILDER_TERRAFORM_ORG_IDS = saved; });

  type Preview = { data: { status: string; confirmationToken: string; planId: string; resourceCount: number; resources: { address: string }[] } };

  it('step 1 previews what is really in the state and destroys nothing; step 2 starts the run and returns a run id', async () => {
    const preview = await call(body());
    expect(preview.status).toBe(200);
    const p = await preview.json() as Preview;
    expect(p.data.status).toBe('confirmation_required');
    expect(p.data.resourceCount).toBe(2);
    expect(p.data.resources.map((r) => r.address)).toEqual(['aws_vpc.main', 'aws_instance.web']);
    expect(mockStart).not.toHaveBeenCalled();

    const started = await call(body({ confirmationToken: p.data.confirmationToken, planId: p.data.planId }));
    expect(started.status).toBe(201);
    expect((await started.json() as { data: { status: string; runId: string } }).data).toEqual({ status: 'started', runId: 'run-123' });
    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({ planId: p.data.planId, planHash: 'c'.repeat(64), projectId: 'proj-1', orgId: 'org-1' }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'destroy', outcome: 'allowed' }));
  });

  describe('approval before the teardown runs', () => {
    const refusal = { ok: false, code: 'needs_approval', reason: 'This teardown has to be approved before it can run. Request approval first.' };

    it('spends the approval for exactly this preview (organisation, project, plan and hash)', async () => {
      const p = await (await call(body())).json() as Preview;
      expect((await call(body({ confirmationToken: p.data.confirmationToken, planId: p.data.planId }))).status).toBe(201);
      expect(mockConsumeApproval).toHaveBeenCalledWith({ orgId: 'org-1', projectId: 'proj-1', action: 'destroy', planId: p.data.planId, planHash: 'c'.repeat(64), userId: expect.any(String) });
    });

    it('passes the deletion-protection choice to the teardown: on by default, off when the person unticks it', async () => {
      const p1 = await (await call(body())).json() as Preview;
      await call(body({ confirmationToken: p1.data.confirmationToken, planId: p1.data.planId }));
      expect(mockStart.mock.calls.at(-1)![0]).toMatchObject({ disableProtection: true });

      const p2 = await (await call(body())).json() as Preview;
      await call(body({ confirmationToken: p2.data.confirmationToken, planId: p2.data.planId, disableProtection: false }));
      expect(mockStart.mock.calls.at(-1)![0]).toMatchObject({ disableProtection: false });
    });

    it('refuses to start without one (403 APPROVAL_REQUIRED), starts nothing, and does NOT use up the confirmation token', async () => {
      const p = await (await call(body())).json() as Preview;
      mockConsumeApproval.mockResolvedValueOnce(refusal);
      const blocked = await call(body({ confirmationToken: p.data.confirmationToken, planId: p.data.planId }));
      expect(blocked.status).toBe(403);
      const err = await blocked.json() as { error: { code: string; message: string } };
      expect(err.error.code).toBe('APPROVAL_REQUIRED');
      expect(err.error.message).toMatch(/approved/);
      expect(mockStart).not.toHaveBeenCalled();
      expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'destroy', outcome: 'blocked', detail: 'approval: needs_approval' }));
      // once it is approved, the same preview and token work — nothing had to be previewed again
      expect((await call(body({ confirmationToken: p.data.confirmationToken, planId: p.data.planId }))).status).toBe(201);
    });

    it('gives the approval back when the teardown could not start, so it is not spent for nothing', async () => {
      const p = await (await call(body())).json() as Preview;
      mockStart.mockRejectedValue(Object.assign(new Error('Another Terraform apply or teardown is already running for this project.'), { statusCode: 409 }));
      expect((await call(body({ confirmationToken: p.data.confirmationToken, planId: p.data.planId }))).status).toBe(409);
      expect(mockReturnApproval).toHaveBeenCalledWith('appr-1');
    });

    it('gives the approval back when the confirmation token is refused', async () => {
      const p = await (await call(body())).json() as Preview;
      const res = await call(body({ confirmationToken: p.data.confirmationToken, planId: p.data.planId, stateBackend: { ...backend, bucket: 'a-different-bucket' } }));
      expect(res.status).toBe(400);
      expect(mockReturnApproval).toHaveBeenCalledWith('appr-1');
      expect(mockStart).not.toHaveBeenCalled();
    });

    it('when approval is switched off (approval is null) the teardown starts as before', async () => {
      mockConsumeApproval.mockResolvedValue({ ok: true, approval: null });
      const p = await (await call(body())).json() as Preview;
      expect((await call(body({ confirmationToken: p.data.confirmationToken, planId: p.data.planId }))).status).toBe(201);
      expect(mockReturnApproval).not.toHaveBeenCalled();
    });
  });

  it('says so when the state holds nothing to destroy', async () => {
    mockPrepare.mockResolvedValue({ planId: null, planHash: null, resources: [] });
    const res = await call(body());
    expect((await res.json() as { data: { status: string } }).data.status).toBe('nothing_to_destroy');
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('a token cannot be replayed, a made-up token or plan id starts nothing', async () => {
    const p = await (await call(body())).json() as Preview;
    expect((await call(body({ confirmationToken: p.data.confirmationToken, planId: p.data.planId }))).status).toBe(201);
    mockStart.mockClear();
    expect((await call(body({ confirmationToken: p.data.confirmationToken, planId: p.data.planId }))).status).toBe(404);   // the plan is used up
    const p2 = await (await call(body())).json() as Preview;
    expect((await call(body({ confirmationToken: 'this-is-not-a-real-token', planId: p2.data.planId }))).status).toBe(400);
    expect((await call(body({ confirmationToken: p2.data.confirmationToken, planId: 'plan-does-not-exist-0000' }))).status).toBe(404);
    expect((await call(body({ confirmationToken: p2.data.confirmationToken }))).status).toBe(400);                           // planId missing
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'destroy', outcome: 'blocked' }));
  });

  it('a token issued for a different state backend does not work', async () => {
    const p = await (await call(body())).json() as Preview;
    const other = body({ confirmationToken: p.data.confirmationToken, planId: p.data.planId, stateBackend: { ...backend, bucket: 'a-different-bucket' } });
    expect((await call(other)).status).toBe(400);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('a concurrent teardown/apply on the project is reported as a conflict', async () => {
    const p = await (await call(body())).json() as Preview;
    mockStart.mockRejectedValue(Object.assign(new Error('Another Terraform apply or teardown is already running for this project.'), { statusCode: 409 }));
    expect((await call(body({ confirmationToken: p.data.confirmationToken, planId: p.data.planId }))).status).toBe(409);
  });

  it('is still behind the access gate: not enabled → 403 and nothing is planned', async () => {
    delete env.CLOUDBUILDER_TERRAFORM_ORG_IDS;
    expect((await call(body())).status).toBe(403);
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it('a preview counts as a plan against the user\'s plan allowance', async () => {
    let last = 200;
    for (let i = 0; i < 7; i++) last = (await call(body())).status;
    expect(last).toBe(429);
    expect(mockPrepare).toHaveBeenCalledTimes(6);
  });

  it('GET returns the run\'s state and live output for its own organisation only, and needs a signed-in user', async () => {
    const run = startRun({ runId: 'run-live-1', orgId: 'org-1', projectId: 'proj-1', kind: 'destroy' });
    run.append('aws_vpc.main: Destroying...\n');
    const res = await status('run-live-1');
    expect(res.status).toBe(200);
    const snap = (await res.json() as { data: { state: string; logTail: string[] } }).data;
    expect(snap.state).toBe('running');
    expect(snap.logTail).toContain('aws_vpc.main: Destroying...');

    mockResolveOrg.mockResolvedValue('org-2');
    expect((await status('run-live-1')).status).toBe(404);                  // another organisation cannot see it
    mockResolveOrg.mockResolvedValue('org-1');
    expect((await status(null)).status).toBe(400);
    mockIdentity.mockReturnValue(null);
    expect((await status('run-live-1')).status).toBe(401);
  });
});
