/**
 * The super administrator (SUPER_ADMIN_EMAILS): only they approve, reject or send back an architecture review, nothing is planned or deployed
 * without their approval, and they are an owner of the organizations they belong to.
 */
jest.mock('@/src/prisma/db', () => ({ db: { orm: { public: {} } }, pool: {} }));
jest.mock('@/lib/repositories/orgRepository', () => ({ orgRepository: {} }));
const mockIdentity = jest.fn();
jest.mock('@/lib/api/auth', () => ({ ...jest.requireActual('@/lib/api/auth'), extractIdentity: (...a: unknown[]) => mockIdentity(...a) }));
jest.mock('@/lib/api/projectAccess', () => ({ requireProjectAccess: async () => ({ orgId: 'o1', role: 'owner' }) }));

import { NextRequest } from 'next/server';
import { ArchitectureReviewService, type ArchitectureReview } from '@/lib/services/ArchitectureReviewService';
import { isSuperAdmin, mayDecideReviews, reviewDecisionMessage, superAdminEmails } from '@/lib/auth/superAdmins';
import { POST as approve } from '@/app/api/projects/[id]/reviews/[reviewId]/approve/route';
import { POST as reject } from '@/app/api/projects/[id]/reviews/[reviewId]/reject/route';
import { POST as requestChanges } from '@/app/api/projects/[id]/reviews/[reviewId]/request-changes/route';
import { generatePlan } from '@/lib/terraform/execution/TerraformExecutionService';
import { canUseRestrictedFeatures } from '@/lib/auth/restrictedFeatures';
import { checkProductionConfig } from '@/lib/startup/productionChecks';
import type { CanvasNode } from '@/types';

const OLD = process.env['SUPER_ADMIN_EMAILS'];
const SUPER = 'ajinkya@neozaar.com';
beforeEach(() => { process.env['SUPER_ADMIN_EMAILS'] = SUPER; mockIdentity.mockReset(); });
afterAll(() => { if (OLD === undefined) delete process.env['SUPER_ADMIN_EMAILS']; else process.env['SUPER_ADMIN_EMAILS'] = OLD; });

const env = (v?: string): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', ...(v === undefined ? {} : { SUPER_ADMIN_EMAILS: v }) });
const submitter = { id: 'u-dev', name: 'Dev', email: 'dev@neozaar.com' };
const summary = { nodeCount: 1, edgeCount: 0, criticalIssuesCount: 0, estimatedMonthlyCost: 10 };
const nodes = [{ id: 'n1', type: 'cloudNode', resourceType: 'aws_s3', provider: 'aws', label: 'Bucket', position: { x: 0, y: 0 }, config: {} }] as CanvasNode[];
let n = 0;
const submit = (project = `p-${++n}`) => ArchitectureReviewService.submitReview(project, 'production', nodes, [], submitter, summary);
const post = (path: string, body: unknown = { comments: 'ok' }) => new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ctx = (id: string, reviewId: string) => ({ params: Promise.resolve({ id, reviewId }) });
const asAdmin = (email: string) => mockIdentity.mockReturnValue({ userId: `u-${email}`, email, role: 'admin', orgIds: ['o1'] });

describe('the rule', () => {
  test('parsing, case, and look-alikes', () => {
    expect(superAdminEmails(env('Ajinkya@NeoZaar.com, ops@neozaar.com'))).toEqual(['ajinkya@neozaar.com', 'ops@neozaar.com']);
    expect(isSuperAdmin(' AJINKYA@neozaar.com ', env(SUPER))).toBe(true);
    for (const x of ['ajinkya@neozaar.com.evil.com', 'xajinkya@neozaar.com', 'ajinkya+1@neozaar.com', '', undefined, null]) expect(isSuperAdmin(x, env(SUPER))).toBe(false);
  });

  test('with a super administrator only they decide, whatever their role; without one an admin decides, as before', () => {
    expect(mayDecideReviews(SUPER, 'admin', env(SUPER))).toBe(true);
    expect(mayDecideReviews(SUPER, 'user', env(SUPER))).toBe(true);
    expect(mayDecideReviews('boss@neozaar.com', 'admin', env(SUPER))).toBe(false);
    expect(mayDecideReviews('boss@neozaar.com', 'admin', env())).toBe(true);
    expect(mayDecideReviews('dev@neozaar.com', 'user', env())).toBe(false);
  });

  test('a setting with no valid address means nobody decides', () => {
    expect(mayDecideReviews(SUPER, 'admin', env('ajinkya'))).toBe(false);
    expect(mayDecideReviews('boss@neozaar.com', 'admin', env('*'))).toBe(false);
  });

  test('the message names who can', () => {
    expect(reviewDecisionMessage(env(SUPER))).toBe(`Only ${SUPER} can approve, reject or send back an architecture review.`);
  });
});

