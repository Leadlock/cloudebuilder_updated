const mockOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({ extractIdentity: jest.fn(), getOrgRole: (...a: unknown[]) => mockOrgRole(...a) }));
const mockResolveOrg = jest.fn();
const mockResolveArch = jest.fn();
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockResolveOrg(...a), resolveArchitecture: (...a: unknown[]) => mockResolveArch(...a) }));

import { NextRequest } from 'next/server';
import { extractIdentity } from '@/lib/api/auth';
import { checkRateLimit, peekRateLimit } from '@/lib/api/rateLimit';
import { planLimit, planRateKey } from '@/lib/terraform/execution/limits';
import { acquireProjectLock, isProjectLocked, releaseProjectLock } from '@/lib/terraform/execution/projectLock';
import { GET as statusGet, _clearStatusAccessCacheForTests } from '@/app/api/projects/[id]/terraform/status/route';

const env = process.env as Record<string, string | undefined>;
const saved: Record<string, string | undefined> = {};
const KEYS = ['CLOUDCRAFT_TERRAFORM_PLANS_PER_WINDOW', 'CLOUDCRAFT_TERRAFORM_PLAN_WINDOW_MINUTES', 'CLOUDCRAFT_TERRAFORM_ORG_IDS', 'CLOUDCRAFT_TERRAFORM_DISABLED'];
beforeEach(() => { KEYS.forEach((k) => { saved[k] = env[k]; delete env[k]; }); });
afterEach(() => { KEYS.forEach((k) => { if (saved[k] === undefined) delete env[k]; else env[k] = saved[k]; }); });

describe('peekRateLimit', () => {
  it('reports what is left without using any of it', () => {
    const key = `peek-${Date.now()}`;
    expect(peekRateLimit(key, 6, 60_000)).toEqual({ limit: 6, remaining: 6, used: 0, resetsInSeconds: 0 });
    checkRateLimit(key, 6, 60_000); checkRateLimit(key, 6, 60_000);
    for (let i = 0; i < 5; i++) expect(peekRateLimit(key, 6, 60_000).remaining).toBe(4);   // looking never spends
    const p = peekRateLimit(key, 6, 60_000);
    expect(p.used).toBe(2);
    expect(p.resetsInSeconds).toBeGreaterThan(55);
    expect(p.resetsInSeconds).toBeLessThanOrEqual(60);
    // and it agrees with what checkRateLimit will actually allow
    for (let i = 0; i < 4; i++) expect(checkRateLimit(key, 6, 60_000).allowed).toBe(true);
    expect(peekRateLimit(key, 6, 60_000).remaining).toBe(0);
    expect(checkRateLimit(key, 6, 60_000).allowed).toBe(false);
  });

  it('shows a full budget again once the window has passed', () => {
    const key = `peek-expire-${Date.now()}`;
    const real = Date.now;
    checkRateLimit(key, 3, 1000);
    try {
      Date.now = () => real() + 1500;
      expect(peekRateLimit(key, 3, 1000)).toEqual({ limit: 3, remaining: 3, used: 0, resetsInSeconds: 0 });
    } finally { Date.now = real; }
  });
});

describe('planLimit', () => {
  it('defaults to 6 plans per 10 minutes', () => {
    expect(planLimit()).toEqual({ limit: 6, windowMs: 600_000, windowMinutes: 10 });
  });
  it('can be adjusted by the operator, and ignores nonsense values', () => {
    env.CLOUDCRAFT_TERRAFORM_PLANS_PER_WINDOW = '12'; env.CLOUDCRAFT_TERRAFORM_PLAN_WINDOW_MINUTES = '30';
    expect(planLimit()).toEqual({ limit: 12, windowMs: 1_800_000, windowMinutes: 30 });
    env.CLOUDCRAFT_TERRAFORM_PLANS_PER_WINDOW = '0'; env.CLOUDCRAFT_TERRAFORM_PLAN_WINDOW_MINUTES = 'abc';
    expect(planLimit()).toEqual({ limit: 6, windowMs: 600_000, windowMinutes: 10 });
    env.CLOUDCRAFT_TERRAFORM_PLANS_PER_WINDOW = '-3'; env.CLOUDCRAFT_TERRAFORM_PLAN_WINDOW_MINUTES = '1.5';
    expect(planLimit().limit).toBe(6);
  });
});

describe('isProjectLocked', () => {
  it('is true only while an apply holds the project, and checking does not take the lock', () => {
    const id = `locked-${Date.now()}`;
    expect(isProjectLocked(id)).toBe(false);
    expect(isProjectLocked(id)).toBe(false);
    expect(acquireProjectLock(id)).toBe(true);        // still free after the checks above
    expect(isProjectLocked(id)).toBe(true);
    releaseProjectLock(id);
    expect(isProjectLocked(id)).toBe(false);
  });
});

