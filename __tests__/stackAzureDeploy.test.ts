/**
 * Deploying a whole project (Frontend, Backend, API, Database) to one Azure VM that runs the compose file: the generated files, the script the VM
 * runs on every start (cut out of cloud-init and run with stand-ins), and deploy.sh (run with stand-ins).
 */
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse } from 'yaml';
import { generateProjectFiles, defaultProject, LAYERS, type Layer, type StackProject } from '@/lib/engines/containers/stackProject';
import { COMPOSE_SHA256, COMPOSE_VERSION } from '@/lib/engines/containers/stackEc2Deploy';

const project = (on: Layer[], tweak?: (p: StackProject) => void): StackProject => {
  const p = defaultProject();
  p.name = 'shop';
  for (const l of LAYERS) p.layers[l].enabled = on.includes(l);
  p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }];
  p.deploy.target = 'azure-vm';
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
const ALL: Layer[] = ['frontend', 'backend', 'api', 'database'];
const combos = (): Layer[][] => { const o: Layer[][] = []; for (let m = 1; m < 16; m++) { const c = LAYERS.filter((_, i) => m & (1 << i)); if (c.length > 1) o.push(c); } return o; };
const sh = (cmd: string, args: string[], input: string) => spawnSync(cmd, args, { input, encoding: 'utf8' });

describe('the files', () => {
  test('a deployment adds deploy.sh, destroy.sh and an azvm folder (and no ec2 folder), and keeps the local compose file', () => {
    const r = gen(ALL);
    const paths = r.files.map((f) => f.path);
    for (const p of ['deploy.sh', 'destroy.sh', 'azvm/main.tf', 'azvm/variables.tf', 'azvm/outputs.tf', 'azvm/cloud-init.sh', 'azvm/compose.deploy.yml', 'azvm/README.md', 'azvm/.gitignore']) expect(paths).toContain(p);
    expect(paths.some((p) => p.startsWith('ec2/'))).toBe(false);
    expect(file(r, 'docker-compose.yml')).toContain('build: ./backend');
    expect(r.files.find((f) => f.path === 'deploy.sh')!.executable).toBe(true);
  });

  test.each(combos().map((c) => [c.join('+'), c] as const))('%s: every script is valid shell and the compose file has exactly those services', (_n, on) => {
    const r = gen(on);
    for (const f of ['deploy.sh', 'destroy.sh', 'azvm/cloud-init.sh']) expect({ f, ...sh('bash', ['-n'], file(r, f)) }).toMatchObject({ f, status: 0, stderr: '' });
    expect(Object.keys((parse(file(r, 'azvm/compose.deploy.yml')) as { services: object }).services).sort()).toEqual([...on].sort());
  });

  test('the compose file is the one the EC2 server runs: images from the registry, one public service', () => {
    const azure = file(gen(ALL), 'azvm/compose.deploy.yml');
    const ec2 = (() => { const r = generateProjectFiles(project(ALL, (p) => { p.deploy.target = 'ec2'; })); return r.ok ? r.files.find((f) => f.path === 'ec2/compose.deploy.yml')!.content : ''; })();
    expect(azure).toBe(ec2);
    expect(azure).toContain('${REGISTRY:?set REGISTRY}/shop-api:${TAG:?set TAG}');
  });

  test('without a deployment, and with one service, nothing about Azure is generated', () => {
    const none = generateProjectFiles(project(ALL, (p) => { p.deploy.target = 'none'; }));
    expect(none.ok && none.files.some((f) => f.path.startsWith('azvm/'))).toBe(false);
    const one = generateProjectFiles(project(['backend']));
    expect(one.ok && one.files.some((f) => f.path === 'azvm/compose.deploy.yml')).toBe(false);
  });
});

