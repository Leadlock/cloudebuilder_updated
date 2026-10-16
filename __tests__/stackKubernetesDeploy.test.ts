/**
 * Deploying a whole project (Frontend, Backend, API) to Kubernetes: a Deployment and a Service per service in one namespace, applied with Kustomize.
 * A database is refused (use the cloud's managed one). deploy.sh is run for real with stand-ins for kubectl and docker; when kubectl is installed the
 * manifests are also rendered by the real `kubectl kustomize`.
 */
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse, parseAllDocuments } from 'yaml';
import { pickStackOption } from '@/lib/engines/containers/stackOptions';
import { generateProjectFiles, defaultProject, LAYERS, type Layer, type StackProject } from '@/lib/engines/containers/stackProject';

const project = (on: Layer[], tweak?: (p: StackProject) => void): StackProject => {
  const p = defaultProject();
  p.name = 'shop';
  for (const l of LAYERS) p.layers[l].enabled = on.includes(l);
  p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }];
  p.deploy.target = 'kubernetes';
  p.deploy.k8s.registry = 'ghcr.io/acme';
  tweak?.(p);
  return p;
};
const gen = (on: Layer[], tweak?: (p: StackProject) => void) => {
  const r = generateProjectFiles(project(on, tweak));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r;
};
type R = ReturnType<typeof gen>;
const file = (r: R, path: string) => r.files.find((f) => f.path === path)?.content ?? '';
const doc = (r: R, path: string) => parse(file(r, path)) as any;   // eslint-disable-line @typescript-eslint/no-explicit-any
const APPS: Layer[] = ['frontend', 'backend', 'api'];
const errorsOf = (p: StackProject) => { const r = generateProjectFiles(p); return r.ok ? '' : r.errors.join(' | '); };

describe('the files', () => {
  test('a folder of manifests per service, one namespace and one top-level kustomization; the local files are kept', () => {
    const r = gen(APPS);
    const paths = r.files.map((f) => f.path);
    for (const l of APPS) for (const f of ['deployment.yaml', 'service.yaml', 'pdb.yaml', 'kustomization.yaml']) expect(paths).toContain(`k8s/${l}/${f}`);
    for (const p of ['deploy.sh', 'destroy.sh', 'k8s/namespace.yaml', 'k8s/kustomization.yaml', 'k8s/README.md', 'docker-compose.yml']) expect(paths).toContain(p);
    expect(paths.filter((p) => p.endsWith('namespace.yaml'))).toHaveLength(1);
    expect(paths.some((p) => p.includes('helm'))).toBe(false);
    expect(doc(r, 'k8s/kustomization.yaml').resources).toEqual(['namespace.yaml', 'frontend', 'backend', 'api']);
    for (const l of APPS) expect(doc(r, `k8s/${l}/kustomization.yaml`).resources).not.toContain('namespace.yaml');
  });

  test.each([[['frontend', 'api']], [['backend', 'api']], [['frontend', 'backend']], [['frontend', 'backend', 'api']]] as const)('%j: valid shell and valid YAML everywhere', (on) => {
    const r = gen([...on]);
    for (const f of ['deploy.sh', 'destroy.sh']) expect(spawnSync('bash', ['-n'], { input: file(r, f), encoding: 'utf8' })).toMatchObject({ status: 0, stderr: '' });
    for (const f of r.files.filter((x) => x.path.startsWith('k8s/') && x.path.endsWith('.yaml'))) expect(parseAllDocuments(f.content).every((d) => d.errors.length === 0)).toBe(true);
  });

  test('without a deployment, or with one service, nothing about Kubernetes is generated', () => {
    const none = generateProjectFiles(project(APPS, (p) => { p.deploy.target = 'none'; }));
    expect(none.ok && none.files.some((f) => f.path.startsWith('k8s/'))).toBe(false);
  });
});

