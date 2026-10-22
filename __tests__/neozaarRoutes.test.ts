/**
 * @jest-environment node
 */
/** The Neozaar export through the API: the public routes with ?format=neozaar, and the routes an administrator writes a template's listing with. */
import { NextRequest } from 'next/server';
import { generateKey, hashKey, SCOPE_TEMPLATES_READ } from '@/lib/apiKeys/keys';

const mockIdentity = jest.fn(); const mockRole = jest.fn(); const mockOrg = jest.fn(); const mockRate = jest.fn();
const K = { findByHash: jest.fn(), touch: jest.fn() };
const T = { list: jest.fn(), listWithGraphs: jest.fn(), get: jest.fn() };
const L = { forOrg: jest.fn(), get: jest.fn(), put: jest.fn(), delete: jest.fn() };

jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockRole(...a) }));
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockOrg(...a) }));
jest.mock('@/lib/api/rateLimit', () => ({ checkRateLimit: (...a: unknown[]) => mockRate(...a) }));
jest.mock('@/lib/api/authRateLimit', () => ({ clientIp: () => '203.0.113.7' }));
jest.mock('@/lib/apiKeys/store', () => ({ PgApiKeyStore: class { findByHash = K.findByHash; touch = K.touch; } }));
jest.mock('@/lib/templates/templateStore', () => ({ PgTemplateStore: class { list = T.list; listWithGraphs = T.listWithGraphs; get = T.get; } }));
jest.mock('@/lib/templates/sync', () => ({ syncBuiltInTemplates: jest.fn() }));
jest.mock('@/lib/marketplace/listingStore', () => ({ PgListingStore: class { forOrg = L.forOrg; get = L.get; put = L.put; delete = L.delete; } }));

import * as pubList from '@/app/api/public/templates/route';
import * as pubOne from '@/app/api/public/templates/[id]/route';
import * as listingRoute from '@/app/api/architecture-templates/[id]/listing/route';

type Ctx = { params: Promise<{ id: string }> };
const PUB_LIST = pubList.GET as (r: NextRequest) => Promise<Response>;
const PUB_ONE = pubOne.GET as (r: NextRequest, c: Ctx) => Promise<Response>;
const LGET = listingRoute.GET as (r: NextRequest, c: Ctx) => Promise<Response>;
const LPUT = listingRoute.PUT as (r: NextRequest, c: Ctx) => Promise<Response>;
const LDEL = listingRoute.DELETE as (r: NextRequest, c: Ctx) => Promise<Response>;

const { key } = generateKey();
const REC = { id: 'k1', orgId: 'o1', name: 'Neozaar', keyPrefix: 'cb_abcdef', scope: SCOPE_TEMPLATES_READ, includeBuiltin: true, includeOwn: true, createdBy: 'a', createdAt: 't', expiresAt: null, lastUsedAt: null, revokedAt: null };
const stored = (id: string, over: Record<string, unknown> = {}) => ({
  id, orgId: null, source: 'builtin', name: `T ${id}`, description: 'A web app on AWS.', provider: 'aws', category: 'Web Applications', complexity: 'simple', tags: ['web'], features: ['Load balanced'], estimatedCost: 100,
  resourceCount: 2, meta: {}, createdBy: 'secret@x.com', createdAt: 't', updatedAt: 'u',
  graph: { nodes: [{ id: 'a', type: 'aws_ec2', label: 'EC2', position: { x: 0, y: 0 } }, { id: 'b', type: 'aws_alb', label: 'ALB', position: { x: 0, y: 0 } }], edges: [] }, ...over,
});
const get = (url: string, headers: Record<string, string> = { authorization: `Bearer ${key}` }) => new NextRequest(url, { headers });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  jest.clearAllMocks();
  K.findByHash.mockResolvedValue(REC); K.touch.mockResolvedValue(undefined); mockRate.mockResolvedValue({ allowed: true });
  T.list.mockResolvedValue([stored('a'), stored('b')]); T.listWithGraphs.mockResolvedValue([stored('a'), stored('b', { category: 'Mystery' })]); T.get.mockResolvedValue(stored('a'));
  L.forOrg.mockResolvedValue(new Map()); L.get.mockResolvedValue(null); L.put.mockResolvedValue(undefined); L.delete.mockResolvedValue(true);
  process.env['CLOUDBUILDER_API_KEY_MANAGERS'] = 'a@x.com';
  mockIdentity.mockReturnValue({ userId: 'u1', email: 'a@x.com' }); mockOrg.mockResolvedValue('o1'); mockRole.mockResolvedValue('admin');
});

