/**
 * Regression tests for the security hardening: Terraform execution gate and the /api/metrics route.
 */
const mockGetOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({
  extractIdentity: jest.fn(),
  getOrgRole: (...a: unknown[]) => mockGetOrgRole(...a),
}));
const mockMetrics = jest.fn();
jest.mock('@/lib/services/ObservabilityService', () => ({
  ObservabilityService: { getResourceMetrics: (...a: unknown[]) => mockMetrics(...a) },
}));

import { NextRequest } from 'next/server';
import { extractIdentity } from '@/lib/api/auth';
import { terraformExecutionDenied, allowedTerraformOrgIds } from '@/lib/api/terraformAccess';
import { POST as metricsPost } from '@/app/api/metrics/route';

const OLD_ENV = process.env.CLOUDBUILDER_TERRAFORM_ORG_IDS;
afterEach(() => { if (OLD_ENV === undefined) delete process.env.CLOUDBUILDER_TERRAFORM_ORG_IDS; else process.env.CLOUDBUILDER_TERRAFORM_ORG_IDS = OLD_ENV; });

describe('Terraform execution gate', () => {
  beforeEach(() => mockGetOrgRole.mockReset());

  it('is denied for everyone by default — a brand-new owner of a brand-new org included', async () => {
    delete process.env.CLOUDBUILDER_TERRAFORM_ORG_IDS;
    mockGetOrgRole.mockResolvedValue('owner');
    expect(allowedTerraformOrgIds().size).toBe(0);
    expect(await terraformExecutionDenied('user-1', 'org-new')).toMatch(/not enabled/i);
    expect(mockGetOrgRole).not.toHaveBeenCalled();
  });

  it(`opens the caller's own org only when NODE_ENV is "development", CLOUDBUILDER_DEV_SHORTCUTS=1 and no list is set — and still needs owner/admin`, async () => {
    const env = process.env as Record<string, string | undefined>;
    const savedEnv = env.NODE_ENV;
    const savedFlag = env.CLOUDBUILDER_DEV_SHORTCUTS;
    try {
      delete env.CLOUDBUILDER_TERRAFORM_ORG_IDS;
      env.NODE_ENV = 'development';
      // `npm run dev` alone is not enough: without the flag the gate is closed like in production
      delete env.CLOUDBUILDER_DEV_SHORTCUTS;
      mockGetOrgRole.mockResolvedValue('owner');
      expect(await terraformExecutionDenied('u', 'any-org')).toMatch(/not enabled/i);
      env.CLOUDBUILDER_DEV_SHORTCUTS = '1';
      mockGetOrgRole.mockResolvedValueOnce('owner');
      expect(await terraformExecutionDenied('u', 'any-org')).toBeNull();
      mockGetOrgRole.mockResolvedValueOnce('member');
      expect(await terraformExecutionDenied('u', 'any-org')).toMatch(/owner or admin/i);

      // setting the list switches the convenience off, so the gate can be tested locally
      env.CLOUDBUILDER_TERRAFORM_ORG_IDS = 'org-a';
      mockGetOrgRole.mockResolvedValue('owner');
      expect(await terraformExecutionDenied('u', 'other-org')).toMatch(/not enabled/i);

      // never in production or test builds, even with the flag
      delete env.CLOUDBUILDER_TERRAFORM_ORG_IDS;
      for (const mode of ['production', 'test']) {
        env.NODE_ENV = mode;
        expect(await terraformExecutionDenied('u', 'any-org')).toMatch(/not enabled/i);
      }
    } finally {
      env.NODE_ENV = savedEnv;
      if (savedFlag === undefined) delete env.CLOUDBUILDER_DEV_SHORTCUTS; else env.CLOUDBUILDER_DEV_SHORTCUTS = savedFlag;
    }
  });

  it("the kill switch denies everyone, even a listed org's owner", async () => {
    const env = process.env as Record<string, string | undefined>;
    env.CLOUDBUILDER_TERRAFORM_ORG_IDS = 'org-a';
    env.CLOUDBUILDER_TERRAFORM_DISABLED = '1';
    mockGetOrgRole.mockResolvedValue('owner');
    try {
      expect(await terraformExecutionDenied('u', 'org-a')).toMatch(/switched off/i);
    } finally {
      delete env.CLOUDBUILDER_TERRAFORM_DISABLED;
    }
    expect(await terraformExecutionDenied('u', 'org-a')).toBeNull();
  });

  it('is denied for an org the operator did not list, even for its owner', async () => {
    process.env.CLOUDBUILDER_TERRAFORM_ORG_IDS = 'org-a, org-b';
    mockGetOrgRole.mockResolvedValue('owner');
    expect(await terraformExecutionDenied('user-1', 'org-other')).toMatch(/not enabled/i);
  });

  it('is allowed only for an owner or admin of a listed org', async () => {
    process.env.CLOUDBUILDER_TERRAFORM_ORG_IDS = 'org-a, org-b';
    mockGetOrgRole.mockResolvedValueOnce('owner');
    expect(await terraformExecutionDenied('u', 'org-a')).toBeNull();
    mockGetOrgRole.mockResolvedValueOnce('admin');
    expect(await terraformExecutionDenied('u', 'org-b')).toBeNull();
    mockGetOrgRole.mockResolvedValueOnce('member');
    expect(await terraformExecutionDenied('u', 'org-a')).toMatch(/owner or admin/i);
    mockGetOrgRole.mockResolvedValueOnce(null);
    expect(await terraformExecutionDenied('u', 'org-a')).toMatch(/owner or admin/i);
  });
});