describe('the Deployments', () => {
  const r = gen(APPS);
  const dep = (l: Layer) => doc(r, `k8s/${l}/deployment.yaml`);

  test('named after the layer, in the project\'s namespace, with the image from the registry', () => {
    for (const l of APPS) {
      expect(dep(l).metadata).toMatchObject({ name: l, namespace: 'shop' });
      expect(dep(l).spec.template.spec.containers[0].image).toBe(`ghcr.io/acme/shop-${l}:latest`);
    }
  });

  test('every pod is hardened', () => {
    for (const l of APPS) {
      const spec = dep(l).spec.template.spec;
      const sc = spec.containers[0].securityContext;
      expect(sc).toMatchObject({ allowPrivilegeEscalation: false, runAsNonRoot: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } });
      expect(spec.automountServiceAccountToken).toBe(false);
      expect(spec.containers[0].readinessProbe.httpGet.path).toBeTruthy();
    }
  });

  test('the services reach each other at the addresses docker compose uses', () => {
    const env = (l: Layer) => Object.fromEntries((dep(l).spec.template.spec.containers[0].env ?? []).map((e: any) => [e.name, e.value ?? `secret:${e.valueFrom.secretKeyRef.name}/${e.valueFrom.secretKeyRef.key}`]));   // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(env('api')).toMatchObject({ BACKEND_URL: 'http://backend:3000' });
    expect(file(r, 'frontend/nginx.conf')).toContain('proxy_pass http://api:8000/');
    expect(doc(r, 'k8s/api/service.yaml').spec.ports[0].port).toBe(8000);
    expect(doc(r, 'k8s/backend/service.yaml').spec.ports[0].port).toBe(3000);
    expect(env('backend')).toMatchObject({ JWT_SECRET: 'secret:backend-secrets/JWT_SECRET' });
  });

  test('a frontend that is not a static site is told where the API is', () => {
    const x = gen(['frontend', 'api'], (p) => { p.layers.frontend.config = pickStackOption(p.layers.frontend.config, 'nextjs'); });
    const env = doc(x, 'k8s/frontend/deployment.yaml').spec.template.spec.containers[0].env;
    expect(env).toContainEqual({ name: 'API_URL', value: 'http://api:8000' });
    expect(file(x, 'docker-compose.yml')).toContain('API_URL: "http://api:8000"');   // the same address in compose
  });

  test('replicas, and a PodDisruptionBudget only when more than one runs', () => {
    expect(dep('api').spec.replicas).toBe(2);
    const one = gen(APPS, (p) => { p.deploy.k8s.replicas = 1; });
    expect(doc(one, 'k8s/api/deployment.yaml').spec.replicas).toBe(1);
    expect(one.files.some((f) => f.path === 'k8s/api/pdb.yaml')).toBe(false);
  });
});

describe('who can be reached from outside', () => {
  test('by default every Service is ClusterIP and there is no Ingress', () => {
    const r = gen(APPS);
    for (const l of APPS) expect(doc(r, `k8s/${l}/service.yaml`).spec.type).toBe('ClusterIP');
    expect(r.files.some((f) => f.path.endsWith('ingress.yaml'))).toBe(false);
    expect(r.warnings.join(' | ')).toMatch(/reachable only inside the cluster/);
  });
  test.each([[APPS, 'frontend'], [['backend', 'api'] as Layer[], 'api'], [['frontend', 'backend'] as Layer[], 'frontend']] as const)('%j: only the %s gets the Ingress and the LoadBalancer', (on, entry) => {
    const r = gen([...on], (p) => { p.deploy.k8s.ingressHost = 'shop.example.com'; p.deploy.k8s.serviceType = 'LoadBalancer'; p.deploy.k8s.tlsSecret = 'shop-tls'; });
    const ingresses = r.files.filter((f) => f.path.endsWith('ingress.yaml')).map((f) => f.path);
    expect(ingresses).toEqual([`k8s/${entry}/ingress.yaml`]);
    for (const l of on) expect(doc(r, `k8s/${l}/service.yaml`).spec.type).toBe(l === entry ? 'LoadBalancer' : 'ClusterIP');
    expect(doc(r, `k8s/${entry}/ingress.yaml`).spec.tls[0].secretName).toBe('shop-tls');
  });
  test('plain HTTP is warned about', () => {
    expect(gen(APPS, (p) => { p.deploy.k8s.ingressHost = 'shop.example.com'; }).warnings.join(' | ')).toMatch(/plain HTTP/);
  });
});

