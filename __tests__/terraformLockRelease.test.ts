jest.mock('fs/promises', () => ({
  mkdtemp: jest.fn().mockImplementation((prefix: string) => Promise.resolve(`${prefix}xyz`)),
  writeFile: jest.fn().mockResolvedValue(undefined),
  rm: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/repositories/cloudAccountRepository', () => ({
  cloudAccountRepository: { getCredentials: jest.fn().mockResolvedValue(JSON.stringify({ tenantId: 't', clientId: 'c', clientSecret: 's', subscriptionId: 'sub' })) },
}));
jest.mock('@/lib/cloud/credentials/resolveExecutionCredentials', () => ({ resolveExecutionCredentials: jest.fn().mockResolvedValue({ ARM_CLIENT_ID: 'c' }) }));
jest.mock('@/lib/terraform/execution/cli', () => ({ runTerraform: jest.fn(), TerraformNotInstalledError: class extends Error {}, pluginCacheDir: () => '/tmp/c' }));

import { decideManualRelease, inspectStateLock, releaseStateLock, MANUAL_RELEASE_MIN_AGE_MS, type LockDeps } from '@/lib/terraform/execution/lockRelease';
import { parseLockInfo } from '@/lib/terraform/execution/stateLockParse';
import { acquireProjectLock, releaseProjectLock } from '@/lib/terraform/execution/projectLock';
import type { TerraformStateBackendConfig } from '@/lib/terraform/execution/types';

const HOST = 'LAPTOP-G4Q1LCQB';
const lockText = (who: string, created = '2026-10-01 11:30:50.6885795 +0000 UTC', id = 'b62dca92-6904-8aff-9c92-38241bd68610') =>
  `terraform plan failed (exit 1): Error: Error acquiring the state lock\nError message: state blob is already locked\nLock Info:\n  ID:        ${id}\n  Path:      tfstate/x.tfstate\n  Operation: OperationTypeApply\n  Who:       ${who}\n  Version:   1.16.4\n  Created:   ${created}\n  Info:      \n`;
const OURS = `${HOST}\\Lenovo@${HOST}`;
const CREATED = Date.parse('2026-10-01T11:30:50Z');
const info = (who = OURS) => parseLockInfo(lockText(who))!;
const ctx = (over = {}) => ({ now: CREATED + 10 * 60_000, host: HOST, processRunning: false, projectBusy: false, ...over });

const backend: TerraformStateBackendConfig = { provider: 'azure', resourceGroupName: 'rg', storageAccountName: 'cloudcraft', containerName: 'tfstate', key: 'k.tfstate' };
const target = (projectId = 'proj-lock-test') => ({ orgId: 'org-1', projectId, cloudAccountId: 'acct-1', stateBackend: backend });

describe('decideManualRelease', () => {
  it('allows a stale lock taken by this machine when nothing is running', () => {
    expect(decideManualRelease(info(), ctx())).toEqual({ allowed: true });
  });
  it.each([
    ['another machine (never, however old)', { }, 'TANMAY\\22tan@Tanmay', /taken by TANMAY\\22tan@Tanmay/],
    ['an apply/teardown running here for the project', { projectBusy: true }, OURS, /running right now for this project/],
    ['a terraform process running on this machine', { processRunning: true }, OURS, /process is running/],
    ['an unknown process state', { processRunning: null }, OURS, /could not check/],
    ['a lock that is too young', { now: CREATED + MANUAL_RELEASE_MIN_AGE_MS - 30_000 }, OURS, /only \d+ seconds old/],
  ])('refuses: %s', (_n, over, who, reason) => {
    const d = decideManualRelease(info(who), ctx({ ...over, now: (over as { now?: number }).now ?? CREATED + 90 * 24 * 3600_000 }));
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toMatch(reason);
  });
  it('refuses a lock with no readable creation time', () => {
    const noTime = parseLockInfo(lockText(OURS).replace(/Created:.*\n/, ''))!;
    expect(decideManualRelease(noTime, ctx()).allowed).toBe(false);
  });
});

describe('inspectStateLock / releaseStateLock', () => {
  const calls: string[][] = [];
  const deps = (planError: string | null, over: Partial<LockDeps> = {}): LockDeps => ({
    run: async (args) => { calls.push(args); if (args[0] === 'plan' && planError) throw new Error(planError); return { stdout: '', stderr: '' }; },
    processRunning: async () => false, now: () => CREATED + 10 * 60_000, host: HOST, ...over,
  });
  beforeEach(() => { calls.length = 0; });
  const ran = (cmd: string) => calls.some((c) => c[0] === cmd);

  it('reports a state that is not locked, and one whose plan fails for another reason, as not locked', async () => {
    expect(await inspectStateLock(target(), deps(null))).toEqual({ locked: false });
    expect(await inspectStateLock(target(), deps('terraform plan failed (exit 1): Error: Provider configuration not present'))).toEqual({ locked: false });
    expect(ran('force-unlock')).toBe(false);
  });

  it('describes our own stale lock and says it can be released — without releasing anything', async () => {
    const r = await inspectStateLock(target(), deps(lockText(OURS)));
    expect(r.locked).toBe(true);
    expect(r.releasable).toBe(true);
    expect(r.lock).toMatchObject({ id: 'b62dca92-6904-8aff-9c92-38241bd68610', who: OURS, operation: 'OperationTypeApply', ageMinutes: 10 });
    expect(ran('force-unlock')).toBe(false);
  });

  it('describes another machine\'s lock and explains why it will not be released', async () => {
    const r = await inspectStateLock(target(), deps(lockText('TANMAY\\22tan@Tanmay')));
    expect(r.releasable).toBe(false);
    expect(r.reason).toMatch(/TANMAY/);
  });

  it('a terraform process running here, or a teardown running for the project, blocks release', async () => {
    expect((await inspectStateLock(target(), deps(lockText(OURS), { processRunning: async () => true }))).releasable).toBe(false);
    expect(acquireProjectLock('proj-busy-lock')).toBe(true);
    try { expect((await inspectStateLock(target('proj-busy-lock'), deps(lockText(OURS)))).releasable).toBe(false); } finally { releaseProjectLock('proj-busy-lock'); }
  });

  it('releases the lock it was asked about, once it has checked again that it is safe', async () => {
    await expect(releaseStateLock({ ...target(), lockId: 'b62dca92-6904-8aff-9c92-38241bd68610' }, deps(lockText(OURS)))).resolves.toEqual({ released: true });
    const unlock = calls.find((c) => c[0] === 'force-unlock')!;
    expect(unlock).toEqual(['force-unlock', '-force', 'b62dca92-6904-8aff-9c92-38241bd68610']);
  });

  it('refuses when a DIFFERENT lock is held now than the one the user looked at', async () => {
    await expect(releaseStateLock({ ...target(), lockId: 'old-lock-id-1234' }, deps(lockText(OURS)))).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/changed since you looked/) });
    expect(ran('force-unlock')).toBe(false);
  });

  it('refuses when the state is not locked any more', async () => {
    await expect(releaseStateLock({ ...target(), lockId: 'b62dca92-6904-8aff-9c92-38241bd68610' }, deps(null))).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/not locked any more/) });
    expect(ran('force-unlock')).toBe(false);
  });

  it('refuses another machine\'s lock even when the id is right', async () => {
    await expect(releaseStateLock({ ...target(), lockId: 'b62dca92-6904-8aff-9c92-38241bd68610' }, deps(lockText('TANMAY\\22tan@Tanmay')))).rejects.toMatchObject({ statusCode: 409 });
    expect(ran('force-unlock')).toBe(false);
  });
});
