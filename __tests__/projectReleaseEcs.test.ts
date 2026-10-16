jest.mock('@/lib/terraform/execution/TerraformExecutionService', () => ({ planBundle: jest.fn(), runApply: jest.fn() }));
jest.mock('@/lib/terraform/execution/cli', () => ({ runTerraform: jest.fn() }));
/**
 * A release on ECS Fargate: the bundle, the ECS operations (against a fake SDK client), the driver and the state machine running through them.
 */
import { defaultProject, LAYERS, type Layer, type StackProject } from '@/lib/engines/containers/stackProject';
import { buildBundle } from '@/lib/deploy/project/bundle';
import { AwsError, type AwsOps } from '@/lib/deploy/project/awsOps';
import { createEcsOps } from '@/lib/deploy/project/ecsOps';
import { ecsDriver } from '@/lib/deploy/project/ecsDriver';
import { InMemoryReleaseStore } from '@/lib/deploy/project/releaseStore';
import { approveRelease, createRollbackRelease, newRelease, provideSecrets, reconcileDestroyed, runRelease, type OrchestratorDeps } from '@/lib/deploy/project/orchestrator';
import { outputsFrom, providerOf, terraformFiles } from '@/lib/deploy/project/infra';
import type { EcsOutputs } from '@/lib/deploy/project/types';

const OUT: EcsOutputs = {
  kind: 'ecs', region: 'us-east-1', cluster: 'shop', services: ['frontend', 'backend', 'api'], desiredCount: 2, sourceBucket: 'shop-src-123456789012', codebuildProject: 'shop-build',
  registry: '123456789012.dkr.ecr.us-east-1.amazonaws.com', ssmPrefix: '/shop', url: 'http://shop-123.us-east-1.elb.amazonaws.com/',
};

function project(on: Layer[] = ['frontend', 'backend', 'api'], tag = 'v1'): StackProject {
  const p = defaultProject();
  p.name = 'shop';
  for (const l of LAYERS) p.layers[l].enabled = on.includes(l);
  p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }];
  p.deploy.target = 'ecs';
  p.deploy.ecs.imageTag = tag;
  return p;
}

describe('the ECS bundle of a release', () => {
  test('has the cluster Terraform and the CodeBuild, and no compose file, no server', () => {
    const b = buildBundle(project());
    expect(b).toMatchObject({ target: 'ecs', project: 'shop', imageTag: 'v1', built: ['frontend', 'backend', 'api'], compose: '', secrets: ['JWT_SECRET'] });
    expect(b.entry).toMatchObject({ service: 'frontend' });
    expect(terraformFiles(b).map((f) => f.filename).sort()).toEqual(['main.tf', 'outputs.tf', 'variables.tf']);
    expect(b.terraform.find((f) => f.filename === 'main.tf')!.content).toContain('desired_count   = 0');
    expect(providerOf('ecs')).toBe('aws');
  });
  test('the tag and the target are part of its hash', () => {
    const base = buildBundle(project()).bundleHash;
    expect(buildBundle(project(undefined, 'v2')).bundleHash).not.toBe(base);
    expect(buildBundle(project()).bundleHash).toBe(base);
  });
  test('a database is refused', () => {
    expect(() => buildBundle(project(['backend', 'api', 'database']))).toThrow(/not run on Fargate/);
  });
});

describe('what Terraform created on ECS', () => {
  const ALL = JSON.stringify(Object.fromEntries(Object.entries({
    region: 'us-east-1', cluster: 'shop', services: ['frontend', 'backend', 'api'], desired_count: 2, registry: OUT.registry, ssm_prefix: '/shop', app_url: OUT.url,
    codebuild_project: 'shop-build', source_bucket: 'shop-src-123456789012',
  }).map(([k, v]) => [k, { value: v }])));
  test('is read from its outputs', () => { expect(outputsFrom(ALL, 'ecs')).toEqual(OUT); });
  test.each(['region', 'cluster', 'registry', 'ssm_prefix', 'app_url', 'services', 'desired_count'])('without %s the step fails with that name', (k) => {
    const o = JSON.parse(ALL); delete o[k];
    expect(() => outputsFrom(JSON.stringify(o), 'ecs')).toThrow(`Terraform did not report ${k}.`);
  });
  test('service names that could be a path or a flag are refused', () => {
    const o = JSON.parse(ALL); o.services.value = ['--force'];
    expect(() => outputsFrom(JSON.stringify(o), 'ecs')).toThrow(/services/);
  });
});

// ─── the ECS operations ──────────────────────────────────────────────────────

