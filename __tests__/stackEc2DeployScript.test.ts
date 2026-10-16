/**
 * The deploy.sh written for a whole project, run for real with stand-ins for terraform, aws, docker and curl: what it asks, what it stores,
 * what it builds and pushes, and that no secret ever appears on a command line.
 */
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { defaultProject, generateProjectFiles, LAYERS, type Layer } from '@/lib/engines/containers/stackProject';

let root: string; let bin: string; let work: string; let calls: string; let stored: string;

const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };

function setup(on: Layer[] = ['frontend', 'backend', 'api', 'database']) {
  const p = defaultProject();
  p.name = 'shop';
  for (const l of LAYERS) p.layers[l].enabled = on.includes(l);
  p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }];
  p.deploy.target = 'ec2';
  const r = generateProjectFiles(p);
  if (!r.ok) throw new Error(r.errors.join(';'));
  for (const f of r.files) { const path = join(work, f.path); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, f.content); }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deploysh-')); bin = join(root, 'bin'); work = join(root, 'project'); calls = join(root, 'calls'); stored = join(root, 'stored');
  mkdirSync(bin); mkdirSync(work); mkdirSync(stored);
  stub('terraform', `echo "terraform $*" >> "${calls}"
case "$*" in
  *"output -raw image_tag"*) echo latest;;
  *"output -raw instance_id"*) echo i-0abc;;
  *"output -raw app_url"*) echo http://203.0.113.9:8080/;;
esac
exit 0`);
  // aws: a secret is "stored" once a file with its name exists in $stored.
  stub('aws', `echo "aws $*" >> "${calls}"
case "$1 $2" in
  "sts get-caller-identity") echo 123456789012;;
  "ssm get-parameter") n=""; while [ $# -gt 0 ]; do [ "$1" = --name ] && n="$2"; shift; done; [ -f "${stored}/\${n##*/}" ] || exit 254;;
  "ssm put-parameter") n=""; v=""; while [ $# -gt 0 ]; do [ "$1" = --name ] && n="$2"; [ "$1" = --value ] && v="$2"; shift; done; cat "\${v#file://}" > "${stored}/\${n##*/}";;
  "ssm send-command") ;;
  "ecr get-login-password") echo pw;;
esac
exit 0`);
  stub('docker', `echo "docker $*" >> "${calls}"; [ "$1" = login ] && cat >/dev/null; exit 0`);
  stub('curl', 'exit 0');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (input: string, args: string[] = ['--yes']) =>
  spawnSync('bash', [join(work, 'deploy.sh'), ...args], { cwd: work, encoding: 'utf8', input, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_WAIT_SECONDS: '5' } });
