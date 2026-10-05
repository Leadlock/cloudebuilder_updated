/**
 * A teardown must work even when the deployment did not finish cleanly: protected resources are unprotected first (AWS refuses to
 * delete them otherwise), and a design that no longer produces a valid configuration falls back to destroying from the state alone.
 */
import { join } from 'path';

const mockFiles = new Map<string, Buffer | string>();
jest.mock('fs/promises', () => ({
  mkdtemp: jest.fn().mockImplementation((prefix: string) => Promise.resolve(`${prefix}${Math.random().toString(36).slice(2, 8)}`)),
  writeFile: jest.fn().mockImplementation((path: string, content: string) => { mockFiles.set(path, content); return Promise.resolve(); }),
  readFile: jest.fn().mockImplementation((path: string) => {
    const c = mockFiles.get(path);
    return c === undefined ? Promise.reject(new Error(`ENOENT: ${path}`)) : Promise.resolve(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  }),
  rm: jest.fn().mockResolvedValue(undefined),
}));

type RunOpts = { cwd: string; onOutput?: (c: string) => void };
const mockRunTerraform = jest.fn();
jest.mock('@/lib/terraform/execution/cli', () => ({
  runTerraform: (...a: unknown[]) => mockRunTerraform(...a),
  TerraformNotInstalledError: class extends Error {},
  pluginCacheDir: () => '/tmp/cache',
}));
const mockGenerate = jest.fn();
jest.mock('@/lib/engines/terraform/TerraformGenerator', () => ({ terraformGenerator: { generate: (...a: unknown[]) => mockGenerate(...a) } }));
jest.mock('@/lib/repositories/cloudAccountRepository', () => ({
  cloudAccountRepository: { getCredentials: jest.fn().mockResolvedValue(JSON.stringify({ roleArn: 'arn:aws:iam::123456789012:role/x', externalId: 'e', region: 'us-east-1' })) },
}));
jest.mock('@/lib/cloud/credentials/resolveExecutionCredentials', () => ({ resolveExecutionCredentials: jest.fn().mockResolvedValue({ AWS_ACCESS_KEY_ID: 'AKIATEST', AWS_SECRET_ACCESS_KEY: 'x' }) }));
jest.mock('@/lib/services/ArchitectureReviewService', () => ({ ArchitectureReviewService: { getLatestReview: jest.fn(), computeArchitectureHash: jest.fn() } }));
jest.mock('@/lib/terraform/execution/audit', () => ({ recordTerraformAudit: jest.fn().mockResolvedValue(undefined) }));

const sends: { name: string; input: Record<string, unknown> }[] = [];
jest.mock('@/lib/terraform/execution/teardownSupport', () => {
  const actual = jest.requireActual('@/lib/terraform/execution/teardownSupport');
  const fake = { send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => { sends.push({ name: c.constructor.name, input: c.input }); return {}; } };
  return { ...actual, protectionClients: () => ({ elb: fake, rds: fake, ddb: fake }) };
});

import { prepareDestroy, startDestroyRun, _setSleepForTests } from '@/lib/terraform/execution/TerraformExecutionService';
import { getRunSnapshot, _clearRunsForTests } from '@/lib/terraform/execution/runRegistry';
import { _clearDestroyPlansForTests } from '@/lib/terraform/execution/destroyPlans';
import type { TerraformStateBackendConfig } from '@/lib/terraform/execution/types';

const backend: TerraformStateBackendConfig = { provider: 'aws', bucket: 'my-tfstate', key: 'proj/prod.tfstate', region: 'eu-north-1' };
const admin = { id: 'user-1', name: 'Admin', email: 'a@example.com', role: 'admin' };
let n = 0;
const input = (projectId = `proj-${++n}`) => ({
  projectId, orgId: 'org-1', environment: 'production', cloudAccountId: 'acct-1', stateBackend: backend, user: admin,
  resources: [{ id: 'r1', resourceType: 'aws_vpc', provider: 'aws', label: 'VPC', positionX: 0, positionY: 0, configJson: '{}', region: 'us-east-1', groupId: null, locked: false, architectureId: 'a' }],
  connections: [], architectureId: 'a', projectName: 'p',
});

type Row = { address: string; type: string; actions: string[]; before?: Record<string, unknown> };
const showJson = (rows: Row[]) => JSON.stringify({ resource_changes: rows.map((r) => ({ address: r.address, type: r.type, change: { actions: r.actions, before: r.before ?? {} } })) });
function scriptTerraform(rows: Row[], overrides: Record<string, (args: string[], o: RunOpts) => unknown> = {}) {
  mockRunTerraform.mockImplementation(async (args: string[], o: RunOpts) => {
    const cmd = args[0] === 'plan' && args.includes('-destroy') ? 'plan-destroy' : args[0]!;
    if (overrides[cmd]) return overrides[cmd]!(args, o);
    if (cmd === 'plan-destroy') mockFiles.set(join(o.cwd, 'tfplan'), 'PLAN');
    if (cmd === 'show') return { stdout: showJson(rows), stderr: '' };
    if (cmd === 'apply') { o.onOutput?.('Destroy complete!\n'); return { stdout: '', stderr: '' }; }
    return { stdout: '', stderr: '' };
  });
}
const waitForRun = async (runId: string) => {
  for (let i = 0; i < 200; i++) { const s = getRunSnapshot(runId, 'org-1'); if (s && s.state !== 'running') return s; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('run did not finish');
};

const FULL = { files: [{ filename: 'main.tf', content: 'resource "aws_vpc" "main" {}' }, { filename: 'terraform.tfvars', content: 'aws_region   = "us-east-1"\n' }], warnings: [], resourceMap: {} };

beforeEach(async () => {
  jest.clearAllMocks(); mockFiles.clear(); sends.length = 0; _clearRunsForTests(); await _clearDestroyPlansForTests();
  _setSleepForTests(async () => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockGenerate.mockReturnValue(FULL);
});

const ALB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/web/abc123';
const PROTECTED: Row[] = [
  { address: 'aws_lb.web', type: 'aws_lb', actions: ['delete'], before: { arn: ALB_ARN, enable_deletion_protection: true } },
  { address: 'aws_db_instance.orders', type: 'aws_db_instance', actions: ['delete'], before: { identifier: 'orders-db', deletion_protection: true } },
  { address: 'aws_dynamodb_table.inv', type: 'aws_dynamodb_table', actions: ['delete'], before: { name: 'my-table', deletion_protection_enabled: true } },
  { address: 'aws_lb.open', type: 'aws_lb', actions: ['delete'], before: { arn: 'arn:x', enable_deletion_protection: false } },
  { address: 'aws_vpc.main', type: 'aws_vpc', actions: ['delete'], before: {} },
];

describe('deletion protection does not block a teardown', () => {
  test('protection is switched off on exactly the protected resources the plan deletes, before terraform destroys', async () => {
    scriptTerraform(PROTECTED);
    const prep = await prepareDestroy(input('proj-prot'));
    const order: string[] = [];
    mockRunTerraform.mockImplementation(async (args: string[], o: RunOpts) => { if (args[0] === 'apply') { order.push(`apply after ${sends.length} protection calls`); o.onOutput?.('ok\n'); } return { stdout: '', stderr: '' }; });
    const { runId } = await startDestroyRun({ planId: prep.planId!, planHash: prep.planHash!, orgId: 'org-1', projectId: 'proj-prot', cloudAccountId: 'acct-1', stateBackend: backend, user: admin });
    const done = await waitForRun(runId);
    expect(done.state).toBe('succeeded');

    expect(sends.map((s) => s.name).sort()).toEqual(['ModifyDBInstanceCommand', 'ModifyLoadBalancerAttributesCommand', 'UpdateTableCommand']);
    expect(sends.find((s) => s.name === 'ModifyLoadBalancerAttributesCommand')!.input).toMatchObject({ LoadBalancerArn: ALB_ARN, Attributes: [{ Key: 'deletion_protection.enabled', Value: 'false' }] });
    expect(sends.find((s) => s.name === 'ModifyDBInstanceCommand')!.input).toMatchObject({ DBInstanceIdentifier: 'orders-db', DeletionProtection: false });
    expect(sends.find((s) => s.name === 'UpdateTableCommand')!.input).toMatchObject({ TableName: 'my-table', DeletionProtectionEnabled: false });
    expect(order).toEqual(['apply after 3 protection calls']);                       // all three first, then the destroy
    expect(done.logTail.join('\n')).toMatch(/3 resource\(s\) have deletion protection on/);
  });

  test('nothing is touched when nothing is protected', async () => {
    scriptTerraform([{ address: 'aws_vpc.main', type: 'aws_vpc', actions: ['delete'], before: {} }]);
    const prep = await prepareDestroy(input('proj-open'));
    await waitForRun((await startDestroyRun({ planId: prep.planId!, planHash: prep.planHash!, orgId: 'org-1', projectId: 'proj-open', cloudAccountId: 'acct-1', stateBackend: backend, user: admin })).runId);
    expect(sends).toEqual([]);
  });
});

describe('teardown still works when the saved design cannot be used', () => {
  const files = () => [...mockFiles.keys()].map((k) => k.replace(/^.*[\\/]/, ''));

  test('a design Terraform rejects: it falls back to a provider-only configuration and plans the destroy from the state', async () => {
    let validates = 0;
    scriptTerraform([{ address: 'aws_vpc.main', type: 'aws_vpc', actions: ['delete'] }], { validate: () => { if (++validates === 1) throw new Error('terraform validate failed (exit 1): Error: Reference to undeclared resource'); return { stdout: '', stderr: '' }; } });
    const log: string[] = [];
    const p = await prepareDestroy(input('proj-fb'), (c) => log.push(c));
    expect(p.resources).toEqual([{ address: 'aws_vpc.main', type: 'aws_vpc' }]);
    expect(log.join('')).toMatch(/cannot be used as it is[\s\S]*work from what Terraform recorded instead/);
    const cmds = mockRunTerraform.mock.calls.map((c) => (c[0] as string[])[0]);
    expect(cmds).toEqual(['init', 'validate', 'init', 'validate', 'plan', 'show']);
    const providerFile = [...mockFiles.entries()].filter(([k]) => k.endsWith('providers.tf')).map(([, v]) => String(v)).pop()!;
    expect(providerFile).toContain('provider "aws"');
    const variables = [...mockFiles.entries()].filter(([k]) => k.endsWith('variables.tf')).map(([, v]) => String(v)).pop()!;
    expect(variables).toContain('default = "us-east-1"');                                  // the deployment region, not the state bucket's
    expect(files().filter((f) => f === 'main.tf')).toHaveLength(1);                         // the generated main.tf was only written for the first attempt
  });

  test('a design that cannot even be generated: same fallback', async () => {
    mockGenerate.mockImplementation(() => { throw new Error('boom'); });
    scriptTerraform([{ address: 'aws_vpc.main', type: 'aws_vpc', actions: ['delete'] }]);
    const p = await prepareDestroy(input('proj-fb2'));
    expect(p.resources).toHaveLength(1);
    expect((mockRunTerraform.mock.calls.map((c) => (c[0] as string[])[0]))).toEqual(['init', 'validate', 'plan', 'show']);
  });

  test('a valid design is used as it always was (no fallback)', async () => {
    scriptTerraform([{ address: 'aws_vpc.main', type: 'aws_vpc', actions: ['delete'] }]);
    await prepareDestroy(input('proj-ok'));
    expect(mockRunTerraform.mock.calls.map((c) => (c[0] as string[])[0])).toEqual(['init', 'validate', 'plan', 'show']);
    expect(files()).toContain('main.tf');
  });

  test('if even the fallback configuration is refused, the teardown stops with Terraform\'s message and destroys nothing', async () => {
    scriptTerraform([], { validate: () => { throw new Error('terraform validate failed (exit 1): Error: nope'); } });
    await expect(prepareDestroy(input('proj-fb3'))).rejects.toThrow(/rejected the generated configuration/);
    expect(mockRunTerraform.mock.calls.some((c) => (c[0] as string[]).includes('-destroy'))).toBe(false);
  });
});
