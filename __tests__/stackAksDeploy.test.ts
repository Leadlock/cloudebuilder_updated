/**
 * Deploying a whole project (Frontend, Backend, API) to Azure Kubernetes Service: Terraform for the cluster, registry and Key Vault, the project's
 * manifests with secrets read from the vault, and deploy.sh (run with stand-ins; the manifests are rendered by the real kubectl when it is installed).
 */
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse, parseAllDocuments } from 'yaml';
import { generateProjectFiles, defaultProject, LAYERS, type Layer, type StackProject } from '@/lib/engines/containers/stackProject';

const APPS: Layer[] = ['frontend', 'backend', 'api'];
const project = (on: Layer[], tweak?: (p: StackProject) => void): StackProject => {
  const p = defaultProject();
  p.name = 'shop';
  for (const l of LAYERS) p.layers[l].enabled = on.includes(l);
  p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }];
  p.layers.api.config.env = [{ key: 'STRIPE_KEY', value: '', secret: true }];
  p.deploy.target = 'aks';
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
const errorsOf = (p: StackProject) => { const r = generateProjectFiles(p); return r.ok ? '' : r.errors.join(' | '); };

describe('the files', () => {
  test('Terraform for the cluster, the project\'s manifests (a folder per service), and the scripts; the local files are kept', () => {
    const r = gen(APPS);
    const paths = r.files.map((f) => f.path);
    for (const p of ['deploy.sh', 'destroy.sh', 'aks/main.tf', 'aks/variables.tf', 'aks/outputs.tf', 'aks/README.md', 'k8s/namespace.yaml', 'k8s/kustomization.yaml', 'docker-compose.yml']) expect(paths).toContain(p);
    for (const l of APPS) for (const f of ['deployment.yaml', 'service.yaml', 'kustomization.yaml']) expect(paths).toContain(`k8s/${l}/${f}`);
    expect(paths.some((p) => p.startsWith('helm') || p.includes('/helm/'))).toBe(false);
    for (const f of ['deploy.sh', 'destroy.sh']) expect(spawnSync('bash', ['-n'], { input: file(r, f), encoding: 'utf8' })).toMatchObject({ status: 0, stderr: '' });
    for (const f of r.files.filter((x) => x.path.startsWith('k8s/') && x.path.endsWith('.yaml'))) expect(parseAllDocuments(f.content).every((d) => d.errors.length === 0)).toBe(true);
  });
  test.each([[['frontend', 'api']], [['backend', 'api']], [['frontend', 'backend']], [['frontend', 'backend', 'api']]] as const)('%j: valid shell and YAML', (on) => {
    const r = gen([...on]);
    for (const f of ['deploy.sh', 'destroy.sh']) expect(spawnSync('bash', ['-n'], { input: file(r, f), encoding: 'utf8' })).toMatchObject({ status: 0, stderr: '' });
  });
  test('without a deployment nothing about AKS is generated', () => {
    const none = generateProjectFiles(project(APPS, (p) => { p.deploy.target = 'none'; }));
    expect(none.ok && none.files.some((f) => f.path.startsWith('aks/'))).toBe(false);
  });
});

