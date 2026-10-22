/**
 * @jest-environment node
 */
/** Read-only API keys: how a key is made and read from a request, who can manage keys, and what a key can and cannot read. */
import { NextRequest } from 'next/server';
import { generateKey, hashKey, keyFromHeaders, keyUsable, looksLikeKey, KEY_PREFIX, SCOPE_TEMPLATES_READ } from '@/lib/apiKeys/keys';

const mockIdentity = jest.fn(); const mockRole = jest.fn(); const mockOrg = jest.fn(); const mockRate = jest.fn();
const K = { create: jest.fn(), list: jest.fn(), countActive: jest.fn(), revoke: jest.fn(), findByHash: jest.fn(), touch: jest.fn() };
const T = { list: jest.fn(), listWithGraphs: jest.fn(), get: jest.fn() };
const mockSync = jest.fn();

jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockRole(...a) }));
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockOrg(...a) }));
jest.mock('@/lib/api/rateLimit', () => ({ checkRateLimit: (...a: unknown[]) => mockRate(...a) }));
jest.mock('@/lib/api/authRateLimit', () => ({ clientIp: () => '203.0.113.7' }));
jest.mock('@/lib/apiKeys/store', () => ({ PgApiKeyStore: class { create = K.create; list = K.list; countActive = K.countActive; revoke = K.revoke; findByHash = K.findByHash; touch = K.touch; } }));
jest.mock('@/lib/templates/templateStore', () => ({ PgTemplateStore: class { list = T.list; listWithGraphs = T.listWithGraphs; get = T.get; } }));
jest.mock('@/lib/templates/sync', () => ({ syncBuiltInTemplates: (...a: unknown[]) => mockSync(...a) }));

import * as keysRoute from '@/app/api/api-keys/route';
import * as keyRoute from '@/app/api/api-keys/[id]/route';
import * as pubList from '@/app/api/public/templates/route';
import * as pubOne from '@/app/api/public/templates/[id]/route';

type Ctx = { params: Promise<{ id: string }> };
const KEYS_GET = keysRoute.GET as (r: NextRequest) => Promise<Response>;
const KEYS_POST = keysRoute.POST as (r: NextRequest) => Promise<Response>;
const KEY_DELETE = keyRoute.DELETE as (r: NextRequest, c: Ctx) => Promise<Response>;
const PUB_LIST = pubList.GET as (r: NextRequest) => Promise<Response>;
const PUB_ONE = pubOne.GET as (r: NextRequest, c: Ctx) => Promise<Response>;

describe('the key itself', () => {
  test('is long, random, prefixed, and only its hash is derived from it', () => {
    const a = generateKey(); const b = generateKey();
    expect(a.key).toMatch(/^cb_[A-Za-z0-9_-]{43}$/);
    expect(a.key).not.toBe(b.key);
    expect(a.prefix).toBe(a.key.slice(0, KEY_PREFIX.length + 6));
    expect(a.hash).toBe(hashKey(a.key));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.key.slice(3, 12));
    expect(looksLikeKey(a.key)).toBe(true);
    expect(looksLikeKey(`${a.key}x`)).toBe(false);
    expect(looksLikeKey('cb_short')).toBe(false);
  });
  test('is read from a Bearer header or X-API-Key, and only when it can be one of ours', () => {
    const { key } = generateKey();
    const h = (o: Record<string, string>) => new Headers(o);
    expect(keyFromHeaders(h({ authorization: `Bearer ${key}` }))).toBe(key);
    expect(keyFromHeaders(h({ authorization: `bearer   ${key}  ` }))).toBe(key);
    expect(keyFromHeaders(h({ 'x-api-key': key }))).toBe(key);
    expect(keyFromHeaders(h({}))).toBeNull();
    expect(keyFromHeaders(h({ authorization: 'Bearer some-session-token' }))).toBeNull();
    expect(keyFromHeaders(h({ authorization: `Basic ${key}` }))).toBeNull();
    expect(keyFromHeaders(h({ 'x-api-key': "cb_' OR 1=1 --" }))).toBeNull();
  });
  test('is usable until it is revoked or past its end date', () => {
    expect(keyUsable({ revokedAt: null, expiresAt: null })).toBe(true);
    expect(keyUsable({ revokedAt: null, expiresAt: new Date(Date.now() + 1000).toISOString() })).toBe(true);
    expect(keyUsable({ revokedAt: null, expiresAt: new Date(Date.now() - 1000).toISOString() })).toBe(false);
    expect(keyUsable({ revokedAt: 'x', expiresAt: null })).toBe(false);
  });
});