type Handler = (input: any) => unknown;   // eslint-disable-line @typescript-eslint/no-explicit-any
function fake(handlers: Record<string, Handler>) {
  const log: Array<{ name: string; input: any }> = [];   // eslint-disable-line @typescript-eslint/no-explicit-any
  return { log, sender: { send: async (command: unknown) => { const c = command as { constructor: { name: string }; input: unknown }; log.push({ name: c.constructor.name, input: c.input }); const h = handlers[c.constructor.name]; if (!h) throw new Error(`no handler for ${c.constructor.name}`); return h(c.input); } } };
}
const err = (name: string, message = name) => Object.assign(new Error(message), { name });
const REG = OUT.registry;
const taskDef = (service: string, tag: string) => ({ taskDefinition: { family: `shop-${service}`, taskRoleArn: 'role-t', executionRoleArn: 'role-e', networkMode: 'awsvpc', cpu: '512', memory: '1024', requiresCompatibilities: ['FARGATE'], runtimePlatform: { operatingSystemFamily: 'LINUX', cpuArchitecture: 'X86_64' }, revision: 7, status: 'ACTIVE', taskDefinitionArn: 'arn:x', containerDefinitions: [{ name: service, image: `${REG}/shop-${service}:${tag}`, secrets: [{ name: 'A', valueFrom: 'arn:ssm' }] }] } });