describe('the manifests', () => {
  const r = gen(APPS, (p) => { p.deploy.aks.ingressHost = 'shop.example.com'; });
  test('the image of a built service has no registry in the manifest: deploy.sh puts the registry in front of it', () => {
    for (const l of APPS) expect(doc(r, `k8s/${l}/deployment.yaml`).spec.template.spec.containers[0].image).toBe(`shop-${l}:latest`);
  });
  test('only a service with secrets gets a service account, a SecretProviderClass and the workload-identity label', () => {
    const x = gen(APPS, (p) => { p.layers.api.config.env = []; });
    expect(x.files.some((f) => f.path === 'k8s/backend/serviceaccount.yaml')).toBe(true);
    expect(x.files.some((f) => f.path === 'k8s/backend/secretproviderclass.yaml')).toBe(true);
    for (const l of ['api', 'frontend']) expect(x.files.some((f) => f.path.startsWith(`k8s/${l}/`) && /serviceaccount|secretproviderclass/.test(f.path))).toBe(false);
    const pod = doc(x, 'k8s/backend/deployment.yaml').spec.template;
    expect(pod.spec.serviceAccountName).toBe('backend');
    expect(pod.metadata.labels['azure.workload.identity/use']).toBe('true');
    expect(doc(x, 'k8s/api/deployment.yaml').spec.template.spec.serviceAccountName).toBeUndefined();
  });
  test('each service reads exactly its own secrets, synced into <service>-secrets', () => {
    expect(file(r, 'k8s/backend/secretproviderclass.yaml')).toContain('objectName: JWT-SECRET');
    expect(file(r, 'k8s/backend/secretproviderclass.yaml')).not.toContain('STRIPE-KEY');
    expect(file(r, 'k8s/api/secretproviderclass.yaml')).toContain('objectName: STRIPE-KEY');
    expect(doc(r, 'k8s/api/secretproviderclass.yaml').spec.secretObjects[0].secretName).toBe('api-secrets');
  });
  test('the vault, tenant and identity are placeholders that deploy.sh fills in (no real value is in a file)', () => {
    const spc = file(r, 'k8s/backend/secretproviderclass.yaml');
    expect(spc).toContain('__VAULT_NAME__'); expect(spc).toContain('__TENANT_ID__'); expect(spc).toContain('__WORKLOAD_CLIENT_ID__');
  });
  test('the managed ingress controller is the ingress class, on the public service only', () => {
    expect(doc(r, 'k8s/frontend/ingress.yaml').spec.ingressClassName).toBe('webapprouting.kubernetes.azure.com');
    expect(r.files.filter((f) => f.path.endsWith('ingress.yaml'))).toHaveLength(1);
  });
  test('the services reach each other at the addresses docker compose uses', () => {
    expect(file(r, 'frontend/nginx.conf')).toContain('proxy_pass http://api:8000/');
    const env = doc(r, 'k8s/api/deployment.yaml').spec.template.spec.containers[0].env;
    expect(env).toContainEqual({ name: 'BACKEND_URL', value: 'http://backend:3000' });
    expect(doc(r, 'k8s/api/service.yaml').spec.ports[0].port).toBe(8000);
  });
});

describe('the Terraform', () => {
  const main = () => file(gen(APPS), 'aks/main.tf');
  test('safe defaults: workload identity, no registry admin user, the cluster can only pull images, a vault read through RBAC', () => {
    const m = main();
    expect(m).toContain('workload_identity_enabled = true');
    expect(m).toContain('oidc_issuer_enabled       = true');
    expect(m).toContain('admin_enabled       = false');
    expect(m).toContain('role_definition_name             = "AcrPull"');
    expect(m).toContain('enable_rbac_authorization  = true');
    expect(m).toContain('key_vault_secrets_provider');
  });
  test('one federated credential for the service account of each service that has secrets, and one identity that can only read the vault', () => {
    const m = main();
    expect(m).toContain('secret_services = ["backend", "api"]');
    expect(m).toMatch(/for_each\s+= toset\(local\.secret_services\)/);
    expect(m).toContain('subject             = "system:serviceaccount:${var.k8s_namespace}:${each.key}"');
    expect(m).toContain('role_definition_name = "Key Vault Secrets User"');
    expect(file(gen(APPS), 'aks/variables.tf')).toMatch(/variable "k8s_namespace"[\s\S]*default\s+= "shop"/);
  });
  test('no vault, identity or key-vault add-on when nothing has a secret', () => {
    const m = file(gen(APPS, (p) => { p.layers.backend.config.env = []; p.layers.api.config.env = []; }), 'aks/main.tf');
    expect(m).not.toContain('azurerm_key_vault');
    expect(m).not.toContain('federated');
    expect(m).not.toContain('key_vault_secrets_provider');
  });
  test('no registry or pull role when every service uses a ready-made image', () => {
    const m = file(gen(['frontend', 'api'], (p) => { for (const l of ['frontend', 'api'] as const) p.layers[l].config = { ...p.layers[l].config, image: 'nginxinc/nginx-unprivileged:1.27' }; p.layers.backend.config.env = []; p.layers.api.config.env = []; }), 'aks/main.tf');
    expect(m).not.toContain('azurerm_container_registry'); expect(m).not.toContain('AcrPull');
  });
  test('the settings from the form end up in variables.tf', () => {
    const v = file(gen(APPS, (p) => { Object.assign(p.deploy.aks, { location: 'eastus2', nodeSize: 'Standard_D2s_v3', minNodes: 1, maxNodes: 5, namespace: 'prod' }); }), 'aks/variables.tf');
    for (const x of ['"eastus2"', '"Standard_D2s_v3"', 'default = 1', 'default = 5', '"prod"', '"shop"']) expect(v).toContain(x);
  });
});

