/**
 * @jest-environment node
 */
/** /api/architecture-templates: who may read, save and delete, that an organization only sees its own, and that a built-in template is never deleted. */
import { NextRequest } from 'next/server';

const mockIdentity = jest.fn();
const mockRole = jest.fn();
const mockOrg = jest.fn();
const S = { list: jest.fn(), listOwn: jest.fn(), get: jest.fn(), countOwn: jest.fn(), createOwn: jest.fn(), deleteOwn: jest.fn(), ownerOf: jest.fn() };
const mockSync = jest.fn();

jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockRole(...a) }));
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockOrg(...a) }));
jest.mock('@/lib/templates/templateStore', () => ({ PgTemplateStore: class { list = S.list; listOwn = S.listOwn; get = S.get; countOwn = S.countOwn; createOwn = S.createOwn; deleteOwn = S.deleteOwn; ownerOf = S.ownerOf; } }));
jest.mock('@/lib/templates/sync', () => ({ syncBuiltInTemplates: (...a: unknown[]) => mockSync(...a) }));

import { GET, POST } from '@/app/api/architecture-templates/route';
import { GET as GET_ONE, DELETE } from '@/app/api/architecture-templates/[id]/route';

const req = (method: string, body?: unknown) => new NextRequest('http://x/api/architecture-templates', { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const GOOD = { name: 'My app', provider: 'aws', nodes: [{ id: 'a', type: 't', label: 'A', position: { x: 0, y: 0 } }], edges: [] };
const builtin = { id: 'ref-x', source: 'builtin', orgId: null, name: 'Ref' };
const own = { id: 'org-1', source: 'org', orgId: 'o1', name: 'Mine' };

beforeEach(() => {
  jest.clearAllMocks();
  mockIdentity.mockReturnValue({ userId: 'u1', email: 'a@x.com' });
  mockOrg.mockResolvedValue('o1'); mockRole.mockResolvedValue('member');
  S.list.mockResolvedValue([builtin, own]); S.listOwn.mockResolvedValue([{ ...own, graph: { nodes: [], edges: [] } }]);
  S.countOwn.mockResolvedValue(0); S.createOwn.mockResolvedValue(own); S.ownerOf.mockResolvedValue('a@x.com'); S.deleteOwn.mockResolvedValue(true);
  mockSync.mockResolvedValue({ added: 1, updated: 0, removed: 0, unchanged: 0 });
});

describe('GET list', () => {
  test('the built-in templates without graphs and the organization\'s own with theirs, for any member', async () => {
    mockRole.mockResolvedValue('viewer');
    const r = await GET(req('GET'));
    expect(r.status).toBe(200);
    const t = (await r.json()).data.templates;
    expect(t[0]).toEqual(builtin);
    expect(t[1]).toMatchObject({ id: 'org-1', graph: { nodes: [], edges: [] } });
    expect(S.list).toHaveBeenCalledWith('o1');
    expect(mockSync).not.toHaveBeenCalled();
  });
  test('the first time, with no built-in rows, the built-in templates are written from the code', async () => {
    S.list.mockResolvedValueOnce([]).mockResolvedValueOnce([builtin]);
    const r = await GET(req('GET'));
    expect((await r.json()).data.templates).toEqual([builtin]);
    expect(mockSync).toHaveBeenCalledTimes(1);
  });
  test('needs a sign-in and a membership', async () => {
    mockIdentity.mockReturnValue(null);
    expect((await GET(req('GET'))).status).toBe(401);
    mockIdentity.mockReturnValue({ userId: 'u1' }); mockRole.mockResolvedValue(null);
    expect((await GET(req('GET'))).status).toBe(403);
  });
});

describe('POST save', () => {
  test('saves for the caller\'s organization, as that person', async () => {
    const r = await POST(req('POST', GOOD));
    expect(r.status).toBe(201);
    expect(S.createOwn).toHaveBeenCalledWith('o1', 'a@x.com', expect.objectContaining({ name: 'My app', category: 'Custom' }));
  });
  test('viewers cannot, a bad body is refused, a broken graph is refused, and there is a limit', async () => {
    mockRole.mockResolvedValue('viewer');
    expect((await POST(req('POST', GOOD))).status).toBe(403);
    mockRole.mockResolvedValue('member');
    expect((await POST(req('POST', { ...GOOD, provider: 'gcp' }))).status).toBe(400);
    expect((await POST(req('POST', { ...GOOD, edges: [{ id: 'e', source: 'a', target: 'zzz' }] }))).status).toBe(400);
    S.countOwn.mockResolvedValue(100);
    expect((await POST(req('POST', GOOD))).status).toBe(400);
    expect(S.createOwn).not.toHaveBeenCalled();
  });
});

describe('one template', () => {
  test('GET gives it with its graph, or 404', async () => {
    S.get.mockResolvedValueOnce({ ...builtin, graph: { nodes: [], edges: [] } }).mockResolvedValueOnce(null);
    expect((await GET_ONE(req('GET'), ctx('ref-x'))).status).toBe(200);
    expect((await GET_ONE(req('GET'), ctx('nope'))).status).toBe(404);
    expect(S.get).toHaveBeenCalledWith('o1', 'ref-x');
  });
  test('DELETE: the person who saved it, or an administrator; nobody else; never a built-in one', async () => {
    expect((await DELETE(req('DELETE'), ctx('org-1'))).status).toBe(200);          // the author (a@x.com)
    S.ownerOf.mockResolvedValue('someone@else.com');
    expect((await DELETE(req('DELETE'), ctx('org-1'))).status).toBe(403);
    mockRole.mockResolvedValue('admin');
    expect((await DELETE(req('DELETE'), ctx('org-1'))).status).toBe(200);
    S.ownerOf.mockResolvedValue(undefined);                                        // a built-in one, or another organization's: not this organization's row
    expect((await DELETE(req('DELETE'), ctx('ref-x'))).status).toBe(404);
    expect(S.deleteOwn).toHaveBeenCalledTimes(2);
  });
});
