jest.mock('@/lib/terraform/execution/TerraformExecutionService', () => ({ planBundle: jest.fn(), runApply: jest.fn() }));
jest.mock('@/lib/terraform/execution/cli', () => ({ runTerraform: jest.fn() }));
/**
 * A release on Azure Container Apps: the bundle, the Container Apps calls (against a fake Azure), the driver and the state machine running through them.
 */
import { defaultProject, LAYERS, type Layer, type StackProject } from '@/lib/engines/containers/stackProject';
import { buildBundle, BundleError } from '@/lib/deploy/project/bundle';
import { AzureError, createAzureOps, type AcaOps, type AzureOps } from '@/lib/deploy/project/azureOps';
import { acaDriver } from '@/lib/deploy/project/acaDriver';
import { InMemoryReleaseStore } from '@/lib/deploy/project/releaseStore';
import { approveRelease, createRollbackRelease, newRelease, provideSecrets, reconcileDestroyed, runRelease, type OrchestratorDeps } from '@/lib/deploy/project/orchestrator';
import { outputsFrom, providerOf, terraformFiles } from '@/lib/deploy/project/infra';
import type { AcaOutputs } from '@/lib/deploy/project/types';

const OUT: AcaOutputs = { kind: 'aca', resourceGroup: 'rg-shop', apps: ['shop-frontend', 'shop-backend', 'shop-api'], minReplicas: 1, acrName: 'acrshopabc123', vaultName: 'kvshopabc123', url: 'https://shop-frontend.example.azurecontainerapps.io/' };

function project(on: Layer[] = ['frontend', 'backend', 'api'], tag = 'v1'): StackProject {
  const p = defaultProject();
  p.name = 'shop';
  for (const l of LAYERS) p.layers[l].enabled = on.includes(l);
  p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }];
  p.deploy.target = 'container-apps';
  p.deploy.aca.imageTag = tag;
  return p;
}

describe('the Container Apps bundle of a release', () => {
  test('has the environment Terraform with placeholders, and no compose file and no server', () => {
    const b = buildBundle(project());
    expect(b).toMatchObject({ target: 'container-apps', project: 'shop', imageTag: 'v1', built: ['frontend', 'backend', 'api'], compose: '', secrets: ['JWT_SECRET'] });
    expect(terraformFiles(b).map((f) => f.filename).sort()).toEqual(['main.tf', 'outputs.tf', 'variables.tf']);
    expect(b.terraform.find((f) => f.filename === 'main.tf')!.content).toContain('min_replicas = 0');
    expect(providerOf('container-apps')).toBe('azure');
  });
  test('the tag is part of its hash; a database and a scale-to-zero project are refused', () => {
    expect(buildBundle(project(undefined, 'v2')).bundleHash).not.toBe(buildBundle(project()).bundleHash);
    expect(() => buildBundle(project(['backend', 'api', 'database']))).toThrow(/not run in Container Apps/);
    const p = project(); p.deploy.aca.minReplicas = 0;
    expect(() => buildBundle(p)).toThrow(BundleError);
  });
});

describe('what Terraform created on Container Apps', () => {
  const ALL = JSON.stringify(Object.fromEntries(Object.entries({
    resource_group: 'rg-shop', apps: OUT.apps, min_replicas: 1, acr_name: OUT.acrName, vault_name: OUT.vaultName, app_url: OUT.url,
  }).map(([k, v]) => [k, { value: v }])));
  test('is read from its outputs', () => { expect(outputsFrom(ALL, 'container-apps')).toEqual(OUT); });
  test.each(['resource_group', 'app_url', 'apps', 'min_replicas'])('without %s the step fails with that name', (k) => {
    const o = JSON.parse(ALL); delete o[k];
    expect(() => outputsFrom(JSON.stringify(o), 'container-apps')).toThrow(`Terraform did not report ${k}.`);
  });
  test('app names that could be a path are refused', () => {
    const o = JSON.parse(ALL); o.apps.value = ['../x'];
    expect(() => outputsFrom(JSON.stringify(o), 'container-apps')).toThrow(/apps/);
  });
  test('a project with nothing built or no secrets has no registry or vault, which is fine', () => {
    const o = JSON.parse(ALL); delete o.acr_name; delete o.vault_name;
    expect(outputsFrom(JSON.stringify(o), 'container-apps')).toMatchObject({ acrName: '', vaultName: '' });
  });
});

