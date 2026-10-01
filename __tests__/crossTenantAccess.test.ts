/**
 * A project id in a URL must not let a caller act on a project of an organisation they do not belong to — and an
 * administrative action needs an owner/admin role in THAT organisation, not just the session's `admin` flag (which every
 * self-registered user gets for their own new organisation).
 */
const mockIdentity = jest.fn();
const mockOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockOrgRole(...a) }));
const mockResolveOrg = jest.fn();
const mockResolveArch = jest.fn();
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockResolveOrg(...a), resolveArchitecture: (...a: unknown[]) => mockResolveArch(...a) }));

const svc = {
  listReviews: jest.fn(), getLatestReview: jest.fn(), submitReview: jest.fn(), approveReview: jest.fn(), rejectReview: jest.fn(),
  requestChanges: jest.fn(), listDeployments: jest.fn(), executeDeployment: jest.fn(),
};
jest.mock('@/lib/services/ArchitectureReviewService', () => ({ ArchitectureReviewService: svc }));
const mockDraft = { getDraft: jest.fn(), saveDraft: jest.fn(), clearDraft: jest.fn() };
jest.mock('@/lib/repositories/draftRepository', () => ({ draftRepository: mockDraft }));

import { NextRequest } from 'next/server';
import { GET as reviewsGet, POST as reviewsPost } from '@/app/api/projects/[id]/reviews/route';
import { GET as deploymentsGet } from '@/app/api/projects/[id]/deployments/route';
import { POST as deployPost } from '@/app/api/projects/[id]/deploy/route';
import { POST as approvePost } from '@/app/api/projects/[id]/reviews/[reviewId]/approve/route';
import { POST as rejectPost } from '@/app/api/projects/[id]/reviews/[reviewId]/reject/route';
import { POST as changesPost } from '@/app/api/projects/[id]/reviews/[reviewId]/request-changes/route';
import { GET as draftGet, PUT as draftPut, DELETE as draftDelete } from '@/app/api/architecture/draft/route';

