/**
 * Terraform access: how an organization gets permission to run Terraform on this server (operator decisions and automatic approval), who may decide,
 * and what each answer means to terraformExecutionDenied.
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

const stores: Record<string, Store> = Object.fromEntries(['Organization', 'OrgMember', 'User', 'TerraformAccess', 'TerraformAuditEvent'].map((k) => [k, new Map()]));
const mockDb = { orm: { public: Object.fromEntries(Object.entries(stores).map(([k, s]) => [k, makeTable(s)])) } };

jest.mock('@/src/prisma/db', () => ({ db: mockDb, rawTransaction: jest.fn(), rawExec: jest.fn() }));

const mockTotp = jest.fn();
jest.mock('@/lib/api/totpStore', () => ({ totpEnabled: (...a: unknown[]) => mockTotp(...a) }));
const mockAccounts = jest.fn();
jest.mock('@/lib/repositories/cloudAccountRepository', () => ({ cloudAccountRepository: { list: (...a: unknown[]) => mockAccounts(...a) } }));

import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/terraform-access/route';
import { GET as OPERATOR_LIST } from '@/app/api/operator/terraform-access/route';
import { PUT as DECIDE } from '@/app/api/operator/terraform-access/[orgId]/route';
import { terraformExecutionDenied } from '@/lib/api/terraformAccess';
import { statusAccessCache } from '@/lib/api/accessCache';

const GOOD_KEY = 'a'.repeat(32) + 'b'.repeat(16) + 'c'.repeat(16);
const ENV_KEYS = ['CLOUDCRAFT_ALLOW_TEST_AUTH_HEADERS', 'CLOUDCRAFT_OPERATOR_EMAILS', 'CLOUDCRAFT_TERRAFORM_AUTO_APPROVE', 'CLOUDCRAFT_TERRAFORM_ORG_IDS', 'ENCRYPTION_KEY', 'CLOUDCRAFT_DEV_SHORTCUTS'];
const saved: Record<string, string | undefined> = {};

function seed() {
  for (const s of Object.values(stores)) s.clear();
  stores.Organization.set('org-a', { id: 'org-a', name: 'Acme' });
  stores.Organization.set('org-b', { id: 'org-b', name: 'Bravo' });
  stores.OrgMember.set('m1', { id: 'm1', orgId: 'org-a', userId: 'owner-a', role: 'owner' });
  stores.OrgMember.set('m2', { id: 'm2', orgId: 'org-a', userId: 'member-a', role: 'member' });
  stores.OrgMember.set('m3', { id: 'm3', orgId: 'org-a', userId: 'admin-a', role: 'admin' });
  stores.OrgMember.set('m4', { id: 'm4', orgId: 'org-b', userId: 'owner-b', role: 'owner' });
  stores.OrgMember.set('m5', { id: 'm5', orgId: 'org-b', userId: 'ops', role: 'owner' });
  mockTotp.mockResolvedValue(true);
  mockAccounts.mockResolvedValue([{ id: 'c1', status: 'active' }]);
  statusAccessCache.clear();
}
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env['CLOUDCRAFT_ALLOW_TEST_AUTH_HEADERS'] = '1';
  process.env['CLOUDCRAFT_OPERATOR_EMAILS'] = 'ops@platform.test, Boss@Platform.test';
  process.env['ENCRYPTION_KEY'] = GOOD_KEY;
  seed();
});
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const req = (method: string, user: string | null, opts: { org?: string; email?: string; body?: unknown; path?: string } = {}) =>
  new NextRequest(`http://localhost:3000/api/${opts.path ?? 'terraform-access'}${opts.org ? `?orgId=${opts.org}` : ''}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { 'x-user-id': user } : {}), ...(opts.email ? { 'x-user-email': opts.email } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
const json = async (r: Response) => (await r.json()).data;
const decide = (orgId: string, body: unknown, email = 'ops@platform.test') => DECIDE(req('PUT', 'ops', { email, body, path: `operator/terraform-access/${orgId}` }), { params: Promise.resolve({ orgId }) });
const request = (user = 'owner-a', org = 'org-a') => POST(req('POST', user, { org }));
const denied = (user = 'owner-a', org = 'org-a') => terraformExecutionDenied(user, org);

describe('before anyone has asked', () => {
  it('Terraform is not enabled, and the answer says how to ask', async () => {
    expect(await denied()).toMatch(/not enabled for this organization.*Ask for access/);
    const s = await json(await GET(req('GET', 'member-a', { org: 'org-a' })));
    expect(s).toMatchObject({ status: 'none', mayDeploy: false, canRequest: false, operator: false });
    expect((await json(await GET(req('GET', 'owner-a', { org: 'org-a' })))).canRequest).toBe(true);
  });
  it('lists the checks with what to do about each', async () => {
    mockTotp.mockResolvedValue(false); mockAccounts.mockResolvedValue([]);
    const { checks } = await json(await GET(req('GET', 'owner-a', { org: 'org-a' })));
    expect(checks.map((c: { id: string; passed: boolean }) => [c.id, c.passed])).toEqual([['authenticator', false], ['cloud-account', false], ['encryption-key', true]]);
    for (const c of checks) { expect(c.fix.length).toBeGreaterThan(10); expect(c.detail.length).toBeGreaterThan(3); }
  });
  it('requires sign-in and membership', async () => {
    expect((await GET(req('GET', null, { org: 'org-a' }))).status).toBe(401);
    expect((await GET(req('GET', 'owner-b', { org: 'org-a' }))).status).toBe(403);
  });
});

describe('asking for access', () => {
  it('goes to an operator when the server does not approve automatically, even if every check passes', async () => {
    const r = await json(await request());
    expect(r).toMatchObject({ status: 'requested', automatic: false });
    expect(await denied()).toMatch(/waiting for an operator/);
    expect(stores.TerraformAuditEvent.size).toBe(1);
  });
  it('is approved at once when the server allows it and every check passes', async () => {
    process.env['CLOUDCRAFT_TERRAFORM_AUTO_APPROVE'] = '1';
    const r = await json(await request());
    expect(r).toMatchObject({ status: 'approved', automatic: true });
    expect(await denied()).toBeNull();
    const row = [...stores.TerraformAccess.values()][0]!;
    expect(row).toMatchObject({ status: 'approved', source: 'auto', decidedBy: 'automatic' });
  });
  it.each([
    ['no authenticator app', () => mockTotp.mockResolvedValue(false)],
    ['no working cloud account', () => mockAccounts.mockResolvedValue([{ status: 'pending' }, { status: 'invalid' }])],
    ['a weak encryption key', () => { process.env['ENCRYPTION_KEY'] = 'short'; }],
  ])('is NOT approved automatically with %s: it waits for an operator, and the failed check is recorded', async (_n, breakIt) => {
    process.env['CLOUDCRAFT_TERRAFORM_AUTO_APPROVE'] = '1';
    breakIt();
    const r = await json(await request());
    expect(r.status).toBe('requested');
    expect(r.checks.filter((c: { passed: boolean }) => !c.passed)).toHaveLength(1);
    expect(await denied()).toMatch(/waiting for an operator/);
  });
  it('only an owner or admin may ask', async () => {
    expect((await request('member-a')).status).toBe(403);
    expect((await request('owner-b', 'org-a')).status).toBe(403);
    expect((await request('admin-a')).status).toBe(200);
    expect(stores.TerraformAccess.size).toBe(1);
  });
  it('asking twice changes nothing, and asking when approved reports it', async () => {
    await request();
    await request('admin-a');
    expect(stores.TerraformAccess.size).toBe(1);
    await decide('org-a', { action: 'approve' });
    expect((await json(await request())).status).toBe('approved');
  });
});

describe('operators', () => {
  it('see requests first with the organization name, the person and the checks; nobody else can', async () => {
    await request('owner-a', 'org-a');
    process.env['CLOUDCRAFT_TERRAFORM_AUTO_APPROVE'] = '1';
    await request('owner-b', 'org-b');
    const list = await json(await OPERATOR_LIST(req('GET', 'ops', { email: 'ops@platform.test', path: 'operator/terraform-access' })));
    expect(list.entries.map((e: { orgName: string; status: string }) => [e.orgName, e.status])).toEqual([['Acme', 'requested'], ['Bravo', 'approved']]);
    expect(list.entries[0].checks).toHaveLength(3);
    expect(list.autoApprove).toBe(true);
    expect((await OPERATOR_LIST(req('GET', 'owner-a', { email: 'owner@acme.test', path: 'operator/terraform-access' }))).status).toBe(403);
    expect((await OPERATOR_LIST(req('GET', null, { path: 'operator/terraform-access' }))).status).toBe(401);
  });
  it('are identified by the server\'s list of emails (case does not matter), never by being an owner or admin', async () => {
    expect((await json(await GET(req('GET', 'ops', { org: 'org-b', email: 'BOSS@platform.test' })))).operator).toBe(true);
    expect((await json(await GET(req('GET', 'owner-a', { org: 'org-a', email: 'owner@acme.test' })))).operator).toBe(false);
    expect((await decide('org-a', { action: 'approve' }, 'owner@acme.test')).status).toBe(403);
    delete process.env['CLOUDCRAFT_OPERATOR_EMAILS'];
    expect((await decide('org-a', { action: 'approve' })).status).toBe(403);
    expect(stores.TerraformAccess.size).toBe(0);
  });
  it('approve takes effect at once, even where the answer was cached', async () => {
    statusAccessCache.set('org-a|owner-a', { denied: 'cached refusal' });
    await decide('org-a', { action: 'approve', note: 'trial customer' });
    expect(statusAccessCache.get('org-a|owner-a')).toBeUndefined();
    expect(await denied()).toBeNull();
    expect([...stores.TerraformAccess.values()][0]).toMatchObject({ status: 'approved', source: 'operator', decidedBy: 'ops@platform.test', note: 'trial customer' });
  });
  it('deny keeps it blocked with the reason, and the organization may ask again', async () => {
    await request();
    await decide('org-a', { action: 'deny', note: 'please connect a test account first' });
    expect(await denied()).toMatch(/declined it: please connect a test account first/);
    expect((await json(await GET(req('GET', 'owner-a', { org: 'org-a' })))).canRequest).toBe(true);
    expect((await json(await request())).status).toBe('requested');
  });
  it('revoke stops a running organization at once, and neither asking again nor passing every check undoes it', async () => {
    process.env['CLOUDCRAFT_TERRAFORM_AUTO_APPROVE'] = '1';
    await request();
    expect(await denied()).toBeNull();
    await decide('org-a', { action: 'revoke', note: 'abuse report' });
    expect(await denied()).toMatch(/withdrew access: abuse report/);
    const again = await request();
    expect(again.status).toBe(400);
    expect((await again.json()).error.message).toMatch(/Ask the operator to approve it again/);
    expect((await json(await GET(req('GET', 'owner-a', { org: 'org-a' })))).canRequest).toBe(false);
    await decide('org-a', { action: 'approve' });
    expect(await denied()).toBeNull();
  });
  it('every decision and request is in the audit trail, with who did it', async () => {
    await request();
    await decide('org-a', { action: 'approve' });
    await decide('org-a', { action: 'revoke', note: 'x' });
    const events = [...stores.TerraformAuditEvent.values()].filter((e) => e['action'] === 'access');
    expect(events.map((e) => e['outcome'])).toEqual(['requested', 'allowed', 'blocked']);
    expect(String(events[1]!['detail'])).toContain('ops@platform.test');
  });
  it('reject an unknown action, a long note, and an organization that does not exist', async () => {
    expect((await decide('org-a', { action: 'delete' })).status).toBe(400);
    expect((await decide('org-a', { action: 'deny', note: 'x'.repeat(301) })).status).toBe(400);
    expect((await decide('no-such-org', { action: 'approve' })).status).toBe(404);
    expect(stores.TerraformAccess.size).toBe(0);
  });
});

describe('what each state means to terraformExecutionDenied', () => {
  it('the server\'s own list still works as an override, and an approved organization still needs an owner or admin', async () => {
    process.env['CLOUDCRAFT_TERRAFORM_ORG_IDS'] = 'org-a';
    expect(await denied('owner-a')).toBeNull();
    expect(await denied('member-a')).toMatch(/owner or admin/);
    expect((await json(await GET(req('GET', 'owner-a', { org: 'org-a' })))).status).toBe('approved');
    expect((await json(await GET(req('GET', 'owner-a', { org: 'org-a' })))).canRequest).toBe(false);
    await decide('org-a', { action: 'approve' });
    delete process.env['CLOUDCRAFT_TERRAFORM_ORG_IDS'];
    expect(await denied('member-a')).toMatch(/owner or admin/);
    expect(await denied('owner-a')).toBeNull();
  });
  it('approving one organization does not open another', async () => {
    await decide('org-a', { action: 'approve' });
    expect(await denied('owner-b', 'org-b')).toMatch(/not enabled/);
  });
  it('a database problem reading the record means "not enabled", never "enabled"', async () => {
    (mockDb.orm.public as Record<string, unknown>)['TerraformAccess'] = { where: () => ({ first: async () => { throw new Error('db down'); } }) };
    expect(await denied()).toMatch(/not enabled/);
  });
});