describe('GET /api/public/templates?format=neozaar', () => {
  test('gives each template as a Create Service request with what is missing, and reads the graphs for it', async () => {
    const r = await PUB_LIST(get('http://x/api/public/templates?format=neozaar'));
    expect(r.status).toBe(200);
    const d = (await r.json()).data;
    expect(d).toMatchObject({ count: 2, total: 2 });
    expect(d.templates[0]).toMatchObject({ id: 'a', ready: true, missing: [], catalog: { type: 'product', fields: { action_type: 'service', brand_name: 'Neozaar' } } });
    expect(T.listWithGraphs).toHaveBeenCalledWith('o1');
    expect(JSON.stringify(d)).not.toMatch(/secret@x|orgId|createdBy/);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
  });
  test('?ready=1 keeps the ones with nothing missing, and the count says how many are ready', async () => {
    L.forOrg.mockResolvedValue(new Map([['a', { audience: [], ctaModels: [] }]]));   // an empty list is not a value: the field would be missing
    const all = (await (await PUB_LIST(get('http://x/api/public/templates?format=neozaar'))).json()).data;
    expect(all.readyCount).toBeLessThanOrEqual(all.total);
    const ready = (await (await PUB_LIST(get('http://x/api/public/templates?format=neozaar&ready=1'))).json()).data;
    expect(ready.templates.every((t: { ready: boolean }) => t.ready)).toBe(true);
    expect(ready.count).toBe(ready.templates.length);
  });
  test('the organization\'s own listing details are used', async () => {
    L.forOrg.mockResolvedValue(new Map([['a', { challenges: 'Their own challenge text.', startingPrice: 999 }]]));
    const d = (await (await PUB_LIST(get('http://x/api/public/templates?format=neozaar'))).json()).data;
    expect(d.templates[0].catalog.fields.starting_price).toBe('999');
    expect(d.templates[0].catalog.service_solution_details.challenges_addressed).toBe('Their own challenge text.');
    expect(L.forOrg).toHaveBeenCalledWith('o1');
  });
  test('a bad key is still the same 401, and the usual list is unchanged without the format', async () => {
    K.findByHash.mockResolvedValue(null);
    expect((await PUB_LIST(get('http://x/api/public/templates?format=neozaar'))).status).toBe(401);
    K.findByHash.mockResolvedValue(REC);
    const plain = (await (await PUB_LIST(get('http://x/api/public/templates'))).json()).data;
    expect(plain.templates[0].catalog).toBeUndefined();
    expect(L.forOrg).not.toHaveBeenCalled();
  });
});

describe('GET /api/public/templates/[id]?format=neozaar', () => {
  test('one template as the request, with its listing', async () => {
    L.get.mockResolvedValue({ listing: { startingPrice: 500 }, updatedAt: 't', updatedBy: 'a' });
    const r = await PUB_ONE(get('http://x/api/public/templates/a?format=neozaar'), ctx('a'));
    expect(r.status).toBe(200);
    expect((await r.json()).data.neozaar.catalog.fields.starting_price).toBe('500');
    expect(L.get).toHaveBeenCalledWith('o1', 'a');
  });
  test('without the format it is the template as before', async () => {
    expect((await (await PUB_ONE(get('http://x/api/public/templates/a'), ctx('a'))).json()).data.template.id).toBe('a');
  });
});