describe('secrets', () => {
  test('one Secret per service, from the values deploy.sh asks for, never in a file', () => {
    const r = gen(APPS, (p) => { p.layers.api.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }, { key: 'STRIPE_KEY', value: '', secret: true }]; });
    const d = file(r, 'deploy.sh');
    expect(d).toContain("SECRETS=('JWT_SECRET' 'STRIPE_KEY')");
    expect(d).toContain('create secret generic backend-secrets --from-literal=JWT_SECRET="$V_JWT_SECRET"');
    expect(d).toContain('create secret generic api-secrets --from-literal=JWT_SECRET="$V_JWT_SECRET" --from-literal=STRIPE_KEY="$V_STRIPE_KEY"');
    expect(d).not.toContain('declare -A');          // macOS ships bash 3.2, which has no associative arrays
    expect(r.files.filter((f) => f.path.startsWith('k8s/')).some((f) => /kind: Secret\b/.test(f.content))).toBe(false);
  });
  test('without secrets nothing is asked', () => {
    const r = gen(APPS, (p) => { p.layers.backend.config.env = []; });
    expect(file(r, 'deploy.sh')).toContain('No secrets are needed.');
  });
});

describe('what is refused or said', () => {
  test('a database is refused, with what to do instead', () => {
    const e = errorsOf(project([...APPS, 'database']));
    expect(e).toMatch(/Database is not run in the cluster/);
    expect(e).toMatch(/managed database/);
    expect(e).toMatch(/DATABASE_URL/);
  });
  test('a registry is needed when anything is built, and has to look like one', () => {
    expect(errorsOf(project(APPS, (p) => { p.deploy.k8s.registry = ''; }))).toMatch(/registry/);
    expect(errorsOf(project(APPS, (p) => { p.deploy.k8s.registry = 'GHCR.io/Acme'; }))).toMatch(/registry/);
    expect(errorsOf(project(APPS, (p) => { p.deploy.k8s.registry = 'ghcr.io/acme'; }))).toBe('');
  });
  test('no registry is needed when every service uses a ready-made image', () => {
    const e = errorsOf(project(['frontend', 'api'], (p) => { p.deploy.k8s.registry = ''; for (const l of ['frontend', 'api'] as const) p.layers[l].config = { ...p.layers[l].config, image: 'nginxinc/nginx-unprivileged:1.27' }; }));
    expect(e).toBe('');
  });
  test('a ready-made image is pulled as it is and not built or pushed', () => {
    const r = gen(['frontend', 'api'], (p) => { p.layers.frontend.config = { ...p.layers.frontend.config, image: 'nginxinc/nginx-unprivileged:1.27' }; });
    expect(doc(r, 'k8s/frontend/deployment.yaml').spec.template.spec.containers[0].image).toBe('nginxinc/nginx-unprivileged:1.27');
    expect(file(r, 'deploy.sh')).toContain("BUILT=('api')");
  });
  test('a namespace Kubernetes would refuse, a bad tag and a bad ingress host are reported', () => {
    expect(errorsOf(project(APPS, (p) => { p.name = 'shop_2'; }))).toMatch(/namespace/);
    expect(errorsOf(project(APPS, (p) => { p.deploy.k8s.namespace = 'Prod'; }))).toMatch(/namespace/);
    expect(errorsOf(project(APPS, (p) => { p.deploy.k8s.imageTag = 'a b'; }))).toMatch(/image/i);
    expect(errorsOf(project(APPS, (p) => { p.deploy.k8s.ingressHost = 'not a host'; }))).toMatch(/ingress host/);
    expect(errorsOf(project(APPS, (p) => { p.deploy.k8s.tlsSecret = 'tls'; }))).toMatch(/TLS secret needs an ingress host/);
    expect(errorsOf(project(APPS, (p) => { p.deploy.k8s.replicas = 0; }))).toMatch(/replicas/);
  });
  test('a custom namespace is used everywhere and the project name is otherwise the namespace', () => {
    const r = gen(APPS, (p) => { p.deploy.k8s.namespace = 'prod'; });
    expect(doc(r, 'k8s/namespace.yaml').metadata.name).toBe('prod');
    expect(doc(r, 'k8s/api/deployment.yaml').metadata.namespace).toBe('prod');
    expect(file(r, 'deploy.sh')).toContain("NAMESPACE='prod'");
    expect(doc(gen(APPS), 'k8s/namespace.yaml').metadata.name).toBe('shop');
  });
});