describe('the review service', () => {
  test('a submitted review is assigned to the super administrator', () => {
    expect(submit().assignedTo).toEqual([SUPER]);
  });

  test('without a super administrator there is no assignment', () => {
    process.env['SUPER_ADMIN_EMAILS'] = '';
    expect(submit().assignedTo).toBeUndefined();
  });

  test.each([
    ['approve', (id: string, who: { id: string; name: string; email: string }) => ArchitectureReviewService.approveReview(id, who, 'ok')],
    ['reject', (id: string, who: { id: string; name: string; email: string }) => ArchitectureReviewService.rejectReview(id, who, 'no')],
    ['request changes', (id: string, who: { id: string; name: string; email: string }) => ArchitectureReviewService.requestChanges(id, who, 'fix')],
  ])('%s: another admin is refused by the service itself, the super administrator is not', (_n, act) => {
    const r = submit();
    expect(() => act(r.id, { id: 'u2', name: 'Boss', email: 'boss@neozaar.com' })).toThrow(/Only ajinkya@neozaar.com/);
    expect(ArchitectureReviewService.listReviews(r.projectId)[0]!.status).toBe('pending_review');
    expect(() => act(r.id, { id: 'u1', name: 'Ajinkya', email: SUPER })).not.toThrow();
  });

  test('an approval by anyone else does not count, even one given before the setting was turned on', () => {
    process.env['SUPER_ADMIN_EMAILS'] = '';
    const r = submit();
    ArchitectureReviewService.approveReview(r.id, { id: 'u2', name: 'Boss', email: 'boss@neozaar.com' });
    const approvedByBoss = ArchitectureReviewService.listReviews(r.projectId)[0]!;
    expect(ArchitectureReviewService.approvalIsValid(approvedByBoss)).toBe(true);        // no super administrator: as before
    process.env['SUPER_ADMIN_EMAILS'] = SUPER;
    expect(ArchitectureReviewService.approvalIsValid(approvedByBoss)).toBe(false);
    expect(ArchitectureReviewService.approvalBlockedMessage(approvedByBoss, 'Deployment')).toContain('must come from ajinkya@neozaar.com');
  });

  test('only a pending, approved-by-the-super-administrator review counts', () => {
    const r = submit();
    expect(ArchitectureReviewService.approvalIsValid(r)).toBe(false);
    const approved = ArchitectureReviewService.approveReview(r.id, { id: 'u1', name: 'Ajinkya', email: SUPER });
    expect(ArchitectureReviewService.approvalIsValid(approved)).toBe(true);
    expect(ArchitectureReviewService.approvalIsValid(null)).toBe(false);
  });

  test('a deployment is blocked without the super administrator\'s approval and allowed with it', async () => {
    const project = `p-deploy-${++n}`;
    const user = { id: 'u1', name: 'Ajinkya', email: SUPER, role: 'admin' };
    const r = ArchitectureReviewService.submitReview(project, 'production', nodes, [], submitter, summary);
    await expect(ArchitectureReviewService.executeDeployment(project, 'production', user, nodes, [])).rejects.toThrow(/formally approved/);
    process.env['SUPER_ADMIN_EMAILS'] = '';
    ArchitectureReviewService.approveReview(r.id, { id: 'u2', name: 'Boss', email: 'boss@neozaar.com' });
    process.env['SUPER_ADMIN_EMAILS'] = SUPER;
    await expect(ArchitectureReviewService.executeDeployment(project, 'production', user, nodes, [])).rejects.toThrow(/must come from ajinkya@neozaar.com/);
    const r2 = ArchitectureReviewService.submitReview(project, 'production', nodes, [], submitter, summary);
    ArchitectureReviewService.approveReview(r2.id, { id: 'u1', name: 'Ajinkya', email: SUPER });
    await expect(ArchitectureReviewService.executeDeployment(project, 'production', user, nodes, [])).resolves.toMatchObject({ status: 'success' });
  });
});

