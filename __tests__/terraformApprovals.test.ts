/**
 * Approval before Terraform runs (lib/terraform/execution/approvals.ts), against an in-memory Postgres (pg-mem) with the
 * same table shape as the migration.
 */
import { newDb } from 'pg-mem';
import { _setSharedDbForTests, type Queryable } from '@/lib/api/sharedStore';
import {
  approvalMode, requestApproval, decideApproval, consumeApproval, returnApproval, getApproval, listApprovals, APPROVAL_TTL_MS,
} from '@/lib/terraform/execution/approvals';

const env = process.env as Record<string, string | undefined>;
const saved = { mode: env['CLOUDBUILDER_TERRAFORM_APPROVAL'], node: env['NODE_ENV'] };
let mem: ReturnType<typeof newDb>;

beforeEach(() => {
  mem = newDb();
  mem.public.none(`CREATE TABLE "terraformApproval" ("id" text PRIMARY KEY, "createdAt" text NOT NULL, "orgId" text NOT NULL, "projectId" text NOT NULL,
    "action" text NOT NULL, "planId" text NOT NULL, "planHash" text NOT NULL, "summary" text, "requestedBy" text NOT NULL, "status" text NOT NULL,
    "decidedBy" text, "decidedAt" text, "comment" text, "expiresAtMs" double precision NOT NULL, "usedAt" text)`);
  const { Pool } = mem.adapters.createPg();
  _setSharedDbForTests(new Pool() as unknown as Queryable);
  env['CLOUDBUILDER_TERRAFORM_APPROVAL'] = 'self-ok';       // these tests are about the approval records; password mode has its own file
  env['NODE_ENV'] = 'test';
});
afterEach(() => {
  _setSharedDbForTests(null);
  if (saved.mode === undefined) delete env['CLOUDBUILDER_TERRAFORM_APPROVAL']; else env['CLOUDBUILDER_TERRAFORM_APPROVAL'] = saved.mode;
  env['NODE_ENV'] = saved.node;
});

const PLAN: { orgId: string; projectId: string; action: 'apply' | 'destroy'; planId: string; planHash: string } = { orgId: 'org-1', projectId: 'proj-1', action: 'apply', planId: 'plan-1', planHash: 'hash-1' };
const ask = (over: Partial<typeof PLAN> & { requestedBy?: string } = {}) => requestApproval({ ...PLAN, requestedBy: 'alice', summary: '3 to add, 0 to change, 0 to destroy', ...over });
const expireEverything = () => mem.public.none('UPDATE "terraformApproval" SET "expiresAtMs" = "expiresAtMs" - 3600000');

describe('approvalMode', () => {
  it('defaults to confirming with a password everywhere, and follows CLOUDBUILDER_TERRAFORM_APPROVAL', () => {
    delete env['CLOUDBUILDER_TERRAFORM_APPROVAL'];
    env['NODE_ENV'] = 'production'; expect(approvalMode()).toBe('password');
    env['NODE_ENV'] = 'development'; expect(approvalMode()).toBe('password');
    env['NODE_ENV'] = 'test'; expect(approvalMode()).toBe('password');
    env['CLOUDBUILDER_TERRAFORM_APPROVAL'] = 'self-ok'; expect(approvalMode()).toBe('self-ok');
    env['CLOUDBUILDER_TERRAFORM_APPROVAL'] = 'REQUIRED'; expect(approvalMode()).toBe('required');
    env['CLOUDBUILDER_TERRAFORM_APPROVAL'] = 'off'; expect(approvalMode()).toBe('off');
    env['CLOUDBUILDER_TERRAFORM_APPROVAL'] = 'nonsense'; env['NODE_ENV'] = 'production'; expect(approvalMode()).toBe('password');   // a typo never switches the gate off
  });
});

describe('requesting approval', () => {
  it('opens a pending request, and asking again for the same plan returns the same one', async () => {
    const first = await ask();
    expect(first.created).toBe(true);
    expect(first.approval).toMatchObject({ status: 'pending', requestedBy: 'alice', planId: 'plan-1', planHash: 'hash-1', action: 'apply' });
    const again = await ask();
    expect(again.created).toBe(false);
    expect(again.approval.id).toBe(first.approval.id);
    expect((await ask({ planHash: 'hash-2' })).created).toBe(true);        // a different plan is a different request
    expect((await ask({ action: 'destroy' })).created).toBe(true);
  });

  it('opens a new request once the old one has expired', async () => {
    const first = await ask(); expireEverything();
    const next = await ask();
    expect(next.created).toBe(true);
    expect(next.approval.id).not.toBe(first.approval.id);
  });
});