const log = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
const out = (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`;

describe('deploy.sh of a project', () => {
  test('creates the infrastructure, stores the secrets, builds and pushes every built service, restarts and reports the address', () => {
    setup();
    const r = run('jwt-value_1\n\n');      // the JWT secret, then Enter at the database password (generate one)
    expect(out(r)).toContain('Done. shop is running at http://203.0.113.9:8080/');
    expect(r.status).toBe(0);
    const l = log();
    expect(l.indexOf('terraform -chdir=ec2 init -input=false')).toBeLessThan(l.findIndex((x) => x.startsWith('terraform -chdir=ec2 apply')));
    for (const layer of ['frontend', 'backend', 'api']) {
      expect(l).toContain(`docker build --platform linux/amd64 -t 123456789012.dkr.ecr.us-east-1.amazonaws.com/shop-${layer}:latest ./${layer}`);
      expect(l).toContain(`docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/shop-${layer}:latest`);
    }
    expect(l.some((x) => x.includes('ssm send-command') && x.includes('systemctl restart shop.service'))).toBe(true);
    // Order: the infrastructure, then secrets, then the images, then the restart.
    const idx = (re: RegExp) => l.findIndex((x) => re.test(x));
    expect(idx(/terraform .* apply/)).toBeLessThan(idx(/ssm put-parameter/));
    expect(idx(/ssm put-parameter/)).toBeLessThan(idx(/docker build/));
    expect(idx(/docker push .*shop-api/)).toBeLessThan(idx(/send-command/));
  });

  test('a secret is stored through a private file, never on a command line, and a generated password is random and not empty', () => {
    setup();
    run('jwt-value_1\n\n');
    expect(log().filter((x) => x.includes('put-parameter')).every((x) => /--value file:\/\//.test(x) && !x.includes('jwt-value_1'))).toBe(true);
    expect(readFileSync(join(stored, 'JWT_SECRET'), 'utf8')).toBe('jwt-value_1');
    expect(readFileSync(join(stored, 'POSTGRES_PASSWORD'), 'utf8')).toMatch(/^[0-9a-f]{48}$/);
  });

  test('a password typed by the person is used as typed', () => {
    setup();
    run('jwt-value_1\nmine.typed-1\n');
    expect(readFileSync(join(stored, 'POSTGRES_PASSWORD'), 'utf8')).toBe('mine.typed-1');
  });

  test('a secret that would break a connection URL or the settings file is refused before anything is stored', () => {
    setup();
    const r = run('has space\n');
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/may use only letters, digits/);
    expect(log().some((x) => x.includes('put-parameter'))).toBe(false);
    expect(log().some((x) => x.startsWith('docker build'))).toBe(false);
  });

  test('an application secret has no "generate" option: an empty answer is refused', () => {
    setup();
    const r = run('\n');
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/JWT_SECRET cannot be empty/);
  });

  test('a secret that is already stored is not asked again', () => {
    setup();
    writeFileSync(join(stored, 'POSTGRES_PASSWORD'), 'x'); writeFileSync(join(stored, 'JWT_SECRET'), 'y');
    const r = run('');
    expect(r.status).toBe(0);
    expect(out(r)).toContain('POSTGRES_PASSWORD: already stored');
    expect(log().some((x) => x.includes('put-parameter'))).toBe(false);
  });

  test('refuses to start when you are not signed in to AWS, before creating anything', () => {
    setup();
    stub('aws', 'exit 1');
    const r = run('');
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/not signed in to AWS/);
    expect(log().some((x) => x.startsWith('terraform'))).toBe(false);
  });

  test('a stopped Docker is reported before anything is created', () => {
    setup();
    stub('docker', 'exit 1');
    const r = run('');
    expect(out(r)).toMatch(/Docker is not running/);
    expect(log().some((x) => x.startsWith('terraform'))).toBe(false);
  });

  test('ready-made images only: nothing is built or pushed and Docker is not needed', () => {
    const p = defaultProject();
    p.name = 'shop';
    for (const l of LAYERS) p.layers[l].enabled = ['frontend', 'api'].includes(l);
    for (const l of ['frontend', 'api'] as const) p.layers[l].config = { ...p.layers[l].config, image: 'nginx:1.27' };
    p.deploy.target = 'ec2';
    const res = generateProjectFiles(p);
    if (!res.ok) throw new Error(res.errors.join(';'));
    for (const f of res.files) { const path = join(work, f.path); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, f.content); }
    stub('docker', 'exit 99');
    const r = run('');
    expect(r.status).toBe(0);
    expect(log().some((x) => x.startsWith('docker'))).toBe(false);
  });

  test('destroy.sh needs the project name typed, and removes everything', () => {
    setup();
    const wrong = spawnSync('bash', [join(work, 'destroy.sh')], { cwd: work, encoding: 'utf8', input: 'nope\n', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(wrong.status).not.toBe(0);
    expect(log().some((x) => x.includes('destroy'))).toBe(false);
    const yes = spawnSync('bash', [join(work, 'destroy.sh')], { cwd: work, encoding: 'utf8', input: 'shop\nn\nn\n', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(yes.status).toBe(0);
    expect(log()).toContain('terraform -chdir=ec2 destroy -auto-approve');
  });
});
