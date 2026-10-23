/**
 * scripts/deploy/remote.sh, the part of the redeploy that runs on the server: backup, build, restart, and going back by itself when anything fails.
 * It is run here for real in a temporary folder, with small stand-ins for npm, pm2 and curl, so every path (success, failed build, site not answering,
 * crash loop, rollback, concurrent deploy, missing .env) is exercised without a server.
 */
import { execSync, spawnSync } from 'child_process';
import { gunzipSync } from 'zlib';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(__dirname, '../scripts/deploy/remote.sh');
const APPS = 'web disc tf';

let root: string; let app: string; let backups: string; let bin: string; let state: string;

const put = (path: string, content: string, mode?: number) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content); if (mode) chmodSync(path, mode); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deploy-test-'));
  app = join(root, 'CloudBuilder'); backups = join(root, 'backups'); bin = join(root, 'bin'); state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  put(join(app, 'package.json'), '{}');
  put(join(app, 'package-lock.json'), 'lock-v1');
  put(join(app, '.env'), 'SECRET=keep-me');
  put(join(app, 'src.txt'), 'OLD');
  put(join(app, '.next', 'BUILD_ID'), 'old-build');
  put(join(app, 'node_modules', 'x'), 'x');
  put(join(app, '.installed-lock-hash'), 'will-be-replaced');
  // npm: `ci` makes node_modules; `run build` writes the build from the file NEWBUILD (or fails when FAIL_BUILD exists).
  put(join(bin, 'npm'), `#!/bin/bash
echo "npm $*" >> "${state}/calls"
if [ "$1" = ci ]; then [ -f "${state}/FAIL_CI" ] && exit 1; mkdir -p node_modules; exit 0; fi
if [ "$1" = run ]; then
  rm -rf .next; mkdir -p .next
  if [ -f "${state}/FAIL_BUILD" ]; then echo partial > .next/BUILD_ID; exit 1; fi
  cat "${state}/NEWBUILD" > .next/BUILD_ID; exit 0
fi`, 0o755);
  // pm2: restart counts per app in files; a CRASHLOOP file makes the count rise on every look.
  put(join(bin, 'pm2'), `#!/bin/bash
S="${state}"
if [ "$1" = restart ]; then echo restart >> "$S/restarts"; for a in $APPS_LIST; do echo $(( $(cat "$S/count-$a" 2>/dev/null || echo 0) + 1 )) > "$S/count-$a"; done; exit 0; fi
if [ "$1" = jlist ]; then
  [ -f "$S/PM2_DOWN" ] && exit 1
  out=""; for a in $APPS_LIST; do
    n=$(cat "$S/count-$a" 2>/dev/null || echo 0)
    if [ -f "$S/CRASHLOOP" ]; then n=$((n + 1)); echo $n > "$S/count-$a"; fi
    st=online; [ -f "$S/STOPPED-$a" ] && st=stopped
    out="$out{\\"name\\":\\"$a\\",\\"pm2_env\\":{\\"status\\":\\"$st\\",\\"restart_time\\":$n}},"
  done
  echo "[\${out%,}]"; exit 0
fi`, 0o755);
  // curl: 200 while the site is "up": the current build is not marked bad and the site was not switched off.
  put(join(bin, 'curl'), `#!/bin/bash
if [ -f "${state}/SITE_DOWN" ] || grep -q bad "${app}/.next/BUILD_ID" 2>/dev/null; then echo 502; else echo 200; fi`, 0o755);
  put(join(bin, 'python3'), `#!/bin/bash
if [ "$1" = "-c" ]; then shift; fi
shift
node -e '
  const fs = require("fs");
  const want = (process.argv[1] || "").split(/\\s+/).filter(Boolean);
  const input = fs.readFileSync(0, "utf8");
  try {
    const list = JSON.parse(input);
    const procs = {};
    for (const p of list) procs[p.name] = p.pm2_env;
    let bad = false;
    for (const name of want) {
      const e = procs[name];
      if (!e || e.status !== "online") {
        console.log(name, "NOT-ONLINE");
        bad = true;
      } else {
        console.log(name, e.restart_time || 0);
      }
    }
    process.exit(bad ? 1 : 0);
  } catch {
    process.exit(1);
  }
' "$1"`, 0o755);
  put(join(bin, 'rsync'), '#!/bin/bash\nexit 0', 0o755);
  writeFileSync(join(state, 'NEWBUILD'), 'new-build');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (args: string[], extra: Record<string, string> = {}) => spawnSync('bash', [SCRIPT, ...args], {
  encoding: 'utf8',
  env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`, APP_DIR: app, BACKUP_DIR: backups, PM2_APPS: APPS, APPS_LIST: APPS,
    HEALTH_URL: 'http://stub', HEALTH_WAIT: '4', STABLE_WAIT: '1', MIN_FREE_MB: '1', KEEP_BACKUPS: '3', KEEP_BUILDS: '2', NODE_MEM: '512', ...extra,
  },
});
const out = (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`;
const read = (p: string) => readFileSync(p, 'utf8');
const restarts = () => (existsSync(join(state, 'restarts')) ? read(join(state, 'restarts')).trim().split('\n').length : 0);
const flag = (name: string) => writeFileSync(join(state, name), '1');

describe('a good deploy', () => {
  test('backs up, installs (the lock file changed), builds, restarts once and records the commit', () => {
    expect(run(['prepare']).status).toBe(0);
    put(join(app, 'src.txt'), 'NEW'); put(join(app, 'package-lock.json'), 'lock-v2');
    const r = run(['activate', 'abc1234']);
    expect(out(r)).toContain('DONE: abc1234');
    expect(r.status).toBe(0);
    expect(read(join(state, 'calls'))).toMatch(/npm ci[\s\S]*npm run build/);
    expect(restarts()).toBe(1);
    expect(read(join(app, '.deployed-commit')).trim()).toBe('abc1234');
    expect(read(join(app, '.next', 'BUILD_ID'))).toBe('new-build');
    expect(read(join(app, '.env'))).toBe('SECRET=keep-me');
  });

  test('skips npm ci when the dependency list is unchanged', () => {
    run(['prepare']); run(['activate', 'one']);
    run(['prepare']);
    const r = run(['activate', 'two']);
    expect(out(r)).toContain('skipping npm ci');
    expect(read(join(state, 'calls')).match(/npm ci/g)?.length).toBe(1);
  });

  test('the backup holds the old source, the old build and the commit it was', () => {
    writeFileSync(join(app, '.deployed-commit'), 'prev111');
    run(['prepare']);
    const id = read(join(backups, 'latest')).trim();
    expect(existsSync(join(backups, `${id}.tgz`))).toBe(true);
    expect(read(join(backups, `${id}.next`, 'BUILD_ID'))).toBe('old-build');
    expect(read(join(backups, `${id}.commit`)).trim()).toBe('prev111');
  });

  test('the backups folder is private (they contain .env)', () => {
    run(['prepare']);
    const id = read(join(backups, 'latest')).trim();
    const mode = (p: string) => statSync(p).mode & 0o077;
    if (process.platform !== 'win32') {
      expect(mode(join(backups, `${id}.tgz`))).toBe(0);
    }
  });
});

describe('the database backup', () => {
  // docker: `ps` lists the database container; `exec ... pg_dump` writes a dump that changes on every call (or fails when FAIL_DUMP exists).
  const withDb = () => {
    put(join(app, '.env'), 'SECRET=keep-me\nDATABASE_URL="postgresql://appuser:pw@localhost:5432/appdb"');
    put(join(bin, 'docker'), `#!/bin/bash
echo "docker $*" >> "${state}/dockercalls"
if [ "$1" = ps ]; then echo cloudcraft-pg; exit 0; fi
[ -f "${state}/FAIL_DUMP" ] && exit 1
n=$(( $(cat "${state}/dumpn" 2>/dev/null || echo 0) + 1 )); echo $n > "${state}/dumpn"; echo "-- dump $n"`, 0o755);
  };
  const dumps = () => readdirSync(backups).filter((f) => f.endsWith('.sql.gz'));

  test('dumps the database next to the source backup, without a password on a command line', () => {
    withDb();
    const r = run(['prepare']);
    expect(r.status).toBe(0);
    expect(dumps()).toHaveLength(1);
    expect(gunzipSync(readFileSync(join(backups, dumps()[0]))).toString()).toContain('-- dump 1');
    const calls = read(join(state, 'dockercalls'));
    expect(calls).toContain('exec cloudcraft-pg pg_dump -U appuser -d appdb');
    expect(calls).not.toContain('pw');
  });

  test('a new dump replaces the previous one', () => {
    withDb();
    run(['prepare']);
    const first = dumps()[0];
    execSync('sleep 1.1'); // a different second gives a different backup id
    expect(run(['prepare']).status).toBe(0);
    expect(dumps()).toHaveLength(1);
    expect(dumps()[0]).not.toBe(first);
    expect(gunzipSync(readFileSync(join(backups, dumps()[0]))).toString()).toContain('-- dump');
  });

  test('a database that cannot be dumped stops the deploy before anything is backed up or changed', () => {
    withDb(); flag('FAIL_DUMP');
    const r = run(['prepare']);
    expect(r.status).not.toBe(0);
    expect(out(r)).toContain('the database backup failed');
    expect(dumps()).toHaveLength(0);
    expect(existsSync(join(backups, 'latest'))).toBe(false);
    expect(read(join(app, 'src.txt'))).toBe('OLD');
  });

  test('without a DATABASE_URL it says so and carries on', () => {
    const r = run(['prepare']);
    expect(r.status).toBe(0);
    expect(out(r)).toContain('the database is not backed up');
    expect(dumps()).toHaveLength(0);
  });
});

describe('a failed deploy goes back by itself', () => {
  test('a failed build restores the source and the build, and restarts nothing', () => {
    run(['prepare']);
    put(join(app, 'src.txt'), 'NEW'); flag('FAIL_BUILD');
    const r = run(['activate', 'bad1']);
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/the build failed/);
    expect(read(join(app, 'src.txt'))).toBe('OLD');
    expect(read(join(app, '.next', 'BUILD_ID'))).toBe('old-build');
    expect(existsSync(join(app, '.deployed-commit'))).toBe(false);
  });

  test('a site that does not answer after the restart is rolled back and restarted on the old build', () => {
    run(['prepare']);
    writeFileSync(join(state, 'NEWBUILD'), 'bad-build');
    const r = run(['activate', 'bad2']);
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/did not answer/);
    expect(out(r)).toContain('ROLLED BACK');
    expect(read(join(app, '.next', 'BUILD_ID'))).toBe('old-build');
    expect(restarts()).toBe(2);       // once for the new version, once back on the old one
    expect(existsSync(join(app, '.deployed-commit'))).toBe(false);
  });

  test('a process that keeps restarting by itself is a failure even though the site answers', () => {
    run(['prepare']); flag('CRASHLOOP');
    const r = run(['activate', 'loop']);
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/not staying up|restarted by itself/);
    expect(out(r)).toContain('ROLLED BACK');
  });

  test('a process that is not online is a failure', () => {
    run(['prepare']); flag('STOPPED-disc');
    const r = run(['activate', 'stopped']);
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/not online|not staying up/);
  });

  test('a failed npm ci rolls back before anything is built', () => {
    run(['prepare']);
    put(join(app, 'package-lock.json'), 'lock-v3'); flag('FAIL_CI');
    const r = run(['activate', 'ci']);
    expect(r.status).not.toBe(0);
    expect(read(join(state, 'calls'))).not.toContain('run build');
    expect(restarts()).toBe(1);   // only the rollback restart
  });
});

