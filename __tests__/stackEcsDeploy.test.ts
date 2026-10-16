/**
 * Deploying a whole project (Frontend, Backend, API) to ECS Fargate: Terraform for the cluster, load balancer and one service per service,
 * and deploy.sh / destroy.sh (syntax-checked; the Terraform is validated by the real terraform in scripts/validate-containers.ts).
 */
import { spawnSync } from 'child_process';
import { generateProjectFiles, defaultProject, LAYERS, type Layer, type StackProject } from '@/lib/engines/containers/stackProject';

const APPS: Layer[] = ['frontend', 'backend', 'api'];
const project = (on: Layer[], tweak?: (p: StackProject) => void): StackProject => {
  const p = defaultProject();
  p.name = 'shop';
  for (const l of LAYERS) p.layers[l].enabled = on.includes(l);
  p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }, { key: 'LOG_LEVEL', value: 'say "hi" ${HOME}' }];
  p.layers.api.config.env = [{ key: 'STRIPE_KEY', value: '', secret: true }];
  p.deploy.target = 'ecs';
  tweak?.(p);
  return p;
};
const gen = (on: Layer[], tweak?: (p: StackProject) => void, forRelease = false) => {
  const r = generateProjectFiles(project(on, tweak), { forRelease });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r;
};
type R = ReturnType<typeof gen>;
const file = (r: R, path: string) => r.files.find((f) => f.path === path)?.content ?? '';
const errorsOf = (p: StackProject) => { const r = generateProjectFiles(p); return r.ok ? '' : r.errors.join(' | '); };

describe('the files', () => {
  test('Terraform, the two scripts and a README, with the local files kept and no compose file for the cluster', () => {
    const r = gen(APPS);
    const paths = r.files.map((f) => f.path);
    for (const p of ['deploy.sh', 'destroy.sh', 'ecs/main.tf', 'ecs/variables.tf', 'ecs/outputs.tf', 'ecs/README.md', 'docker-compose.yml', 'frontend/Dockerfile', 'backend/Dockerfile', 'api/Dockerfile']) expect(paths).toContain(p);
    expect(paths.some((p) => p.endsWith('compose.deploy.yml'))).toBe(false);
    for (const f of ['deploy.sh', 'destroy.sh']) expect(spawnSync('bash', ['-n'], { input: file(r, f), encoding: 'utf8' })).toMatchObject({ status: 0, stderr: '' });
  });

  test('one service, one repository and one task definition per service, behind a load balancer that reaches the public service only', () => {
    const tf = file(gen(APPS), 'ecs/main.tf');
    expect(tf).toContain('built = ["frontend", "backend", "api"]');
    for (const l of APPS) expect(tf).toMatch(new RegExp(`    ${l} = \\{\\n      port    = `));
    expect(tf).toContain('entry = "frontend"');
    expect(tf).toContain('resource "aws_ecs_service" "svc"');
    expect(tf).toContain('for_each        = local.services');
    expect(tf).toContain('each.key == local.entry ? [1] : []');
    expect(tf).toContain('from_port       = local.services[local.entry].port');      // only the public service's port from the load balancer
    expect(tf).toContain('self        = true');                                       // services reach each other
  });

  test('the services find each other by the same names as in Docker Compose', () => {
    const tf = file(gen(APPS), 'ecs/main.tf');
    expect(tf).toContain('aws_service_discovery_http_namespace');
    expect(tf).toContain('dns_name = each.key');
    expect(tf).toMatch(/"BACKEND_URL" = "http:\/\/backend:\d+"/);
  });

  test('secrets are read from Parameter Store by ECS, never written into the Terraform, and variables are escaped', () => {
    const r = gen(APPS);
    const tf = file(r, 'ecs/main.tf');
    expect(tf).toContain('secrets = ["JWT_SECRET"]');
    expect(tf).toContain('secrets = ["STRIPE_KEY"]');
    expect(tf).toContain('parameter/${var.app_name}/${n}');
    expect(tf).toContain('"LOG_LEVEL" = "say \\"hi\\" $${HOME}"');
    expect(tf).toContain('sid       = "ReadThisProjectsSecrets"');
    expect(tf).toContain('deployment_circuit_breaker');
    expect(tf).toContain('scan_on_push = true');
  });

  test('a ready-made image has no repository and keeps its image', () => {
    const r = gen(['frontend', 'api'], (p) => { for (const l of ['frontend', 'api'] as const) p.layers[l].config = { ...p.layers[l].config, image: 'nginx:1.27' }; });
    const tf = file(r, 'ecs/main.tf');
    expect(tf).toContain('built = []');
    expect(tf).toContain('image   = "nginx:1.27"');
    expect(tf).not.toContain('resource "aws_ecr_repository"');
    expect(file(r, 'deploy.sh')).toContain('Every service uses a ready-made image');
  });

  test('HTTPS adds the certificate and the redirect', () => {
    const tf = file(gen(APPS, (p) => { p.deploy.ecs.certificateArn = 'arn:aws:acm:us-east-1:123456789012:certificate/abc-123'; }), 'ecs/main.tf');
    expect(tf).toContain('resource "aws_lb_listener" "https"');
    expect(tf).toContain('status_code = "HTTP_301"');
    expect(file(gen(APPS), 'ecs/main.tf')).not.toContain('"https"');
  });

  test('the files a person downloads have no CodeBuild; a release has it, with no tasks started and Terraform leaving the services alone', () => {
    const dl = file(gen(APPS), 'ecs/main.tf');
    expect(dl).not.toContain('codebuild');
    expect(dl).toContain('desired_count   = var.desired_count');
    expect(dl).toContain('wait_for_steady_state = true');
    expect(dl).not.toContain('ignore_changes');
    const rel = gen(APPS, undefined, true);
    const tf = file(rel, 'ecs/main.tf');
    expect(tf).toContain('aws_codebuild_project" "build"');
    expect(tf).toContain('desired_count   = 0');
    expect(tf).toContain('ignore_changes = [task_definition, desired_count]');
    expect(tf).toContain('skip_destroy             = true');
    expect(tf).not.toContain('wait_for_steady_state');
    const out = file(rel, 'ecs/outputs.tf');
    for (const o of ['output "cluster"', 'output "services"', 'output "registry"', 'output "ssm_prefix"', 'output "desired_count"', 'output "codebuild_project"', 'output "source_bucket"', 'output "app_url"']) expect(out).toContain(o);
    expect(file(gen(APPS), 'ecs/outputs.tf')).not.toContain('codebuild_project');
  });

  test('deploy.sh creates the repositories, asks for the secrets, builds, then creates the services; destroy.sh asks for the name', () => {
    const r = gen(APPS);
    const d = file(r, 'deploy.sh');
    expect(d.indexOf('-target=aws_ecr_repository.svc')).toBeLessThan(d.indexOf('put-parameter'));
    expect(d.indexOf('put-parameter')).toBeLessThan(d.indexOf('docker build'));
    expect(d.indexOf('docker build')).toBeLessThan(d.indexOf('terraform -chdir=ecs apply ${APPROVE'));
    expect(d).toContain('SECRETS=(\'JWT_SECRET\' \'STRIPE_KEY\')');
    expect(d).toContain('--platform linux/amd64');
    expect(file(r, 'destroy.sh')).toContain('Type the project name ($APP)');
  });
});