describe('the ECS operations', () => {
  test('a release registers a new revision per service that runs the new tag, copying everything else, and leaves a ready-made image alone', async () => {
    const t = fake({
      DescribeTaskDefinitionCommand: (i) => (i.taskDefinition === 'shop-api'
        ? { taskDefinition: { ...taskDef('api', 'x').taskDefinition, containerDefinitions: [{ name: 'api', image: 'nginx:1.27' }] } }
        : taskDef(i.taskDefinition.replace('shop-', ''), 'v1')),
      RegisterTaskDefinitionCommand: () => ({}),
    });
    await createEcsOps({ ecs: t.sender }).setImageTag({ project: 'shop', services: ['frontend', 'api'], registry: REG, tag: 'v2' });
    const regs = t.log.filter((l) => l.name === 'RegisterTaskDefinitionCommand').map((l) => l.input);
    expect(regs).toHaveLength(2);
    expect(regs[0]).toMatchObject({ family: 'shop-frontend', taskRoleArn: 'role-t', executionRoleArn: 'role-e', networkMode: 'awsvpc', cpu: '512', memory: '1024', requiresCompatibilities: ['FARGATE'] });
    expect(regs[0].containerDefinitions).toEqual([{ name: 'frontend', image: `${REG}/shop-frontend:v2`, secrets: [{ name: 'A', valueFrom: 'arn:ssm' }] }]);
    expect(regs[0]).not.toHaveProperty('revision');
    expect(regs[1].containerDefinitions[0].image).toBe('nginx:1.27');
  });

  test('a failure to read or register says which service and why', async () => {
    const noRead = createEcsOps({ ecs: fake({ DescribeTaskDefinitionCommand: () => { throw err('ClientException', 'Unable to describe'); } }).sender });
    await expect(noRead.setImageTag({ project: 'shop', services: ['api'], registry: REG, tag: 'v2' })).rejects.toThrow(/task definition of api: ClientException: Unable to describe/);
    const noReg = createEcsOps({ ecs: fake({ DescribeTaskDefinitionCommand: () => taskDef('api', 'v1'), RegisterTaskDefinitionCommand: () => { throw err('AccessDeniedException', 'denied'); } }).sender });
    await expect(noReg.setImageTag({ project: 'shop', services: ['api'], registry: REG, tag: 'v2' })).rejects.toThrow(/register the new task definition of api: AccessDeniedException/);
  });

  test('names that could point elsewhere are refused before any request', async () => {
    const t = fake({});
    const ops = createEcsOps({ ecs: t.sender });
    for (const bad of [{ project: 'Shop' }, { registry: 'evil.example.com' }, { tag: 'a b' }, { services: ['../x'] }]) await expect(ops.setImageTag({ project: 'shop', services: ['api'], registry: REG, tag: 'v1', ...bad })).rejects.toThrow(AwsError);
    await expect(ops.startServices({ cluster: 'a b', project: 'shop', services: ['api'], desiredCount: 1 })).rejects.toThrow(AwsError);
    await expect(ops.startServices({ cluster: 'shop', project: 'shop', services: ['api'], desiredCount: 0 })).rejects.toThrow(AwsError);
    expect(t.log).toHaveLength(0);
  });

  const view = (name: string, o: { running: number; desired?: number; rollout?: string; primaryOnly?: boolean; reason?: string }) => ({
    serviceName: name, desiredCount: o.desired ?? 2, runningCount: o.running,
    deployments: [{ status: 'PRIMARY', rolloutState: o.rollout ?? 'COMPLETED', rolloutStateReason: o.reason }, ...(o.primaryOnly === false ? [{ status: 'ACTIVE', rolloutState: 'COMPLETED' }] : [])],
  });

  test('starting points each service at its newest task definition with its task count, then waits until all are steady', async () => {
    let polls = 0;
    const t = fake({
      UpdateServiceCommand: () => ({}),
      DescribeServicesCommand: () => { polls++; return { services: [view('frontend', { running: polls < 3 ? 0 : 2, rollout: polls < 3 ? 'IN_PROGRESS' : 'COMPLETED' }), view('api', { running: 2 })] }; },
    });
    const lines: string[] = [];
    await createEcsOps({ ecs: t.sender, sleep: async () => undefined }).startServices({ cluster: 'shop', project: 'shop', services: ['frontend', 'api'], desiredCount: 2, onLog: (l) => lines.push(l) });
    expect(t.log.filter((l) => l.name === 'UpdateServiceCommand').map((l) => l.input)).toEqual([
      { cluster: 'shop', service: 'frontend', taskDefinition: 'shop-frontend', desiredCount: 2, forceNewDeployment: true },
      { cluster: 'shop', service: 'api', taskDefinition: 'shop-api', desiredCount: 2, forceNewDeployment: true },
    ]);
    expect(polls).toBe(3);
    expect(lines.at(-1)).toBe('frontend 2/2, api 2/2');
  });

  test('an old deployment still draining is not steady yet', async () => {
    let n = 0;
    const t = fake({ UpdateServiceCommand: () => ({}), DescribeServicesCommand: () => ({ services: [view('api', { running: 2, primaryOnly: ++n > 2 })] }) });
    await createEcsOps({ ecs: t.sender, sleep: async () => undefined }).startServices({ cluster: 'shop', project: 'shop', services: ['api'], desiredCount: 2 });
    expect(n).toBe(3);
  });

  test('a deployment that fails (the circuit breaker) says why', async () => {
    const t = fake({ UpdateServiceCommand: () => ({}), DescribeServicesCommand: () => ({ services: [view('api', { running: 0, rollout: 'FAILED', reason: 'ECS deployment circuit breaker: tasks failed to start.' })] }) });
    await expect(createEcsOps({ ecs: t.sender, sleep: async () => undefined }).startServices({ cluster: 'shop', project: 'shop', services: ['api'], desiredCount: 2 })).rejects.toThrow(/api did not start: ECS deployment circuit breaker/);
  });

  test('services that never become steady are given up on, and a refusal to update says which service', async () => {
    const t = fake({ UpdateServiceCommand: () => ({}), DescribeServicesCommand: () => ({ services: [view('api', { running: 0, rollout: 'IN_PROGRESS' })] }) });
    await expect(createEcsOps({ ecs: t.sender, sleep: async () => undefined, rolloutTimeoutMs: -1 }).startServices({ cluster: 'shop', project: 'shop', services: ['api'], desiredCount: 2 })).rejects.toThrow(/did not become steady in time \(api 0\/2\)/);
    const no = fake({ UpdateServiceCommand: () => { throw err('ServiceNotFoundException', 'gone'); } });
    await expect(createEcsOps({ ecs: no.sender }).startServices({ cluster: 'shop', project: 'shop', services: ['api'], desiredCount: 2 })).rejects.toThrow(/Could not start api: ServiceNotFoundException/);
  });

  test('a cluster is there while it is active, gone when inactive or missing, and an error is not "gone"', async () => {
    const ops = (h: Handler) => createEcsOps({ ecs: fake({ DescribeClustersCommand: h }).sender });
    expect(await ops(() => ({ clusters: [{ status: 'ACTIVE' }] })).clusterExists('shop')).toBe(true);
    expect(await ops(() => ({ clusters: [{ status: 'INACTIVE' }] })).clusterExists('shop')).toBe(false);
    expect(await ops(() => ({ clusters: [], failures: [{ reason: 'MISSING' }] })).clusterExists('shop')).toBe(false);
    await expect(ops(() => { throw err('AccessDeniedException', 'no'); }).clusterExists('shop')).rejects.toThrow(/Could not look for the cluster/);
  });
});

// ─── a whole release on ECS ──────────────────────────────────────────────────