describe('deciding', () => {
  it('in required mode a different admin approves; the requester cannot approve their own request but can withdraw it', async () => {
    env['CLOUDBUILDER_TERRAFORM_APPROVAL'] = 'required';
    const { approval } = await ask();
    const own = await decideApproval({ id: approval.id, orgId: 'org-1', decidedBy: 'alice', decision: 'approve' });
    expect(own).toMatchObject({ ok: false, code: 'own_request' });
    const ok = await decideApproval({ id: approval.id, orgId: 'org-1', decidedBy: 'bob', decision: 'approve', comment: 'looks right' });
    expect(ok.ok && ok.approval).toMatchObject({ status: 'approved', decidedBy: 'bob', comment: 'looks right' });

    const other = (await ask({ planId: 'plan-2' })).approval;
    const withdrawn = await decideApproval({ id: other.id, orgId: 'org-1', decidedBy: 'alice', decision: 'reject' });
    expect(withdrawn.ok && withdrawn.approval.status).toBe('rejected');
  });

  it('in self-ok mode the requester may approve, still as an explicit step', async () => {
    env['CLOUDBUILDER_TERRAFORM_APPROVAL'] = 'self-ok';
    const { approval } = await ask();
    const r = await decideApproval({ id: approval.id, orgId: 'org-1', decidedBy: 'alice', decision: 'approve' });
    expect(r.ok && r.approval.status).toBe('approved');
  });

  it('cannot decide something twice, in another organisation, that does not exist, or that has expired', async () => {
    env['CLOUDBUILDER_TERRAFORM_APPROVAL'] = 'required';
    const { approval } = await ask();
    expect(await decideApproval({ id: approval.id, orgId: 'org-OTHER', decidedBy: 'bob', decision: 'approve' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await decideApproval({ id: 'missing', orgId: 'org-1', decidedBy: 'bob', decision: 'approve' })).toMatchObject({ ok: false, code: 'not_found' });
    expect((await decideApproval({ id: approval.id, orgId: 'org-1', decidedBy: 'bob', decision: 'reject' })).ok).toBe(true);
    expect(await decideApproval({ id: approval.id, orgId: 'org-1', decidedBy: 'carol', decision: 'approve' })).toMatchObject({ ok: false, code: 'not_pending' });
    const stale = (await ask({ planId: 'plan-3' })).approval; expireEverything();
    expect(await decideApproval({ id: stale.id, orgId: 'org-1', decidedBy: 'bob', decision: 'approve' })).toMatchObject({ ok: false, code: 'expired' });
  });

  it('an approval gets a fresh window to be used once it is given', async () => {
    env['CLOUDBUILDER_TERRAFORM_APPROVAL'] = 'required';
    const { approval } = await ask();
    const before = Date.parse(approval.expiresAt);
    const r = await decideApproval({ id: approval.id, orgId: 'org-1', decidedBy: 'bob', decision: 'approve' });
    expect(r.ok && Date.parse(r.approval.expiresAt)).toBeGreaterThanOrEqual(before);
    expect(r.ok && Date.parse(r.approval.expiresAt) - Date.now()).toBeLessThanOrEqual(APPROVAL_TTL_MS + 5000);
  });
});

describe('consuming an approval (what the apply / destroy routes do)', () => {
  const approved = async (over: Partial<typeof PLAN> = {}) => {
    const { approval } = await ask(over);
    await decideApproval({ id: approval.id, orgId: over.orgId ?? 'org-1', decidedBy: 'bob', decision: 'approve' });
    return approval;
  };

  it('refuses a plan that was never submitted, and says what to do', async () => {
    expect(await consumeApproval(PLAN)).toMatchObject({ ok: false, code: 'needs_approval' });
  });

  it('refuses while the request is pending or after it was rejected, with a message for each', async () => {
    const { approval } = await ask();
    const pending = await consumeApproval(PLAN);
    expect(pending).toMatchObject({ ok: false, code: 'pending' });
    expect(!pending.ok && pending.reason).toMatch(/waiting for approval/);
    await decideApproval({ id: approval.id, orgId: 'org-1', decidedBy: 'bob', decision: 'reject' });
    const rejected = await consumeApproval(PLAN);
    expect(rejected).toMatchObject({ ok: false, code: 'rejected' });
  });

  it('is single-use: one approval starts one run', async () => {
    await approved();
    const first = await consumeApproval(PLAN);
    expect(first.ok && first.approval?.status).toBe('used');
    expect(await consumeApproval(PLAN)).toMatchObject({ ok: false, code: 'needs_approval' });
  });

  it('under concurrent requests exactly one run gets the approval', async () => {
    await approved();
    const results = await Promise.all(Array.from({ length: 6 }, () => consumeApproval(PLAN)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('only covers exactly the plan that was approved: another plan, hash, project, organisation or action is not covered', async () => {
    await approved();
    for (const other of [{ planId: 'plan-X' }, { planHash: 'hash-X' }, { projectId: 'proj-X' }, { orgId: 'org-X' }, { action: 'destroy' as const }]) {
      expect(await consumeApproval({ ...PLAN, ...other })).toMatchObject({ ok: false });
    }
    expect((await consumeApproval(PLAN)).ok).toBe(true);                       // and the real one is still there, untouched
  });

  it('an approval that was not used in time expires', async () => {
    await approved(); expireEverything();
    expect(await consumeApproval(PLAN)).toMatchObject({ ok: false, code: 'needs_approval' });
  });

  it('can be given back if the run could not start, so the approver is not asked twice for nothing', async () => {
    const a = await approved();
    const spent = await consumeApproval(PLAN);
    expect(spent.ok).toBe(true);
    await returnApproval(a.id);
    expect((await consumeApproval(PLAN)).ok).toBe(true);
  });

  it('is not required at all when the mode is off', async () => {
    env['CLOUDBUILDER_TERRAFORM_APPROVAL'] = 'off';
    expect(await consumeApproval(PLAN)).toEqual({ ok: true, approval: null });
  });
});

describe('reading', () => {
  it('getApproval is scoped to the organisation, and listApprovals shows newest first with expiry worked out', async () => {
    const a = (await ask()).approval;
    expect(await getApproval(a.id, 'org-1')).toMatchObject({ id: a.id });
    expect(await getApproval(a.id, 'org-OTHER')).toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    const b = (await ask({ planId: 'plan-9' })).approval;
    expect((await listApprovals('proj-1', 'org-1')).map((x) => x.id)).toEqual([b.id, a.id]);
    expect(await listApprovals('proj-1', 'org-OTHER')).toEqual([]);
    expireEverything();
    expect((await listApprovals('proj-1', 'org-1')).every((x) => x.status === 'expired')).toBe(true);
  });
});
