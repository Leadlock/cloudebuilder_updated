/**
 * scripts/deploy.sh, the command run from your own computer. It is run for real in a throwaway git repository, with a stand-in for ssh that runs the
 * server's commands in a temporary folder, so what it refuses and what it sends are tested without a server.
 */
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SRC = resolve(__dirname, '..');
let root: string; let repo: string; let server: string; let bin: string; let state: string; let ci: string;

const sh = (cwd: string, cmd: string) => { const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`${cmd}\n${r.stdout}\n${r.stderr}`); return r.stdout.trim(); };
const put = (path: string, content: string, mode?: number) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content); if (mode) chmodSync(path, mode); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deploy-script-'));
  repo = join(root, 'repo'); server = join(root, 'server', 'CloudBuilder'); bin = join(root, 'bin'); state = join(root, 'state'); ci = join(state, 'ci');
  mkdirSync(state, { recursive: true });
  // The repository: the deploy scripts, a package.json and one source file, pushed to a bare "origin".
  mkdirSync(join(repo, 'scripts', 'deploy'), { recursive: true });
  for (const f of ['scripts/deploy.sh', 'scripts/deploy/remote.sh']) { writeFileSync(join(repo, f), readFileSync(join(SRC, f))); chmodSync(join(repo, f), 0o755); }
  put(join(repo, 'package.json'), '{}'); put(join(repo, 'package-lock.json'), 'lock'); put(join(repo, 'src.txt'), 'NEW'); put(join(repo, '.gitignore'), 'local-only.txt\n.env\n');
  sh(root, `git init -q --bare origin.git && git init -q -b main repo`);
  sh(repo, `git config user.email t@t && git config user.name t && git add -A && git commit -q -m 'first' && git remote add origin ../origin.git && git push -q origin main`);
  // The "server": the running old version, with its own .env.
  put(join(server, 'package.json'), '{}'); put(join(server, 'package-lock.json'), 'lock'); put(join(server, '.env'), 'RESTRICTED_FEATURES_ALLOWED_EMAILS=ajinkya@neozaar.com');
  put(join(server, 'src.txt'), 'OLD'); put(join(server, '.next', 'BUILD_ID'), 'old-build'); put(join(server, 'node_modules', 'x'), 'x');
  // ssh stand-in: drops its options (newer rsync passes the user as `-l user`) and the host, then runs the command here. rsync uses it too.
  put(join(bin, 'ssh'), `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -o|-O|-l|-p|-i) shift 2;; -*) shift;; *) break;; esac; done
shift
[ $# -eq 0 ] && exit 0
exec bash -c "$*"`, 0o755);
  put(join(bin, 'gh'), `#!/bin/bash\ncat "${ci}"`, 0o755);
  writeFileSync(ci, 'success');
  put(join(bin, 'npm'), `#!/bin/bash
if [ "$1" = ci ]; then mkdir -p node_modules; exit 0; fi
if [ "$1" = run ]; then rm -rf .next; mkdir -p .next; [ -f "${state}/FAIL_BUILD" ] && exit 1; echo new-build > .next/BUILD_ID; exit 0; fi`, 0o755);
  put(join(bin, 'pm2'), `#!/bin/bash
[ "$1" = restart ] && { echo r >> "${state}/restarts"; exit 0; }
[ "$1" = jlist ] && { echo '[{"name":"web","pm2_env":{"status":"online","restart_time":0}}]'; exit 0; }
exit 0`, 0o755);
  put(join(bin, 'curl'), `#!/bin/bash\ngrep -q bad "${server}/.next/BUILD_ID" 2>/dev/null && echo 502 || echo 200`, 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const deploy = (args: string[] = []) => spawnSync('bash', ['scripts/deploy.sh', '--yes', ...args], {
  cwd: repo, encoding: 'utf8',
  env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? root, DEPLOY_HOST: 'root@fake', DEPLOY_DIR: server,
    BACKUP_DIR: join(root, 'backups'), PM2_APPS: 'web', HEALTH_URL: 'http://stub', HEALTH_WAIT: '4', STABLE_WAIT: '1', MIN_FREE_MB: '1',
  },
});
const out = (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`;
const read = (p: string) => readFileSync(p, 'utf8');

describe('deploy.sh refuses before touching the server', () => {
  test('uncommitted changes', () => {
    writeFileSync(join(repo, 'src.txt'), 'edited');
    const r = deploy();
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/uncommitted changes/);
    expect(read(join(server, 'src.txt'))).toBe('OLD');
  });

  test('a commit that is not on origin/main, unless asked', () => {
    writeFileSync(join(repo, 'src.txt'), 'second'); sh(repo, `git commit -qam second`);
    const r = deploy();
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/is not origin\/main/);
    expect(read(join(server, 'src.txt'))).toBe('OLD');
    expect(deploy(['--allow-unpushed']).status).toBe(0);
  });

  test('a CI that is not green, unless overridden', () => {
    writeFileSync(ci, 'failure');
    const r = deploy();
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/CI is 'failure'/);
    expect(read(join(server, 'src.txt'))).toBe('OLD');
    expect(deploy(['--ignore-ci']).status).toBe(0);
  });

  test('a commit CI has not finished', () => {
    writeFileSync(ci, 'none');
    expect(out(deploy())).toMatch(/no finished CI run/);
  });

  test('an unknown option', () => {
    expect(deploy(['--wat']).status).toBe(2);
  });
});

describe('deploy.sh', () => {
  test('--dry-run lists the files and changes nothing', () => {
    const r = deploy(['--dry-run']);
    expect(r.status).toBe(0);
    expect(out(r)).toContain('src.txt');
    expect(read(join(server, 'src.txt'))).toBe('OLD');
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });

  test('a good deploy: backs up, sends the new source, keeps .env, builds, restarts and records the commit', () => {
    const r = deploy();
    expect(r.status).toBe(0);
    expect(out(r)).toMatch(/Deployed/);
    expect(read(join(server, 'src.txt'))).toBe('NEW');
    expect(read(join(server, '.env'))).toBe('RESTRICTED_FEATURES_ALLOWED_EMAILS=ajinkya@neozaar.com');
    expect(read(join(server, '.next', 'BUILD_ID')).trim()).toBe('new-build');
    expect(read(join(server, '.deployed-commit')).trim()).toBe(sh(repo, 'git rev-parse HEAD'));
    expect(existsSync(join(root, 'backups', 'latest'))).toBe(true);
  });

  test('only what git tracks is sent: ignored local files and .env never leave', () => {
    writeFileSync(join(repo, 'local-only.txt'), 'private');
    writeFileSync(join(repo, '.env'), 'LOCAL_SECRET=1');
    sh(repo, 'git status --porcelain');
    expect(deploy().status).toBe(0);
    expect(existsSync(join(server, 'local-only.txt'))).toBe(false);
    expect(read(join(server, '.env'))).not.toContain('LOCAL_SECRET');
  });

  test('a build that fails puts the old version back and says so', () => {
    writeFileSync(join(state, 'FAIL_BUILD'), '1');
    const r = deploy();
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/previous version was put back/);
    expect(read(join(server, 'src.txt'))).toBe('OLD');
    expect(read(join(server, '.next', 'BUILD_ID'))).toBe('old-build');
  });

  test('--rollback puts the backup of the last deploy back', () => {
    expect(deploy().status).toBe(0);
    expect(read(join(server, 'src.txt'))).toBe('NEW');
    const r = deploy(['--rollback']);
    expect(r.status).toBe(0);
    expect(read(join(server, 'src.txt'))).toBe('OLD');
  });

  test('without a --yes it asks, and an empty answer cancels', () => {
    const r = spawnSync('bash', ['scripts/deploy.sh'], { cwd: repo, encoding: 'utf8', input: '\n', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? root, DEPLOY_HOST: 'root@fake', DEPLOY_DIR: server } });
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/cancelled/);
    expect(read(join(server, 'src.txt'))).toBe('OLD');
  });
});