const req = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
  new NextRequest(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const params = (id = 'proj-A', reviewId = 'rev-1') => ({ params: Promise.resolve({ id, reviewId }) });
const SUBMIT = { environment: 'production', nodes: [], edges: [], summary: {} };
const DEPLOY = { environment: 'production', nodes: [], edges: [] };

/** Every project route, called as one caller, so each is tested the same way. */
const routes: [string, () => Promise<Response>, { adminOnly: boolean }][] = [
  ['GET reviews', () => reviewsGet(req('/api/projects/proj-A/reviews'), params()), { adminOnly: false }],
  ['POST reviews (submit)', () => reviewsPost(req('/api/projects/proj-A/reviews', SUBMIT), params()), { adminOnly: false }],
  ['GET deployments', () => deploymentsGet(req('/api/projects/proj-A/deployments'), params()), { adminOnly: false }],
  ['POST deploy', () => deployPost(req('/api/projects/proj-A/deploy', DEPLOY), params()), { adminOnly: true }],
  ['POST approve', () => approvePost(req('/api/projects/proj-A/reviews/rev-1/approve', {}), params()), { adminOnly: true }],
  ['POST reject', () => rejectPost(req('/api/projects/proj-A/reviews/rev-1/reject', { comments: 'no' }), params()), { adminOnly: true }],
  ['POST request-changes', () => changesPost(req('/api/projects/proj-A/reviews/rev-1/request-changes', { comments: 'fix it' }), params()), { adminOnly: true }],
];
const touched = () => Object.values(svc).some((m) => m.mock.calls.length > 0);

beforeEach(() => {
  [mockIdentity, mockOrgRole, mockResolveOrg, mockResolveArch, ...Object.values(svc), ...Object.values(mockDraft)].forEach((m) => m.mockReset());
  // the caller is an "admin" (as every self-registered user is, of their own org) belonging to org-B
  mockIdentity.mockReturnValue({ userId: 'user-B', role: 'admin', email: 'b@example.com', orgIds: ['org-B'] });
  mockResolveOrg.mockResolvedValue('org-B');
  mockOrgRole.mockResolvedValue('owner');
  mockResolveArch.mockResolvedValue({ arch: {}, project: {} });
  svc.listReviews.mockReturnValue([{ id: 'rev-1' }]); svc.getLatestReview.mockReturnValue(null); svc.listDeployments.mockReturnValue([]);
  svc.submitReview.mockReturnValue({ id: 'rev-new' }); svc.approveReview.mockReturnValue({ id: 'rev-1', status: 'approved' });
  svc.rejectReview.mockReturnValue({ id: 'rev-1' }); svc.requestChanges.mockReturnValue({ id: 'rev-1' }); svc.executeDeployment.mockResolvedValue({ id: 'dep-1' });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe.each(routes)('%s', (_name, call, { adminOnly }) => {
  it('works for a member of the project\'s organisation', async () => {
    expect((await call()).status).toBeLessThan(300);
  });

  it('is refused (404) for an admin of ANOTHER organisation — and never reaches the service', async () => {
    mockResolveArch.mockResolvedValue({ error: 'project_not_found' });         // proj-A is not in org-B
    const res = await call();
    expect(res.status).toBe(404);
    expect(touched()).toBe(false);
  });

  it('is refused (403) for someone who is not a member of the organisation at all', async () => {
    mockOrgRole.mockResolvedValue(null);
    expect((await call()).status).toBe(403);
    expect(touched()).toBe(false);
  });

  it(adminOnly ? 'needs owner/admin in the organisation: a plain member is refused (403)' : 'is open to a plain member of the organisation', async () => {
    mockOrgRole.mockResolvedValue('member');
    const res = await call();
    if (adminOnly) { expect(res.status).toBe(403); expect(touched()).toBe(false); } else expect(res.status).toBeLessThan(300);
  });

  it('still requires a signed-in user', async () => {
    mockIdentity.mockReturnValue(null);
    expect((await call()).status).toBe(401);
    expect(touched()).toBe(false);
  });
});

describe('a review can only be acted on through its own project', () => {
  it.each([
    ['approve', () => approvePost(req('/api/projects/proj-A/reviews/rev-OF-ANOTHER-PROJECT/approve', {}), params('proj-A', 'rev-OF-ANOTHER-PROJECT')), svc.approveReview],
    ['reject', () => rejectPost(req('/api/projects/proj-A/reviews/rev-OF-ANOTHER-PROJECT/reject', { comments: 'no' }), params('proj-A', 'rev-OF-ANOTHER-PROJECT')), svc.rejectReview],
    ['request changes', () => changesPost(req('/api/projects/proj-A/reviews/rev-OF-ANOTHER-PROJECT/request-changes', { comments: 'x' }), params('proj-A', 'rev-OF-ANOTHER-PROJECT')), svc.requestChanges],
  ])('%s: a review id that belongs to a different project is 404, even for an owner', async (_n, call, action) => {
    const res = await call();
    expect(res.status).toBe(404);
    expect(action).not.toHaveBeenCalled();
  });
});

describe('/api/architecture/draft — a draft is only ever the signed-in caller\'s own', () => {
  const draftReq = (method: string, query = '') => new NextRequest(`http://localhost/api/architecture/draft${query}`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'PUT' ? { body: JSON.stringify({ nodes: [], edges: [] }) } : {}) });

  it('refuses every method without a signed-in user (it used to hand out a shared draft)', async () => {
    mockIdentity.mockReturnValue(null);
    expect((await draftGet(draftReq('GET'))).status).toBe(401);
    expect((await draftPut(draftReq('PUT'))).status).toBe(401);
    expect((await draftDelete(draftReq('DELETE'))).status).toBe(401);
    expect(mockDraft.getDraft).not.toHaveBeenCalled(); expect(mockDraft.saveDraft).not.toHaveBeenCalled(); expect(mockDraft.clearDraft).not.toHaveBeenCalled();
  });

  it('ignores a ?key= that names someone else\'s draft: it always uses the caller\'s own key', async () => {
    mockDraft.getDraft.mockResolvedValue(null); mockDraft.clearDraft.mockResolvedValue(true);
    mockDraft.saveDraft.mockResolvedValue({ conflict: false, draft: { revision: 1, hash: 'h' } });
    await draftGet(draftReq('GET', '?key=usr-victim'));
    await draftPut(draftReq('PUT', '?key=usr-victim'));
    await draftDelete(draftReq('DELETE', '?key=usr-victim'));
    expect(mockDraft.getDraft).toHaveBeenCalledWith('usr-user-B');
    expect(mockDraft.saveDraft.mock.calls[0]![0]).toBe('usr-user-B');
    expect(mockDraft.clearDraft).toHaveBeenCalledWith('usr-user-B');
  });
});
