/**
 * The release state machine: steps in order, waiting for secrets, retrying, rolling back, cancelling and the kill switch, with a fake Azure.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { defaultProject, LAYERS, type Layer, type StackProject } from '@/lib/engines/containers/stackProject';
import { buildAzureVmBundle } from '@/lib/deploy/project/bundle';
import { InMemoryReleaseStore } from '@/lib/deploy/project/releaseStore';
import { approveRelease, cancelRelease, newRelease, provideSecrets, ReleaseError, runRelease, writeComposeScript, type InfraRunner, type OrchestratorDeps } from '@/lib/deploy/project/orchestrator';
import type { AzureOps } from '@/lib/deploy/project/azureOps';
import type { Release, ReleaseOutputs } from '@/lib/deploy/project/types';

const OUT: ReleaseOutputs = { resourceGroup: 'rg-shop', vmName: 'vm-shop', acrName: 'acrshop', vaultName: 'kvshop', url: 'http://203.0.113.9:8080/' };

function project(on: Layer[] = ['frontend', 'backend', 'api', 'database'], tag = 'v1'): StackProject {
  const p = defaultProject();
  p.name = 'shop';
  for (const l of LAYERS) p.layers[l].enabled = on.includes(l);
  p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }];
  p.deploy.target = 'azure-vm';
  p.deploy.azvm.imageTag = tag;
  return p;
}

class FakeOps implements AzureOps {
  calls: string[] = [];
  vault = new Set<string>();
  failOn: Array<(c: string) => boolean> = [];
  up = true;
  private maybeFail(call: string) { this.calls.push(call); if (this.failOn.some((f) => f(call))) throw new Error(`fake failure in ${call.split(' ')[0]}`); }
  async secretExists(_v: string, name: string) { return this.vault.has(name); }
  async putSecret(vault: string, name: string, _value: string) { this.maybeFail(`putSecret ${vault} ${name}`); this.vault.add(name); }
  async acrBuild(a: { registry: string; image: string; source: Buffer }) { this.maybeFail(`acrBuild ${a.registry} ${a.image} ${a.source.length > 20 ? 'archive' : 'empty'}`); }
  async setVmTag(rg: string, vm: string, key: string, value: string) { this.maybeFail(`setVmTag ${rg} ${vm} ${key}=${value}`); }
  async runShell(_rg: string, _vm: string, script: string) { this.maybeFail(`runShell ${script.startsWith('mkdir') ? 'compose' : script}`); return ''; }
  async httpOk(url: string) { this.calls.push(`httpOk ${url}`); return this.up; }
}

function setup(over: { ops?: FakeOps; infraCalls?: { n: number }; killSwitch?: () => boolean } = {}) {
  const store = new InMemoryReleaseStore();
  const ops = over.ops ?? new FakeOps();
  const infraCalls = over.infraCalls ?? { n: 0 };
  const infra: InfraRunner = { async apply() { infraCalls.n++; return OUT; } };
  const logs: string[] = [];
  const deps: OrchestratorDeps = { store, ops, infra, killSwitch: over.killSwitch, now: () => 1000, sleep: async () => undefined, log: (_id, l) => logs.push(l), verifyWaitMs: 50, verifyEveryMs: 1 };
  return { store, ops, deps, logs, infraCalls };
}

async function plan(store: InMemoryReleaseStore, p = project(), id = 'r1', previousReleaseId: string | null = null): Promise<Release> {
  const bundle = buildAzureVmBundle(p);
  const r = newRelease({ id, orgId: 'org', projectId: 'p1', environment: 'production', cloudAccountId: 'acct-1', project: p, bundle, createdBy: 'u1', previousReleaseId, planId: 'plan-1', planHash: 'hash-1', now: 1 });
  await store.save(r);
  await approveRelease(store, id, { bundleHash: bundle.bundleHash, planHash: 'hash-1' }, 2);
  return (await store.get(id))!;
}

describe('a release that goes through', () => {
  test('runs the steps in order, builds every built service in the registry, publishes and starts, and checks the address', async () => {
    const { store, ops, deps, infraCalls } = setup();
    await plan(store);
    ops.vault.add('JWT-SECRET'); ops.vault.add('POSTGRES-PASSWORD');
    const r = await runRelease(deps, 'r1');
    expect(r.status).toBe('succeeded');
    expect(r.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(infraCalls.n).toBe(1);
    expect(ops.calls.filter((c) => c.startsWith('acrBuild'))).toEqual([
      'acrBuild acrshop shop-frontend:v1 archive', 'acrBuild acrshop shop-backend:v1 archive', 'acrBuild acrshop shop-api:v1 archive',
    ]);
    const order = (re: RegExp) => ops.calls.findIndex((c) => re.test(c));
    expect(order(/acrBuild/)).toBeLessThan(order(/setVmTag/));
    expect(order(/setVmTag/)).toBeLessThan(order(/runShell compose/));
    expect(order(/runShell compose/)).toBeLessThan(order(/systemctl restart shop\.service/));
    expect(order(/systemctl restart/)).toBeLessThan(order(/httpOk/));
    expect(ops.calls).toContain('setVmTag rg-shop vm-shop image_tag=v1');
    expect(r.outputs).toEqual(OUT);
  });

  test('a project with nothing built skips the build step', async () => {
    const { store, ops, deps } = setup();
    const p = project(['frontend', 'api'], 'v1');
    for (const l of ['frontend', 'api'] as const) p.layers[l].config = { ...p.layers[l].config, image: 'nginx:1.27' };
    await plan(store, p);
    const r = await runRelease(deps, 'r1');
    expect(r.steps.find((s) => s.name === 'build')!.state).toBe('skipped');
    expect(r.status).toBe('succeeded');
    expect(ops.calls.some((c) => c.startsWith('acrBuild'))).toBe(false);
  });

  test('the compose script written to the VM really writes the compose file, atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compose-'));
    try {
      const compose = 'services:\n  a:\n    image: "x$$y"\n    command: ["sh", "-c", \'echo \\"hi\\"\']\n';
      const script = writeComposeScript('shop', compose).replace(/\/opt\/shop/g, `${dir}/opt/shop`);
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
      expect(readFileSync(join(dir, 'opt/shop/compose.yml'), 'utf8')).toBe(compose);
      expect(writeComposeScript('shop', compose)).toMatch(/^mkdir -p \/opt\/shop && printf '%s' '[A-Za-z0-9+/=]+' \| base64 -d > \/opt\/shop\/compose\.yml\.new && mv /);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('waiting for secrets', () => {
  test('stops at the secrets step, says what is needed, and holds no value', async () => {
    const { store, deps } = setup();
    await plan(store);
    const r = await runRelease(deps, 'r1');
    expect(r.status).toBe('waiting');
    const s = r.steps.find((x) => x.name === 'secrets')!;
    expect(s.state).toBe('waiting');
    expect(s.message).toBe('Waiting for JWT_SECRET, POSTGRES_PASSWORD');
    expect(r.steps.find((x) => x.name === 'build')!.state).toBe('pending');
  });

  test('provided values go straight to the vault, then the release resumes without repeating the infrastructure', async () => {
    const { store, ops, deps, infraCalls, logs } = setup();
    await plan(store);
    await runRelease(deps, 'r1');
    const left = await provideSecrets(deps, 'r1', { JWT_SECRET: 'jwt-value_1', POSTGRES_PASSWORD: 'pg.pass-2' });
    expect(left.missing).toEqual([]);
    expect(ops.calls).toEqual(expect.arrayContaining(['putSecret kvshop JWT-SECRET', 'putSecret kvshop POSTGRES-PASSWORD']));
    const r = await runRelease(deps, 'r1');
    expect(r.status).toBe('succeeded');
    expect(infraCalls.n).toBe(1);
    // No value anywhere a record, a call or a log could hold it.
    const everything = JSON.stringify([r, ops.calls, logs]);
    for (const v of ['jwt-value_1', 'pg.pass-2']) expect(everything).not.toContain(v);
  });

  test('a partial answer leaves the rest missing and the release still waiting', async () => {
    const { store, deps } = setup();
    await plan(store);
    await runRelease(deps, 'r1');
    expect((await provideSecrets(deps, 'r1', { JWT_SECRET: 'jwt-value_1' })).missing).toEqual(['POSTGRES_PASSWORD']);
    expect((await runRelease(deps, 'r1')).status).toBe('waiting');
  });

  test.each([
    ['a name the release is not waiting for', { OTHER_SECRET: 'abcdef' }, /not a secret this release is waiting for/],
    ['a lowercase name', { jwt_secret: 'abcdef' }, /not a secret/],
    ['a value with a space', { JWT_SECRET: 'has space' }, /may use only letters, digits/],
    ['a value with a quote', { JWT_SECRET: "it's" }, /may use only letters, digits/],
    ['an empty value', { JWT_SECRET: '' }, /may use only letters, digits/],
    ['a very long value', { JWT_SECRET: 'a'.repeat(201) }, /up to 200 characters/],
  ])('%s is refused and nothing is stored', async (_n, values, why) => {
    const { store, ops, deps } = setup();
    await plan(store);
    await runRelease(deps, 'r1');
    await expect(provideSecrets(deps, 'r1', values)).rejects.toThrow(why);
    expect(ops.calls.some((c) => c.startsWith('putSecret'))).toBe(false);
  });

  test('secrets cannot be provided to a release that is not waiting for them', async () => {
    const { store, deps } = setup();
    await plan(store);
    await expect(provideSecrets(deps, 'r1', { JWT_SECRET: 'abcdef' })).rejects.toThrow(/not waiting for secrets/);
    await expect(provideSecrets(deps, 'nope', {})).rejects.toThrow(/not found/);
  });

  test('a release whose services need no secret does not wait', async () => {
    const { store, deps } = setup();
    const p = project(['frontend', 'api']);
    p.layers.backend.config.env = [];
    await plan(store, p);
    expect((await runRelease(deps, 'r1')).status).toBe('succeeded');
  });
});

describe('a step that fails', () => {
  test('stops there, says which step, and a retry continues from it without repeating what was done', async () => {
    const ops = new FakeOps(); ops.vault.add('JWT-SECRET'); ops.vault.add('POSTGRES-PASSWORD');
    ops.failOn.push((c) => c.startsWith('acrBuild') && c.includes('shop-backend'));
    const { store, deps, infraCalls } = setup({ ops });
    await plan(store);
    const first = await runRelease(deps, 'r1');
    expect(first.status).toBe('failed');
    expect(first.error).toMatch(/^build: fake failure in acrBuild/);
    expect(first.steps.map((s) => s.state)).toEqual(['done', 'done', 'failed', 'pending', 'pending', 'pending']);
    expect(ops.calls.some((c) => c.startsWith('setVmTag'))).toBe(false);     // nothing was published
    ops.failOn = [];
    const second = await runRelease(deps, 'r1');
    expect(second.status).toBe('succeeded');
    expect(infraCalls.n).toBe(1);
    expect(second.error).toBeNull();
  });

  test('a failure of the infrastructure stops everything after it', async () => {
    const { store, ops, deps } = setup();
    deps.infra = { async apply() { throw new Error('terraform apply failed'); } };
    await plan(store);
    const r = await runRelease(deps, 'r1');
    expect(r.status).toBe('failed');
    expect(r.error).toBe('infrastructure: terraform apply failed');
    expect(ops.calls).toEqual([]);
  });

  test('files that no longer match what was approved are not built', async () => {
    const { store, ops, deps } = setup();
    const r0 = await plan(store);
    ops.vault.add('JWT-SECRET'); ops.vault.add('POSTGRES-PASSWORD');
    const tampered = structuredClone(r0.settings) as StackProject;
    tampered.deploy.azvm.imageTag = 'evil';
    r0.settings = tampered;
    await store.save(r0);
    const r = await runRelease(deps, 'r1');
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/no longer match what was approved/);
    expect(ops.calls.some((c) => c.startsWith('acrBuild'))).toBe(false);
  });

  test('only an approved, running, waiting or failed release can be run', async () => {
    const { store, deps } = setup();
    const bundle = buildAzureVmBundle(project());
    await store.save(newRelease({ id: 'r1', orgId: 'o', projectId: 'p1', environment: 'production', cloudAccountId: 'acct-1', project: project(), bundle, createdBy: 'u', previousReleaseId: null, now: 1 }));
    await expect(runRelease(deps, 'r1')).rejects.toThrow(/planned release cannot be run/);
    await expect(runRelease(deps, 'nope')).rejects.toThrow(/not found/);
  });
});

describe('rollback', () => {
  async function withPrevious(ops: FakeOps) {
    const s = setup({ ops });
    ops.vault.add('JWT-SECRET'); ops.vault.add('POSTGRES-PASSWORD');
    await plan(s.store, project(['frontend', 'backend', 'api', 'database'], 'v1'), 'r1');
    expect((await runRelease(s.deps, 'r1')).status).toBe('succeeded');
    await plan(s.store, project(['frontend', 'backend', 'api', 'database'], 'v2'), 'r2', 'r1');
    ops.calls.length = 0;
    return s;
  }

  test('an address that does not answer puts the previous release back (tag, compose file, restart) and says so', async () => {
    const ops = new FakeOps();
    const s = await withPrevious(ops);
    let running = 'v1';
    const tag = ops.setVmTag.bind(ops);
    ops.setVmTag = async (rg: string, vm: string, key: string, value: string) => { await tag(rg, vm, key, value); running = value; };
    ops.httpOk = async (url: string) => { ops.calls.push(`httpOk ${url}`); return running === 'v1'; };   // v2 never answers; v1 does
    const r = await runRelease(s.deps, 'r2');
    expect(r.status).toBe('rolled_back');
    expect(r.error).toMatch(/^verify: .*previous release \(v1\) was put back and answers/);
    expect(ops.calls).toEqual(expect.arrayContaining(['setVmTag rg-shop vm-shop image_tag=v1']));
    const tagCalls = ops.calls.filter((c) => c.startsWith('setVmTag'));
    expect(tagCalls).toEqual(['setVmTag rg-shop vm-shop image_tag=v2', 'setVmTag rg-shop vm-shop image_tag=v1']);
    expect(ops.calls.filter((c) => c === 'runShell systemctl restart shop.service')).toHaveLength(2);
    expect(r.steps.filter((x) => ['publish', 'start'].includes(x.name)).every((x) => x.state === 'rolled_back')).toBe(true);
  });

  test('a failed publish is rolled back too, a failed build is not (nothing was changed)', async () => {
    const ops = new FakeOps();
    const s = await withPrevious(ops);
    ops.failOn.push((c) => c === 'runShell compose' && ops.calls.filter((x) => x === 'runShell compose').length === 1);
    expect((await runRelease(s.deps, 'r2')).status).toBe('rolled_back');
    const s2 = await withPrevious(new FakeOps());
    s2.ops.failOn.push((c) => c.startsWith('acrBuild'));
    const r = await runRelease(s2.deps, 'r2');
    expect(r.status).toBe('failed');
    expect(s2.ops.calls.some((c) => c.startsWith('setVmTag'))).toBe(false);
  });

  test('when putting the previous release back does not work either, the release is failed and says to check the VM', async () => {
    const ops = new FakeOps();
    const s = await withPrevious(ops);
    ops.up = false;
    const r = await runRelease(s.deps, 'r2');
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/did not work: check the VM/);
  });

  test('the first release has nothing to go back to: it fails and leaves what was created', async () => {
    const ops = new FakeOps(); ops.up = false;
    ops.vault.add('JWT-SECRET'); ops.vault.add('POSTGRES-PASSWORD');
    const s = setup({ ops });
    await plan(s.store);
    const r = await runRelease(s.deps, 'r1');
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/^verify: .*did not answer/);
    expect(ops.calls.filter((c) => c.startsWith('setVmTag'))).toHaveLength(1);    // no rollback attempt
  });
});

describe('stopping a release', () => {
  test('the operator\'s kill switch stops it between steps, also when it was already queued', async () => {
    const { store, ops, deps } = setup({ killSwitch: () => true });
    await plan(store);
    const r = await runRelease(deps, 'r1');
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/switched off by the server operator/);
    expect(ops.calls).toEqual([]);
  });

  test('a cancel is honoured before the next step', async () => {
    const ops = new FakeOps(); ops.vault.add('JWT-SECRET'); ops.vault.add('POSTGRES-PASSWORD');
    const { store, deps } = setup({ ops });
    await plan(store);
    const real = ops.acrBuild.bind(ops);
    let once = false;
    ops.acrBuild = async (a) => { if (!once) { once = true; await cancelRelease(store, 'r1', 5); } await real(a); };
    const r = await runRelease(deps, 'r1');
    expect(r.status).toBe('cancelled');
    expect(ops.calls.filter((c) => c.startsWith('acrBuild'))).toHaveLength(1);   // the other services are not built
    expect(ops.calls.some((c) => c.startsWith('setVmTag'))).toBe(false);
  });

  test('a finished release cannot be cancelled', async () => {
    const { store, ops, deps } = setup();
    ops.vault.add('JWT-SECRET'); ops.vault.add('POSTGRES-PASSWORD');
    await plan(store);
    await runRelease(deps, 'r1');
    await expect(cancelRelease(store, 'r1', 9)).rejects.toThrow(/already succeeded/);
  });
});

describe('approval', () => {
  test('only the release that was planned, with the hashes that were approved', async () => {
    const store = new InMemoryReleaseStore();
    const p = project();
    const bundle = buildAzureVmBundle(p);
    await store.save(newRelease({ id: 'r1', orgId: 'o', projectId: 'p1', environment: 'production', cloudAccountId: 'acct-1', project: p, bundle, createdBy: 'u', previousReleaseId: null, planId: 'x', planHash: 'h', now: 1 }));
    await expect(approveRelease(store, 'r1', { bundleHash: 'other', planHash: 'h' }, 2)).rejects.toThrow(/different files or a different plan/);
    await expect(approveRelease(store, 'r1', { bundleHash: bundle.bundleHash, planHash: 'other' }, 2)).rejects.toThrow(/different files or a different plan/);
    await expect(approveRelease(store, 'nope', { bundleHash: bundle.bundleHash, planHash: 'h' }, 2)).rejects.toThrow(ReleaseError);
    expect((await approveRelease(store, 'r1', { bundleHash: bundle.bundleHash, planHash: 'h' }, 2)).status).toBe('approved');
    await expect(approveRelease(store, 'r1', { bundleHash: bundle.bundleHash, planHash: 'h' }, 3)).rejects.toThrow(/only a planned release/);
  });

  test('a different tag, project setting or service is a different bundle hash', () => {
    const base = buildAzureVmBundle(project()).bundleHash;
    expect(buildAzureVmBundle(project(['frontend', 'backend', 'api', 'database'], 'v2')).bundleHash).not.toBe(base);
    expect(buildAzureVmBundle(project(['frontend', 'backend', 'api'])).bundleHash).not.toBe(base);
    expect(buildAzureVmBundle(project()).bundleHash).toBe(base);
    const p = project(); p.deploy.azvm.allowedCidr = '203.0.113.0/24';
    expect(buildAzureVmBundle(p).bundleHash).not.toBe(base);
  });
});