describe('a release on ECS, from the first step to the last', () => {
  function world() {
    const calls: string[] = []; const secrets = new Set<string>(); let tag = ''; let live = 'none'; let exists = true;
    const aws: AwsOps = {
      secretExists: async (p) => secrets.has(p), putSecret: async (p) => { secrets.add(p); },
      buildImage: async (a) => { calls.push(`build ${a.image}`); },
      putReleaseFiles: async () => { throw new Error('ECS has no release bucket'); }, restartService: async () => { throw new Error('ECS has no server'); },
      bucketExists: async () => { throw new Error('ECS has no bucket'); }, httpOk: async () => live !== 'bad' && live !== 'none',
    };
    const ecs = {
      setImageTag: async (a: { tag: string }) => { calls.push(`tag ${a.tag}`); tag = a.tag; },
      startServices: async () => { calls.push(`start ${tag}`); live = tag; },
      clusterExists: async () => exists,
    };
    return { aws, ecs, calls, secrets, setExists: (v: boolean) => { exists = v; } };
  }
  function setup() {
    const w = world();
    const store = new InMemoryReleaseStore();
    let clock = 1000;
    const deps: OrchestratorDeps = { store, driver: ecsDriver(w.aws, w.ecs), infra: { apply: async () => OUT }, now: () => ++clock, sleep: async () => undefined, verifyWaitMs: 50, verifyEveryMs: 1 };
    return { store, deps, w };
  }
  async function plan(store: InMemoryReleaseStore, tag: string, id: string, prev: string | null = null) {
    const p = project(undefined, tag);
    const bundle = buildBundle(p);
    await store.save(newRelease({ id, orgId: 'org', projectId: 'p1', environment: 'production', cloudAccountId: 'a', project: p, bundle, createdBy: 'u', previousReleaseId: prev, planId: 'pl', planHash: 'h', now: 1 }));
    await approveRelease(store, id, { bundleHash: bundle.bundleHash, planHash: 'h' }, 2);
  }

  test('creates the infrastructure, waits for the secrets, builds each image, points the services at them, starts them and checks the address', async () => {
    const { store, deps, w } = setup();
    await plan(store, 'v1', 'r1');
    const first = await runRelease(deps, 'r1');
    expect(first.status).toBe('waiting');
    await provideSecrets(deps, 'r1', { JWT_SECRET: 'jwt-value_1' });
    expect([...w.secrets]).toEqual(['/shop/JWT_SECRET']);
    const r = await runRelease(deps, 'r1');
    expect(r.status).toBe('succeeded');
    expect(w.calls).toEqual([`build ${REG}/shop-frontend:v1`, `build ${REG}/shop-backend:v1`, `build ${REG}/shop-api:v1`, 'tag v1', 'start v1']);
    expect(r.steps[0]!.message).toContain('the cluster shop in us-east-1');
    expect(JSON.stringify([r, w.calls])).not.toContain('jwt-value_1');
  });

  test('a release that does not answer puts the previous images back and starts them again', async () => {
    const { store, deps, w } = setup();
    w.secrets.add('/shop/JWT_SECRET');
    await plan(store, 'v1', 'r1'); expect((await runRelease(deps, 'r1')).status).toBe('succeeded');
    await plan(store, 'bad', 'r2', 'r1');
    w.calls.length = 0;
    const r = await runRelease(deps, 'r2');
    expect(r.status).toBe('rolled_back');
    expect(w.calls.filter((c) => c.startsWith('tag') || c.startsWith('start'))).toEqual(['tag bad', 'start bad', 'tag v1', 'start v1']);
  });

  test('an earlier release is put back without building anything, and a teardown is noticed by the cluster being gone', async () => {
    const { store, deps, w } = setup();
    w.secrets.add('/shop/JWT_SECRET');
    await plan(store, 'v1', 'r1'); await runRelease(deps, 'r1');
    await plan(store, 'v2', 'r2', 'r1'); await runRelease(deps, 'r2');
    w.calls.length = 0;
    await store.save(await createRollbackRelease(store, { targetId: 'r1', newId: 'r3', orgId: 'org', projectId: 'p1', createdBy: 'u', now: 99 }));
    expect((await runRelease(deps, 'r3')).status).toBe('succeeded');
    expect(w.calls).toEqual(['tag v1', 'start v1']);
    const r1 = (await store.get('r1'))!;
    expect(await reconcileDestroyed(deps, r1)).toBe(0);
    w.setExists(false);
    expect(await reconcileDestroyed(deps, r1)).toBeGreaterThanOrEqual(1);
    expect((await store.get('r1'))!.status).toBe('destroyed');
  });

  test('services that do not start fail the release before anything else changes, and say why', async () => {
    const { store, deps, w } = setup();
    w.secrets.add('/shop/JWT_SECRET');
    w.ecs.startServices = async () => { throw new AwsError('api did not start: tasks failed to start.'); };
    await plan(store, 'v1', 'r1');
    const r = await runRelease(deps, 'r1');
    expect(['failed', 'rolled_back']).toContain(r.status);
    expect(r.error).toMatch(/api did not start/);
  });
});
