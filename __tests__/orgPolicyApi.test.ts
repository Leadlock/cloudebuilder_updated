/**
 * /api/org-policy: who may read and change an organization's policy, tenant isolation, and what is accepted.
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

const stores: Record<string, Store> = Object.fromEntries(['Organization', 'OrgMember', 'User', 'OrgPolicy'].map((k) => [k, new Map()]));
const mockDb = { orm: { public: Object.fromEntries(Object.entries(stores).map(([k, s]) => [k, makeTable(s)])) } };

jest.mock('@/src/prisma/db', () => ({ db: mockDb, rawTransaction: jest.fn(), rawExec: jest.fn() }));

import { NextRequest } from 'next/server';
import { GET, PUT } from '@/app/api/org-policy/route';

function seed() {
  for (const s of Object.values(stores)) s.clear();
  stores.Organization.set('org-a', { id: 'org-a', name: 'A' });
  stores.Organization.set('org-b', { id: 'org-b', name: 'B' });
  stores.OrgMember.set('m1', { id: 'm1', orgId: 'org-a', userId: 'owner-a', role: 'owner' });
  stores.OrgMember.set('m2', { id: 'm2', orgId: 'org-a', userId: 'member-a', role: 'member' });
  stores.OrgMember.set('m3', { id: 'm3', orgId: 'org-a', userId: 'admin-a', role: 'admin' });
  stores.OrgMember.set('m4', { id: 'm4', orgId: 'org-b', userId: 'owner-b', role: 'owner' });
}
beforeEach(seed);

const req = (method: 'GET' | 'PUT', user: string | null, orgId?: string, body?: unknown) =>
  new NextRequest(`http://localhost:3000/api/org-policy${orgId ? `?orgId=${orgId}` : ''}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { 'x-user-id': user } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const policy = { approvedRegions: ['ap-south-1'], allowedInstanceTypes: ['t3.*'], requiredTags: [{ key: 'CostCenter' }], namingPattern: '^prod-' };

describe('GET /api/org-policy', () => {
  it('returns the empty policy (version 0) when none has been saved, and tells a member they cannot edit', async () => {
    const res = await GET(req('GET', 'member-a', 'org-a'));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.policy).toMatchObject({ approvedRegions: [], allowedInstanceTypes: [], requiredTags: [], namingPattern: '', version: 0 });
    expect(data.canEdit).toBe(false);
  });

  it('requires authentication', async () => {
    expect((await GET(req('GET', null, 'org-a'))).status).toBe(401);
  });

  it('refuses a caller who is not a member of the organization', async () => {
    expect((await GET(req('GET', 'owner-b', 'org-a'))).status).toBe(403);
  });
});

describe('PUT /api/org-policy', () => {
  it('lets an owner save, and bumps the version on each save', async () => {
    const first = await (await PUT(req('PUT', 'owner-a', 'org-a', policy))).json();
    expect(first.data.policy).toMatchObject({ ...policy, version: 1 });
    expect(first.data.canEdit).toBe(true);

    const second = await (await PUT(req('PUT', 'owner-a', 'org-a', { ...policy, approvedRegions: ['ap-south-1', 'centralindia'] }))).json();
    expect(second.data.policy.version).toBe(2);

    const read = await (await GET(req('GET', 'member-a', 'org-a'))).json();
    expect(read.data.policy).toMatchObject({ approvedRegions: ['ap-south-1', 'centralindia'], version: 2 });
    expect(stores.OrgPolicy.size).toBe(1); // updated in place, one row per organization
  });

  it('lets an admin save', async () => {
    expect((await PUT(req('PUT', 'admin-a', 'org-a', policy))).status).toBe(200);
  });

  it('refuses an ordinary member', async () => {
    const res = await PUT(req('PUT', 'member-a', 'org-a', policy));
    expect(res.status).toBe(403);
    expect(stores.OrgPolicy.size).toBe(0);
  });

  it('refuses the owner of another organization (tenant isolation)', async () => {
    const res = await PUT(req('PUT', 'owner-b', 'org-a', policy));
    expect(res.status).toBe(403);
    expect(stores.OrgPolicy.size).toBe(0);
  });

  it('keeps each organization\'s policy separate', async () => {
    await PUT(req('PUT', 'owner-a', 'org-a', policy));
    const other = await (await GET(req('GET', 'owner-b', 'org-b'))).json();
    expect(other.data.policy.approvedRegions).toEqual([]);
  });

  it('rejects an invalid naming pattern', async () => {
    const res = await PUT(req('PUT', 'owner-a', 'org-a', { ...policy, namingPattern: '([' }));
    expect(res.status).toBe(400);
    expect(stores.OrgPolicy.size).toBe(0);
  });

  it('rejects a duplicate required tag and an unexpected shape', async () => {
    expect((await PUT(req('PUT', 'owner-a', 'org-a', { ...policy, requiredTags: [{ key: 'A' }, { key: 'A' }] }))).status).toBe(400);
    expect((await PUT(req('PUT', 'owner-a', 'org-a', { approvedRegions: 'ap-south-1' }))).status).toBe(400);
  });

  it('removes repeated entries before saving', async () => {
    const res = await PUT(req('PUT', 'owner-a', 'org-a', { ...policy, approvedRegions: ['ap-south-1', 'ap-south-1'] }));
    expect((await res.json()).data.policy.approvedRegions).toEqual(['ap-south-1']);
  });

  it('requires authentication', async () => {
    expect((await PUT(req('PUT', null, 'org-a', policy))).status).toBe(401);
  });
});
