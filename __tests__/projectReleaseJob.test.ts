/**
 * The worker's side of a release: what runs it, what it records, and that the project is always unlocked afterwards.
 */
const audit: Array<Record<string, unknown>> = [];
jest.mock('@/lib/terraform/execution/audit', () => ({ recordTerraformAudit: jest.fn(async (e: Record<string, unknown>) => { audit.push(e); }) }));
jest.mock('@/lib/jobs/queue', () => ({ getQueue: jest.fn() }));
jest.mock('@/lib/deploy/project/accountOps', () => ({ releaseDriverFor: jest.fn() }));
jest.mock('@/lib/deploy/project/infra', () => ({ createTerraformInfraRunner: jest.fn(() => ({ apply: async () => { throw new Error('not used'); } })) }));
jest.mock('@/lib/deploy/project/pgReleaseStore', () => ({ PgReleaseStore: class {} }));

import { acquireProjectLock, releaseProjectLock } from '@/lib/terraform/execution/projectLock';
import { processReleaseJob, type ReleaseJobDeps } from '@/lib/jobs/projectReleaseJob';
import { InMemoryReleaseStore } from '@/lib/deploy/project/releaseStore';
import { approveRelease, newRelease } from '@/lib/deploy/project/orchestrator';
import { buildAzureVmBundle } from '@/lib/deploy/project/bundle';
import { defaultProject, LAYERS } from '@/lib/engines/containers/stackProject';
import type { AzureOps } from '@/lib/deploy/project/azureOps';
import { azureDriver } from '@/lib/deploy/project/driver';
import type { ReleaseOutputs } from '@/lib/deploy/project/types';

const OUT: ReleaseOutputs = { resourceGroup: 'rg-shop', vmName: 'vm-shop', acrName: 'acrshop', vaultName: 'kvshop', url: 'http://203.0.113.9:8080/' };
const project = () => { const p = defaultProject(); p.name = 'shop'; for (const l of LAYERS) p.layers[l].enabled = ['backend', 'api'].includes(l); p.layers.backend.config.env = []; p.deploy.target = 'azure-vm'; return p; };
const okOps = (): AzureOps => ({ secretExists: async () => true, putSecret: async () => undefined, acrBuild: async () => undefined, setVmTag: async () => undefined, runShell: async () => '', httpOk: async () => true, resourceGroupExists: async () => true });

async function seed(store: InMemoryReleaseStore) {
  const p = project(); const bundle = buildAzureVmBundle(p);
  await store.save(newRelease({ id: 'r1', orgId: 'org', projectId: 'p1', environment: 'production', cloudAccountId: 'acct', project: p, bundle, createdBy: 'u1', previousReleaseId: null, planId: 'pl', planHash: 'h', now: 1 }));
  await approveRelease(store, 'r1', { bundleHash: bundle.bundleHash, planHash: 'h' }, 2);
}
const data = { releaseId: 'r1', orgId: 'org', projectId: 'p1', requestedBy: 'u1' };
const deps = (store: InMemoryReleaseStore, over: Partial<ReleaseJobDeps> = {}): ReleaseJobDeps => ({ store, driverFor: async () => azureDriver(okOps()), infra: { apply: async () => OUT }, killSwitch: () => false, ...over });
const locked = () => { const got = acquireProjectLock('p1'); if (got) releaseProjectLock('p1'); return !got; };

beforeEach(() => { audit.length = 0; releaseProjectLock('p1'); jest.spyOn(console, 'info').mockImplementation(() => undefined); });

describe('processReleaseJob', () => {
  test('runs the release to the end, records it in the audit trail and leaves the project unlocked', async () => {
    const store = new InMemoryReleaseStore(); await seed(store);
    expect(acquireProjectLock('p1')).toBe(true);          // the route took it before queueing
    const r = await processReleaseJob(data, deps(store));
    expect(r.status).toBe('succeeded');
    expect((await store.get('r1'))!.status).toBe('succeeded');
    expect(audit).toEqual([expect.objectContaining({ action: 'release', outcome: 'succeeded', orgId: 'org', projectId: 'p1', userId: 'u1', planId: 'pl', planHash: 'h' })]);
    expect(locked()).toBe(false);
  });

  test('a release that waits for secrets or is cancelled is "allowed", a failed one "failed"', async () => {
    const store = new InMemoryReleaseStore(); await seed(store);
    const waiting = await processReleaseJob(data, deps(store, { driverFor: async () => azureDriver({ ...okOps(), secretExists: async () => false }) }));
    expect(waiting.status).toBe('succeeded');            // this project has no secrets, so it does not wait
    const store2 = new InMemoryReleaseStore(); await seed(store2);
    const r2 = (await store2.get('r1'))!; r2.secrets = ['JWT_SECRET']; await store2.save(r2);
    // the hash is of the files, not of the list of secrets, so this is still the approved release
    const w = await processReleaseJob(data, deps(store2, { driverFor: async () => azureDriver({ ...okOps(), secretExists: async () => false }) }));
    expect(w.status).toBe('waiting');
    expect(audit.at(-1)).toMatchObject({ outcome: 'allowed' });
    const store3 = new InMemoryReleaseStore(); await seed(store3);
    const f = await processReleaseJob(data, deps(store3, { infra: { apply: async () => { throw new Error('boom'); } } }));
    expect(f.status).toBe('failed');
    expect(audit.at(-1)).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('boom') });
  });

  test('an account that cannot be used fails the release with the reason, and the project is unlocked', async () => {
    const store = new InMemoryReleaseStore(); await seed(store);
    expect(acquireProjectLock('p1')).toBe(true);
    const r = await processReleaseJob(data, deps(store, { driverFor: async () => { throw new Error('A deployment to an Azure VM needs an Azure account.'); } }));
    expect(r.status).toBe('failed');
    const rel = (await store.get('r1'))!;
    expect(rel.status).toBe('failed');
    expect(rel.error).toBe('account: A deployment to an Azure VM needs an Azure account.');
    expect(locked()).toBe(false);
  });

  test('the operator\'s switch stops it before any step', async () => {
    const store = new InMemoryReleaseStore(); await seed(store);
    const r = await processReleaseJob(data, deps(store, { killSwitch: () => true }));
    expect(r.status).toBe('failed');
    expect((await store.get('r1'))!.error).toMatch(/switched off/);
  });

  test('a release of another organization or project is not touched, and an unknown one is reported', async () => {
    const store = new InMemoryReleaseStore(); await seed(store);
    expect((await processReleaseJob({ ...data, orgId: 'other' }, deps(store))).message).toMatch(/not found/);
    expect((await processReleaseJob({ ...data, projectId: 'other' }, deps(store))).message).toMatch(/not found/);
    expect((await processReleaseJob({ ...data, releaseId: 'nope' }, deps(store))).message).toMatch(/not found/);
    expect((await store.get('r1'))!.status).toBe('approved');
    expect(audit.every((e) => e['outcome'] === 'failed')).toBe(true);
  });

  test('it never throws, whatever goes wrong', async () => {
    const store = new InMemoryReleaseStore(); await seed(store);
    store.get = async () => { throw new Error('database is down'); };
    await expect(processReleaseJob(data, deps(store))).resolves.toMatchObject({ status: 'failed', message: 'database is down' });
    expect(locked()).toBe(false);
  });
});
