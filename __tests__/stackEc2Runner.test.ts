/**
 * The script the EC2 server runs on every start (written by stackEc2Deploy.ts into user_data.sh). It is cut out of the generated file and run for
 * real, with stand-ins for curl (the instance metadata), aws and docker, so what it fetches, writes and runs is checked without a server.
 */
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { defaultProject, generateProjectFiles, LAYERS, type Layer } from '@/lib/engines/containers/stackProject';

let root: string; let bin: string; let fixtures: string; let calls: string;

function runnerFor(on: Layer[]): string {
  const p = defaultProject();
  p.name = 'shop';
  for (const l of LAYERS) p.layers[l].enabled = on.includes(l);
  p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }];
  p.deploy.target = 'ec2';
  const r = generateProjectFiles(p);
  if (!r.ok) throw new Error(r.errors.join(';'));
  const ud = r.files.find((f) => f.path === 'ec2/user_data.sh')!.content;
  const m = /<<'RUNNER'\n([\s\S]*?)\nRUNNER\n/.exec(ud);
  if (!m) throw new Error('runner not found');
  return m[1]!.replace(/"\/opt\/\$APP"/g, `"${root}/opt/$APP"`);
}
const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runner-')); bin = join(root, 'bin'); fixtures = join(root, 'fixtures'); calls = join(root, 'calls');
  mkdirSync(bin); mkdirSync(fixtures); mkdirSync(join(fixtures, 'ssm'));
  writeFileSync(join(fixtures, 'compose.yml'), 'services: {}\n'); writeFileSync(join(fixtures, 'release.env'), 'TAG=v9\n');
  writeFileSync(join(fixtures, 'ssm', 'POSTGRES_PASSWORD'), 'dbpass123'); writeFileSync(join(fixtures, 'ssm', 'JWT_SECRET'), 'jwt.secret-1');
  // IMDS: a token, then the region.
  stub('curl', `case "$*" in *api/token*) echo tok;; *placement/region*) echo eu-west-1;; *) exit 1;; esac`);
  stub('aws', `echo "aws $*" >> "${calls}"
case "$1 $2" in
  "sts get-caller-identity") echo 123456789012;;
  "s3 cp") src="$3"; dst="$4"; key="\${src##*/}"; [ -f "${fixtures}/$key" ] || exit 1; cp "${fixtures}/$key" "$dst";;
  "ssm get-parameter") name=""; while [ $# -gt 0 ]; do [ "$1" = --name ] && name="$2"; shift; done; f="${fixtures}/ssm/\${name##*/}"; [ -f "$f" ] || exit 254; cat "$f";;
  "ecr get-login-password") echo ecrpass;;
  *) exit 2;;
esac`);
  stub('docker', `echo "docker $*" >> "${calls}"; [ "$1" = login ] && cat >/dev/null; exit 0`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (script: string) => {
  const path = join(root, 'runner.sh'); writeFileSync(path, script);
  return spawnSync('bash', [path], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
};
const log = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
const dir = () => join(root, 'opt', 'shop');

describe('the runner on the server', () => {
  const ALL: Layer[] = ['frontend', 'backend', 'api', 'database'];

  test('fetches the compose file and the tag from the release bucket, signs in to ECR, then pulls and runs compose', () => {
    const r = run(runnerFor(ALL));
    expect(r.status).toBe(0);
    const l = log();
    expect(l).toContain('aws s3 cp s3://shop-123456789012/compose.yml compose.yml --region eu-west-1 --only-show-errors');
    expect(l).toContain('aws s3 cp s3://shop-123456789012/release.env release.env --region eu-west-1 --only-show-errors');
    expect(l.some((x) => x.startsWith('docker login'))).toBe(true);
    const pull = l.findIndex((x) => /docker compose -p shop -f compose\.yml pull/.test(x));
    const up = l.findIndex((x) => /docker compose -p shop -f compose\.yml up --remove-orphans/.test(x));
    expect(pull).toBeGreaterThan(l.findIndex((x) => x.startsWith('docker login')));
    expect(up).toBeGreaterThan(pull);
  });

  test('writes the settings file for compose: registry, tag and every secret, readable only by its owner', () => {
    run(runnerFor(ALL));
    const env = readFileSync(join(dir(), '.env'), 'utf8');
    expect(env).toContain('REGISTRY=123456789012.dkr.ecr.eu-west-1.amazonaws.com');
    expect(env).toContain('TAG=v9');
    expect(env).toContain("POSTGRES_PASSWORD='dbpass123'");
    expect(env).toContain("JWT_SECRET='jwt.secret-1'");
    expect(statSync(join(dir(), '.env')).mode & 0o077).toBe(0);
    expect(readFileSync(join(dir(), 'compose.yml'), 'utf8')).toBe('services: {}\n');
  });

  test('a secret that cannot be read stops the start: nothing is run with an empty password', () => {
    rmSync(join(fixtures, 'ssm', 'POSTGRES_PASSWORD'));
    const r = run(runnerFor(ALL));
    expect(r.status).not.toBe(0);
    expect(log().some((x) => /compose .* up/.test(x))).toBe(false);
  });

  test('a release that is not uploaded yet stops the start (systemd tries again)', () => {
    rmSync(join(fixtures, 'compose.yml'));
    const r = run(runnerFor(ALL));
    expect(r.status).not.toBe(0);
    expect(log().some((x) => /compose .* up/.test(x))).toBe(false);
  });

  test('a failed image pull stops the start', () => {
    stub('docker', `echo "docker $*" >> "${calls}"; [ "$1" = login ] && cat >/dev/null; case "$*" in *" pull"*) exit 1;; esac; exit 0`);
    const r = run(runnerFor(ALL));
    expect(r.status).not.toBe(0);
    expect(log().some((x) => /compose .* up/.test(x))).toBe(false);
  });

  test('only the secrets of the services that are on are read', () => {
    run(runnerFor(['backend', 'api']));
    const names = log().filter((x) => x.includes('ssm get-parameter')).map((x) => /--name (\S+)/.exec(x)![1]);
    expect(names).toEqual(['/shop/JWT_SECRET']);
  });
});