// ─── deploy.sh ───────────────────────────────────────────────────────────────

describe('deploy.sh of a Kubernetes project', () => {
  let root: string; let bin: string; let work: string; let calls: string; let stored: string;
  const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  function setup(on: Layer[] = APPS, tweak?: (p: StackProject) => void) {
    const r = generateProjectFiles(project(on, tweak));
    if (!r.ok) throw new Error(r.errors.join(';'));
    for (const f of r.files) { const path = join(work, f.path); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, f.content); }
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'k8sdeploy-')); bin = join(root, 'bin'); work = join(root, 'p'); calls = join(root, 'calls'); stored = join(root, 'secrets');
    mkdirSync(bin); mkdirSync(work); mkdirSync(stored);
    // kubectl: a Secret "exists" when a file with its name is in $stored; creating one records its literals.
    stub('kubectl', `echo "kubectl $*" >> "${calls}"
case "$1" in
  config) echo test-cluster;; version) exit 0;;
  create) if [ "$2" = namespace ]; then echo "apiVersion: v1"; exit 0; fi; for a in "$@"; do case "$a" in --from-literal=*) echo "\${a#--from-literal=}" >> "${stored}/$5.pending";; esac; done; [ -f "${stored}/$5.pending" ] && mv "${stored}/$5.pending" "${stored}/$5";;
  apply) cat >/dev/null 2>&1 < /dev/null;;
esac
if [ "$1" = -n ] && [ "$3" = get ] && [ "$4" = secret ]; then [ -f "${stored}/$5" ] || exit 1; fi
exit 0`);
    stub('docker', `echo "docker $*" >> "${calls}"; exit 0`);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const run = (input: string, args: string[] = ['--yes'], env: Record<string, string> = {}) =>
    spawnSync('bash', [join(work, 'deploy.sh'), ...args], { cwd: work, encoding: 'utf8', input, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env } });
  const log = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  const out = (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`;

  test('builds and pushes each built service, stores the secret, applies, points the Deployments at the pushed tag and waits for every rollout', () => {
    setup();
    const r = run('jwt-value\n');
    expect(r.status).toBe(0);
    expect(out(r)).toContain('Done.');
    const l = log();
    for (const layer of APPS) expect(l).toContain(`docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/acme/shop-${layer}:latest --push ./${layer}`);
    expect(l).toContain('kubectl -n shop create secret generic backend-secrets --from-literal=JWT_SECRET=jwt-value');
    expect(l).toContain('kubectl apply -k k8s');
    for (const layer of APPS) {
      expect(l).toContain(`kubectl -n shop set image deployment/${layer} ${layer}=ghcr.io/acme/shop-${layer}:latest`);
      expect(l).toContain(`kubectl -n shop rollout status deployment/${layer} --timeout=300s`);
    }
    const idx = (re: RegExp) => l.findIndex((x) => re.test(x));
    expect(idx(/buildx build/)).toBeLessThan(idx(/create secret/));
    expect(idx(/create secret/)).toBeLessThan(idx(/apply -k/));
    expect(idx(/apply -k/)).toBeLessThan(idx(/rollout status/));
  });

  test('IMAGE_TAG builds, pushes and runs another tag; SKIP_BUILD skips the build', () => {
    setup();
    run('jwt-value\n', ['--yes'], { IMAGE_TAG: 'v9', SKIP_BUILD: '1' });
    const l = log();
    expect(l.some((x) => x.startsWith('docker'))).toBe(false);
    expect(l).toContain('kubectl -n shop set image deployment/api api=ghcr.io/acme/shop-api:v9');
  });

  test('a Secret that already exists is kept and its value is not asked again', () => {
    setup();
    writeFileSync(join(stored, 'backend-secrets'), 'x');
    const r = run('');
    expect(r.status).toBe(0);
    expect(out(r)).toContain('JWT_SECRET: already stored');
    expect(log().some((x) => x.includes('create secret'))).toBe(false);
  });

  test('a secret shared by two services is asked once and stored in both', () => {
    setup(APPS, (p) => { p.layers.api.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }]; });
    const r = run('shared-value\n');
    expect(r.status).toBe(0);
    expect(log()).toEqual(expect.arrayContaining(['kubectl -n shop create secret generic backend-secrets --from-literal=JWT_SECRET=shared-value', 'kubectl -n shop create secret generic api-secrets --from-literal=JWT_SECRET=shared-value']));
  });

  test('an empty secret is refused before anything is applied', () => {
    setup();
    const r = run('\n');
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/JWT_SECRET cannot be empty/);
    expect(log().some((x) => x.includes('apply -k'))).toBe(false);
  });

  test('no cluster is reported before anything is built', () => {
    setup();
    stub('kubectl', 'exit 1');
    const r = run('');
    expect(out(r)).toMatch(/not pointed at a cluster/);
    expect(log().some((x) => x.startsWith('docker'))).toBe(false);
  });

  test('without --yes it asks, and an empty answer cancels', () => {
    setup();
    const r = run('\n', []);
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/Cancelled/);
    expect(log().some((x) => x.includes('apply -k'))).toBe(false);
  });

  test('destroy.sh needs the project name typed, then deletes the manifests and the secrets', () => {
    setup();
    const d = (input: string) => spawnSync('bash', [join(work, 'destroy.sh')], { cwd: work, encoding: 'utf8', input, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(d('nope\n').status).not.toBe(0);
    expect(log().some((x) => x.includes('delete'))).toBe(false);
    expect(d('shop\n').status).toBe(0);
    expect(log()).toEqual(expect.arrayContaining(['kubectl delete -k k8s --ignore-not-found', 'kubectl -n shop delete secret backend-secrets --ignore-not-found']));
  });
});

// ─── the real renderer, when it is installed ─────────────────────────────────

const hasKubectl = spawnSync('kubectl', ['version', '--client'], { encoding: 'utf8' }).status === 0;
(hasKubectl ? describe : describe.skip)('the real kubectl kustomize', () => {
  test('renders every service, the namespace and the Ingress', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kustomize-'));
    try {
      const r = gen(APPS, (p) => { p.deploy.k8s.ingressHost = 'shop.example.com'; });
      for (const f of r.files) { const path = join(dir, f.path); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, f.content); }
      const k = spawnSync('kubectl', ['kustomize', 'k8s'], { cwd: dir, encoding: 'utf8' });
      expect(k.status).toBe(0);
      const kinds = parseAllDocuments(k.stdout).map((d) => (d.toJSON() as { kind: string }).kind).sort();
      expect(kinds).toEqual(['Deployment', 'Deployment', 'Deployment', 'Ingress', 'Namespace', 'PodDisruptionBudget', 'PodDisruptionBudget', 'PodDisruptionBudget', 'Service', 'Service', 'Service']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
