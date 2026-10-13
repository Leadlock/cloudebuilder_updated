/**
 * Generates the Container Templates deployment bundles (ECS Fargate, Azure Container Apps, Kubernetes) and checks them with the real tools:
 * `terraform validate` for ECS and Container Apps (needs a terraform binary: TERRAFORM_BIN), `kubectl kustomize` and
 * `helm lint` / `helm template` for Kubernetes (kubectl and helm on the PATH). Not part of `npm test`: terraform downloads the providers.
 * Run: TERRAFORM_BIN=/path/to/terraform npx tsx --tsconfig tsconfig.json scripts/validate-containers.ts [dir]
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { defaultConfig, generateContainerFiles, withDeployTarget, type ContainerConfig } from '../lib/engines/containers/dockerTemplates';

const tf = process.env.TERRAFORM_BIN ?? 'terraform';
const root = process.argv[2] ?? '/tmp/validate-containers';
const base = (): ContainerConfig => ({
  ...defaultConfig('python'), appName: 'orders-api', port: 8000, healthPath: '/health',
  env: [{ key: 'LOG_LEVEL', value: 'say "hi" ${HOME}' }, { key: 'API_TOKEN', value: '', secret: true }],
});
const make = (target: Parameters<typeof withDeployTarget>[1], edit: (c: ContainerConfig) => void = () => {}) => {
  const c = withDeployTarget(base(), target);
  c.k8s.image = 'ghcr.io/acme/orders-api:1.0';
  edit(c);
  return c;
};

type Kind = 'terraform' | 'kubernetes' | 'both';
const cases: Array<[string, Kind, string, ContainerConfig]> = [
  ['ecs-http', 'terraform', 'ecs', make('ecs')],
  ['ecs-https-autoscaling-github', 'terraform', 'ecs', make('ecs', (c) => { c.ecs.certificateArn = 'arn:aws:acm:us-east-1:123456789012:certificate/abc-123'; c.ecs.autoscaling = true; c.ecs.githubRepo = 'acme/orders'; c.ecs.cpu = 1024; c.ecs.memoryMb = 4096; })],
  ['ecs-no-env', 'terraform', 'ecs', make('ecs', (c) => { c.env = []; })],
  ['aca-default', 'terraform', 'aca', make('container-apps')],
  ['aca-internal-restricted', 'terraform', 'aca', make('container-apps', (c) => { c.aca.allowedCidr = '203.0.113.0/24'; c.aca.minReplicas = 0; c.aca.cpu = 1.25; })],
  ['aca-no-env', 'terraform', 'aca', make('container-apps', (c) => { c.env = []; })],
  ['azvm-default', 'terraform', 'azvm', make('azure-vm')],
  ['azvm-restricted-no-env', 'terraform', 'azvm', make('azure-vm', (c) => { c.env = []; c.azvm.allowedCidr = '203.0.113.0/24'; c.azvm.size = 'Standard_D2s_v3'; c.azvm.githubRepo = 'acme/orders'; })],
  ['aks-default', 'both', 'aks', make('aks')],
  ['aks-ingress-autoscale', 'both', 'aks', make('aks', (c) => { c.k8s.namespace = 'shop'; c.k8s.ingressHost = 'orders.example.com'; c.k8s.autoscaling = true; c.aks.maxNodes = 5; })],
  ['ec2-default', 'terraform', 'ec2', make('ec2')],
  ['ec2-existing-image', 'terraform', 'ec2', make('ec2', (c) => { c.image = 'ghcr.io/acme/orders-api:1.4.2'; })],
  ['ec2-existing-image-no-env', 'terraform', 'ec2', make('ec2', (c) => { c.image = 'nginx:1.27'; c.env = []; })],
  ['ecs-existing-image', 'terraform', 'ecs', make('ecs', (c) => { c.image = 'ghcr.io/acme/orders-api:1.4.2'; })],
  ['aca-existing-image', 'terraform', 'aca', make('container-apps', (c) => { c.image = 'ghcr.io/acme/orders-api:1.4.2'; })],
  ['aca-existing-image-no-env', 'terraform', 'aca', make('container-apps', (c) => { c.image = 'nginx:1.27'; c.env = []; })],
  ['azvm-existing-image', 'terraform', 'azvm', make('azure-vm', (c) => { c.image = 'ghcr.io/acme/orders-api:1.4.2'; })],
  ['aks-existing-image', 'both', 'aks', make('aks', (c) => { c.image = 'ghcr.io/acme/orders-api:1.4.2'; })],
  ['aks-existing-image-no-env', 'both', 'aks', make('aks', (c) => { c.image = 'nginx:1.27'; c.env = []; })],
  ['k8s-existing-image', 'kubernetes', 'k8s', make('kubernetes', (c) => { c.image = 'nginx:1.27'; c.k8s.image = ''; })],
  ['k8s-full', 'kubernetes', 'k8s', make('kubernetes', (c) => { c.k8s.namespace = 'shop'; c.k8s.ingressHost = 'orders.example.com'; c.k8s.tlsSecret = 'orders-tls'; c.k8s.autoscaling = true; })],
  ['k8s-minimal', 'kubernetes', 'k8s', make('kubernetes', (c) => { c.env = []; c.k8s.replicas = 1; })],
  ['k8s-java', 'kubernetes', 'k8s', (() => { const c = withDeployTarget({ ...defaultConfig('java'), appName: 'svc' }, 'kubernetes'); c.k8s.image = 'ghcr.io/acme/svc:2'; return c; })()],
  ['k8s-static', 'kubernetes', 'k8s', (() => { const c = withDeployTarget({ ...defaultConfig('static'), appName: 'site' }, 'kubernetes'); c.k8s.image = 'ghcr.io/acme/site:2'; return c; })()],
];

const run = (cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, TF_IN_AUTOMATION: '1', TF_PLUGIN_CACHE_DIR: join(root, '.plugins'), ...env } });

rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, '.plugins'), { recursive: true });
let failed = 0;
const fail = (name: string, what: string, out: { stdout: string; stderr: string }) => { failed++; console.log(`${name}: ${what} FAILED\n${(out.stderr || out.stdout).slice(0, 2500)}`); };

for (const [name, kind, dir, cfg] of cases) {
  const res = generateContainerFiles(cfg);
  if (!res.ok) { failed++; console.log(`${name}: not generated: ${res.errors.join('; ')}`); continue; }
  const base = join(root, name);
  for (const f of res.files) { const p = join(base, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }

  if (kind === 'terraform' || kind === 'both') {
    const cwd = join(base, dir);
    const init = run(tf, ['init', '-backend=false', '-input=false', '-no-color'], cwd);
    if (init.status !== 0) { fail(name, 'terraform init', init); continue; }
    const v = run(tf, ['validate', '-no-color'], cwd);
    if (v.status !== 0) { fail(name, 'terraform validate', v); continue; }
    console.log(`${name}: terraform valid (${res.files.length} files)`);
  }
  if (kind === 'kubernetes' || kind === 'both') {
    const k = run('kubectl', ['kustomize', 'k8s'], base);
    if (k.status !== 0) { fail(name, 'kubectl kustomize', k); continue; }
    const chart = join(base, 'helm', cfg.appName);
    const lint = run('helm', ['lint', chart], base);
    if (lint.status !== 0) { fail(name, 'helm lint', lint); continue; }
    const tpl = run('helm', ['template', 'rel', chart, '--namespace', cfg.k8s.namespace], base);
    if (tpl.status !== 0) { fail(name, 'helm template', tpl); continue; }
    console.log(`${name}: kustomize and helm OK (${k.stdout.split('\n---').length} objects / ${tpl.stdout.split('\n---').length} objects)`);
  }
}
process.exit(failed ? 1 : 0);