describe('POST /api/metrics', () => {
  const req = (body: unknown) => new NextRequest('http://localhost/api/metrics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const asUser = (id: string) => (extractIdentity as jest.Mock).mockReturnValue({ userId: id, role: 'user', orgIds: [] });
  const SUB = '12345678-1234-1234-1234-123456789abc';
  const good = { nodeId: 'n1', provider: 'aws', resourceId: 'i-0123456789abcdef0', resourceType: 'aws_ec2', region: 'us-east-1' };

  beforeEach(() => { mockMetrics.mockReset(); mockMetrics.mockResolvedValue({ status: 'ok' }); });

  it('rejects an unauthenticated caller without touching the cloud', async () => {
    (extractIdentity as jest.Mock).mockReturnValue(null);
    const res = await metricsPost(req({ resources: [good] }));
    expect(res.status).toBe(401);
    expect(mockMetrics).not.toHaveBeenCalled();
  });

  it('serves a signed-in caller with valid resources', async () => {
    asUser('metrics-ok');
    const res = await metricsPost(req({ resources: [good] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ n1: { status: 'ok' } });
  });

  it('refuses an Azure resource id that is not a plain ARM resource path (URL / query injection)', async () => {
    asUser('metrics-az');
    const azure = (resourceId: string) => req({ resources: [{ nodeId: 'a', provider: 'azure', resourceId, region: 'eastus' }] });
    const base = `/subscriptions/${SUB}/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm1`;
    expect((await metricsPost(azure(base))).status).toBe(200);
    for (const bad of [`${base}?api-version=x&evil=`, `${base}#frag`, `${base}/../../other`, '/subscriptions/not-a-guid/x', `https://evil.example/${base}`, `${base}%2f..%2f`]) {
      expect((await metricsPost(azure(bad))).status).toBe(400);
    }
    expect(mockMetrics).toHaveBeenCalledTimes(1);
  });

  it('refuses bad providers, regions, duplicate node ids and oversized batches, and does not echo the input', async () => {
    asUser('metrics-bad');
    expect((await metricsPost(req({ resources: [{ ...good, provider: 'gcp' }] }))).status).toBe(400);
    expect((await metricsPost(req({ resources: [{ ...good, region: 'us-east-1"; drop' }] }))).status).toBe(400);
    expect((await metricsPost(req({ resources: [good, good] }))).status).toBe(400);
    expect((await metricsPost(req({ resources: Array.from({ length: 51 }, (_, i) => ({ ...good, nodeId: `n${i}` })) }))).status).toBe(400);
    const res = await metricsPost(req({ resources: [{ ...good, resourceId: 'SECRET-MARKER "quote' }] }));
    expect(JSON.stringify(await res.json())).not.toContain('SECRET-MARKER');
  });

  it('is rate limited per user', async () => {
    asUser('metrics-rl');
    let last = 200;
    for (let i = 0; i < 40; i++) last = (await metricsPost(req({ resources: [] }))).status;
    expect(last).toBe(429);
  });
});
