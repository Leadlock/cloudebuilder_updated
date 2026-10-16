/**
 * A release on AWS (EC2): the bundle, the AWS operations (against fake SDK clients), the driver, and the whole state machine running through them.
 */
jest.mock('@/lib/terraform/execution/TerraformExecutionService', () => ({ planBundle: jest.fn(), runApply: jest.fn() }));
jest.mock('@/lib/terraform/execution/cli', () => ({ runTerraform: jest.fn() }));
import { defaultProject, generateProjectFiles, LAYERS, type Layer, type StackProject } from '@/lib/engines/containers/stackProject';
import { buildBundle, buildAzureVmBundle, BundleError, sourceFiles } from '@/lib/deploy/project/bundle';
import { AwsError, createAwsOps, type AwsClients, type AwsOps } from '@/lib/deploy/project/awsOps';
import { awsDriver } from '@/lib/deploy/project/awsDriver';
import { InMemoryReleaseStore } from '@/lib/deploy/project/releaseStore';
import { approveRelease, createRollbackRelease, newRelease, provideSecrets, reconcileDestroyed, runRelease, type OrchestratorDeps } from '@/lib/deploy/project/orchestrator';
import { outputsFrom, terraformFiles } from '@/lib/deploy/project/infra';
import { readZip } from '@/lib/deploy/project/zip';
import type { AwsOutputs } from '@/lib/deploy/project/types';

const OUT: AwsOutputs = {
  kind: 'ec2', region: 'us-east-1', instanceId: 'i-0abc123def456', releaseBucket: 'shop-123456789012', sourceBucket: 'shop-src-123456789012', codebuildProject: 'shop-build',
  registry: '123456789012.dkr.ecr.us-east-1.amazonaws.com', ssmPrefix: '/shop', url: 'http://203.0.113.9:8080/',
};

function project(on: Layer[] = ['frontend', 'backend', 'api', 'database'], tag = 'v1'): StackProject {
  const p = defaultProject();
  p.name = 'shop';
  for (const l of LAYERS) p.layers[l].enabled = on.includes(l);
  p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }];
  p.deploy.target = 'ec2';
  p.deploy.ec2.imageTag = tag;
  return p;
}

// ─── the bundle ──────────────────────────────────────────────────────────────

describe('the EC2 bundle of a release', () => {
  test('is the project\'s EC2 Terraform plus the CodeBuild that builds its images, which the downloaded files do not have', () => {
    const b = buildBundle(project());
    expect(b).toMatchObject({ target: 'ec2', project: 'shop', imageTag: 'v1', built: ['frontend', 'backend', 'api'], entry: { service: 'frontend', port: 8080 } });
    expect(b.secrets).toEqual(['JWT_SECRET', 'POSTGRES_PASSWORD']);
    expect(terraformFiles(b).map((f) => f.filename).sort()).toEqual(['compose.deploy.yml', 'main.tf', 'outputs.tf', 'user_data.sh', 'variables.tf']);
    const main = b.terraform.find((f) => f.filename === 'main.tf')!.content;
    for (const x of ['aws_codebuild_project" "build"', 'privileged_mode             = true', 'aws_s3_bucket" "source"', 'EcrPushTheseRepositories']) expect(main).toContain(x);
    const dl = generateProjectFiles(project());
    expect(dl.ok && dl.files.find((f) => f.path === 'ec2/main.tf')!.content).not.toContain('codebuild');
  });

  test('its CodeBuild may only write its logs, read the source bucket and push to this project\'s repositories', () => {
    const main = buildBundle(project()).terraform.find((f) => f.filename === 'main.tf')!.content;
    const policy = main.slice(main.indexOf('data "aws_iam_policy_document" "codebuild"'), main.indexOf('resource "aws_iam_role_policy" "codebuild"'));
    expect(policy).toContain('resources = [for r in aws_ecr_repository.svc : r.arn]');
    expect(policy).not.toMatch(/"\*:\*"|"ecr:\*"|"s3:\*"/);
    expect(policy.match(/sid\s+=/g)).toHaveLength(4);
  });

  test('outputs what the steps need', () => {
    const out = buildBundle(project()).terraform.find((f) => f.filename === 'outputs.tf')!.content;
    for (const o of ['output "region"', 'output "registry"', 'output "ssm_prefix"', 'output "codebuild_project"', 'output "source_bucket"', 'output "release_bucket"', 'output "instance_id"', 'output "app_url"']) expect(out).toContain(o);
  });

  test('with nothing built there is no CodeBuild and no source bucket', () => {
    const p = project(['frontend', 'api']);
    for (const l of ['frontend', 'api'] as const) p.layers[l].config = { ...p.layers[l].config, image: 'nginx:1.27' };
    const b = buildBundle(p);
    const main = b.terraform.find((f) => f.filename === 'main.tf')!.content;
    expect(main).not.toContain('codebuild');
    expect(b.terraform.find((f) => f.filename === 'outputs.tf')!.content).not.toContain('codebuild_project');
  });

  test('the tag, the target and the code are part of its hash, and it is not an Azure bundle', () => {
    const base = buildBundle(project()).bundleHash;
    expect(buildBundle(project(undefined, 'v2')).bundleHash).not.toBe(base);
    expect(buildBundle(project()).bundleHash).toBe(base);
    const p = project(); p.deploy.target = 'azure-vm';
    expect(buildBundle(p).bundleHash).not.toBe(base);
    expect(() => buildAzureVmBundle(project())).toThrow(BundleError);
  });

  test('a project that goes nowhere, or has one service, is not a release', () => {
    const p = project(); p.deploy.target = 'none';
    expect(() => buildBundle(p)).toThrow(/Azure VM or AWS EC2/);
    expect(() => buildBundle(project(['backend']))).toThrow(/two or more/);
  });

  test('the files of a service for CodeBuild are the generated folder, as a zip it can read', () => {
    const b = buildBundle(project());
    expect(sourceFiles(b, 'api').map((f) => f.path)).toContain('Dockerfile');
  });
});

