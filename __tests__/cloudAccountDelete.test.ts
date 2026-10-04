/**
 * DELETE /api/cloud-accounts/[id] — what the new "Delete account" button calls. Only an owner or admin of the organisation may
 * remove an account, only one of their own organisation, and nothing secret is logged.
 */
const mockIdentity = jest.fn();
const mockOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockOrgRole(...a) }));
const mockResolveOrg = jest.fn();
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockResolveOrg(...a) }));
const mockDelete = jest.fn();
jest.mock('@/lib/repositories/cloudAccountRepository', () => ({ cloudAccountRepository: { delete: (...a: unknown[]) => mockDelete(...a) } }));

import { NextRequest } from 'next/server';
import { DELETE } from '@/app/api/cloud-accounts/[id]/route';

const call = (id = 'acct-1') => DELETE(new NextRequest(`http://localhost/api/cloud-accounts/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  [mockIdentity, mockOrgRole, mockResolveOrg, mockDelete].forEach((m) => m.mockReset());
  mockIdentity.mockReturnValue({ userId: 'user-1', role: 'admin', orgIds: ['org-1'] });
  mockResolveOrg.mockResolvedValue('org-1');
  mockOrgRole.mockResolvedValue('owner');
  mockDelete.mockResolvedValue(true);
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('DELETE /api/cloud-accounts/[id]', () => {
  it.each(['owner', 'admin'])('lets an %s remove an account of their organisation', async (role) => {
    mockOrgRole.mockResolvedValue(role);
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ deleted: true });
    expect(mockDelete).toHaveBeenCalledWith('acct-1', 'org-1');
  });

  it('records who removed it, with ids only', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    await call();
    const line = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[cloud-account]'));
    expect(line).toMatch(/removed acct-1 from org org-1 by user user-1/);
  });

  it('refuses a plain member (403) and deletes nothing', async () => {
    mockOrgRole.mockResolvedValue('member');
    expect((await call()).status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('refuses someone who is not in the organisation at all, and a signed-out caller', async () => {
    mockOrgRole.mockResolvedValue(null);
    expect((await call()).status).toBe(403);
    mockIdentity.mockReturnValue(null);
    expect((await call()).status).toBe(401);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('cannot remove another organisation\'s account: the delete is scoped to the caller\'s organisation, and "not found" is the answer', async () => {
    mockDelete.mockResolvedValue(false);                       // the repository finds nothing for (id, org-1)
    const res = await call('acct-of-another-org');
    expect(res.status).toBe(404);
    expect(mockDelete).toHaveBeenCalledWith('acct-of-another-org', 'org-1');
  });

  it('answers a database failure with a generic error, not its text', async () => {
    mockDelete.mockRejectedValue(new Error('connection to db.internal:5432 refused'));
    const res = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/db\.internal|5432/);
  });
});