describe('the Terraform', () => {
  const main = () => file(gen(ALL), 'azvm/main.tf');
  test('safe defaults: no SSH, no registry admin user, a managed identity that only pulls images and reads secrets, RBAC on the vault', () => {
    const m = main();
    expect(m).toContain('disable_password_authentication = true');
    expect(m).toContain('admin_enabled       = false');
    expect(m).toContain('role_definition_name = "AcrPull"');
    expect(m).toContain('role_definition_name = "Key Vault Secrets User"');
    expect(m).toContain('enable_rbac_authorization  = true');
    expect(m).not.toMatch(/destination_port_range\s+= "22"/);
  });
  test('the network group opens exactly one rule, for the public service\'s port', () => {
    const r = gen(ALL);
    expect(file(r, 'azvm/main.tf').match(/security_rule \{/g)).toHaveLength(1);
    expect(file(r, 'azvm/variables.tf')).toMatch(/variable "entry_port"[\s\S]*default\s+= 8080/);
  });
  test('the VM is never replaced by a new start-up script, a tag or a key', () => {
    expect(main()).toContain('ignore_changes = [admin_ssh_key, tags, custom_data]');
  });
  test('the registry and its pull role exist only when something is built', () => {
    const none = file(gen(['frontend', 'api'], (p) => { for (const l of ['frontend', 'api'] as const) p.layers[l].config = { ...p.layers[l].config, image: 'nginx:1.27' }; }), 'azvm/main.tf');
    expect(none).not.toContain('azurerm_container_registry');
    expect(none).not.toContain('AcrPull');
    expect(main()).toContain('azurerm_container_registry');
  });
  test('the settings from the form end up in variables.tf', () => {
    const v = file(gen(ALL, (p) => { Object.assign(p.deploy.azvm, { location: 'eastus2', size: 'Standard_D2s_v3', allowedCidr: '203.0.113.0/24', diskGb: 64, imageTag: 'v7' }); }), 'azvm/variables.tf');
    for (const x of ['"eastus2"', '"Standard_D2s_v3"', '"203.0.113.0/24"', '= 64', '"v7"', '"shop"']) expect(v).toContain(x);
  });
});

describe('what is checked and said', () => {
  test('bad settings stop the files, with the reason', () => {
    for (const [patch, why] of [[{ allowedCidr: 'everyone' }, /who can connect/], [{ size: 'big' }, /size/], [{ diskGb: 5 }, /disk size/], [{ location: 'Mars 1' }, /location/], [{ imageTag: 'a b' }, /image tag/]] as const) {
      const r = generateProjectFiles(project(ALL, (x) => { Object.assign(x.deploy.azvm, patch); }));
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.errors.join(' ')).toMatch(why);
    }
  });
  test('a project name Azure would refuse stops the files (it names the resource group, registry and vault)', () => {
    const r = generateProjectFiles(project(ALL, (p) => { p.name = 'shop_2'; }));
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.errors.join(' ')).toMatch(/app name/);
  });
  test('a database on the same VM, an open range and the latest tag are warned about; a cost without a registry when nothing is built', () => {
    const r = gen(ALL);
    const w = r.warnings.join(' | ');
    expect(w).toContain('whole internet'); expect(w).toContain('same VM as the application'); expect(w).toContain('"latest" tag');
    expect(r.cost?.lines.map((l) => l.label).join(' ')).toContain('Standard_B2ms');
    expect(r.cost?.lines.map((l) => l.label).join(' ')).toContain('Container Registry');
    const none = gen(['frontend', 'api'], (p) => { for (const l of ['frontend', 'api'] as const) p.layers[l].config = { ...p.layers[l].config, image: 'nginx:1.27' }; });
    expect(none.cost?.lines.map((l) => l.label).join(' ')).not.toContain('Container Registry');
  });
});

// ─── the script the VM runs ──────────────────────────────────────────────────

