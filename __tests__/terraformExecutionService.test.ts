/**
 * Tests for real Terraform plan/apply execution
 * (lib/terraform/execution/TerraformExecutionService.ts).
 *
 * The real `terraform` CLI and filesystem are mocked — these tests verify
 * CloudCraft's own orchestration logic: gate enforcement (RBAC, review
 * approval, hash tamper, destroy blocking), plan hash computation and
 * verification, and that a confirmed plan can only be applied once with an
 * exact hash match.
 */

import { join } from 'path';

const mockFiles = new Map<string, Buffer | string>();

jest.mock('fs/promises', () => ({
  mkdtemp: jest.fn().mockImplementation((prefix: string) => Promise.resolve(`${prefix}abc123`)),
  writeFile: jest.fn().mockImplementation((path: string, content: string) => {
    mockFiles.set(path, content);
    return Promise.resolve();
  }),
  readFile: jest.fn().mockImplementation((path: string) => {
    const content = mockFiles.get(path);
    if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
    return Promise.resolve(Buffer.isBuffer(content) ? content : Buffer.from(String(content)));
  }),
  rm: jest.fn().mockResolvedValue(undefined),
}));

const mockRunTerraform = jest.fn();
jest.mock('@/lib/terraform/execution/cli', () => ({
  runTerraform: (...args: unknown[]) => mockRunTerraform(...args),
  TerraformNotInstalledError: class TerraformNotInstalledError extends Error {},
}));

jest.mock('@/lib/engines/terraform/TerraformGenerator', () => ({
  terraformGenerator: {
    generate: jest.fn().mockReturnValue({
      files: [{ filename: 'main.tf', content: 'resource "aws_vpc" "main" {}' }],
      warnings: [],
      resourceMap: {},
    }),
  },
}));

jest.mock('@/lib/repositories/cloudAccountRepository', () => ({
  cloudAccountRepository: {
    getCredentials: jest.fn().mockResolvedValue(
      JSON.stringify({ roleArn: 'arn:aws:iam::123456789012:role/x', externalId: 'ext', region: 'us-east-1' }),
    ),
  },
}));

jest.mock('@/lib/cloud/credentials/resolveExecutionCredentials', () => ({
  resolveExecutionCredentials: jest.fn().mockResolvedValue({
    AWS_ACCESS_KEY_ID: 'ASIATEST', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'token', AWS_DEFAULT_REGION: 'us-east-1',
  }),
}));

jest.mock('@/lib/services/ArchitectureReviewService', () => ({
  ArchitectureReviewService: {
    getLatestReview: jest.fn(),
    computeArchitectureHash: jest.fn(),
  },
}));

import { ArchitectureReviewService } from '@/lib/services/ArchitectureReviewService';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import {
  generatePlan, verifyPlanForApply, runApply, PlanBlockedError,
} from '@/lib/terraform/execution/TerraformExecutionService';
import { getPlan, savePlan } from '@/lib/terraform/execution/planStore';
import type { TerraformStateBackendConfig } from '@/lib/terraform/execution/types';

function planJsonOutput(actions: string[][]) {
  return JSON.stringify({
    resource_changes: actions.map((a, i) => ({
      address: `aws_vpc.main${i}`,
      type: 'aws_vpc',
      change: { actions: a },
    })),
  });
}

const awsBackend: TerraformStateBackendConfig = { provider: 'aws', bucket: 'my-tfstate', key: 'proj/prod.tfstate', region: 'us-east-1' };
const adminUser = { id: 'user-1', name: 'Admin', email: 'admin@example.com', role: 'admin' };

const baseInput = {
  projectId: 'proj-1',
  orgId: 'org-1',
  environment: 'production',
  cloudAccountId: 'acct-1',
  stateBackend: awsBackend,
  user: adminUser,
  resources: [{
    id: 'r1', resourceType: 'aws_vpc', provider: 'aws', label: 'VPC', positionX: 0, positionY: 0,
    configJson: '{}', region: 'us-east-1', groupId: null, locked: false, architectureId: 'arch-1',
  }],
  connections: [],
  architectureId: 'arch-1',
  projectName: 'test-proj',
};

