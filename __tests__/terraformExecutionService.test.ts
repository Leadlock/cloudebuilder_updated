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

jest.mock('@/lib/terraform/execution/audit', () => ({ recordTerraformAudit: jest.fn().mockResolvedValue(undefined) }));

jest.mock('@/lib/services/ArchitectureReviewService', () => ({
  ArchitectureReviewService: {
    getLatestReview: jest.fn(),
    computeArchitectureHash: jest.fn(),
    // No super administrator is set in these tests, so an approved review counts, as it always did.
    approvalIsValid: (r: { status?: string } | null) => r?.status === 'approved',
    approvalBlockedMessage: (r: { status?: string } | null) => (r?.status === 'invalidated_due_to_changes' ? 'Plan blocked: Architecture was modified after approval and approval was invalidated.' : 'Plan blocked: Architecture must be formally approved before a Terraform plan can be generated.'),
  },
}));

import { ArchitectureReviewService } from '@/lib/services/ArchitectureReviewService';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import {
  generatePlan, verifyPlanForApply, runApply, planBundle, PlanBlockedError,
} from '@/lib/terraform/execution/TerraformExecutionService';
import { terraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
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

  describe('deploying only some resources', () => {
    const generated = { files: [{ filename: 'main.tf', content: 'resource "aws_vpc" "main" {}\nresource "aws_flow_log" "main_flow_log" {}' }], warnings: [], resourceMap: { r1: 'aws_vpc.main' } };
    const planArgs = () => (mockRunTerraform.mock.calls.map((c) => c[0] as string[]).find((a) => a[0] === 'plan') ?? []);

    test('gives terraform -target for the resource and the parts named after it, and records them', async () => {
      (terraformGenerator.generate as jest.Mock).mockReturnValueOnce(generated);
      const record = await generatePlan({ ...baseInput, targetNodeIds: ['r1'] });
      expect(planArgs()).toEqual(expect.arrayContaining(['-target=aws_flow_log.main_flow_log', '-target=aws_vpc.main']));
      expect(record.summary.targets).toEqual(['aws_flow_log.main_flow_log', 'aws_vpc.main']);
    });

    test('without a selection there is no -target and nothing is recorded', async () => {
      const record = await generatePlan(baseInput);
      expect(planArgs().some((a) => a.startsWith('-target'))).toBe(false);
      expect(record.summary.targets).toBeUndefined();
    });

    test('a resource that creates nothing stops the plan before terraform runs', async () => {
      (terraformGenerator.generate as jest.Mock).mockReturnValueOnce(generated);
      await expect(generatePlan({ ...baseInput, targetNodeIds: ['missing'] })).rejects.toMatchObject({ statusCode: 400 });
      expect(mockRunTerraform).not.toHaveBeenCalled();
    });

    test('the review, admin and destroy rules still apply to a targeted plan', async () => {
      (terraformGenerator.generate as jest.Mock).mockReturnValueOnce(generated);
      await expect(generatePlan({ ...baseInput, targetNodeIds: ['r1'], user: { ...adminUser, role: 'member' } })).rejects.toMatchObject({ statusCode: 403 });
      (ArchitectureReviewService.computeArchitectureHash as jest.Mock).mockReturnValue('different-hash');
      await expect(generatePlan({ ...baseInput, targetNodeIds: ['r1'] })).rejects.toMatchObject({ statusCode: 409 });
      (ArchitectureReviewService.computeArchitectureHash as jest.Mock).mockReturnValue('matching-hash');
      mockRunTerraform.mockImplementation((args: string[]) => Promise.resolve({ stdout: args[0] === 'show' ? planJsonOutput([['create'], ['delete']]) : '', stderr: '' }));
      await expect(generatePlan({ ...baseInput, targetNodeIds: ['r1'] })).rejects.toBeInstanceOf(PlanBlockedError);
    });
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

describe('TerraformExecutionService.planBundle (the Terraform of a project release)', () => {
  const azureCreds = JSON.stringify({ tenantId: 't', clientId: 'c', clientSecret: 's', subscriptionId: 'sub' });
  const azureBackend: TerraformStateBackendConfig = { provider: 'azure', resourceGroupName: 'rg', storageAccountName: 'sa', containerName: 'tfstate', key: 'k.tfstate' };
  const input = {
    projectId: 'proj-1', orgId: 'org-1', environment: 'production', cloudAccountId: 'acct-1', stateBackend: azureBackend, provider: 'azure' as const,
    user: adminUser, files: [{ filename: 'main.tf', content: 'resource "azurerm_resource_group" "app" {}' }, { filename: 'cloud-init.sh', content: '#!/bin/bash\n' }], notes: ['a note'],
    extraEnv: { TF_VAR_admin_ssh_public_key: 'ssh-ed25519 AAAA' },
  };
  beforeEach(() => {
    jest.clearAllMocks();
    mockFiles.clear();
    (cloudAccountRepository.getCredentials as jest.Mock).mockResolvedValue(azureCreds);
    mockRunTerraform.mockImplementation((args: string[], options: { cwd: string }) => {
      if (args[0] === 'show') return Promise.resolve({ stdout: planJsonOutput([['create']]), stderr: '' });
      if (args[0] === 'plan') mockFiles.set(join(options.cwd, 'tfplan'), Buffer.from('fake-tfplan-binary'));
      return Promise.resolve({ stdout: '', stderr: '' });
    });
  });

  test('plans the files it is given with the state backend added, and stores the plan with the notes', async () => {
    const record = await planBundle(input);
    expect(record.provider).toBe('azure');
    expect(record.summary.toAdd).toBe(1);
    expect(record.summary.notes).toEqual(['a note']);
    expect(getPlan(record.planId)).not.toBeNull();
    const written = [...mockFiles.keys()].map((k) => k.split('/').pop());
    expect(written).toEqual(expect.arrayContaining(['main.tf', 'cloud-init.sh', 'backend.tf']));
    expect(String(mockFiles.get([...mockFiles.keys()].find((k) => k.endsWith('backend.tf'))!))).toContain('azurerm');
    const calls = mockRunTerraform.mock.calls.map((c) => (c[0] as string[])[0]);
    expect(calls.indexOf('init')).toBeLessThan(calls.indexOf('plan'));
  });

  test('the extra environment reaches Terraform, next to the account\'s credentials', async () => {
    await planBundle(input);
    const planCall = mockRunTerraform.mock.calls.find((c) => (c[0] as string[])[0] === 'plan')!;
    expect((planCall[1] as { env: Record<string, string> }).env['TF_VAR_admin_ssh_public_key']).toBe('ssh-ed25519 AAAA');
  });

  test('a plan that destroys anything is refused, as for any plan', async () => {
    mockRunTerraform.mockImplementation((args: string[]) => Promise.resolve({ stdout: args[0] === 'show' ? planJsonOutput([['create'], ['delete']]) : '', stderr: '' }));
    await expect(planBundle(input)).rejects.toBeInstanceOf(PlanBlockedError);
  });

  test('administrators only, a remote state backend of the same cloud, and an account of the same cloud', async () => {
    await expect(planBundle({ ...input, user: { ...adminUser, role: 'member' } })).rejects.toMatchObject({ statusCode: 403 });
    await expect(planBundle({ ...input, stateBackend: awsBackend })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('state backend is for aws') });
    (cloudAccountRepository.getCredentials as jest.Mock).mockResolvedValue(JSON.stringify({ roleArn: 'arn:aws:iam::123456789012:role/x', externalId: 'e', region: 'us-east-1' }));
    await expect(planBundle(input)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('connected account is aws') });
    (cloudAccountRepository.getCredentials as jest.Mock).mockResolvedValue(null);
    await expect(planBundle(input)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockRunTerraform).not.toHaveBeenCalled();
  });

  test.each(['../evil.tf', 'a/b.tf', 'backend.tf', '.hidden.tf', 'x y.tf', ''])('the file name %j is refused, so nothing can be written outside the folder or replace the state backend', async (filename) => {
    await expect(planBundle({ ...input, files: [{ filename, content: 'x' }] })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockRunTerraform).not.toHaveBeenCalled();
  });

  test('a plan that cannot be made leaves no folder behind', async () => {
    const fsp = jest.requireMock('fs/promises') as { rm: jest.Mock };
    mockRunTerraform.mockRejectedValueOnce(new Error('terraform init failed'));
    await expect(planBundle(input)).rejects.toThrow(/init failed/);
    expect(fsp.rm).toHaveBeenCalled();
  });

  test('runApply reads the outputs through the hook while the folder still exists, and only after a successful apply', async () => {
    const record = await planBundle(input);
    mockRunTerraform.mockClear();
    const seen: string[] = [];
    await runApply(record.planId, 'org-1', undefined, async ({ workDir }) => { seen.push(workDir); });
    expect(seen).toEqual([record.workDir]);
    const record2 = await planBundle(input);
    mockRunTerraform.mockRejectedValueOnce(new Error('apply failed'));
    const hook = jest.fn();
    await expect(runApply(record2.planId, 'org-1', undefined, hook)).rejects.toThrow(/apply failed/);
    expect(hook).not.toHaveBeenCalled();
  });
});
