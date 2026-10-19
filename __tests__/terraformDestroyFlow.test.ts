/**
 * Teardown orchestration: PREVIEW with a real `plan -destroy`, then RUN exactly that saved plan in the background.
 * The terraform CLI and the filesystem are mocked; CloudBuilder's own logic is what is tested.
 */
import { join } from 'path';

const mockFiles = new Map<string, Buffer | string>();
const mockRm = jest.fn().mockResolvedValue(undefined);
jest.mock('fs/promises', () => ({
  mkdtemp: jest.fn().mockImplementation((prefix: string) => Promise.resolve(`${prefix}${Math.random().toString(36).slice(2, 8)}`)),
  writeFile: jest.fn().mockImplementation((path: string, content: string) => { mockFiles.set(path, content); return Promise.resolve(); }),
  readFile: jest.fn().mockImplementation((path: string) => {
    const c = mockFiles.get(path);
    return c === undefined ? Promise.reject(new Error(`ENOENT: ${path}`)) : Promise.resolve(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  }),
  rm: (...a: unknown[]) => mockRm(...a),
}));

type RunOpts = { cwd: string; onOutput?: (c: string) => void };
const mockRunTerraform = jest.fn();
jest.mock('@/lib/terraform/execution/cli', () => ({
  runTerraform: (...a: unknown[]) => mockRunTerraform(...a),
  TerraformNotInstalledError: class extends Error {},
  pluginCacheDir: () => '/tmp/cache',
}));
jest.mock('@/lib/engines/terraform/TerraformGenerator', () => ({
  terraformGenerator: { generate: jest.fn().mockReturnValue({ files: [{ filename: 'main.tf', content: 'resource "aws_vpc" "main" {}' }], warnings: [], resourceMap: {} }) },
}));
jest.mock('@/lib/repositories/cloudAccountRepository', () => ({
  cloudAccountRepository: { getCredentials: jest.fn().mockResolvedValue(JSON.stringify({ roleArn: 'arn:aws:iam::123456789012:role/x', externalId: 'e', region: 'us-east-1' })) },
}));
jest.mock('@/lib/cloud/credentials/resolveExecutionCredentials', () => ({ resolveExecutionCredentials: jest.fn().mockResolvedValue({ AWS_ACCESS_KEY_ID: 'AKIATEST' }) }));
jest.mock('@/lib/services/ArchitectureReviewService', () => ({ ArchitectureReviewService: { getLatestReview: jest.fn(), computeArchitectureHash: jest.fn() } }));
const mockAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/terraform/execution/audit', () => ({ recordTerraformAudit: (...a: unknown[]) => mockAudit(...a) }));

import { prepareDestroy, startDestroyRun, _setSleepForTests } from '@/lib/terraform/execution/TerraformExecutionService';
import { acquireProjectLock, isProjectLocked, releaseProjectLock } from '@/lib/terraform/execution/projectLock';
import { getRunSnapshot, _clearRunsForTests } from '@/lib/terraform/execution/runRegistry';
import { peekPreparedDestroy, _clearDestroyPlansForTests } from '@/lib/terraform/execution/destroyPlans';
import type { TerraformStateBackendConfig } from '@/lib/terraform/execution/types';

const backend: TerraformStateBackendConfig = { provider: 'aws', bucket: 'my-tfstate', key: 'proj/prod.tfstate', region: 'us-east-1' };
const admin = { id: 'user-1', name: 'Admin', email: 'a@example.com', role: 'admin' };
let n = 0;
const input = (projectId = `proj-${++n}`) => ({
  projectId, orgId: 'org-1', environment: 'production', cloudAccountId: 'acct-1', stateBackend: backend, user: admin,
  resources: [{ id: 'r1', resourceType: 'aws_vpc', provider: 'aws', label: 'VPC', positionX: 0, positionY: 0, configJson: '{}', region: 'us-east-1', groupId: null, locked: false, architectureId: 'a' }],
  connections: [], architectureId: 'a', projectName: 'p',
});
const showJson = (rows: { address: string; type: string; actions: string[]; mode?: string }[]) => JSON.stringify({ resource_changes: rows.map((r) => ({ address: r.address, type: r.type, mode: r.mode, change: { actions: r.actions } })) });

/** A scripted terraform: each command can be overridden by a test. */
function scriptTerraform(overrides: Record<string, (args: string[], o: RunOpts) => unknown> = {}, rows: { address: string; type: string; actions: string[]; mode?: string }[] = [{ address: 'aws_vpc.main', type: 'aws_vpc', actions: ['delete'] }, { address: 'aws_subnet.a', type: 'aws_subnet', actions: ['delete'] }]) {
  mockRunTerraform.mockImplementation(async (args: string[], o: RunOpts) => {
    const cmd = args[0] === 'plan' && args.includes('-destroy') ? 'plan-destroy' : args[0]!;
    if (overrides[cmd]) return overrides[cmd]!(args, o);
    if (cmd === 'plan-destroy') mockFiles.set(join(o.cwd, 'tfplan'), `PLAN-${rows.length}`);
    if (cmd === 'show') return { stdout: showJson(rows), stderr: '' };
    if (cmd === 'apply') { o.onOutput?.('aws_vpc.main: Destroying...\naws_vpc.main: Destruction complete\n'); return { stdout: 'Destroy complete! Resources: 2 destroyed.', stderr: '' }; }
    return { stdout: '', stderr: '' };
  });
}
const waitForRun = async (runId: string) => {
  for (let i = 0; i < 200; i++) { const s = getRunSnapshot(runId, 'org-1'); if (s && s.state !== 'running') return s; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('run did not finish');
};

beforeEach(async () => {
  jest.clearAllMocks(); mockFiles.clear(); _clearRunsForTests(); await _clearDestroyPlansForTests();
  _setSleepForTests(async () => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('prepareDestroy — a real plan -destroy', () => {
  it('initialises, validates, plans the destroy, and lists exactly what is in the state', async () => {
    scriptTerraform();
    const p = await prepareDestroy(input());
    expect(p.resources).toEqual([{ address: 'aws_vpc.main', type: 'aws_vpc' }, { address: 'aws_subnet.a', type: 'aws_subnet' }]);
    expect(p.planId).toBeTruthy(); expect(p.planHash).toMatch(/^[0-9a-f]{64}$/);
    const cmds = mockRunTerraform.mock.calls.map((c) => (c[0] as string[]).slice(0, 2).join(' '));
    expect(cmds).toEqual(['init -input=false', 'validate -no-color', 'plan -destroy', 'show -json']);
    expect(peekPreparedDestroy(p.planId!)).not.toBeNull();         // kept so the confirmation can run exactly it
  });

  it('lists only managed resources that would be deleted (not reads, not unchanged, not data sources)', async () => {
    scriptTerraform({}, [
      { address: 'aws_vpc.main', type: 'aws_vpc', actions: ['delete'] },
      { address: 'aws_vpc.other', type: 'aws_vpc', actions: ['no-op'] },
      { address: 'data.aws_vpc.x', type: 'aws_vpc', actions: ['delete'], mode: 'data' },
    ]);
    const p = await prepareDestroy(input());
    expect(p.resources.map((r) => r.address)).toEqual(['aws_vpc.main']);
  });

  it('says so, and cleans up, when the state holds nothing to destroy', async () => {
    scriptTerraform({}, []);
    const p = await prepareDestroy(input());
    expect(p).toEqual({ planId: null, planHash: null, resources: [] });
    expect(mockRm).toHaveBeenCalled();
  });

  it('stops at validate when Terraform rejects the generated files — it never plans or touches the cloud', async () => {
    scriptTerraform({ validate: () => { throw new Error('terraform validate failed (exit 1): Error: Reference to undeclared resource'); } });
    await expect(prepareDestroy(input())).rejects.toThrow(/rejected the generated configuration \(nothing was changed\)/);
    expect(mockRunTerraform.mock.calls.some((c) => (c[0] as string[]).includes('-destroy'))).toBe(false);
    expect(mockRm).toHaveBeenCalled();
  });

  it('a lock held by another machine is explained, and never force-unlocked', async () => {
    const LOCK = 'terraform plan failed (exit 1): Error: Error acquiring the state lock\nLock Info:\n  ID:        abc-123\n  Path:      x\n  Operation: OperationTypeApply\n  Who:       TANMAY\\22tan@Tanmay\n  Version:   1.9.8\n  Created:   2026-10-01 08:44:17.5 +0000 UTC\n  Info:      \n';
    scriptTerraform({ 'plan-destroy': () => { throw new Error(LOCK); } });
    await expect(prepareDestroy(input())).rejects.toThrow(/locked by TANMAY\\22tan@Tanmay/);
    expect(mockRunTerraform.mock.calls.some((c) => (c[0] as string[])[0] === 'force-unlock')).toBe(false);
  });

  it('only administrators may prepare a teardown', async () => {
    scriptTerraform();
    await expect(prepareDestroy({ ...input(), user: { ...admin, role: 'user' } })).rejects.toMatchObject({ statusCode: 403 });
    expect(mockRunTerraform).not.toHaveBeenCalled();
  });
});

describe('startDestroyRun — runs exactly the previewed plan, in the background', () => {
  const prepared = async (projectId: string) => { scriptTerraform(); const p = await prepareDestroy(input(projectId)); return { ...p, projectId } as { planId: string; planHash: string; projectId: string; resources: unknown[] }; };
  const start = (p: { planId: string; planHash: string; projectId: string }, over = {}) =>
    startDestroyRun({ planId: p.planId, planHash: p.planHash, orgId: 'org-1', projectId: p.projectId, cloudAccountId: 'acct-1', stateBackend: backend, user: admin, ...over });

  it('returns a run id at once, streams the output, applies the SAVED plan, and cleans up', async () => {
    const p = await prepared('proj-run-ok');
    const { runId } = await start(p);
    expect(typeof runId).toBe('string');
    const done = await waitForRun(runId);
    expect(done.state).toBe('succeeded');
    expect(done.logTail.join('\n')).toContain('aws_vpc.main: Destruction complete');
    expect(done.logTail.join('\n')).toMatch(/Destroying 2 resource\(s\) from the plan you reviewed/);
    const apply = mockRunTerraform.mock.calls.find((c) => (c[0] as string[])[0] === 'apply')!;
    expect(apply[0]).toEqual(['apply', '-input=false', '-no-color', 'tfplan']);        // the saved plan, not "destroy -auto-approve"
    expect(typeof (apply[1] as RunOpts).onOutput).toBe('function');
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'destroy', outcome: 'succeeded' }));
    expect(isProjectLocked('proj-run-ok')).toBe(false);
    expect(peekPreparedDestroy(p.planId)).toBeNull();                                    // single use
    expect(mockRm).toHaveBeenCalled();                                                   // working folder removed
  });

  it('a prepared plan can be run only once', async () => {
    const p = await prepared('proj-once');
    await waitForRun((await start(p)).runId);
    await expect(start(p)).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each([
    ['a different plan hash', { planHash: 'f'.repeat(64) }],
    ['a different organisation', { orgId: 'org-2' }],
    ['a different project', { projectId: 'proj-else' }],
    ['a different user', { user: { ...admin, id: 'user-2' } }],
  ])('refuses %s', async (_n, over) => {
    const p = await prepared('proj-mismatch');
    await expect(start(p, over)).rejects.toMatchObject({ statusCode: 409 });
    expect(peekPreparedDestroy(p.planId)).not.toBeNull();                                // a refused attempt does not use it up
  });

  it('one teardown or apply at a time per project — and a refused start does not consume the plan', async () => {
    const p = await prepared('proj-busy');
    expect(acquireProjectLock('proj-busy')).toBe(true);
    try {
      await expect(start(p)).rejects.toMatchObject({ statusCode: 409 });
      expect(peekPreparedDestroy(p.planId)).not.toBeNull();
    } finally { releaseProjectLock('proj-busy'); }
  });

  it('reports a failure with Terraform\'s error, audits it, and still releases the project', async () => {
    const p = await prepared('proj-fail');
    scriptTerraform({ apply: () => { throw new Error('terraform apply failed (exit 1): Error: deleting Resource Group "rg": still contains Resources'); } });
    const done = await waitForRun((await start(p)).runId);
    expect(done.state).toBe('failed');
    expect(done.error).toMatch(/still contains Resources/);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
    expect(isProjectLocked('proj-fail')).toBe(false);
  });

  it('waits and re-plans when a dependent resource is still shutting down, then succeeds', async () => {
    const p = await prepared('proj-transient');
    const planDestroys = () => mockRunTerraform.mock.calls.filter((c) => (c[0] as string[]).includes('-destroy')).length;
    const before = planDestroys();
    let applies = 0; const sleeps: number[] = [];
    _setSleepForTests(async (ms) => { sleeps.push(ms); });
    scriptTerraform({
      apply: (_a, o) => { applies++; if (applies === 1) throw new Error('terraform apply failed (exit 1): Error: DependencyViolation: network interface in use'); o.onOutput?.('done\n'); return { stdout: 'ok', stderr: '' }; },
    });
    const done = await waitForRun((await start(p)).runId);
    expect(done.state).toBe('succeeded');
    expect(applies).toBe(2);
    expect(sleeps).toEqual([20000]);
    expect(done.logTail.join('\n')).toMatch(/still shutting down/);
    expect(planDestroys() - before).toBe(1);                                                                      // re-planned once
  });

  it('never force-unlocks a lock held by someone else during a teardown', async () => {
    const p = await prepared('proj-lock');
    scriptTerraform({ apply: () => { throw new Error('terraform apply failed (exit 1): Error: Error acquiring the state lock\nLock Info:\n  ID:        zzz-1\n  Who:       TANMAY\\22tan@Tanmay\n  Created:   2026-10-01 08:44:17 +0000 UTC\n'); } });
    const done = await waitForRun((await start(p)).runId);
    expect(done.state).toBe('failed');
    expect(done.error).toMatch(/locked by TANMAY/);
    expect(mockRunTerraform.mock.calls.some((c) => (c[0] as string[])[0] === 'force-unlock')).toBe(false);
  });
});