describe('TerraformExecutionService.generatePlan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFiles.clear();
    (ArchitectureReviewService.getLatestReview as jest.Mock).mockReturnValue({
      id: 'review-1', status: 'approved', architectureHash: 'matching-hash',
    });
    (ArchitectureReviewService.computeArchitectureHash as jest.Mock).mockReturnValue('matching-hash');
    (cloudAccountRepository.getCredentials as jest.Mock).mockResolvedValue(
      JSON.stringify({ roleArn: 'arn:aws:iam::123456789012:role/x', externalId: 'ext', region: 'us-east-1' }),
    );
    mockRunTerraform.mockImplementation((args: string[], options: { cwd: string }) => {
      if (args[0] === 'show') return Promise.resolve({ stdout: planJsonOutput([['create']]), stderr: '' });
      if (args[0] === 'plan') mockFiles.set(join(options.cwd, 'tfplan'), Buffer.from('fake-tfplan-binary'));
      return Promise.resolve({ stdout: '', stderr: '' });
    });
  });

  test('refuses a non-admin user', async () => {
    await expect(generatePlan({ ...baseInput, user: { ...adminUser, role: 'member' } }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  test('refuses when there is no approved review', async () => {
    (ArchitectureReviewService.getLatestReview as jest.Mock).mockReturnValue(null);
    await expect(generatePlan(baseInput)).rejects.toMatchObject({ statusCode: 400 });
  });

  test('refuses when the approved review was invalidated by later changes', async () => {
    (ArchitectureReviewService.getLatestReview as jest.Mock).mockReturnValue({
      id: 'review-1', status: 'invalidated_due_to_changes', architectureHash: 'matching-hash',
    });
    await expect(generatePlan(baseInput)).rejects.toMatchObject({ statusCode: 400 });
  });

  test('refuses when the current architecture hash does not match the approved hash', async () => {
    (ArchitectureReviewService.computeArchitectureHash as jest.Mock).mockReturnValue('different-hash');
    await expect(generatePlan(baseInput)).rejects.toMatchObject({ statusCode: 409 });
  });

  test('blocks and never stores a plan that contains a destroy action', async () => {
    mockRunTerraform.mockImplementation((args: string[]) => {
      if (args[0] === 'show') return Promise.resolve({ stdout: planJsonOutput([['create'], ['delete']]), stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    await expect(generatePlan(baseInput)).rejects.toBeInstanceOf(PlanBlockedError);
  });

  test('generates and stores a plan with a stable sha256 hash of the plan file bytes', async () => {
    const record = await generatePlan(baseInput);
    expect(record.summary.toAdd).toBe(1);
    expect(record.summary.toDestroy).toBe(0);
    expect(record.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(getPlan(record.planId)).not.toBeNull();
  });

  test('runs init before plan, and plan before show', async () => {
    await generatePlan(baseInput);
    const calls = mockRunTerraform.mock.calls.map((c) => (c[0] as string[])[0]);
    expect(calls.indexOf('init')).toBeLessThan(calls.indexOf('plan'));
    expect(calls.indexOf('plan')).toBeLessThan(calls.indexOf('show'));
  });
});

describe('TerraformExecutionService.verifyPlanForApply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('throws 404 when the plan does not exist', () => {
    expect(() => verifyPlanForApply('nonexistent', 'somehash')).toThrow(/not found|expired/i);
  });

  test('throws 409 when the supplied hash does not match the stored plan', () => {
    savePlan({
      planId: 'plan-1', planHash: 'real-hash', projectId: 'proj-1', orgId: 'org-1', environment: 'production',
      cloudAccountId: 'acct-1', provider: 'aws', workDir: '/tmp/x', summary: { toAdd: 1, toChange: 0, toDestroy: 0, resourceChanges: [] },
      createdBy: adminUser, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(() => verifyPlanForApply('plan-1', 'wrong-hash')).toThrow(/mismatch/i);
  });

  test('accepts a plan whose hash matches exactly', () => {
    savePlan({
      planId: 'plan-2', planHash: 'real-hash-2', projectId: 'proj-1', orgId: 'org-1', environment: 'production',
      cloudAccountId: 'acct-1', provider: 'aws', workDir: '/tmp/x', summary: { toAdd: 1, toChange: 0, toDestroy: 0, resourceChanges: [] },
      createdBy: adminUser, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const record = verifyPlanForApply('plan-2', 'real-hash-2');
    expect(record.planId).toBe('plan-2');
  });
});

describe('TerraformExecutionService.runApply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunTerraform.mockResolvedValue({ stdout: 'Apply complete! Resources: 1 added, 0 changed, 0 destroyed.', stderr: '' });
  });

  test('runs apply against the saved plan file and reports the resource counts from the stored summary', async () => {
    savePlan({
      planId: 'plan-3', planHash: 'h3', projectId: 'proj-1', orgId: 'org-1', environment: 'production',
      cloudAccountId: 'acct-1', provider: 'aws', workDir: '/tmp/plan3', summary: { toAdd: 2, toChange: 1, toDestroy: 0, resourceChanges: [] },
      createdBy: adminUser, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await runApply('plan-3', 'org-1');
    expect(result.message).toContain('2 new and 1 changed');
    expect(mockRunTerraform).toHaveBeenCalledWith(
      ['apply', '-input=false', '-no-color', 'tfplan'],
      expect.objectContaining({ cwd: '/tmp/plan3' }),
    );
    // Applying is single-use — the plan is gone afterwards.
    expect(getPlan('plan-3')).toBeNull();
  });

  test('throws when the plan is missing (expired or server restarted before apply ran)', async () => {
    await expect(runApply('never-existed', 'org-1')).rejects.toThrow(/not found|expired/i);
  });
});