describe('what is refused or warned about', () => {
  test('a database is not run on Fargate', () => {
    expect(errorsOf(project(['backend', 'api', 'database']))).toMatch(/ECS: a Database is not run on Fargate/);
  });
  test.each([
    ['name', (p: StackProject) => { p.name = 'my_shop'; }, /load balancer name/],
    ['region', (p: StackProject) => { p.deploy.ecs.region = 'mars'; }, /region looks like/],
    ['cpu', (p: StackProject) => { p.deploy.ecs.cpu = 300; }, /CPU must be/],
    ['memory', (p: StackProject) => { p.deploy.ecs.memoryMb = 300; }, /memory must be one of/],
    ['count', (p: StackProject) => { p.deploy.ecs.desiredCount = 0; }, /1 to 20/],
    ['cidr', (p: StackProject) => { p.deploy.ecs.allowedCidr = 'everyone'; }, /IPv4 range/],
    ['certificate', (p: StackProject) => { p.deploy.ecs.certificateArn = 'nope'; }, /ACM certificate ARN/],
    ['tag', (p: StackProject) => { p.deploy.ecs.imageTag = 'a b'; }, /image tag/],
  ])('a bad %s is refused', (_n, tweak, re) => {
    const p = project(APPS); tweak(p);
    expect(errorsOf(p)).toMatch(re);
  });
  test('warnings say what to know, and a cost is shown', () => {
    const r = gen(APPS);
    expect(r.warnings.join('\n')).toMatch(/plain HTTP/);
    expect(r.warnings.join('\n')).toMatch(/whole internet/);
    expect(r.warnings.join('\n')).toMatch(/JWT_SECRET, STRIPE_KEY/);
    expect(r.warnings.join('\n')).toMatch(/no database on Fargate/);
    expect(r.cost?.lines.map((l) => l.label).join('|')).toMatch(/3 Fargate tasks.*Application Load Balancer/);
    expect(r.cost!.monthlyUsd).toBeGreaterThan(50);
  });
  test('one service keeps its own single-service ECS deployment', () => {
    const r = generateProjectFiles(project(['backend']));
    expect(r.ok && r.files.map((f) => f.path).some((p) => p.startsWith('ecs/'))).toBe(false);
  });
});