describe('what Terraform created on AWS', () => {
  const ALL = JSON.stringify(Object.fromEntries(Object.entries({
    region: 'us-east-1', instance_id: 'i-0abc123def456', release_bucket: 'shop-123456789012', registry: '123456789012.dkr.ecr.us-east-1.amazonaws.com', ssm_prefix: '/shop',
    app_url: 'http://203.0.113.9:8080/', codebuild_project: 'shop-build', source_bucket: 'shop-src-123456789012',
  }).map(([k, v]) => [k, { value: v }])));
  test('is read from its outputs', () => { expect(outputsFrom(ALL, 'ec2')).toEqual(OUT); });
  test.each(['region', 'instance_id', 'release_bucket', 'registry', 'ssm_prefix', 'app_url'])('without %s the step fails with that name', (k) => {
    const o = JSON.parse(ALL); delete o[k];
    expect(() => outputsFrom(JSON.stringify(o), 'ec2')).toThrow(`Terraform did not report ${k}.`);
  });
  test('a project with nothing built has no builder, which is fine', () => {
    const o = JSON.parse(ALL); delete o.codebuild_project; delete o.source_bucket;
    expect(outputsFrom(JSON.stringify(o), 'ec2')).toMatchObject({ kind: 'ec2', sourceBucket: '', codebuildProject: '' });
  });
});

// ─── the AWS operations, against fake SDK clients ────────────────────────────

type Handler = (input: any) => unknown;   // eslint-disable-line @typescript-eslint/no-explicit-any
function fake(handlers: Record<string, Handler>) {
  const log: Array<{ name: string; input: any }> = [];   // eslint-disable-line @typescript-eslint/no-explicit-any
  const send = async (command: unknown) => {
    const c = command as { constructor: { name: string }; input: unknown };
    log.push({ name: c.constructor.name, input: c.input });
    const h = handlers[c.constructor.name];
    if (!h) throw Object.assign(new Error(`no handler for ${c.constructor.name}`), { name: 'NoHandler' });
    return h(c.input);
  };
  return { sender: { send }, log };
}
const err = (name: string, message = name, status?: number) => Object.assign(new Error(message), { name, ...(status ? { $metadata: { httpStatusCode: status } } : {}) });
const noSleep = { sleep: async () => undefined, pollMs: 1 };
const ops = (h: { ssm?: Record<string, Handler>; s3?: Record<string, Handler>; codebuild?: Record<string, Handler> }, extra: Partial<Parameters<typeof createAwsOps>[0]> = {}) => {
  const ssm = fake(h.ssm ?? {}); const s3 = fake(h.s3 ?? {}); const codebuild = fake(h.codebuild ?? {});
  const clients: AwsClients = { ssm: ssm.sender, s3: s3.sender, codebuild: codebuild.sender };
  return { ops: createAwsOps({ clients, ...noSleep, ...extra }), ssm, s3, codebuild };
};