const put = (body: unknown) => new NextRequest('http://x/api/architecture-templates/a/listing', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const plain = (method: string) => new NextRequest('http://x/api/architecture-templates/a/listing', { method });

afterAll(() => { delete process.env['CLOUDBUILDER_API_KEY_MANAGERS']; });

describe('/api/architecture-templates/[id]/listing', () => {
  test('only the account that may manage keys: another administrator can neither read, write nor delete a listing', async () => {
    mockIdentity.mockReturnValue({ userId: 'u2', email: 'other-admin@x.com' });          // an administrator of the organization, but not the listed account
    expect((await LGET(plain('GET'), ctx('a'))).status).toBe(403);
    expect((await LPUT(put({ startingPrice: 1 }), ctx('a'))).status).toBe(403);
    expect((await LDEL(plain('DELETE'), ctx('a'))).status).toBe(403);
    expect(L.get).not.toHaveBeenCalled(); expect(L.put).not.toHaveBeenCalled(); expect(L.delete).not.toHaveBeenCalled(); expect(T.get).not.toHaveBeenCalled();
    mockIdentity.mockReturnValue({ userId: 'u1', email: 'A@X.com' });                    // the listed account, in another letter case
    expect((await LGET(plain('GET'), ctx('a'))).status).toBe(200);
    delete process.env['CLOUDBUILDER_API_KEY_MANAGERS'];
    expect((await LGET(plain('GET'), ctx('a'))).status).toBe(403);                      // an empty setting is nobody
  });
  test('an administrator writes the listing, and gets the request it produces', async () => {
    const r = await LPUT(put({ challenges: 'Real problem.', startingPrice: 1000, audience: ['CTO'] }), ctx('a'));
    expect(r.status).toBe(200);
    expect(L.put).toHaveBeenCalledWith('o1', 'a', { challenges: 'Real problem.', startingPrice: 1000, audience: ['CTO'] }, 'a@x.com');
    expect((await r.json()).data.neozaar.catalog.fields.starting_price).toBe('1000');
  });
  test('even the listed account must be an administrator to write or delete; as a member it may read', async () => {
    mockRole.mockResolvedValue('member');
    expect((await LPUT(put({ startingPrice: 1 }), ctx('a'))).status).toBe(403);
    expect((await LDEL(plain('DELETE'), ctx('a'))).status).toBe(403);
    expect((await LGET(plain('GET'), ctx('a'))).status).toBe(200);
    expect(L.put).not.toHaveBeenCalled();
    mockIdentity.mockReturnValue(null);
    expect((await LGET(plain('GET'), ctx('a'))).status).toBe(401);
  });
  test('a value the form does not offer, an unknown field, and a template that is not there are refused', async () => {
    expect((await LPUT(put({ audience: ['Astronaut'] }), ctx('a'))).status).toBe(400);
    expect((await LPUT(put({ surprise: true }), ctx('a'))).status).toBe(400);
    T.get.mockResolvedValue(null);
    expect((await LPUT(put({ startingPrice: 1 }), ctx('zzz'))).status).toBe(404);
    expect(L.put).not.toHaveBeenCalled();
  });
  test('GET shows the saved listing and the request; DELETE puts the defaults back', async () => {
    L.get.mockResolvedValue({ listing: { startingPrice: 7 }, updatedAt: 'T', updatedBy: 'a' });
    const d = (await (await LGET(plain('GET'), ctx('a'))).json()).data;
    expect(d).toMatchObject({ listing: { startingPrice: 7 }, updatedAt: 'T' });
    expect(d.neozaar.catalog.fields.starting_price).toBe('7');
    expect((await (await LDEL(plain('DELETE'), ctx('a'))).json()).data.deleted).toBe(true);
    expect(L.delete).toHaveBeenCalledWith('o1', 'a');
  });
});
void hashKey;