// ─── the Container Apps calls ────────────────────────────────────────────────

type Handler = (req: { method: string; url: string; body: string }) => { status: number; json?: unknown; headers?: Record<string, string> };
function fakeAzure(routes: Array<[RegExp, Handler]>) {
  const log: Array<{ method: string; url: string; body: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const req = { method: init.method ?? 'GET', url: String(url), body: typeof init.body === 'string' ? init.body : '' };
    log.push(req);
    const h = routes.find(([re]) => re.test(`${req.method} ${req.url}`));
    if (!h) return new Response('no route', { status: 599 });
    const r = h[1](req);
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : '', { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fetchImpl, log };
}
const ops = (routes: Array<[RegExp, Handler]>, extra: Record<string, unknown> = {}) => {
  const f = fakeAzure(routes);
  return { ops: createAzureOps({ subscriptionId: 'sub-1', getToken: async () => 'tok', sleep: async () => undefined, pollMs: 1, fetchImpl: f.fetchImpl, ...extra }), log: f.log };
};
const APP_URL = /\/resourceGroups\/rg-shop\/providers\/Microsoft\.App\/containerApps\/shop-api\?api-version=2024-03-01/;
const app = (p: Record<string, unknown> = {}) => ({ properties: { provisioningState: 'Succeeded', latestRevisionName: 'shop-api--b', latestReadyRevisionName: 'shop-api--b', runningStatus: { runningState: 'Running' }, template: { containers: [{ name: 'api', image: 'quickstart', probes: [{ type: 'Liveness' }] }], scale: { minReplicas: 0, maxReplicas: 5 } }, ...p } });

describe('the Container Apps calls', () => {
  test('a secret that is only the marker Terraform left is not stored yet; a stored one is; a missing one is not', async () => {
    const t = ops([
      [/secrets\/MARK/, () => ({ status: 200, json: { value: 'not-set-yet', tags: { cloudbuilder: 'placeholder' } } })],
      [/secrets\/REAL/, () => ({ status: 200, json: { value: 'x' } })],
      [/secrets\/NONE/, () => ({ status: 404, json: {} })],
      [/secrets\/DENY/, () => ({ status: 403, json: { error: { code: 'Forbidden', message: 'no' } } })],
    ]);
    expect(await t.ops.secretHasValue('kvshop', 'MARK')).toBe(false);
    expect(await t.ops.secretHasValue('kvshop', 'REAL')).toBe(true);
    expect(await t.ops.secretHasValue('kvshop', 'NONE')).toBe(false);
    await expect(t.ops.secretHasValue('kvshop', 'DENY')).rejects.toThrow(/Could not read secret DENY: Forbidden: no/);
  });

  test('pointing an app at an image changes only the first container\'s image, keeps the rest of the template, and waits for Azure to finish', async () => {
    let reads = 0;
    const t = ops([
      [new RegExp(`GET .*containerApps/shop-api`), () => { reads++; return { status: 200, json: reads < 3 ? app() : app() }; }],
      [new RegExp(`PATCH .*containerApps/shop-api`), () => ({ status: 200, json: {} })],
    ]);
    await t.ops.containerAppSetImage({ resourceGroup: 'rg-shop', app: 'shop-api', image: 'acrshopabc123.azurecr.io/shop-api:v2' });
    const patch = t.log.find((l) => l.method === 'PATCH')!;
    expect(patch.url).toMatch(APP_URL);
    const body = JSON.parse(patch.body);
    expect(body.properties.template.containers).toEqual([{ name: 'api', image: 'acrshopabc123.azurecr.io/shop-api:v2', probes: [{ type: 'Liveness' }] }]);
    expect(body.properties.template.scale).toEqual({ minReplicas: 0, maxReplicas: 5 });
  });

  test('starting gives the app its replicas and waits until the newest revision is ready and running', async () => {
    let n = 0;
    const t = ops([
      [/GET .*containerApps\/shop-api/, () => ({ status: 200, json: ++n === 1 ? app() : n === 2 ? app({ latestReadyRevisionName: 'shop-api--a' }) : n === 3 ? app({ runningStatus: { runningState: 'Degraded' } }) : app() })],
      [/PATCH .*containerApps\/shop-api/, () => ({ status: 200, json: {} })],
    ]);
    const lines: string[] = [];
    await t.ops.containerAppStart({ resourceGroup: 'rg-shop', app: 'shop-api', minReplicas: 2, onLog: (l) => lines.push(l) });
    expect(JSON.parse(t.log.find((l) => l.method === 'PATCH')!.body).properties.template.scale).toEqual({ minReplicas: 2, maxReplicas: 5 });
    expect(n).toBe(4);
    expect(lines.at(-1)).toBe('shop-api: Succeeded, revision ready, Running');
  });

  test('an app Azure could not provision, or that never becomes ready, fails with its name', async () => {
    const failing = ops([[/GET .*containerApps/, () => ({ status: 200, json: app({ provisioningState: 'Failed' }) })], [/PATCH/, () => ({ status: 200, json: {} })]]);
    await expect(failing.ops.containerAppStart({ resourceGroup: 'rg-shop', app: 'shop-api', minReplicas: 1 })).rejects.toThrow(/Azure could not provision shop-api/);
    const never = ops([[/GET .*containerApps/, () => ({ status: 200, json: app({ latestReadyRevisionName: 'old' }) })], [/PATCH/, () => ({ status: 200, json: {} })]], { buildTimeoutMs: -1 });
    await expect(never.ops.containerAppStart({ resourceGroup: 'rg-shop', app: 'shop-api', minReplicas: 1 })).rejects.toThrow(/shop-api did not become ready in time/);
    const refused = ops([[/GET .*containerApps/, () => ({ status: 200, json: app() })], [/PATCH/, () => ({ status: 403, json: { error: { code: 'AuthorizationFailed', message: 'no' } } })]]);
    await expect(refused.ops.containerAppSetImage({ resourceGroup: 'rg-shop', app: 'shop-api', image: 'a.azurecr.io/x:v1' })).rejects.toThrow(/AuthorizationFailed/);
  });

  test('names that could point elsewhere are refused before any request', async () => {
    const t = ops([]);
    await expect(t.ops.containerAppSetImage({ resourceGroup: 'rg-shop', app: '../x', image: 'a.azurecr.io/x:v1' })).rejects.toThrow(AzureError);
    await expect(t.ops.containerAppSetImage({ resourceGroup: 'rg-shop', app: 'shop-api', image: 'bad image' })).rejects.toThrow(AzureError);
    await expect(t.ops.containerAppStart({ resourceGroup: 'rg-shop', app: 'shop-api', minReplicas: 0 })).rejects.toThrow(AzureError);
    expect(t.log).toHaveLength(0);
  });
});

// ─── a whole release on Container Apps ───────────────────────────────────────

describe('a release on Container Apps, from the first step to the last', () => {
  function world() {
    const calls: string[] = []; const stored = new Set<string>(); let tag = ''; let live = 'none'; let exists = true;
    const base: AzureOps = {
      secretExists: async () => { throw new Error('use secretHasValue'); }, putSecret: async (_v, n) => { stored.add(n); },
      acrBuild: async (a) => { calls.push(`build ${a.image}`); },
      setVmTag: async () => { throw new Error('no VM'); }, runShell: async () => { throw new Error('no VM'); },
      httpOk: async () => live !== 'bad' && live !== 'none', resourceGroupExists: async () => exists,
    };
    const aca: AcaOps = {
      secretHasValue: async (_v, n) => stored.has(n),
      containerAppSetImage: async (a) => { calls.push(`image ${a.app} ${a.image.split(':')[1]}`); tag = a.image.split(':')[1]!; },
      containerAppStart: async (a) => { calls.push(`start ${a.app}`); live = tag; },
    };
    return { all: { ...base, ...aca }, calls, stored, setExists: (v: boolean) => { exists = v; } };
  }
  function setup() {
    const w = world();
    const store = new InMemoryReleaseStore();
    let clock = 1000;
    const deps: OrchestratorDeps = { store, driver: acaDriver(w.all), infra: { apply: async () => OUT }, now: () => ++clock, sleep: async () => undefined, verifyWaitMs: 50, verifyEveryMs: 1 };
    return { store, deps, w };
  }
  async function plan(store: InMemoryReleaseStore, tag: string, id: string, prev: string | null = null, p = project(undefined, tag)) {
    const bundle = buildBundle(p);
    await store.save(newRelease({ id, orgId: 'org', projectId: 'p1', environment: 'production', cloudAccountId: 'a', project: p, bundle, createdBy: 'u', previousReleaseId: prev, planId: 'pl', planHash: 'h', now: 1 }));
    await approveRelease(store, id, { bundleHash: bundle.bundleHash, planHash: 'h' }, 2);
  }

  test('creates the infrastructure, waits for the secrets, builds, points each built app at its image, starts every app and checks the address', async () => {
    const { store, deps, w } = setup();
    await plan(store, 'v1', 'r1');
    expect((await runRelease(deps, 'r1')).status).toBe('waiting');
    await provideSecrets(deps, 'r1', { JWT_SECRET: 'jwt-value_1' });
    expect([...w.stored]).toEqual(['JWT-SECRET']);
    const r = await runRelease(deps, 'r1');
    expect(r.status).toBe('succeeded');
    expect(w.calls).toEqual([
      'build shop-frontend:v1', 'build shop-backend:v1', 'build shop-api:v1',
      'image shop-frontend v1', 'image shop-backend v1', 'image shop-api v1', 'start shop-frontend', 'start shop-backend', 'start shop-api',
    ]);
    expect(JSON.stringify([r, w.calls])).not.toContain('jwt-value_1');
  });

  test('a ready-made image is never repointed', async () => {
    const { store, deps, w } = setup();
    w.stored.add('JWT-SECRET');
    const p = project(undefined, 'v1');
    p.layers.frontend.config = { ...p.layers.frontend.config, image: 'nginx:1.27' };
    await plan(store, 'v1', 'r1', null, p);
    expect((await runRelease(deps, 'r1')).status).toBe('succeeded');
    expect(w.calls.filter((c) => c.startsWith('image')).map((c) => c.split(' ')[1])).toEqual(['shop-backend', 'shop-api']);
  });

  test('a release that does not answer puts the previous images back and starts the apps again', async () => {
    const { store, deps, w } = setup();
    w.stored.add('JWT-SECRET');
    await plan(store, 'v1', 'r1'); expect((await runRelease(deps, 'r1')).status).toBe('succeeded');
    await plan(store, 'bad', 'r2', 'r1');
    w.calls.length = 0;
    const r = await runRelease(deps, 'r2');
    expect(r.status).toBe('rolled_back');
    const tags = w.calls.filter((c) => c.startsWith('image shop-api')).map((c) => c.split(' ')[2]);
    expect(tags).toEqual(['bad', 'v1']);
  });

  test('an earlier release is put back without building, and a teardown is noticed by the resource group being gone', async () => {
    const { store, deps, w } = setup();
    w.stored.add('JWT-SECRET');
    await plan(store, 'v1', 'r1'); await runRelease(deps, 'r1');
    await plan(store, 'v2', 'r2', 'r1'); await runRelease(deps, 'r2');
    w.calls.length = 0;
    await store.save(await createRollbackRelease(store, { targetId: 'r1', newId: 'r3', orgId: 'org', projectId: 'p1', createdBy: 'u', now: 99 }));
    expect((await runRelease(deps, 'r3')).status).toBe('succeeded');
    expect(w.calls.some((c) => c.startsWith('build'))).toBe(false);
    expect(w.calls.filter((c) => c.startsWith('image shop-api'))).toEqual(['image shop-api v1']);
    const r1 = (await store.get('r1'))!;
    expect(await reconcileDestroyed(deps, r1)).toBe(0);
    w.setExists(false);
    expect(await reconcileDestroyed(deps, r1)).toBeGreaterThanOrEqual(1);
    expect((await store.get('r1'))!.status).toBe('destroyed');
  });
});