describe('secrets in Parameter Store', () => {
  test('a secret that exists is found without being read, one that does not is not, anything else is an error', async () => {
    const t = ops({ ssm: { GetParameterCommand: (i) => { if (i.Name === '/shop/NOPE') throw err('ParameterNotFound'); if (i.Name === '/shop/DENIED') throw err('AccessDeniedException', 'no'); return { Parameter: { Value: 'x' } }; } } });
    expect(await t.ops.secretExists('/shop/JWT_SECRET')).toBe(true);
    expect(t.ssm.log[0]!.input).toMatchObject({ Name: '/shop/JWT_SECRET', WithDecryption: false });
    expect(await t.ops.secretExists('/shop/NOPE')).toBe(false);
    await expect(t.ops.secretExists('/shop/DENIED')).rejects.toThrow(/AccessDeniedException: no/);
  });
  test('is stored as an encrypted string that is not overwritten, and the value goes nowhere else', async () => {
    const t = ops({ ssm: { PutParameterCommand: () => ({}) } });
    await t.ops.putSecret('/shop/JWT_SECRET', 'jwt-value_1');
    expect(t.ssm.log[0]!.input).toEqual({ Name: '/shop/JWT_SECRET', Value: 'jwt-value_1', Type: 'SecureString', Overwrite: false });
  });
  test('a secret stored in the meantime is fine; a refusal says what role is missing and never shows the value', async () => {
    await expect(ops({ ssm: { PutParameterCommand: () => { throw err('ParameterAlreadyExists'); } } }).ops.putSecret('/shop/A_B', 'v')).resolves.toBeUndefined();
    const e = await ops({ ssm: { PutParameterCommand: () => { throw err('AccessDeniedException', 'not authorized'); } } }).ops.putSecret('/shop/A_B', 'super-secret-value').catch((x: Error) => x);
    expect((e as Error).message).toMatch(/Could not store secret \/shop\/A_B: AccessDeniedException: not authorized \(the account's role needs ssm:PutParameter/);
    expect((e as Error).message).not.toContain('super-secret-value');
  });
  test.each(['shop/A', '/shop/a_lower', '/Shop/A', '/shop/../A', '/shop/A/B', '/shop/A B', ''])('the name %j is refused before any request', async (path) => {
    const t = ops({});
    await expect(t.ops.secretExists(path)).rejects.toThrow(AwsError);
    await expect(t.ops.putSecret(path, 'x')).rejects.toThrow(AwsError);
    expect(t.ssm.log).toHaveLength(0);
  });
});

describe('building an image with CodeBuild', () => {
  const args = { codebuildProject: 'shop-build', sourceBucket: 'shop-src-123456789012', registry: OUT.registry, image: `${OUT.registry}/shop-api:v1`, zip: Buffer.from('PK-zip') };
  function build(statuses: string[], extra: Record<string, Handler> = {}, phases: unknown[] = []) {
    let n = 0;
    return ops({
      s3: { PutObjectCommand: () => ({}), DeleteObjectCommand: () => ({}) },
      codebuild: { StartBuildCommand: () => ({ build: { id: 'shop-build:abc' } }), BatchGetBuildsCommand: () => ({ builds: [{ buildStatus: statuses[Math.min(n++, statuses.length - 1)], currentPhase: 'BUILD', phases }] }), ...extra },
    });
  }

  test('uploads the source to the bucket, starts a build of that object with the registry and image, waits, and removes the source', async () => {
    const t = build(['IN_PROGRESS', 'IN_PROGRESS', 'SUCCEEDED']);
    const lines: string[] = [];
    await t.ops.buildImage({ ...args, onLog: (l) => lines.push(l) });
    const put = t.s3.log.find((l) => l.name === 'PutObjectCommand')!.input;
    expect(put).toMatchObject({ Bucket: 'shop-src-123456789012', ServerSideEncryption: 'AES256' });
    expect(put.Key).toMatch(/^src\/[0-9a-f-]{36}\.zip$/);
    const start = t.codebuild.log.find((l) => l.name === 'StartBuildCommand')!.input;
    expect(start).toMatchObject({ projectName: 'shop-build', sourceTypeOverride: 'S3', sourceLocationOverride: `shop-src-123456789012/${put.Key}` });
    expect(start.environmentVariablesOverride).toEqual([{ name: 'REGISTRY', value: OUT.registry, type: 'PLAINTEXT' }, { name: 'IMAGE', value: args.image, type: 'PLAINTEXT' }]);
    expect(t.codebuild.log.filter((l) => l.name === 'BatchGetBuildsCommand')).toHaveLength(3);
    expect(t.s3.log.find((l) => l.name === 'DeleteObjectCommand')!.input).toEqual({ Bucket: 'shop-src-123456789012', Key: put.Key });
    expect(lines.at(-1)).toBe(`${args.image}: built and pushed`);
  });

  test.each(['FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'])('a build that ends %s fails with the phase that failed, and the source is still removed', async (status) => {
    const t = build([status], {}, [{ phaseType: 'BUILD', phaseStatus: 'FAILED', contexts: [{ message: 'Command did not exit successfully docker build' }] }, { phaseType: 'SUBMITTED', phaseStatus: 'SUCCEEDED' }]);
    await expect(t.ops.buildImage(args)).rejects.toThrow(new RegExp(`${status.toLowerCase().replace('_', ' ')}\\. BUILD: Command did not exit successfully docker build`));
    expect(t.s3.log.some((l) => l.name === 'DeleteObjectCommand')).toBe(true);
  });

  test('a source that cannot be uploaded, or a build that cannot be started, is reported, and nothing is left behind', async () => {
    const noUpload = ops({ s3: { PutObjectCommand: () => { throw err('AccessDenied', 'denied'); } } });
    await expect(noUpload.ops.buildImage(args)).rejects.toThrow(/Could not upload the source.*AccessDenied: denied/);
    const noStart = build(['SUCCEEDED'], { StartBuildCommand: () => { throw err('ResourceNotFoundException', 'no such project'); } });
    await expect(noStart.ops.buildImage(args)).rejects.toThrow(/Could not start the build.*no such project/);
    expect(noStart.s3.log.some((l) => l.name === 'DeleteObjectCommand')).toBe(true);
  });

  test('a build that never ends is given up on', async () => {
    const t = ops({ s3: { PutObjectCommand: () => ({}), DeleteObjectCommand: () => ({}) }, codebuild: { StartBuildCommand: () => ({ build: { id: 'b' } }), BatchGetBuildsCommand: () => ({ builds: [{ buildStatus: 'IN_PROGRESS' }] }) } }, { buildTimeoutMs: -1 });
    await expect(t.ops.buildImage(args)).rejects.toThrow(/did not finish in time/);
  });

  test('names that could point somewhere else are refused before anything is uploaded', async () => {
    const t = build(['SUCCEEDED']);
    for (const bad of [{ sourceBucket: 'Bad_Bucket' }, { registry: 'evil.example.com' }, { image: 'evil.example.com/shop-api:v1' }, { image: `${OUT.registry}/shop-api` }, { codebuildProject: '../x' }]) await expect(t.ops.buildImage({ ...args, ...bad })).rejects.toThrow(AwsError);
    expect(t.s3.log).toHaveLength(0);
  });
});

describe('the release files and the restart', () => {
  test('the compose file and the tag go to the release bucket, encrypted', async () => {
    const t = ops({ s3: { PutObjectCommand: () => ({}) } });
    await t.ops.putReleaseFiles('shop-123456789012', { compose: 'services: {}\n', tag: 'v2' });
    expect(t.s3.log.map((l) => [l.input.Key, l.input.Body])).toEqual([['compose.yml', 'services: {}\n'], ['release.env', 'TAG=v2\n']]);
    expect(t.s3.log.every((l) => l.input.Bucket === 'shop-123456789012' && l.input.ServerSideEncryption === 'AES256')).toBe(true);
    await expect(t.ops.putReleaseFiles('shop-123456789012', { compose: 'x', tag: 'a b' })).rejects.toThrow(/tag is not valid/);
    await expect(t.ops.putReleaseFiles('Bad Bucket', { compose: 'x', tag: 'v1' })).rejects.toThrow(AwsError);
  });

  test('restart is a run command on the instance, followed to its end', async () => {
    let polls = 0;
    const t = ops({ ssm: { SendCommandCommand: () => ({ Command: { CommandId: 'cmd-1' } }), GetCommandInvocationCommand: () => { if (++polls === 1) throw err('InvocationDoesNotExist'); return { Status: polls < 3 ? 'InProgress' : 'Success' }; } } });
    await t.ops.restartService('i-0abc123def456', 'shop');
    expect(t.ssm.log[0]!.input).toMatchObject({ InstanceIds: ['i-0abc123def456'], DocumentName: 'AWS-RunShellScript', Parameters: { commands: ['systemctl restart shop.service'] } });
    expect(polls).toBe(3);
  });

  test('a failed restart says why; a new instance Systems Manager does not know yet is waited for, then reported', async () => {
    const failed = ops({ ssm: { SendCommandCommand: () => ({ Command: { CommandId: 'c' } }), GetCommandInvocationCommand: () => ({ Status: 'Failed', StandardErrorContent: 'Unit shop.service not found.' }) } });
    await expect(failed.ops.restartService('i-0abc123def456', 'shop')).rejects.toThrow(/restart failed on the instance \(failed\): Unit shop.service not found/);
    let tries = 0;
    const slow = ops({ ssm: { SendCommandCommand: () => { if (++tries < 4) throw err('InvalidInstanceId'); return { Command: { CommandId: 'c' } }; }, GetCommandInvocationCommand: () => ({ Status: 'Success' }) } });
    await slow.ops.restartService('i-0abc123def456', 'shop');
    expect(tries).toBe(4);
    const never = ops({ ssm: { SendCommandCommand: () => { throw err('InvalidInstanceId'); } } }, { instanceWaitMs: 0 });
    await expect(never.ops.restartService('i-0abc123def456', 'shop')).rejects.toThrow(/not reachable by Systems Manager yet/);
  });

  test('an instance or project name that could change the command is refused first', async () => {
    const t = ops({});
    await expect(t.ops.restartService('i-0abc123def456', 'shop; rm -rf /')).rejects.toThrow(AwsError);
    await expect(t.ops.restartService('not-an-instance', 'shop')).rejects.toThrow(AwsError);
    expect(t.ssm.log).toHaveLength(0);
  });

  test('a bucket is there for a success, gone for "not found", and a refusal is an error, never "gone"', async () => {
    expect(await ops({ s3: { HeadBucketCommand: () => ({}) } }).ops.bucketExists('shop-123456789012')).toBe(true);
    expect(await ops({ s3: { HeadBucketCommand: () => { throw err('NotFound', 'x', 404); } } }).ops.bucketExists('shop-123456789012')).toBe(false);
    await expect(ops({ s3: { HeadBucketCommand: () => { throw err('Forbidden', 'x', 403); } } }).ops.bucketExists('shop-123456789012')).rejects.toThrow(/Could not look for the bucket/);
  });

  test('the address answers for a success status only, and never throws', async () => {
    const f = (async (url: string) => (String(url).includes('up') ? new Response('ok') : new Response('', { status: 502 }))) as unknown as typeof fetch;
    const o = ops({}, { fetchImpl: f }).ops;
    expect(await o.httpOk('http://up/')).toBe(true);
    expect(await o.httpOk('http://down/')).toBe(false);
    expect(await ops({}, { fetchImpl: (async () => { throw new Error('refused'); }) as unknown as typeof fetch }).ops.httpOk('http://x/')).toBe(false);
  });
});

// ─── the driver ──────────────────────────────────────────────────────────────

describe('the AWS driver', () => {
  function recorder() {
    const calls: string[] = []; const vault = new Set<string>(); let zip: Buffer | null = null;
    const o: AwsOps = {
      secretExists: async (p) => vault.has(p), putSecret: async (p) => { calls.push(`putSecret ${p}`); vault.add(p); },
      buildImage: async (a) => { calls.push(`build ${a.image} ${a.codebuildProject} ${a.sourceBucket}`); zip = a.zip; },
      putReleaseFiles: async (b, a) => { calls.push(`release ${b} ${a.tag}`); }, restartService: async (i, p) => { calls.push(`restart ${i} ${p}`); },
      bucketExists: async () => true, httpOk: async () => true,
    };
    return { o, calls, vault, zip: () => zip };
  }
  test('maps a release onto the operations: secrets under the project\'s path, the image in the account\'s registry, the release bucket and the instance', async () => {
    const r = recorder(); const d = awsDriver(r.o);
    await d.putSecret(OUT, 'JWT_SECRET', 'v');
    expect(await d.secretExists(OUT, 'JWT_SECRET')).toBe(true);
    expect(await d.secretExists(OUT, 'OTHER')).toBe(false);
    await d.build(OUT, { project: 'shop', layer: 'api', tag: 'v1', files: [{ path: 'Dockerfile', content: 'FROM scratch\n' }, { path: 'a.bin', content: Buffer.from([1, 2, 255]) }] });
    await d.publish(OUT, { project: 'shop', tag: 'v1', compose: 'x' });
    await d.start(OUT, { project: 'shop' });
    expect(r.calls).toEqual([
      'putSecret /shop/JWT_SECRET', `build ${OUT.registry}/shop-api:v1 shop-build shop-src-123456789012`, 'release shop-123456789012 v1', 'restart i-0abc123def456 shop',
    ]);
    expect(readZip(r.zip()!).files.map((f) => f.path)).toEqual(['Dockerfile', 'a.bin']);
    expect(d.describe(OUT)).toContain('i-0abc123def456');
    expect(d.same(OUT, { ...OUT })).toBe(true);
    expect(d.same(OUT, { ...OUT, releaseBucket: 'other' })).toBe(false);
  });
  test('refuses the outputs of the other cloud', async () => {
    const d = awsDriver(recorder().o);
    await expect(async () => d.secretExists({ resourceGroup: 'rg', vmName: 'vm', acrName: 'a', vaultName: 'v', url: 'u' }, 'X')).rejects.toThrow(/not an AWS one/);
  });
});

// ─── a whole release on AWS ──────────────────────────────────────────────────

describe('a release on AWS, from the first step to the last', () => {
  function world() {
    const calls: string[] = []; const secrets = new Set<string>(); const files: Record<string, string> = {}; let live = 'none'; let up = true;
    const o: AwsOps = {
      secretExists: async (p) => secrets.has(p), putSecret: async (p) => { secrets.add(p); },
      buildImage: async (a) => { calls.push(`build ${a.image}`); },
      putReleaseFiles: async (_b, a) => { calls.push(`release ${a.tag}`); files['tag'] = a.tag; files['compose'] = a.compose; },
      restartService: async () => { calls.push(`restart ${files['tag']}`); live = files['tag']!; },
      bucketExists: async () => exists, httpOk: async () => up && live !== 'bad',
    };
    let exists = true;
    return { o, calls, secrets, files, setUp: (v: boolean) => { up = v; }, setExists: (v: boolean) => { exists = v; } };
  }
  function setup(w = world()) {
    const store = new InMemoryReleaseStore();
    let clock = 1000;
    const deps: OrchestratorDeps = { store, driver: awsDriver(w.o), infra: { apply: async () => OUT }, now: () => ++clock, sleep: async () => undefined, verifyWaitMs: 50, verifyEveryMs: 1 };
    return { store, deps, w };
  }
  async function plan(store: InMemoryReleaseStore, tag: string, id: string, prev: string | null = null) {
    const p = project(undefined, tag);
    const bundle = buildBundle(p);
    await store.save(newRelease({ id, orgId: 'org', projectId: 'p1', environment: 'production', cloudAccountId: 'a', project: p, bundle, createdBy: 'u', previousReleaseId: prev, planId: 'pl', planHash: 'h', now: 1 }));
    await approveRelease(store, id, { bundleHash: bundle.bundleHash, planHash: 'h' }, 2);
  }

  test('creates the infrastructure, waits for the secrets, builds in the account, writes the release files, restarts, checks the address', async () => {
    const { store, deps, w } = setup();
    await plan(store, 'v1', 'r1');
    const first = await runRelease(deps, 'r1');
    expect(first.status).toBe('waiting');
    expect(first.steps.find((s) => s.name === 'secrets')!.message).toBe('Waiting for JWT_SECRET, POSTGRES_PASSWORD');
    await provideSecrets(deps, 'r1', { JWT_SECRET: 'jwt-value_1', POSTGRES_PASSWORD: 'pg.pass-2' });
    expect([...w.secrets].sort()).toEqual(['/shop/JWT_SECRET', '/shop/POSTGRES_PASSWORD']);
    const r = await runRelease(deps, 'r1');
    expect(r.status).toBe('succeeded');
    expect(w.calls).toEqual([`build ${OUT.registry}/shop-frontend:v1`, `build ${OUT.registry}/shop-backend:v1`, `build ${OUT.registry}/shop-api:v1`, 'release v1', 'restart v1']);
    expect(r.steps[0]!.message).toContain('i-0abc123def456');
    expect(JSON.stringify([r, w.calls])).not.toMatch(/jwt-value_1|pg\.pass-2/);
  });

  test('a release that does not answer puts the previous release back (its tag and compose file), and says so', async () => {
    const { store, deps, w } = setup();
    w.secrets.add('/shop/JWT_SECRET'); w.secrets.add('/shop/POSTGRES_PASSWORD');
    await plan(store, 'v1', 'r1'); expect((await runRelease(deps, 'r1')).status).toBe('succeeded');
    await plan(store, 'bad', 'r2', 'r1');
    w.calls.length = 0;
    const r = await runRelease(deps, 'r2');
    expect(r.status).toBe('rolled_back');
    expect(r.error).toMatch(/previous release \(v1\) was put back and answers/);
    expect(w.calls.filter((c) => c.startsWith('release') || c.startsWith('restart'))).toEqual(['release bad', 'restart bad', 'release v1', 'restart v1']);
    expect(w.files['tag']).toBe('v1');
  });

  test('an earlier release can be put back by writing its files again, with nothing built', async () => {
    const { store, deps, w } = setup();
    w.secrets.add('/shop/JWT_SECRET'); w.secrets.add('/shop/POSTGRES_PASSWORD');
    await plan(store, 'v1', 'r1'); await runRelease(deps, 'r1');
    await plan(store, 'v2', 'r2', 'r1'); await runRelease(deps, 'r2');
    w.calls.length = 0;
    const rb = await createRollbackRelease(store, { targetId: 'r1', newId: 'r3', orgId: 'org', projectId: 'p1', createdBy: 'u', now: 99 });
    await store.save(rb);
    expect((await runRelease(deps, 'r3')).status).toBe('succeeded');
    expect(w.calls).toEqual(['release v1', 'restart v1']);
  });

  test('after a teardown the releases are marked destroyed because the release bucket is gone', async () => {
    const { store, deps, w } = setup();
    w.secrets.add('/shop/JWT_SECRET'); w.secrets.add('/shop/POSTGRES_PASSWORD');
    await plan(store, 'v1', 'r1'); await runRelease(deps, 'r1');
    const r1 = (await store.get('r1'))!;
    expect(await reconcileDestroyed(deps, r1)).toBe(0);
    w.setExists(false);
    expect(await reconcileDestroyed(deps, r1)).toBe(1);
    expect((await store.get('r1'))!.status).toBe('destroyed');
  });

  test('a build that fails stops the release before anything is written to the server', async () => {
    const { store, deps, w } = setup();
    w.secrets.add('/shop/JWT_SECRET'); w.secrets.add('/shop/POSTGRES_PASSWORD');
    w.o.buildImage = async () => { throw new AwsError('The build of x failed. BUILD: docker build failed'); };
    await plan(store, 'v1', 'r1');
    const r = await runRelease(deps, 'r1');
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/^build: The build of x failed/);
    expect(w.calls.some((c) => c.startsWith('release') || c.startsWith('restart'))).toBe(false);
  });
});
