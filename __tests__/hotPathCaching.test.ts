/**
 * The per-request lookups that each cost a database round trip are remembered briefly, and forgotten when they change.
 * The caches are off under NODE_ENV=test (other tests change roles between calls), so this loads the modules as production would.
 */
const env = process.env as Record<string, string | undefined>;
const savedEnv = env['NODE_ENV'];

const memberFirst = jest.fn();
const memberAll = jest.fn();
function loadAuth() {
  jest.resetModules();
  env['NODE_ENV'] = 'production';
  jest.doMock('@/src/prisma/db', () => ({
    db: { orm: { public: { OrgMember: { where: () => ({ first: memberFirst, select: () => ({ all: memberAll }) }) } } } },
  }));
  jest.doMock('@/lib/api/authService', () => ({ AuthService: { getSession: jest.fn() } }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/api/auth') as typeof import('@/lib/api/auth');
}

beforeEach(() => { memberFirst.mockReset(); memberAll.mockReset(); });
afterAll(() => { env['NODE_ENV'] = savedEnv; jest.resetModules(); });

describe('membership lookups', () => {
  it('asks the database once for the same user and organisation, then answers from memory', async () => {
    const { getOrgRole } = loadAuth();
    memberFirst.mockResolvedValue({ role: 'admin' });
    expect(await getOrgRole('u1', 'o1')).toBe('admin');
    expect(await getOrgRole('u1', 'o1')).toBe('admin');
    expect(await getOrgRole('u1', 'o1')).toBe('admin');
    expect(memberFirst).toHaveBeenCalledTimes(1);
    await getOrgRole('u1', 'o2');            // another organisation is another question
    await getOrgRole('u2', 'o1');            // and another person
    expect(memberFirst).toHaveBeenCalledTimes(3);
  });

  it('also remembers "not a member", and forgets it the moment membership changes', async () => {
    const { getOrgRole, forgetMembership } = loadAuth();
    memberFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ role: 'member' });
    expect(await getOrgRole('u1', 'o1')).toBeNull();
    expect(await getOrgRole('u1', 'o1')).toBeNull();            // still remembered
    forgetMembership('u1');                                      // e.g. the invitation was accepted
    expect(await getOrgRole('u1', 'o1')).toBe('member');
    expect(memberFirst).toHaveBeenCalledTimes(2);
  });

  it('remembers a person\'s organisations too, and forgetting one person leaves the others', async () => {
    const { resolveOrgIds, forgetMembership } = loadAuth();
    memberAll.mockResolvedValue([{ orgId: 'o1' }]);
    expect(await resolveOrgIds('u1')).toEqual(['o1']);
    expect(await resolveOrgIds('u1')).toEqual(['o1']);
    await resolveOrgIds('u2');
    expect(memberAll).toHaveBeenCalledTimes(2);
    forgetMembership('u1');
    await resolveOrgIds('u1'); await resolveOrgIds('u2');
    expect(memberAll).toHaveBeenCalledTimes(3);                  // u1 asked again, u2 still remembered
  });
});

describe('credential expiry sweep', () => {
  it('runs at most once a minute per organisation unless forced', async () => {
    jest.resetModules();
    env['NODE_ENV'] = 'production';
    const select = jest.fn().mockReturnValue({ all: async () => [] });
    jest.doMock('@/src/prisma/db', () => ({ db: { orm: { public: { CloudAccount: { where: () => ({ select }) } } } } }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { cloudAccountRepository } = require('@/lib/repositories/cloudAccountRepository') as typeof import('@/lib/repositories/cloudAccountRepository');
    await cloudAccountRepository.expireDue('o1');
    await cloudAccountRepository.expireDue('o1');
    await cloudAccountRepository.expireDue('o1');
    expect(select).toHaveBeenCalledTimes(1);
    await cloudAccountRepository.expireDue('o2');                // another organisation sweeps on its own
    expect(select).toHaveBeenCalledTimes(2);
    await cloudAccountRepository.expireDue('o1', true);          // forced
    expect(select).toHaveBeenCalledTimes(3);
  });
});