describe('what is refused or said', () => {
  test('a database is refused, with the way out', () => {
    const e = errorsOf(project([...APPS, 'database']));
    expect(e).toMatch(/AKS: a Database is not run in the cluster/);
    expect(e).toMatch(/Azure Database/);
    expect(e).toMatch(/DATABASE_URL/);
  });
  test('names, location, node counts, tag, namespace and ingress host are checked', () => {
    expect(errorsOf(project(APPS, (p) => { p.name = 'shop_2'; }))).toMatch(/app name|cluster/i);
    expect(errorsOf(project(APPS, (p) => { p.deploy.aks.location = 'Mars 1'; }))).toMatch(/location/);
    expect(errorsOf(project(APPS, (p) => { p.deploy.aks.nodeSize = 'big'; }))).toMatch(/node size/);
    expect(errorsOf(project(APPS, (p) => { p.deploy.aks.minNodes = 5; p.deploy.aks.maxNodes = 2; }))).toMatch(/nodes/);
    expect(errorsOf(project(APPS, (p) => { p.deploy.aks.imageTag = 'a b'; }))).toMatch(/image tag/);
    expect(errorsOf(project(APPS, (p) => { p.deploy.aks.namespace = 'Prod'; }))).toMatch(/namespace/);
    expect(errorsOf(project(APPS, (p) => { p.deploy.aks.ingressHost = 'not a host'; }))).toMatch(/ingress host/);
    expect(errorsOf(project(APPS, (p) => { p.deploy.aks.tlsSecret = 'tls'; }))).toMatch(/TLS secret needs an ingress host/);
    expect(errorsOf(project(APPS))).toBe('');
  });
  test('warnings, and a cost with a registry only when something is built', () => {
    const r = gen(APPS);
    const w = r.warnings.join(' | ');
    expect(w).toMatch(/"latest" tag/); expect(w).toMatch(/reachable only inside the cluster/); expect(w).toMatch(/Key Vault CSI/); expect(w).toMatch(/every service that has a secret could read every secret/);
    expect(r.cost?.lines.map((l) => l.label).join(' ')).toContain('Container Registry');
    expect(r.cost?.lines.map((l) => l.label).join(' ')).toContain('2 nodes (Standard_B2s)');
    const none = gen(['frontend', 'api'], (p) => { for (const l of ['frontend', 'api'] as const) p.layers[l].config = { ...p.layers[l].config, image: 'nginxinc/nginx-unprivileged:1.27' }; p.layers.backend.config.env = []; p.layers.api.config.env = []; });
    expect(none.cost?.lines.map((l) => l.label).join(' ')).not.toContain('Container Registry');
  });
});

// ─── deploy.sh ───────────────────────────────────────────────────────────────

const real = spawnSync('which', ['kubectl'], { encoding: 'utf8' });
const REAL_KUBECTL = real.status === 0 ? real.stdout.trim() : '';