const req = (method: string, url = 'http://x/api/api-keys', init: { body?: unknown; headers?: Record<string, string> } = {}) =>
  new NextRequest(url, { method, headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const REC = { id: 'k1', orgId: 'o1', name: 'Marketplace', keyPrefix: 'cb_abcdef', scope: SCOPE_TEMPLATES_READ, includeBuiltin: true, includeOwn: true, createdBy: 'a@x.com', createdAt: 't', expiresAt: null, lastUsedAt: null, revokedAt: null };

beforeEach(() => {
  jest.clearAllMocks();
  process.env['CLOUDBUILDER_API_KEY_MANAGERS'] = 'a@x.com';
  mockIdentity.mockReturnValue({ userId: 'u1', email: 'a@x.com' }); mockOrg.mockResolvedValue('o1'); mockRole.mockResolvedValue('admin'); mockRate.mockResolvedValue({ allowed: true });
  K.create.mockResolvedValue(REC); K.list.mockResolvedValue([REC]); K.countActive.mockResolvedValue(0); K.revoke.mockResolvedValue(true); K.touch.mockResolvedValue(undefined);
});

afterAll(() => { delete process.env['CLOUDBUILDER_API_KEY_MANAGERS']; });

describe('managing keys', () => {
  test('only the account in CLOUDBUILDER_API_KEY_MANAGERS: another administrator is refused, and the setting empty refuses everybody', async () => {
    mockIdentity.mockReturnValue({ userId: 'u2', email: 'other-admin@x.com' });           // an administrator of the organization, but not listed
    expect((await KEYS_GET(req('GET'))).status).toBe(403);
    expect((await KEYS_POST(req('POST', undefined, { body: { name: 'x' } }))).status).toBe(403);
    expect((await KEY_DELETE(req('DELETE'), ctx('k1'))).status).toBe(403);
    expect(K.list).not.toHaveBeenCalled(); expect(K.create).not.toHaveBeenCalled(); expect(K.revoke).not.toHaveBeenCalled();
    mockIdentity.mockReturnValue({ userId: 'u1', email: 'A@X.com' });                     // the listed one, in another letter case
    expect((await KEYS_GET(req('GET'))).status).toBe(200);
    delete process.env['CLOUDBUILDER_API_KEY_MANAGERS'];
    expect((await KEYS_GET(req('GET'))).status).toBe(403);
  });
  test('an administrator makes a key: it is in the answer once, and only its hash and prefix are stored', async () => {
    const r = await KEYS_POST(req('POST', undefined, { body: { name: 'Marketplace', expiresInDays: 30 } }));
    expect(r.status).toBe(201);
    const body = (await r.json()).data;
    expect(body.key).toMatch(/^cb_/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const stored = K.create.mock.calls[0]![0];
    expect(stored.hash).toBe(hashKey(body.key));
    expect(JSON.stringify(stored)).not.toContain(body.key);
    expect(stored).toMatchObject({ orgId: 'o1', scope: SCOPE_TEMPLATES_READ, includeBuiltin: true, includeOwn: true, createdBy: 'a@x.com' });
    expect(Date.parse(stored.expiresAt)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(JSON.stringify(body.record)).not.toMatch(/hash/i);
  });
  test('the list never contains a key or a hash', async () => {
    const r = await KEYS_GET(req('GET'));
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).not.toMatch(/keyHash|"cb_[A-Za-z0-9_-]{43}"/);
  });
  test('only administrators and owners; a bad body, no kind of template, and too many keys are refused', async () => {
    mockRole.mockResolvedValue('member');
    expect((await KEYS_GET(req('GET'))).status).toBe(403);
    expect((await KEYS_POST(req('POST', undefined, { body: { name: 'x' } }))).status).toBe(403);
    expect((await KEY_DELETE(req('DELETE'), ctx('k1'))).status).toBe(403);
    mockRole.mockResolvedValue('owner');
    expect((await KEYS_POST(req('POST', undefined, { body: { name: '  ' } }))).status).toBe(400);
    expect((await KEYS_POST(req('POST', undefined, { body: { name: 'x', includeBuiltin: false, includeOwn: false } }))).status).toBe(400);
    expect((await KEYS_POST(req('POST', undefined, { body: { name: 'x', expiresInDays: 4000 } }))).status).toBe(400);
    K.countActive.mockResolvedValue(20);
    expect((await KEYS_POST(req('POST', undefined, { body: { name: 'x' } }))).status).toBe(400);
    mockIdentity.mockReturnValue(null);
    expect((await KEYS_GET(req('GET'))).status).toBe(401);
    expect(K.create).not.toHaveBeenCalled();
  });
  test('revoking is for this organization\'s key only', async () => {
    expect((await KEY_DELETE(req('DELETE'), ctx('k1'))).status).toBe(200);
    expect(K.revoke).toHaveBeenCalledWith('o1', 'k1');
    K.revoke.mockResolvedValue(false);
    expect((await KEY_DELETE(req('DELETE'), ctx('other-orgs'))).status).toBe(404);
  });
});

describe('reading templates with a key', () => {
  const { key } = generateKey();
  const auth = { authorization: `Bearer ${key}` };
  const stored = (o: Record<string, unknown>) => ({ id: 'x', orgId: null, source: 'builtin', name: 'N', description: 'D', provider: 'aws', category: 'Web Applications', complexity: 'simple', tags: [], features: [], estimatedCost: 1, resourceCount: 2, meta: { a: 1 }, createdBy: 'secret@person.com', createdAt: 't', updatedAt: 'u', ...o });
  beforeEach(() => {
    K.findByHash.mockResolvedValue(REC);
    T.list.mockResolvedValue([stored({ id: 'b1' }), stored({ id: 'o1', source: 'org', orgId: 'o1', category: 'Custom', provider: 'azure' })]);
    T.listWithGraphs.mockResolvedValue([stored({ id: 'b1', graph: { nodes: [{ id: 'n' }], edges: [] } })]);
    T.get.mockResolvedValue({ ...stored({ id: 'b1' }), graph: { nodes: [], edges: [] } });
  });
  const list = (q = '') => PUB_LIST(req('GET', `http://x/api/public/templates${q}`, { headers: auth }));

  test('gives the templates the key may see, without who saved them, and notes the use', async () => {
    const r = await list();
    expect(r.status).toBe(200);
    const body = (await r.json()).data;
    expect(body.count).toBe(2);
    expect(body.templates[0]).toMatchObject({ id: 'b1', name: 'N', estimatedCostUsd: 1, source: 'builtin', details: { a: 1 } });
    expect(body.templates[0].graph).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/secret@person|orgId|createdBy/);
    expect(K.findByHash).toHaveBeenCalledWith(hashKey(key));
    expect(K.touch).toHaveBeenCalledWith('k1');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
  });
  test('?graphs=1 is a full export, and the filters apply', async () => {
    const r = await list('?graphs=1');
    expect((await r.json()).data.templates[0].graph).toEqual({ nodes: [{ id: 'n' }], edges: [] });
    expect(T.listWithGraphs).toHaveBeenCalledWith('o1');
    expect((await (await list('?provider=azure')).json()).data.templates.map((t: { id: string }) => t.id)).toEqual(['o1']);
    expect((await (await list('?category=Custom')).json()).data.count).toBe(1);
  });
  test('a key made for built-in templates only, or for the organization\'s own only, sees only those', async () => {
    K.findByHash.mockResolvedValue({ ...REC, includeOwn: false });
    expect((await (await list()).json()).data.templates.map((t: { id: string }) => t.id)).toEqual(['b1']);
    K.findByHash.mockResolvedValue({ ...REC, includeBuiltin: false });
    expect((await (await list()).json()).data.templates.map((t: { id: string }) => t.id)).toEqual(['o1']);
    const one = (id: string, source: string) => { T.get.mockResolvedValue({ ...stored({ id, source }), graph: { nodes: [], edges: [] } }); return PUB_ONE(req('GET', 'http://x/api/public/templates/x', { headers: auth }), ctx(id)); };
    expect((await one('b1', 'builtin')).status).toBe(404);          // this key may not read built-in templates
    expect((await one('o1', 'org')).status).toBe(200);
  });
  test('one template, with its graph', async () => {
    const r = await PUB_ONE(req('GET', 'http://x/api/public/templates/b1', { headers: auth }), ctx('b1'));
    expect(r.status).toBe(200);
    expect((await r.json()).data.template).toMatchObject({ id: 'b1', graph: { nodes: [], edges: [] } });
    T.get.mockResolvedValue(null);
    expect((await PUB_ONE(req('GET', 'http://x/api/public/templates/zzz', { headers: auth }), ctx('zzz'))).status).toBe(404);
  });
  test('every kind of bad key is the same 401: none, malformed, unknown, revoked, expired, or for another scope', async () => {
    const same = async (headers: Record<string, string>) => { const r = await PUB_LIST(req('GET', 'http://x/api/public/templates', { headers })); return { status: r.status, body: await r.json() }; };
    const results = [];
    results.push(await same({}));
    results.push(await same({ authorization: 'Bearer nope' }));
    K.findByHash.mockResolvedValueOnce(null); results.push(await same(auth));
    K.findByHash.mockResolvedValueOnce({ ...REC, revokedAt: 'x' }); results.push(await same(auth));
    K.findByHash.mockResolvedValueOnce({ ...REC, expiresAt: '2000-01-01T00:00:00Z' }); results.push(await same(auth));
    K.findByHash.mockResolvedValueOnce({ ...REC, scope: 'other:scope' }); results.push(await same(auth));
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]!.status).toBe(401);
    expect(T.list).not.toHaveBeenCalled();
    expect(K.touch).not.toHaveBeenCalled();
  });
  test('a session cookie is not an API key, and failed attempts and busy keys are limited', async () => {
    const r = await PUB_LIST(req('GET', 'http://x/api/public/templates', { headers: { cookie: 'cloudbuilder_session=abc' } }));
    expect(r.status).toBe(401);
    mockRate.mockResolvedValue({ allowed: false, retryAfterSeconds: 12 });
    const limited = await list();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('12');
    expect(T.list).not.toHaveBeenCalled();
  });
  test('the sessions of signed-in users do not reach the public routes, and the key reaches nothing else', async () => {
    mockIdentity.mockReturnValue({ userId: 'u1' });
    expect((await PUB_LIST(req('GET', 'http://x/api/public/templates'))).status).toBe(401);
    // The key is understood only by authenticateApiKey: the routes that need a signed-in person never look at it.
    mockIdentity.mockReturnValue(null);
    expect((await KEYS_GET(req('GET', 'http://x/api/api-keys', { headers: auth }))).status).toBe(401);
  });
});
