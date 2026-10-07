/**
 * GET /api/resources/[id]/findings: the Well-Architected findings of one resource, for the properties panel.
 *
 * Bug being pinned: the panel sends the PROJECT id as `architectureId`, the route only knew architecture ids, so every request from the
 * panel was a 404 (swallowed by the client) and a resource's findings never showed.
 */
const mockIdentity = jest.fn();
const mockOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockOrgRole(...a) }));
const mockResolveOrg = jest.fn();
const mockResolveArch = jest.fn();
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockResolveOrg(...a), resolveArchitecture: (...a: unknown[]) => mockResolveArch(...a) }));
const mockArchInOrg = jest.fn();
jest.mock('@/lib/api/tenantScope', () => ({ architectureInOrg: (...a: unknown[]) => mockArchInOrg(...a) }));
const mockFindings = jest.fn();
jest.mock('@/lib/repositories/wellArchitectedRepository', () => ({ wellArchitectedRepository: { findingsByResource: (...a: unknown[]) => mockFindings(...a) } }));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/resources/[id]/findings/route';

const get = (query: string) => GET(new NextRequest(`http://localhost/api/resources/res-1/findings${query}`), { params: Promise.resolve({ id: 'res-1' }) });
const body = async (res: Response) => (await res.json()) as { data?: { findings: unknown[]; findingCount: number }; error?: { code: string } };

beforeEach(() => {
  [mockIdentity, mockOrgRole, mockResolveOrg, mockResolveArch, mockArchInOrg, mockFindings].forEach((m) => m.mockReset());
  mockIdentity.mockReturnValue({ userId: 'alice' });
  mockOrgRole.mockResolvedValue('owner');
  mockResolveOrg.mockResolvedValue('org-1');
  mockFindings.mockResolvedValue([{ ruleId: 'WA-1' }]);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('resource findings route', () => {
  it('uses an architecture id of the organization as it is', async () => {
    mockArchInOrg.mockResolvedValue(true);
    const res = await get('?architectureId=arch-1');
    expect(res.status).toBe(200);
    expect(mockFindings).toHaveBeenCalledWith('res-1', 'arch-1');
    expect(mockResolveArch).not.toHaveBeenCalled();
  });

  it('accepts the project id the properties panel sends, and reads that project\'s architecture', async () => {
    mockArchInOrg.mockResolvedValue(false);
    mockResolveArch.mockResolvedValue({ arch: { id: 'arch-of-project' }, project: { id: 'proj-1' } });
    const res = await get('?architectureId=proj-1');
    expect(res.status).toBe(200);
    expect(mockResolveArch).toHaveBeenCalledWith('proj-1', 'org-1', 'production');
    expect(mockFindings).toHaveBeenCalledWith('res-1', 'arch-of-project');
    expect((await body(res)).data!.findingCount).toBe(1);
  });

  it('passes the environment on when the panel names one', async () => {
    mockArchInOrg.mockResolvedValue(false);
    mockResolveArch.mockResolvedValue({ arch: { id: 'arch-dev' }, project: {} });
    await get('?architectureId=proj-1&env=development');
    expect(mockResolveArch).toHaveBeenCalledWith('proj-1', 'org-1', 'development');
  });

  it('is a 404 for an id that is neither an architecture nor a project of this organization, and reads no findings', async () => {
    mockArchInOrg.mockResolvedValue(false);
    mockResolveArch.mockResolvedValue({ error: 'project_not_found' });
    const res = await get('?architectureId=someone-elses');
    expect(res.status).toBe(404);
    expect(mockFindings).not.toHaveBeenCalled();
  });

  it('still refuses a caller who is not signed in, not a member, or sends no id', async () => {
    mockIdentity.mockReturnValue(null);
    expect((await get('?architectureId=a')).status).toBe(401);
    mockIdentity.mockReturnValue({ userId: 'alice' });
    mockOrgRole.mockResolvedValue(null);
    expect((await get('?architectureId=a')).status).toBe(403);
    mockOrgRole.mockResolvedValue('owner');
    expect((await get('')).status).toBe(400);
  });
});