describe('deploy.sh of an AKS project', () => {
  let root: string; let bin: string; let work: string; let calls: string; let stored: string; let applied: string;
  const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  function setup(on: Layer[] = APPS, tweak?: (p: StackProject) => void) {
    const r = generateProjectFiles(project(on, tweak));
    if (!r.ok) throw new Error(r.errors.join(';'));
    for (const f of r.files) { const path = join(work, f.path); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, f.content); }
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aksdeploy-')); bin = join(root, 'bin'); work = join(root, 'p'); calls = join(root, 'calls'); stored = join(root, 'kv'); applied = join(root, 'applied.yaml');
    mkdirSync(bin); mkdirSync(work); mkdirSync(stored);
    stub('terraform', `echo "terraform $*" >> "${calls}"
case "$*" in
  *"output -raw acr_name"*) echo acrshop;; *"output -raw resource_group"*) echo rg-shop;; *"output -raw cluster_name"*) echo aks-shop;;
  *"output -raw vault_name"*) echo kvshop;; *"output -raw tenant_id"*) echo tenant-123;; *"output -raw workload_client_id"*) echo client-456;;
esac
exit 0`);
    stub('az', `echo "az $*" >> "${calls}"
case "$1 $2 $3" in
  "account show "*) echo sub;;
  "keyvault secret show") n=""; while [ $# -gt 0 ]; do [ "$1" = --name ] && n="$2"; shift; done; [ -f "${stored}/$n" ] || exit 3;;
  "keyvault secret set") n=""; f=""; while [ $# -gt 0 ]; do [ "$1" = --name ] && n="$2"; [ "$1" = --file ] && f="$2"; shift; done; cat "$f" > "${stored}/$n";;
esac
exit 0`);
    // kubectl: "kustomize" is the real renderer when it is installed; "apply -f -" saves what it is given.
    stub('kubectl', `echo "kubectl $*" >> "${calls}"
if [ "$1" = kustomize ]; then ${REAL_KUBECTL ? `exec "${REAL_KUBECTL}" "$@"` : 'echo "kind: Placeholder"'}; fi
if [ "$1" = apply ] && [ "$2" = -f ] && [ "$3" = - ]; then cat >> "${applied}"; exit 0; fi
if [ "$1" = create ]; then echo "apiVersion: v1"; fi
exit 0`);
    stub('sleep', 'exit 0');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const run = (input: string) => spawnSync('bash', [join(work, 'deploy.sh'), '--yes'], { cwd: work, encoding: 'utf8', input, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const log = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  const out = (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`;

  test('creates the cluster, stores the secrets, builds each image in Azure, connects with a private kubeconfig, applies and waits for every rollout', () => {
    setup();
    const r = run('jwt-value\nstripe-value\n');
    expect(r.status).toBe(0);
    expect(out(r)).toContain('Done.');
    const l = log();
    const idx = (re: RegExp) => l.findIndex((x) => re.test(x));
    expect(idx(/terraform -chdir=aks apply/)).toBeLessThan(idx(/keyvault secret set/));
    for (const layer of APPS) expect(l).toContain(`az acr build --registry acrshop --image shop-${layer}:latest --platform linux/amd64 ./${layer}`);
    expect(idx(/keyvault secret set/)).toBeLessThan(idx(/acr build/));
    expect(idx(/acr build/)).toBeLessThan(idx(/aks get-credentials/));
    expect(idx(/aks get-credentials/)).toBeLessThan(idx(/kustomize k8s/));
    for (const layer of APPS) expect(l).toContain(`kubectl -n shop rollout status deployment/${layer} --timeout=300s`);
    expect(l.find((x) => x.includes('aks get-credentials'))).toMatch(/--file \S+/);   // a kubeconfig of its own: the user's contexts are left alone
    expect(readFileSync(join(stored, 'JWT-SECRET'), 'utf8')).toBe('jwt-value');
    expect(readFileSync(join(stored, 'STRIPE-KEY'), 'utf8')).toBe('stripe-value');
  });

  (REAL_KUBECTL ? test : test.skip)('what is applied has the registry, the vault, the tenant and the identity filled in, and no placeholder left', () => {
    setup();
    run('jwt-value\nstripe-value\n');
    const text = readFileSync(applied, 'utf8');
    for (const layer of APPS) expect(text).toContain(`image: acrshop.azurecr.io/shop-${layer}:latest`);
    expect(text).toContain('keyvaultName: kvshop');
    expect(text).toContain('tenantId: tenant-123');
    expect(text).toContain('clientID: client-456');
    expect(text).toContain('azure.workload.identity/client-id: client-456');
    expect(text).not.toMatch(/__[A-Z_]+__/);
    expect(text).not.toContain('image: shop-');
  });

  test('a secret is stored through a private file, never on a command line', () => {
    setup();
    run('jwt-value\nstripe-value\n');
    expect(log().filter((x) => x.includes('secret set')).every((x) => x.includes('--file') && !x.includes('jwt-value') && !x.includes('stripe-value'))).toBe(true);
  });

  test('a secret that is already in the vault is not asked again', () => {
    setup();
    writeFileSync(join(stored, 'JWT-SECRET'), 'x'); writeFileSync(join(stored, 'STRIPE-KEY'), 'y');
    const r = run('');
    expect(r.status).toBe(0);
    expect(out(r)).toContain('JWT_SECRET: already stored');
    expect(log().some((x) => x.includes('secret set'))).toBe(false);
  });

  test('an empty secret is refused before anything is built or applied', () => {
    setup();
    const r = run('\n');
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/JWT_SECRET cannot be empty/);
    expect(log().some((x) => x.includes('acr build') || x.includes('kustomize'))).toBe(false);
  });

  test('the managed ingress controller is turned on only when there is an ingress host', () => {
    setup(APPS, (p) => { p.deploy.aks.ingressHost = 'shop.example.com'; });
    run('a\nb\n');
    expect(log().some((x) => x.includes('aks approuting enable'))).toBe(true);
    rmSync(calls); setup();
    run('a\nb\n');
    expect(log().some((x) => x.includes('approuting'))).toBe(false);
  });

  test('without secrets there are no vault steps and the manifests are applied as they are with the registry filled in', () => {
    setup(APPS, (p) => { p.layers.backend.config.env = []; p.layers.api.config.env = []; });
    const r = run('');
    expect(r.status).toBe(0);
    expect(out(r)).not.toMatch(/Secrets/);
    expect(log().some((x) => x.includes('keyvault') || x.includes('vault_name'))).toBe(false);
  });

  test('IMAGE_TAG is used for the build and the image that runs', () => {
    setup();
    const r = spawnSync('bash', [join(work, 'deploy.sh'), '--yes'], { cwd: work, encoding: 'utf8', input: 'a\nb\n', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, IMAGE_TAG: 'v9' } });
    expect(r.status).toBe(0);
    expect(log()).toContain('az acr build --registry acrshop --image shop-api:v9 --platform linux/amd64 ./api');
    if (REAL_KUBECTL) expect(readFileSync(applied, 'utf8')).toContain('image: acrshop.azurecr.io/shop-api:v9');
  });

  test('refuses to start when not signed in to Azure, before creating anything', () => {
    setup();
    stub('az', 'exit 1');
    const r = run('');
    expect(out(r)).toMatch(/not signed in to Azure/);
    expect(log().some((x) => x.startsWith('terraform'))).toBe(false);
  });

  test('destroy.sh needs the project name typed', () => {
    setup();
    const d = (input: string) => spawnSync('bash', [join(work, 'destroy.sh')], { cwd: work, encoding: 'utf8', input, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(d('nope\n').status).not.toBe(0);
    expect(log().some((x) => x.includes('destroy'))).toBe(false);
    expect(d('shop\n').status).toBe(0);
    expect(log()).toContain('terraform -chdir=aks destroy -auto-approve');
  });
});