describe('GET /api/projects/[id]/terraform/status', () => {
  const call = (projectId = 'proj-s') => statusGet(new NextRequest(`http://localhost/api/projects/${projectId}/terraform/status`), { params: Promise.resolve({ id: projectId }) });
  const signedIn = (id: string) => (extractIdentity as jest.Mock).mockReturnValue({ userId: id, role: 'admin', orgIds: [] });
  beforeEach(() => { _clearStatusAccessCacheForTests(); mockOrgRole.mockReset(); mockResolveOrg.mockReset(); mockResolveArch.mockReset(); mockResolveOrg.mockResolvedValue('org-s'); mockOrgRole.mockResolvedValue('owner'); mockResolveArch.mockResolvedValue({ arch: {}, project: {} }); });

  it('requires a signed-in org member and an existing project', async () => {
    (extractIdentity as jest.Mock).mockReturnValue(null);
    expect((await call()).status).toBe(401);
    signedIn('u-s'); mockOrgRole.mockResolvedValue(null);
    expect((await call()).status).toBe(403);
    mockOrgRole.mockResolvedValue('member'); mockResolveArch.mockResolvedValue({ error: 'project_not_found' });
    expect((await call()).status).toBe(404);
  });

  it('says when execution is switched off or not enabled for the org, with the reason', async () => {
    signedIn('u-s');
    const body = await (await call()).json() as { data: { enabled: boolean; reason?: string } };
    expect(body.data.enabled).toBe(false);
    expect(body.data.reason).toMatch(/not enabled/i);
    _clearStatusAccessCacheForTests();                       // the server's settings just changed; a real change shows within 30 s
    env.CLOUDCRAFT_TERRAFORM_ORG_IDS = 'org-s'; env.CLOUDCRAFT_TERRAFORM_DISABLED = '1';
    const off = await (await call()).json() as { data: { enabled: boolean; reason?: string } };
    expect(off.data.reason).toMatch(/switched off/i);
  });

  it('reports plans left and the countdown for this user, and never uses any of the budget', async () => {
    signedIn('u-count');
    env.CLOUDCRAFT_TERRAFORM_ORG_IDS = 'org-s';
    const { limit, windowMs } = planLimit();
    checkRateLimit(planRateKey('u-count'), limit, windowMs); checkRateLimit(planRateKey('u-count'), limit, windowMs);
    for (let i = 0; i < 4; i++) {
      const body = await (await call()).json() as { data: { enabled: boolean; plans: { limit: number; remaining: number; resetsInSeconds: number; windowMinutes: number } } };
      expect(body.data.enabled).toBe(true);
      expect(body.data.plans).toMatchObject({ limit: 6, remaining: 4, windowMinutes: 10 });
      expect(body.data.plans.resetsInSeconds).toBeGreaterThan(590);
    }
  });

  it('remembers a successful access check for a short time (the panel polls every 20 s), but never a refusal, and always reads the numbers fresh', async () => {
    signedIn('u-cache'); env.CLOUDCRAFT_TERRAFORM_ORG_IDS = 'org-s';
    const id = `proj-cache-${Date.now()}`;
    expect((await call(id)).status).toBe(200);
    expect(mockResolveOrg).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) expect((await call(id)).status).toBe(200);
    expect(mockResolveOrg).toHaveBeenCalledTimes(1);                               // three more polls, no more database lookups
    const { limit, windowMs } = planLimit();
    checkRateLimit(planRateKey('u-cache'), limit, windowMs);
    expect((await (await call(id)).json() as { data: { plans: { remaining: number } } }).data.plans.remaining).toBe(5);   // plans left is never cached

    mockOrgRole.mockResolvedValue(null);                                           // a refusal is not remembered
    expect((await call(`${id}-other`)).status).toBe(403);
    mockOrgRole.mockResolvedValue('owner');
    expect((await call(`${id}-other`)).status).toBe(200);
  });

  it('shows whether an apply is running for this project, and only this project', async () => {
    signedIn('u-apply');
    env.CLOUDCRAFT_TERRAFORM_ORG_IDS = 'org-s';
    const id = `proj-running-${Date.now()}`;
    expect((await (await call(id)).json() as { data: { applyRunning: boolean } }).data.applyRunning).toBe(false);
    acquireProjectLock(id);
    try {
      expect((await (await call(id)).json() as { data: { applyRunning: boolean } }).data.applyRunning).toBe(true);
      expect((await (await call(`${id}-other`)).json() as { data: { applyRunning: boolean } }).data.applyRunning).toBe(false);
    } finally { releaseProjectLock(id); }
  });
});
