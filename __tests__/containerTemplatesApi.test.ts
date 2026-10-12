/**
 * /api/container-templates: who may save, change and delete saved container configurations, tenant isolation, and what is stored.
 */
interface Row { [key: string]: unknown }
type Store = Map<string, Row>;

function makeTable(store: Store) {
  const matches = (filter: Record<string, unknown>) => [...store.values()].filter((row) => Object.entries(filter).every(([k, v]) => row[k] === v));
  return {
    where(filter: Record<string, unknown>) {
      return {
        select(..._f: string[]) { return { async first() { return matches(filter)[0] ?? null; }, async all() { return matches(filter); } }; },
        async first() { return matches(filter)[0] ?? null; },
        async all() { return matches(filter); },
        async update(data: Record<string, unknown>) { for (const r of matches(filter)) Object.assign(r, data); },
        async delete() { for (const r of matches(filter)) store.delete(r['id'] as string); },
      };
    },
    async create(row: Record<string, unknown>) { store.set(row['id'] as string, { ...row }); },
    select(..._f: string[]) { return { async first() { return [...store.values()][0] ?? null; }, async all() { return [...store.values()]; } }; },
  };
}

const stores: Record<string, Store> = Object.fromEntries(['Organization', 'OrgMember', 'User', 'ContainerTemplate'].map((k) => [k, new Map()]));
const mockDb = { orm: { public: Object.fromEntries(Object.entries(stores).map(([k, s]) => [k, makeTable(s)])) } };

jest.mock('@/src/prisma/db', () => ({ db: mockDb, rawTransaction: jest.fn(), rawExec: jest.fn() }));

import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/container-templates/route';
import { PUT, DELETE } from '@/app/api/container-templates/[id]/route';
import { defaultConfig } from '@/lib/engines/containers/dockerTemplates';
import { parseStoredConfig } from '@/lib/engines/containers/stored';

function seed() {
  for (const s of Object.values(stores)) s.clear();
  stores.Organization.set('org-a', { id: 'org-a', name: 'A' });
  stores.Organization.set('org-b', { id: 'org-b', name: 'B' });
  stores.OrgMember.set('m1', { id: 'm1', orgId: 'org-a', userId: 'owner-a', role: 'owner' });
  stores.OrgMember.set('m2', { id: 'm2', orgId: 'org-a', userId: 'member-a', role: 'member' });
  stores.OrgMember.set('m3', { id: 'm3', orgId: 'org-a', userId: 'viewer-a', role: 'viewer' });
  stores.OrgMember.set('m4', { id: 'm4', orgId: 'org-a', userId: 'member-a2', role: 'member' });
  stores.OrgMember.set('m5', { id: 'm5', orgId: 'org-b', userId: 'owner-b', role: 'owner' });
}
beforeEach(seed);

