/**
 * The super administrator is an owner of every organization they belong to, and of no other. Their session carries the admin role at once.
 */
const members: Record<string, { role: string }> = {};
const users: Record<string, { email: string }> = {};
const lookups = { user: 0 };
jest.mock('@/src/prisma/db', () => ({
  db: { orm: { public: {
    OrgMember: { where: (f: { orgId: string; userId: string }) => ({ first: async () => members[`${f.userId}|${f.orgId}`] ?? null }) },
    User: { where: (f: { id: string }) => ({ first: async () => { lookups.user++; return users[f.id] ?? null; } }) },
  } } },
  pool: {},
}));
jest.mock('@/lib/repositories/orgRepository', () => ({ orgRepository: {} }));

import { getOrgRole } from '@/lib/api/auth';
import { AuthService } from '@/lib/api/authService';

const OLD = process.env['SUPER_ADMIN_EMAILS'];
beforeEach(() => {
  process.env['SUPER_ADMIN_EMAILS'] = 'ajinkya@neozaar.com';
  lookups.user = 0;
  for (const k of Object.keys(members)) delete members[k];
  members['u-aj|org1'] = { role: 'member' };
  members['u-boss|org1'] = { role: 'admin' };
  users['u-aj'] = { email: 'ajinkya@neozaar.com' };
  users['u-boss'] = { email: 'boss@neozaar.com' };
});
afterAll(() => { if (OLD === undefined) delete process.env['SUPER_ADMIN_EMAILS']; else process.env['SUPER_ADMIN_EMAILS'] = OLD; });

describe('getOrgRole', () => {
  test('a super administrator who is only a member of the organization is its owner', async () => {
    expect(await getOrgRole('u-aj', 'org1')).toBe('owner');
  });

  test('never of an organization they do not belong to', async () => {
    expect(await getOrgRole('u-aj', 'org2')).toBeNull();
  });

  test('everyone else keeps the role they have', async () => {
    expect(await getOrgRole('u-boss', 'org1')).toBe('admin');
  });

  test('without the setting nothing changes and the user is not even looked up', async () => {
    process.env['SUPER_ADMIN_EMAILS'] = '';
    expect(await getOrgRole('u-aj', 'org1')).toBe('member');
    expect(lookups.user).toBe(0);
  });

  test('a database error never grants anything', async () => {
    users['u-aj'] = undefined as never;
    expect(await getOrgRole('u-aj', 'org1')).toBe('member');
  });
});

describe('sessions', () => {
  const user = (email: string, role: 'admin' | 'user') => ({ id: `u-${email}`, email, name: 'X', role, orgId: 'org1' });

  test('a super administrator\'s session is an admin session, even one made before they were promoted', () => {
    const { token } = AuthService.createSession(user('ajinkya@neozaar.com', 'user'));
    expect(AuthService.getSession(token)?.user.role).toBe('admin');
  });

  test('another user\'s session is left as it is', () => {
    const { token } = AuthService.createSession(user('dev@neozaar.com', 'user'));
    expect(AuthService.getSession(token)?.user.role).toBe('user');
    const admin = AuthService.createSession(user('boss@neozaar.com', 'admin'));
    expect(AuthService.getSession(admin.token)?.user.role).toBe('admin');
  });

  test('without the setting the role is the one in the session', () => {
    process.env['SUPER_ADMIN_EMAILS'] = '';
    const { token } = AuthService.createSession(user('ajinkya@neozaar.com', 'user'));
    expect(AuthService.getSession(token)?.user.role).toBe('user');
  });
});