describe('the Terraform plan gate', () => {
  const input = (project: string) => ({
    projectId: project, environment: 'production', user: { id: 'u1', name: 'Ajinkya', email: SUPER, role: 'admin' }, resources: [], connections: [],
    architectureId: 'a1', projectName: 'x', orgId: 'o1', cloudAccountId: 'c1', stateBackend: { provider: 's3' },
  } as never);

  test('a plan is refused when the approval is not the super administrator\'s', async () => {
    const project = `p-plan-${++n}`;
    process.env['SUPER_ADMIN_EMAILS'] = '';
    const r = ArchitectureReviewService.submitReview(project, 'production', [], [], submitter, summary);
    ArchitectureReviewService.approveReview(r.id, { id: 'u2', name: 'Boss', email: 'boss@neozaar.com' });
    process.env['SUPER_ADMIN_EMAILS'] = SUPER;
    await expect(generatePlan(input(project))).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('must come from ajinkya@neozaar.com') });
  });

  test('a plan is refused with no approval at all', async () => {
    await expect(generatePlan(input(`p-plan-${++n}`))).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('formally approved') });
  });
});

describe('the decision routes', () => {
  test.each([
    ['approve', approve, 'approve'],
    ['reject', reject, 'reject'],
    ['request changes', requestChanges, 'request-changes'],
  ])('%s: another admin gets 403 and the review stays pending; the super administrator gets through', async (_n, handler, segment) => {
    const r = submit();
    asAdmin('boss@neozaar.com');
    const denied = await handler(post(`/api/x/${segment}`), ctx(r.projectId, r.id));
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).toContain(SUPER);
    expect(ArchitectureReviewService.listReviews(r.projectId)[0]!.status).toBe('pending_review');
    asAdmin(SUPER);
    const allowed = await handler(post(`/api/x/${segment}`), ctx(r.projectId, r.id));
    expect(allowed.status).toBe(200);
    expect(ArchitectureReviewService.listReviews(r.projectId)[0]!.status).not.toBe('pending_review');
  });

  test('an ordinary member is refused too, and nobody signed in is not served', async () => {
    const r = submit();
    mockIdentity.mockReturnValue({ userId: 'u9', email: 'dev@neozaar.com', role: 'user', orgIds: ['o1'] });
    expect((await approve(post('/api/x'), ctx(r.projectId, r.id))).status).toBe(403);
    mockIdentity.mockReturnValue(null);
    expect((await approve(post('/api/x'), ctx(r.projectId, r.id))).status).toBe(401);
  });

  test('without a super administrator any admin decides, as before', async () => {
    process.env['SUPER_ADMIN_EMAILS'] = '';
    const r = submit();
    asAdmin('boss@neozaar.com');
    expect((await approve(post('/api/x'), ctx(r.projectId, r.id))).status).toBe(200);
  });
});

describe('around it', () => {
  test('the super administrator is never locked out of Deploy, the AI Generator or Cloud Accounts', () => {
    const e = { NODE_ENV: 'test', RESTRICTED_FEATURES_ALLOWED_EMAILS: 'someone@neozaar.com', SUPER_ADMIN_EMAILS: SUPER } as NodeJS.ProcessEnv;
    expect(canUseRestrictedFeatures(SUPER, e)).toBe(true);
    expect(canUseRestrictedFeatures('boss@neozaar.com', e)).toBe(false);
  });

  test('production startup announces it, and refuses a setting nobody could satisfy', () => {
    const prod = (v: string): NodeJS.ProcessEnv => ({
      NODE_ENV: 'production', SESSION_SECRET: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      ENCRYPTION_KEY: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f1', DATABASE_URL: 'postgresql://a:b@localhost:5432/x',
      APP_URL: 'https://x.test', SMTP_HOST: 's', SUPER_ADMIN_EMAILS: v,
    });
    const ok = checkProductionConfig(prod(SUPER));
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.join(' ')).toContain('Only ajinkya@neozaar.com can approve');
    expect(checkProductionConfig(prod('ajinkya')).errors.join(' ')).toContain('nobody could approve');
  });
});

export type { ArchitectureReview };
