/**
 * Development shortcuts need an explicit opt-in. `NODE_ENV=development` alone (every `npm run dev`) used to give a signed-in user without an
 * organization a shared dev organization, demo projects in place of database errors, open Terraform access, and acceptance of unverified ID tokens.
 */
jest.mock('@/src/prisma/db', () => ({ db: { orm: { public: { Project: { where: () => ({ first: async () => null }) } } } }, rawTransaction: jest.fn(), rawExec: jest.fn() }));
const ensureDevContext = jest.fn(async () => ({ userId: 'dev-user-id', orgId: 'dev-org-1' }));
jest.mock('@/lib/repositories/orgRepository', () => ({ orgRepository: { ensureDevContext: (...a: unknown[]) => (ensureDevContext as unknown as (...x: unknown[]) => unknown)(...a) } }));
jest.mock('@/lib/api/auth', () => ({ extractIdentity: () => ({ userId: 'u1', orgIds: [] }), getOrgRole: async () => null, resolveOrgIds: async () => [] }));

import { NextRequest } from 'next/server';
import { devShortcutsEnabled } from '@/lib/dev/shortcuts';
import { resolveOrgId } from '@/lib/api/phase2d';
import { unverifiedTokenFallbackAllowed } from '@/lib/auth/localFallback';
import { GET as listProjects } from '@/app/api/projects/route';

const env = process.env as Record<string, string | undefined>;
const saved = { n: env.NODE_ENV, f: env.CLOUDCRAFT_DEV_SHORTCUTS };
afterEach(() => {
  if (saved.n === undefined) delete env.NODE_ENV; else env.NODE_ENV = saved.n;
  if (saved.f === undefined) delete env.CLOUDCRAFT_DEV_SHORTCUTS; else env.CLOUDCRAFT_DEV_SHORTCUTS = saved.f;
  ensureDevContext.mockClear();
});
const mode = (nodeEnv: string, flag?: string) => { env.NODE_ENV = nodeEnv; if (flag === undefined) delete env.CLOUDCRAFT_DEV_SHORTCUTS; else env.CLOUDCRAFT_DEV_SHORTCUTS = flag; };

describe('devShortcutsEnabled', () => {
  it('needs development AND the flag', () => {
    expect(devShortcutsEnabled({ NODE_ENV: 'development', CLOUDCRAFT_DEV_SHORTCUTS: '1' })).toBe(true);
    expect(devShortcutsEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(devShortcutsEnabled({ NODE_ENV: 'development', CLOUDCRAFT_DEV_SHORTCUTS: 'true' })).toBe(false);
    expect(devShortcutsEnabled({ NODE_ENV: 'development', CLOUDCRAFT_DEV_SHORTCUTS: '' })).toBe(false);
  });
  it('is never on in production or test, flag or not', () => {
    for (const m of ['production', 'test', undefined]) expect(devShortcutsEnabled({ NODE_ENV: m, CLOUDCRAFT_DEV_SHORTCUTS: '1' })).toBe(false);
  });
});

describe('what the shortcuts used to give a signed-in user with no organization', () => {
  const req = () => new NextRequest('http://localhost:3000/api/projects');

  it('resolveOrgId: no organization means none, under plain next dev', async () => {
    mode('development');
    expect(await resolveOrgId(req(), 'u1')).toBeNull();
    expect(ensureDevContext).not.toHaveBeenCalled();                 // the shared dev org is not even created
  });
  it('resolveOrgId: with the flag, the shared dev organization stands in (for people who want it)', async () => {
    mode('development', '1');
    expect(await resolveOrgId(req(), 'u1')).toBe('dev-org-1');
    expect(ensureDevContext).toHaveBeenCalledTimes(1);
  });
  it('GET /api/projects: "organization required" under plain next dev, and no dev organization is created', async () => {
    mode('development');
    const res = await listProjects(req());
    expect(res.status).toBe(400);
    expect(ensureDevContext).not.toHaveBeenCalled();
  });
  it('GET /api/projects: with the flag the dev organization is used, and a non-member is still refused', async () => {
    mode('development', '1');
    const res = await listProjects(req());
    expect(res.status).toBe(403);                                    // the shortcut finds an org, but membership is still checked
    expect(ensureDevContext).toHaveBeenCalledTimes(1);
  });
});

describe('unverified ID tokens', () => {
  it('are not accepted under plain next dev', () => {
    mode('development');
    expect(unverifiedTokenFallbackAllowed()).toBe(false);
  });
  it('are accepted only with the flag, and never in production', () => {
    mode('development', '1');
    expect(unverifiedTokenFallbackAllowed()).toBe(true);
    mode('production', '1');
    expect(unverifiedTokenFallbackAllowed()).toBe(false);
  });
});

describe('no code path switches a shortcut on from NODE_ENV alone', () => {
  it('every development check in the app goes through devShortcutsEnabled', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawnSync } = require('child_process') as typeof import('child_process');
    const r = spawnSync('grep', ['-rn', '--include=*.ts', '--include=*.tsx', "NODE_ENV === 'development'", 'app', 'lib', 'components', 'context', 'workers'], { encoding: 'utf8' });
    const hits = r.stdout.split('\n').filter(Boolean)
      .filter((l) => !l.startsWith('lib/dev/shortcuts.ts'))              // the helper itself (and the comment explaining it)
      .filter((l) => !l.startsWith('lib/auth/localFallback.ts'));        // local sign-up already needs its own second flag
    expect(hits).toEqual([]);
  });
});
