/**
 * The routes around approval: asking for it, deciding it, and the apply route refusing to run a plan without it.
 * (The approval rules themselves — single use, expiry, second person — are in terraformApprovals.test.ts.)
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

const A = { mode: jest.fn(), request: jest.fn(), list: jest.fn(), get: jest.fn(), decide: jest.fn(), consume: jest.fn(), giveBack: jest.fn() };
jest.mock('@/lib/terraform/execution/approvals', () => ({
  approvalMode: (...a: unknown[]) => A.mode(...a), requestApproval: (...a: unknown[]) => A.request(...a), listApprovals: (...a: unknown[]) => A.list(...a),
  getApproval: (...a: unknown[]) => A.get(...a), decideApproval: (...a: unknown[]) => A.decide(...a),
  consumeApproval: (...a: unknown[]) => A.consume(...a), returnApproval: (...a: unknown[]) => A.giveBack(...a),
}));
const mockVerify = jest.fn();
jest.mock('@/lib/terraform/execution/TerraformExecutionService', () => ({ verifyPlanForApply: (...a: unknown[]) => mockVerify(...a) }));
const mockPeekDestroy = jest.fn();
jest.mock('@/lib/terraform/execution/destroyPlans', () => ({ peekPreparedDestroy: (...a: unknown[]) => mockPeekDestroy(...a) }));
const mockEnqueue = jest.fn();
jest.mock('@/lib/jobs/terraformApplyJob', () => ({ enqueueApplyJob: (...a: unknown[]) => mockEnqueue(...a), getApplyJobStatus: jest.fn() }));

import { NextRequest } from 'next/server';
import { POST as applyPost } from '@/app/api/projects/[id]/terraform/apply/route';
import { GET as approvalsGet, POST as approvalsPost } from '@/app/api/projects/[id]/terraform/approvals/route';
import { POST as decidePost } from '@/app/api/projects/[id]/terraform/approvals/[approvalId]/route';
import { isProjectLocked, releaseProjectLock } from '@/lib/terraform/execution/projectLock';

let n = 0;
let projectId = '';
const PLAN = { planId: 'plan-1', planHash: 'h'.repeat(64) };
const record = (over: object = {}) => ({ planId: 'plan-1', planHash: PLAN.planHash, projectId, orgId: 'org-1', cloudAccountId: 'acct-1', summary: { toAdd: 3, toChange: 1, toDestroy: 0 }, ...over });
const req = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
  new NextRequest(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const proj = () => ({ params: Promise.resolve({ id: projectId }) });
const decideCtx = (approvalId = 'appr-1') => ({ params: Promise.resolve({ id: projectId, approvalId }) });
const approval = (over: object = {}) => ({ id: 'appr-1', orgId: 'org-1', projectId, action: 'apply', planId: 'plan-1', planHash: PLAN.planHash, summary: '3 to add', requestedBy: 'alice', status: 'pending', decidedBy: null, decidedAt: null, comment: null, createdAt: 'now', expiresAt: 'later', ...over });
const signedIn = (userId: string, role = 'owner') => { mockIdentity.mockReturnValue({ userId, role: 'admin', email: `${userId}@x.io`, orgIds: ['org-1'] }); mockOrgRole.mockResolvedValue(role); };
const lastBody = async (res: Response) => (await res.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string } };

beforeEach(() => {
  [mockIdentity, mockOrgRole, mockResolveOrg, mockResolveArch, mockDenied, mockAudit, mockVerify, mockPeekDestroy, mockEnqueue, ...Object.values(A)].forEach((m) => m.mockReset());
  projectId = `proj-approval-${++n}`;
  mockResolveOrg.mockResolvedValue('org-1'); mockResolveArch.mockResolvedValue({ arch: {}, project: {} });
  mockDenied.mockResolvedValue(null);
  A.mode.mockReturnValue('required');
  signedIn('alice');
  mockVerify.mockImplementation(() => record());
  mockEnqueue.mockResolvedValue('job-1');
  A.consume.mockResolvedValue({ ok: true, approval: { id: 'appr-1', decidedBy: 'bob' } });
  A.giveBack.mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => releaseProjectLock(projectId));

describe('POST /terraform/apply — needs an approval for exactly this plan', () => {
  const apply = () => applyPost(req(`/api/projects/${projectId}/terraform/apply`, PLAN), proj());

  it('runs an approved plan, spending the approval for exactly that organisation, project, plan and hash', async () => {
    const res = await apply();
    expect(res.status).toBe(201);
    expect(A.consume).toHaveBeenCalledWith({ orgId: 'org-1', projectId, action: 'apply', planId: 'plan-1', planHash: PLAN.planHash, userId: expect.any(String) });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'apply', outcome: 'allowed', detail: expect.stringContaining('approved by bob') }));
  });

  it('refuses a plan nobody approved (403 APPROVAL_REQUIRED), queues nothing and leaves the project unlocked', async () => {
    A.consume.mockResolvedValue({ ok: false, code: 'needs_approval', reason: 'This plan has to be approved before it can run. Request approval first.' });
    const res = await apply();
    expect(res.status).toBe(403);
    const body = await lastBody(res);
    expect(body.error?.code).toBe('APPROVAL_REQUIRED');
    expect(body.error?.message).toMatch(/approved/);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(isProjectLocked(projectId)).toBe(false);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'apply', outcome: 'blocked', detail: 'approval: needs_approval' }));
  });

  it.each(['pending', 'rejected'])('refuses a plan whose request is %s', async (code) => {
    A.consume.mockResolvedValue({ ok: false, code, reason: `request is ${code}` });
    expect((await apply()).status).toBe(403);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('gives the approval back if the apply could not be queued, so it is not spent for nothing', async () => {
    mockEnqueue.mockRejectedValue(new Error('queue down'));
    expect((await apply()).status).toBe(500);
    expect(A.giveBack).toHaveBeenCalledWith('appr-1');
    expect(isProjectLocked(projectId)).toBe(false);
  });

  it('does not spend an approval on a plan that fails verification, or while another apply holds the project', async () => {
    mockVerify.mockImplementation(() => { throw Object.assign(new Error('Plan not found or has expired'), { statusCode: 404 }); });
    expect((await apply()).status).toBe(404);
    expect(A.consume).not.toHaveBeenCalled();

    mockVerify.mockImplementation(() => record());
    expect((await apply()).status).toBe(201);                                  // takes the project lock…
    A.consume.mockClear();
    expect((await apply()).status).toBe(409);                                  // …so the next apply is a conflict, and spends nothing
    expect(A.consume).not.toHaveBeenCalled();
  });

  it('still applies when approval is switched off (no approval to spend)', async () => {
    A.consume.mockResolvedValue({ ok: true, approval: null });
    expect((await apply()).status).toBe(201);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'allowed', detail: expect.stringContaining('approval switched off') }));
  });
});

describe('POST /terraform/approvals — asking for approval', () => {
  const ask = (body: object = { action: 'apply', ...PLAN }) => approvalsPost(req(`/api/projects/${projectId}/terraform/approvals`, body), proj());

  it('opens a request for a real plan of this project, with a summary the approver can read', async () => {
    A.request.mockImplementation(async (i: object) => ({ approval: approval(i), created: true }));
    const res = await ask();
    expect(res.status).toBe(201);
    expect(A.request).toHaveBeenCalledWith({ orgId: 'org-1', projectId, action: 'apply', planId: 'plan-1', planHash: PLAN.planHash, requestedBy: 'alice', summary: '3 to add, 1 to change, 0 to destroy' });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'approval', outcome: 'requested', userId: 'alice' }));
  });

  it('asking again returns the request that is already open (200, not a second one)', async () => {
    A.request.mockResolvedValue({ approval: approval(), created: false });
    expect((await ask()).status).toBe(200);
  });

  it('can ask for a teardown preview too', async () => {
    mockPeekDestroy.mockReturnValue({ planId: 'plan-1', planHash: PLAN.planHash, orgId: 'org-1', projectId, environment: 'production', resources: [{ address: 'a', type: 'aws_vpc' }, { address: 'b', type: 'aws_s3' }] });
    A.request.mockImplementation(async (i: object) => ({ approval: approval(i), created: true }));
    expect((await ask({ action: 'destroy', ...PLAN })).status).toBe(201);
    expect(A.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'destroy', summary: 'Tear down 2 resource(s) in the production state' }));
  });

  it('refuses a plan of another project or organisation, an unknown or changed plan, and a preview that expired', async () => {
    mockVerify.mockImplementation(() => record({ projectId: 'some-other-project' }));
    expect((await ask()).status).toBe(404);
    mockVerify.mockImplementation(() => record({ orgId: 'org-2' }));
    expect((await ask()).status).toBe(404);
    mockVerify.mockImplementation(() => { throw Object.assign(new Error('Plan hash mismatch'), { statusCode: 409 }); });
    expect((await ask()).status).toBe(400);
    mockVerify.mockImplementation(() => { throw Object.assign(new Error('Plan not found or has expired'), { statusCode: 404 }); });
    expect((await ask()).status).toBe(404);
    mockPeekDestroy.mockReturnValue(null);
    expect((await ask({ action: 'destroy', ...PLAN })).status).toBe(404);
    mockPeekDestroy.mockReturnValue({ planId: 'plan-1', planHash: 'different', orgId: 'org-1', projectId, environment: 'production', resources: [] });
    expect((await ask({ action: 'destroy', ...PLAN })).status).toBe(400);
    expect(A.request).not.toHaveBeenCalled();
  });

  it('needs owner/admin of the organisation, a project of that organisation, a signed-in user and the Terraform access gate', async () => {
    signedIn('mallory', 'member');
    expect((await ask()).status).toBe(403);
    signedIn('alice'); mockResolveArch.mockResolvedValue({ error: 'project_not_found' });
    expect((await ask()).status).toBe(404);
    mockResolveArch.mockResolvedValue({ arch: {}, project: {} }); mockDenied.mockResolvedValue('Terraform execution is not enabled for this organization.');
    expect((await ask()).status).toBe(403);
    mockDenied.mockResolvedValue(null); mockIdentity.mockReturnValue(null);
    expect((await ask()).status).toBe(401);
    expect(A.request).not.toHaveBeenCalled();
  });

  it('says there is nothing to request when approval is switched off', async () => {
    A.mode.mockReturnValue('off');
    expect((await ask()).status).toBe(400);
    expect(A.request).not.toHaveBeenCalled();
  });

  it('validates its input', async () => {
    expect((await ask({ action: 'format-disk', ...PLAN })).status).toBe(400);
    expect((await ask({ action: 'apply' })).status).toBe(400);
  });
});

describe('GET /terraform/approvals', () => {
  it('lists the project\'s requests with the policy and who is asking, for any member; nothing for another organisation\'s project', async () => {
    signedIn('viewer', 'member');
    A.list.mockResolvedValue([approval()]);
    const res = await approvalsGet(req(`/api/projects/${projectId}/terraform/approvals`), proj());
    expect(res.status).toBe(200);
    const body = await lastBody(res);
    expect(body.data).toMatchObject({ mode: 'required', you: 'viewer' });
    expect((body.data?.approvals as unknown[]).length).toBe(1);
    expect(A.list).toHaveBeenCalledWith(projectId, 'org-1');
    mockResolveArch.mockResolvedValue({ error: 'project_not_found' });
    expect((await approvalsGet(req(`/api/projects/${projectId}/terraform/approvals`), proj())).status).toBe(404);
  });
});

describe('POST /terraform/approvals/[approvalId] — deciding', () => {
  const decide = (body: object = { decision: 'approve' }, id = 'appr-1') => decidePost(req(`/api/projects/${projectId}/terraform/approvals/${id}`, body), decideCtx(id));

  it('lets another owner/admin approve, and records who decided and what', async () => {
    signedIn('bob', 'admin');
    A.get.mockResolvedValue(approval());
    A.decide.mockResolvedValue({ ok: true, approval: approval({ status: 'approved', decidedBy: 'bob' }) });
    const res = await decide({ decision: 'approve', comment: 'looks right' });
    expect(res.status).toBe(200);
    expect(A.decide).toHaveBeenCalledWith({ id: 'appr-1', orgId: 'org-1', decidedBy: 'bob', decision: 'approve', comment: 'looks right' });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'approval', outcome: 'allowed', userId: 'bob', detail: expect.stringContaining('approved') }));
  });

  it('records a rejection as denied', async () => {
    signedIn('bob', 'admin'); A.get.mockResolvedValue(approval());
    A.decide.mockResolvedValue({ ok: true, approval: approval({ status: 'rejected', decidedBy: 'bob' }) });
    expect((await decide({ decision: 'reject' })).status).toBe(200);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'approval', outcome: 'denied' }));
  });

  it('refuses your own request (403), an expired or already-decided one (409), and says why', async () => {
    A.get.mockResolvedValue(approval());
    A.decide.mockResolvedValue({ ok: false, code: 'own_request', reason: 'A different owner or admin has to approve this.' });
    const own = await decide();
    expect(own.status).toBe(403);
    expect((await lastBody(own)).error?.message).toMatch(/different owner or admin/);
    A.decide.mockResolvedValue({ ok: false, code: 'expired', reason: 'That request has expired.' });
    expect((await decide()).status).toBe(409);
    A.decide.mockResolvedValue({ ok: false, code: 'not_pending', reason: 'already approved' });
    expect((await decide()).status).toBe(409);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'approval', outcome: 'blocked' }));
  });

  it('cannot decide a request that does not exist or belongs to a different project', async () => {
    A.get.mockResolvedValue(null);
    expect((await decide()).status).toBe(404);
    A.get.mockResolvedValue(approval({ projectId: 'a-different-project' }));
    expect((await decide()).status).toBe(404);
    expect(A.decide).not.toHaveBeenCalled();
  });

  it('is only for an owner/admin of the organisation who passes the Terraform access gate, and needs a valid body', async () => {
    A.get.mockResolvedValue(approval());
    signedIn('mallory', 'member');
    expect((await decide()).status).toBe(403);
    signedIn('bob', 'admin'); mockDenied.mockResolvedValue('Terraform execution is not enabled for this organization.');
    expect((await decide()).status).toBe(403);
    mockDenied.mockResolvedValue(null);
    expect((await decide({ decision: 'maybe' })).status).toBe(400);
    mockIdentity.mockReturnValue(null);
    expect((await decide()).status).toBe(401);
    expect(A.decide).not.toHaveBeenCalled();
  });
});