const url = (id = '', orgId?: string) => `http://localhost:3000/api/container-templates${id ? `/${id}` : ''}${orgId ? `?orgId=${orgId}` : ''}`;
const call = (method: string, user: string | null, id = '', orgId?: string, body?: unknown) =>
  new NextRequest(url(id, orgId), {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { 'x-user-id': user } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const cfg = () => ({ ...defaultConfig('python'), appName: 'orders-api' });
const save = (user: string, orgId = 'org-a', name = 'Orders API', config: unknown = cfg()) => POST(call('POST', user, '', orgId, { name, config }));

describe('saving', () => {
  it('lets a member save and list, newest first', async () => {
    const a = await (await save('member-a', 'org-a', 'First')).json();
    expect(a.data.template).toMatchObject({ name: 'First', config: { stack: 'python', appName: 'orders-api' } });
    await new Promise((r) => setTimeout(r, 5));
    await save('member-a', 'org-a', 'Second');
    const list = await (await GET(call('GET', 'viewer-a', '', 'org-a'))).json();
    expect(list.data.templates.map((t: { name: string }) => t.name)).toEqual(['Second', 'First']);
  });
  it('requires sign-in, membership and a role that can write', async () => {
    expect((await POST(call('POST', null, '', 'org-a', { name: 'x', config: cfg() }))).status).toBe(401);
    expect((await save('owner-b', 'org-a')).status).toBe(403);
    expect((await save('viewer-a')).status).toBe(403);
    expect((await GET(call('GET', 'owner-b', '', 'org-a'))).status).toBe(403);
    expect(stores.ContainerTemplate.size).toBe(0);
  });
  it('keeps organizations apart', async () => {
    await save('member-a');
    const other = await (await GET(call('GET', 'owner-b', '', 'org-b'))).json();
    expect(other.data.templates).toEqual([]);
  });
  it('never stores a secret value', async () => {
    const c = { ...cfg(), env: [{ key: 'API_TOKEN', value: 'hunter2-should-not-be-kept', secret: true }, { key: 'LOG_LEVEL', value: 'info' }] };
    const res = await (await save('member-a', 'org-a', 'With secret', c)).json();
    expect(JSON.stringify(res)).not.toContain('hunter2');
    expect(JSON.stringify([...stores.ContainerTemplate.values()])).not.toContain('hunter2');
    expect(res.data.template.config.env).toEqual([{ key: 'API_TOKEN', value: '', secret: true }, { key: 'LOG_LEVEL', value: 'info' }]);
  });
  it('rejects an empty or very long name, an invalid configuration, and a body of the wrong shape', async () => {
    expect((await save('member-a', 'org-a', '   ')).status).toBe(400);
    expect((await save('member-a', 'org-a', 'x'.repeat(81))).status).toBe(400);
    expect((await save('member-a', 'org-a', 'ok', { ...cfg(), port: 70000 })).status).toBe(400);
    expect((await save('member-a', 'org-a', 'ok', { stack: 'cobol' })).status).toBe(400);
    expect((await save('member-a', 'org-a', 'ok', 'text')).status).toBe(400);
    expect((await POST(call('POST', 'member-a', '', 'org-a', { name: 5 }))).status).toBe(400);
    expect(stores.ContainerTemplate.size).toBe(0);
  });
  it('stops at 100 templates per organization', async () => {
    for (let i = 0; i < 100; i++) stores.ContainerTemplate.set(`t${i}`, { id: `t${i}`, orgId: 'org-a', name: `n${i}`, configJson: JSON.stringify(cfg()), createdBy: 'x', createdAt: 'a', updatedAt: 'a' });
    expect((await save('member-a')).status).toBe(400);
    expect((await save('owner-b', 'org-b')).status).toBe(201);
  });
});

describe('changing and deleting', () => {
  async function one(user = 'member-a') { return (await (await save(user)).json()).data.template.id as string; }
  it('updates the name and the configuration in place', async () => {
    const id = await one();
    const res = await PUT(call('PUT', 'member-a', id, 'org-a', { name: 'Renamed', config: { ...cfg(), port: 9000 } }), params(id));
    expect((await res.json()).data.template).toMatchObject({ name: 'Renamed', config: { port: 9000 } });
    expect(stores.ContainerTemplate.size).toBe(1);
  });
  it('cannot change another organization\'s template, or a viewer\'s', async () => {
    const id = await one();
    expect((await PUT(call('PUT', 'owner-b', id, 'org-b', { name: 'x', config: cfg() }), params(id))).status).toBe(404);
    expect((await PUT(call('PUT', 'viewer-a', id, 'org-a', { name: 'x', config: cfg() }), params(id))).status).toBe(403);
    expect(Array.from(stores.ContainerTemplate.values())[0]!['name']).toBe('Orders API');
  });
  it('lets the author or an owner delete, not another member or another organization', async () => {
    const id = await one('member-a');
    expect((await DELETE(call('DELETE', 'member-a2', id, 'org-a'), params(id))).status).toBe(403);
    expect((await DELETE(call('DELETE', 'owner-b', id, 'org-b'), params(id))).status).toBe(404);
    expect(stores.ContainerTemplate.size).toBe(1);
    expect((await DELETE(call('DELETE', 'member-a', id, 'org-a'), params(id))).status).toBe(200);
    const id2 = await one('member-a');
    expect((await DELETE(call('DELETE', 'owner-a', id2, 'org-a'), params(id2))).status).toBe(200);
    expect(stores.ContainerTemplate.size).toBe(0);
    expect((await DELETE(call('DELETE', 'owner-a', id2, 'org-a'), params(id2))).status).toBe(404);
  });
  it('a damaged row is left out of the list but can still be deleted', async () => {
    stores.ContainerTemplate.set('bad', { id: 'bad', orgId: 'org-a', name: 'broken', configJson: '{nope', createdBy: 'member-a', createdAt: 'a', updatedAt: 'a' });
    await save('member-a');
    expect((await (await GET(call('GET', 'member-a', '', 'org-a'))).json()).data.templates).toHaveLength(1);
    expect((await DELETE(call('DELETE', 'owner-a', 'bad', 'org-a'), params('bad'))).status).toBe(200);
  });
});

describe('reading stored configurations', () => {
  it('fills in options added after it was saved', () => {
    const old = JSON.parse(JSON.stringify(defaultConfig('node'))) as Record<string, unknown>;
    delete (old['ec2'] as Record<string, unknown>)['scanImage'];
    delete old['includeSample'];
    const c = parseStoredConfig(JSON.stringify(old))!;
    expect(c.ec2.scanImage).toBe(true);
    expect(c.includeSample).toBe(defaultConfig('node').includeSample);
  });
  it('refuses junk', () => {
    for (const j of ['', 'null', '[]', '{"stack":"node","port":"x"}', '{"stack":"node","env":[{"key":"1bad","value":""}]}']) expect(parseStoredConfig(j)).toBeNull();
  });
});