describe('rollback and safety', () => {
  test('rollback puts the newest backup back', () => {
    run(['prepare']);
    put(join(app, 'src.txt'), 'NEW'); put(join(app, '.next', 'BUILD_ID'), 'new-build');
    const r = run(['rollback']);
    expect(r.status).toBe(0);
    expect(read(join(app, 'src.txt'))).toBe('OLD');
    expect(read(join(app, '.next', 'BUILD_ID'))).toBe('old-build');
  });

  test('rollback with no backup says so', () => {
    const r = run(['rollback']);
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/no backup/);
  });

  test('prepare refuses a server without .env, so the access lock cannot silently vanish', () => {
    rmSync(join(app, '.env'));
    const r = run(['prepare']);
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/\.env is missing/);
    expect(existsSync(backups)).toBe(false);
  });

  test('prepare refuses a folder that is not the app, and a full disk', () => {
    rmSync(join(app, 'package.json'));
    expect(out(run(['prepare']))).toMatch(/no package\.json/);
    put(join(app, 'package.json'), '{}');
    const r = run(['prepare'], { MIN_FREE_MB: '999999999' });
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/MB free/);
  });

  test('prepare refuses a server without rsync, before anything is backed up or copied', () => {
    const r = run(['prepare'], { RSYNC_BIN: 'no-such-rsync' });
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/rsync is not installed/);
    expect(existsSync(backups)).toBe(false);
  });

  test('activate without a backup is refused', () => {
    const r = run(['activate', 'x']);
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/run 'prepare' first/);
  });

  test('two deploys at once: the second is refused', () => {
    mkdirSync(join(backups, '.deploy.lock'), { recursive: true });
    const r = run(['prepare']);
    expect(r.status).not.toBe(0);
    expect(out(r)).toMatch(/another deploy is running/);
  });

  test('the lock is released afterwards, also after a failure', () => {
    run(['prepare']); flag('FAIL_BUILD'); run(['activate', 'f']);
    expect(existsSync(join(backups, '.deploy.lock'))).toBe(false);
  });

  test('only the newest backups are kept (3 sources, 2 builds)', () => {
    for (let i = 0; i < 5; i++) { run(['prepare']); spawnSync('sleep', ['1.1']); }
    const files = readdirSync(backups);
    expect(files.filter((f) => f.endsWith('.tgz'))).toHaveLength(3);
    expect(files.filter((f) => f.endsWith('.next'))).toHaveLength(2);
  });

  test('an unknown command is refused', () => {
    expect(run(['wat']).status).not.toBe(0);
  });
});