describe('cloud-init and the runner on the VM', () => {
  let root: string; let bin: string; let fixtures: string; let calls: string;
  const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'azrunner-')); bin = join(root, 'bin'); fixtures = join(root, 'fx'); calls = join(root, 'calls');
    mkdirSync(bin); mkdirSync(join(fixtures, 'kv'), { recursive: true });
    writeFileSync(join(fixtures, 'tags.json'), JSON.stringify([{ name: 'acr', value: 'acrshop.azurecr.io' }, { name: 'vault', value: 'kvshop' }, { name: 'image_tag', value: 'v3' }]));
    writeFileSync(join(fixtures, 'kv', 'POSTGRES-PASSWORD'), 'dbpass123'); writeFileSync(join(fixtures, 'kv', 'JWT-SECRET'), 'jwt.secret-1');
    stub('curl', `echo "curl $*" >> "${calls}"
case "$*" in
  *tagsList*) cat "${fixtures}/tags.json";;
  *oauth2/exchange*) echo '{"refresh_token":"rt"}';;
  *identity/oauth2/token*) echo '{"access_token":"aad"}';;
  *vault.azure.net/secrets/*) for a in "$@"; do u="$a"; done; n="\${u##*/secrets/}"; n="\${n%%\\?*}"; [ -f "${fixtures}/kv/$n" ] || exit 22; printf '{"value":"%s"}' "$(cat "${fixtures}/kv/$n")";;
  *) exit 22;;
esac`);
  stub('docker', `echo "docker $*" >> "${calls}"; [ "$1" = login ] && cat >/dev/null; exit 0`);
  const pyStub = join(bin, 'py_stub.cjs');
  writeFileSync(pyStub, `
    const fs = require("fs");
    const code = process.argv[2] || "";
    const arg = process.argv[3];
    const stdin = fs.readFileSync(0, "utf8");
    try {
      const json = JSON.parse(stdin);
      if (Array.isArray(json)) {
        const map = {};
        for (const item of json) map[item.name] = item.value;
        process.stdout.write(map[arg] || "");
      } else if (code.includes("access_token")) {
        process.stdout.write(json.access_token || "");
      } else if (code.includes("refresh_token")) {
        process.stdout.write(json.refresh_token || "");
      } else if (code.includes("value")) {
        process.stdout.write(json.value || "");
      }
    } catch (e) {
      process.exit(1);
    }
  `);
  stub('python3', `if [ "$1" = "-c" ]; then shift; fi
node "${pyStub.replace(/\\/g, '/')}" "$@"`);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const cloudInit = (on: Layer[] = ALL) => file(gen(on), 'azvm/cloud-init.sh');
  const runner = (on: Layer[] = ALL) => {
    const m = /<<'RUNNER'\n([\s\S]*?)\nRUNNER\n/.exec(cloudInit(on));
    return m![1]!.replace('DIR="/opt/$APP"', `DIR="${root}/opt/$APP"`);
  };
  const seed = () => { mkdirSync(join(root, 'opt', 'shop'), { recursive: true }); writeFileSync(join(root, 'opt', 'shop', 'compose.yml'), 'services: {}\n'); };
  const run = (script: string) => { const path = join(root, 'runner.sh'); writeFileSync(path, script); return spawnSync('bash', [path], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }); };
  const log = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);

  test('cloud-init installs Docker and a pinned, checksum-verified Compose, writes the compose file and starts the service', () => {
    const c = cloudInit();
    expect(c).toContain('apt-get install -y docker.io curl python3');
    expect(c).toContain(`releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64`);
    expect(c).toContain(`echo "${COMPOSE_SHA256}  $PLUGIN_DIR/docker-compose" | sha256sum -c -`);
    expect(c).toContain("cat > /opt/shop/compose.yml <<'COMPOSE'");
    expect(c).toContain('systemctl enable --now shop.service');
    // The compose file written at first boot is the one in the bundle.
    expect(/<<'COMPOSE'\n([\s\S]*?)\nCOMPOSE\n/.exec(c)![1]! + '\n').toBe(file(gen(ALL), 'azvm/compose.deploy.yml'));
  });

  test('the runner reads the registry, vault and tag from the VM tags, signs in with the identity, and writes the settings for compose', () => {
    seed();
    const r = run(runner());
    expect(r.status).toBe(0);
    const l = log();
    expect(l.some((x) => x.includes('acrshop.azurecr.io/oauth2/exchange'))).toBe(true);
    expect(l).toContain('docker login acrshop.azurecr.io --username 00000000-0000-0000-0000-000000000000 --password-stdin');
    const pull = l.findIndex((x) => /docker compose -p shop -f compose\.yml pull/.test(x));
    expect(pull).toBeGreaterThan(l.findIndex((x) => x.startsWith('docker login')));
    expect(l.findIndex((x) => /docker compose -p shop -f compose\.yml up --remove-orphans/.test(x))).toBeGreaterThan(pull);
    const env = readFileSync(join(root, 'opt', 'shop', '.env'), 'utf8');
    expect(env).toContain('REGISTRY=acrshop.azurecr.io');
    expect(env).toContain('TAG=v3');
    expect(env).toContain("POSTGRES_PASSWORD='dbpass123'");
    expect(env).toContain("JWT_SECRET='jwt.secret-1'");
    if (process.platform !== 'win32') {
      expect(statSync(join(root, 'opt', 'shop', '.env')).mode & 0o077).toBe(0);
    }
  });

  test('a secret that cannot be read, a missing compose file or a failed pull stops the start: nothing runs with an empty password', () => {
    seed();
    rmSync(join(fixtures, 'kv', 'POSTGRES-PASSWORD'));
    expect(run(runner()).status).not.toBe(0);
    expect(log().some((x) => /compose .* up/.test(x))).toBe(false);
    rmSync(join(fixtures, 'kv'), { recursive: true }); mkdirSync(join(fixtures, 'kv')); writeFileSync(join(fixtures, 'kv', 'POSTGRES-PASSWORD'), 'p'); writeFileSync(join(fixtures, 'kv', 'JWT-SECRET'), 'j');
    rmSync(join(root, 'opt', 'shop', 'compose.yml'));
    const r = run(runner());
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/compose\.yml is missing/);
    writeFileSync(join(root, 'opt', 'shop', 'compose.yml'), 'services: {}\n');
    stub('docker', `echo "docker $*" >> "${calls}"; [ "$1" = login ] && cat >/dev/null; case "$*" in *" pull"*) exit 1;; esac; exit 0`);
    expect(run(runner()).status).not.toBe(0);
  });

  test('with only ready-made images there is no registry sign-in, and only the secrets that exist are read', () => {
    seed();
    const on: Layer[] = ['frontend', 'api'];
    const script = file(gen(on, (p) => { for (const l of on) p.layers[l].config = { ...p.layers[l].config, image: 'nginx:1.27' }; p.layers.backend.config.env = []; }), 'azvm/cloud-init.sh');
    const body = /<<'RUNNER'\n([\s\S]*?)\nRUNNER\n/.exec(script)![1]!.replace('DIR="/opt/$APP"', `DIR="${root}/opt/$APP"`);
    const r = run(body);
    expect(r.status).toBe(0);
    expect(log().some((x) => x.startsWith('docker login'))).toBe(false);
    expect(log().some((x) => x.includes('vault.azure.net'))).toBe(false);
  });
});

