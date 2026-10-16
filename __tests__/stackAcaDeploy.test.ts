/**
 * Deploying a whole project (Frontend, Backend, API) to Azure Container Apps: Terraform for the environment and an app per service, and
 * deploy.sh / destroy.sh (syntax-checked; the Terraform is validated by the real terraform in scripts/validate-containers.ts).
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
  p.deploy.target = 'container-apps';
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
  test('Terraform, the two scripts and a README, with the local files kept', () => {
    const r = gen(APPS);
    const paths = r.files.map((f) => f.path);
    for (const p of ['deploy.sh', 'destroy.sh', 'aca/main.tf', 'aca/variables.tf', 'aca/outputs.tf', 'aca/README.md', 'docker-compose.yml', 'frontend/Dockerfile']) expect(paths).toContain(p);
    for (const f of ['deploy.sh', 'destroy.sh']) expect(spawnSync('bash', ['-n'], { input: file(r, f), encoding: 'utf8' })).toMatchObject({ status: 0, stderr: '' });
  });

  test('an app per service; only the public one is open to the internet, the others take plain HTTP from inside the environment', () => {
    const tf = file(gen(APPS), 'aca/main.tf');
    for (const l of APPS) expect(tf).toContain(`resource "azurerm_container_app" "${l}"`);
    expect(tf.match(/external_enabled\s+= true/g)).toHaveLength(1);
    expect(tf.match(/external_enabled\s+= false/g)).toHaveLength(2);
    expect(tf.match(/allow_insecure_connections = true/g)).toHaveLength(2);
    expect(tf).toContain('name                         = "${var.app_name}-frontend"');
  });

  test('the services call each other by app name and no port, and the frontend\'s nginx sends that name as Host', () => {
    const r = gen(APPS);
    expect(file(r, 'aca/main.tf')).toContain('"BACKEND_URL"');
    expect(file(r, 'aca/main.tf')).toContain('"http://shop-backend"');
    const nginx = file(r, 'frontend/nginx.conf');
    expect(nginx).toContain('proxy_pass http://shop-api/;');
    expect(nginx).toContain('proxy_set_header Host shop-api;');
    // The other targets keep the compose names and ports.
    const compose = generateProjectFiles(project(APPS, (p) => { p.deploy.target = 'ecs'; }));
    expect(compose.ok && compose.files.find((f) => f.path === 'frontend/nginx.conf')!.content).toContain('proxy_pass http://api:');
  });

  test('secrets are Key Vault references through the identity, never values, and variables are escaped', () => {
    const tf = file(gen(APPS), 'aca/main.tf');
    expect(tf).toContain('key_vault_secret_id = "${azurerm_key_vault.app.vault_uri}secrets/JWT-SECRET"');
    expect(tf).toContain('secret_name = "jwt-secret"');
    expect(tf).toContain('"LOG_LEVEL"');
    expect(tf).toContain('say \\"hi\\" $${HOME}');
    expect(tf).toContain('admin_enabled       = false');
    expect(tf).toContain('role_definition_name = "AcrPull"');
    expect(tf).not.toContain('azurerm_key_vault_secret');
  });

  test('a ready-made image has no registry and keeps its image', () => {
    const r = gen(['frontend', 'api'], (p) => { for (const l of ['frontend', 'api'] as const) p.layers[l].config = { ...p.layers[l].config, image: 'nginx:1.27' }; p.layers.backend.config.env = []; });
    const tf = file(r, 'aca/main.tf');
    expect(tf).toContain('image  = "nginx:1.27"');
    expect(tf).not.toContain('azurerm_container_registry');
    expect(file(r, 'deploy.sh')).toContain('Every service uses a ready-made image');
  });

  test('a restricted range limits only the public service', () => {
    const tf = file(gen(APPS, (p) => { p.deploy.aca.allowedCidr = '203.0.113.0/24'; }), 'aca/main.tf');
    expect(tf.match(/ip_security_restriction/g)).toHaveLength(1);
    expect(file(gen(APPS), 'aca/main.tf')).not.toContain('ip_security_restriction');
  });

  test('the files a person downloads create the apps after the secrets; a release has placeholders, no replicas and an app Terraform leaves alone', () => {
    const dl = gen(APPS);
    const d = file(dl, 'deploy.sh');
    expect(d.indexOf('-target=azurerm_key_vault.app')).toBeLessThan(d.indexOf('az keyvault secret set'));
    expect(d.indexOf('az keyvault secret set')).toBeLessThan(d.indexOf('az acr build --registry'));
    expect(d.indexOf('az acr build --registry')).toBeLessThan(d.indexOf('terraform -chdir=aca apply -var "image_tag=$TAG" ${APPROVE'));
    expect(file(dl, 'aca/main.tf')).not.toContain('ignore_changes');
    expect(file(dl, 'aca/outputs.tf')).not.toContain('output "apps"');

    const rel = gen(APPS, undefined, true);
    const tf = file(rel, 'aca/main.tf');
    expect(tf).toContain('min_replicas = 0');
    expect(tf).toContain('mcr.microsoft.com/k8se/quickstart:latest');
    expect(tf).toContain('ignore_changes = [template[0].container[0].image, template[0].min_replicas]');
    expect(tf).toContain('tags         = { cloudcraft = "placeholder" }');
    expect(tf).toContain('ignore_changes = [value, tags]');
    expect(tf).toContain('azurerm_key_vault_secret.jwt-secret');
    expect(tf).not.toContain('Value for');
    const out = file(rel, 'aca/outputs.tf');
    for (const o of ['output "apps"', 'output "min_replicas"', 'output "acr_name"', 'output "vault_name"', 'output "resource_group"', 'output "app_url"']) expect(out).toContain(o);
  });
});

describe('what is refused or warned about', () => {
  test('a database is not run here', () => {
    expect(errorsOf(project(['backend', 'api', 'database']))).toMatch(/Container Apps: a Database is not run/);
  });
  test.each([
    ['name', (p: StackProject) => { p.name = 'a-very-long-project-name-here'; }, /up to 23 characters/],
    ['location', (p: StackProject) => { p.deploy.aca.location = 'Mars 1'; }, /location looks like/],
    ['cpu', (p: StackProject) => { p.deploy.aca.cpu = 3; }, /CPU must be one of/],
    ['replicas', (p: StackProject) => { p.deploy.aca.maxReplicas = 0; }, /maximum number of replicas/],
    ['cidr', (p: StackProject) => { p.deploy.aca.allowedCidr = 'everyone'; }, /IPv4 range/],
    ['tag', (p: StackProject) => { p.deploy.aca.imageTag = 'a b'; }, /image tag/],
  ])('a bad %s is refused', (_n, tweak, re) => {
    const p = project(APPS); tweak(p);
    expect(errorsOf(p)).toMatch(re);
  });
  test('warnings say what to know, and a cost is shown', () => {
    const r = gen(APPS);
    expect(r.warnings.join('\n')).toMatch(/whole internet/);
    expect(r.warnings.join('\n')).toMatch(/JWT_SECRET, STRIPE_KEY/);
    expect(r.cost?.lines.map((l) => l.label).join('|')).toMatch(/3 apps x 1 replica.*Container Registry/);
  });
  test('one service keeps its own single-service Container Apps deployment', () => {
    const r = generateProjectFiles(project(['backend']));
    expect(r.ok && r.files.map((f) => f.path).some((p) => p.startsWith('aca/'))).toBe(false);
  });
});