// ─── deploy.sh ───────────────────────────────────────────────────────────────

describe('deploy.sh of an Azure project', () => {
  let root: string; let bin: string; let work: string; let calls: string; let stored: string;
  const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  function setup(on: Layer[] = ALL) {
    const r = generateProjectFiles(project(on));
    if (!r.ok) throw new Error(r.errors.join(';'));
    for (const f of r.files) { const path = join(work, f.path); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, f.content); }
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'azdeploy-')); bin = join(root, 'bin'); work = join(root, 'p'); calls = join(root, 'calls'); stored = join(root, 'kv');
    mkdirSync(bin); mkdirSync(work); mkdirSync(stored);
    stub('terraform', `echo "terraform $*" >> "${calls}"
case "$*" in
  *"output -raw vault_name"*) echo kvshop;; *"output -raw acr_name"*) echo acrshop;; *"output -raw resource_group"*) echo rg-shop;;
  *"output -raw vm_name"*) echo vm-shop;; *"output -raw app_url"*) echo http://203.0.113.9:8080/;;
esac
exit 0`);
    stub('az', `echo "az $*" >> "${calls}"
case "$1 $2 $3" in
  "account show "*) echo sub;;
  "keyvault secret show") n=""; while [ $# -gt 0 ]; do [ "$1" = --name ] && n="$2"; shift; done; [ -f "${stored}/$n" ] || exit 3;;
  "keyvault secret set") n=""; f=""; while [ $# -gt 0 ]; do [ "$1" = --name ] && n="$2"; [ "$1" = --file ] && f="$2"; shift; done; cat "$f" > "${stored}/$n";;
esac
exit 0`);
    stub('curl', 'exit 0'); stub('sleep', 'exit 0');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const run = (input: string) => spawnSync('bash', [join(work, 'deploy.sh'), '--yes'], { cwd: work, encoding: 'utf8', input, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_WAIT_SECONDS: '5' } });
  const log = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  const out = (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`;

  test('creates the vault and registry first, stores the secrets, builds each image in Azure, then creates the VM, sets the tag, sends the compose file and restarts', () => {
    setup();
    const r = run('jwt-value_1\n\n');
    expect(out(r)).toContain('Done. shop is running at http://203.0.113.9:8080/');
    expect(r.status).toBe(0);
    const l = log();
    const idx = (re: RegExp) => l.findIndex((x) => re.test(x));
    expect(l.find((x) => /terraform .* apply/.test(x))).toContain('-target=azurerm_container_registry.app');
    for (const layer of ['frontend', 'backend', 'api']) expect(l).toContain(`az acr build --registry acrshop --image shop-${layer}:latest --platform linux/amd64 ./${layer}`);
    expect(idx(/keyvault secret set/)).toBeLessThan(idx(/acr build/));
    expect(idx(/acr build/)).toBeLessThan(idx(/vm update/));
    expect(idx(/vm update/)).toBeLessThan(idx(/base64 -d > \/opt\/shop\/compose\.yml/));
    expect(idx(/base64 -d > \/opt\/shop\/compose\.yml/)).toBeLessThan(idx(/systemctl restart shop\.service/));
    expect(l.some((x) => x.includes('--set tags.image_tag=latest'))).toBe(true);
  });

  test('the compose file sent to the VM is the one in the bundle', () => {
    setup();
    run('jwt-value_1\n\n');
    const put = log().find((x) => x.includes('base64 -d > /opt/shop/compose.yml'))!;
    const b64 = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(put)![1]!;
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(readFileSync(join(work, 'azvm', 'compose.deploy.yml'), 'utf8'));
  });

  test('secrets: hidden prompt, stored through a private file, the database password can be generated, bad characters are refused', () => {
    setup();
    run('jwt-value_1\n\n');
    expect(readFileSync(join(stored, 'JWT-SECRET'), 'utf8')).toBe('jwt-value_1');
    expect(readFileSync(join(stored, 'POSTGRES-PASSWORD'), 'utf8')).toMatch(/^[0-9a-f]{48}$/);
    expect(log().filter((x) => x.includes('secret set')).every((x) => x.includes('--file') && !x.includes('jwt-value_1'))).toBe(true);
    rmSync(stored, { recursive: true }); mkdirSync(stored); rmSync(calls);
    const bad = run('has space\n');
    expect(bad.status).not.toBe(0);
    expect(out(bad)).toMatch(/may use only letters, digits/);
    expect(log().some((x) => x.includes('secret set') || x.includes('acr build'))).toBe(false);
  });

  test('a VM that never accepts commands stops the release with a clear message (the compose file would be stale)', () => {
    setup();
    stub('az', `echo "az $*" >> "${calls}"
case "$1 $2 $3" in "account show "*) echo sub;; "keyvault secret show") exit 0;; "vm run-command invoke") exit 1;; esac
exit 0`);
    const r = run('');
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/Could not reach the VM to update its compose file/);
    expect(log().some((x) => x.includes('systemctl restart'))).toBe(false);
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
    const wrong = spawnSync('bash', [join(work, 'destroy.sh')], { cwd: work, encoding: 'utf8', input: 'nope\n', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(wrong.status).not.toBe(0);
    expect(log().some((x) => x.includes('destroy'))).toBe(false);
    const yes = spawnSync('bash', [join(work, 'destroy.sh')], { cwd: work, encoding: 'utf8', input: 'shop\n', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(yes.status).toBe(0);
    expect(log()).toContain('terraform -chdir=azvm destroy -auto-approve');
  });
});
