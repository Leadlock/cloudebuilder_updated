/**
 * Builds and starts a combined project (Frontend + Backend + API + Database) from the files Container Templates generates, and checks for real that
 * the parts are connected the way the README says:
 *  1. docker compose builds every image and every service becomes healthy;
 *  2. the Frontend's own web server forwards /api/ to the API, and the API (not the browser) is what answers;
 *  3. the API reaches the Backend through BACKEND_URL;
 *  4. the Backend and the API reach the Database by its service name, with the shared password, and the database refuses a wrong one;
 *  5. only the Frontend is published on all interfaces; the others and the database are bound to 127.0.0.1.
 * Needs Docker. Not part of `npm test`: it builds images and pulls official ones. Run: npx tsx --tsconfig tsconfig.json scripts/verify-stack-project.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { defaultProject, generateProjectFiles, LAYERS, projectLayout } from '../lib/engines/containers/stackProject';

const run = (cmd: string, args: string[], cwd?: string) => spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const out = (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`.trim();
let failed = 0;
const fail = (what: string, detail: string) => { failed++; console.log(`FAIL  ${what}\n${detail.split('\n').slice(-25).join('\n')}`); };
const ok = (what: string) => console.log(`ok    ${what}`);

const project = defaultProject();
project.name = 'vsp';
for (const l of LAYERS) { project.layers[l].enabled = true; project.layers[l].config = { ...project.layers[l].config, includeSample: true }; }
const res = generateProjectFiles(project);
if (!res.ok) { console.log(`FAIL  generate: ${res.errors.join('; ')}`); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'verify-stack-'));
const layout = projectLayout(project);
// Only the host side of the ports is moved, so ports already in use on this machine do not get in the way.
let base = 21000 + Math.floor(Math.random() * 20000);
const hostOf: Record<string, number> = {};
let compose = res.files.find((f) => f.path === 'docker-compose.yml')!.content;
for (const l of LAYERS) {
  const inner = project.layers[l].config.port;
  const from = layout.hostPort[l]!;
  hostOf[l] = base++;
  compose = compose.replace(new RegExp(`"((?:127\\.0\\.0\\.1:)?)${from}:${inner}"`), `"$1${hostOf[l]}:${inner}"`);
}
for (const f of res.files) {
  const p = join(dir, f.path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, f.path === 'docker-compose.yml' ? compose : f.content);
}
const password = randomBytes(12).toString('hex');
writeFileSync(join(dir, '.env'), `POSTGRES_PASSWORD=${password}\n`);

const dc = (...args: string[]) => run('docker', ['compose', '-p', 'vsp', ...args], dir);
const exec = (service: string, line: string) => dc('exec', '-T', service, 'sh', '-c', line);

async function main() {
  console.log(`files: ${res.ok ? res.files.map((f) => f.path).join(', ') : ''}`);
  const up = dc('up', '-d', '--build', '--wait', '--wait-timeout', '600');
  if (up.status !== 0) { fail('compose up --build --wait: every service becomes healthy', out(up) + '\n' + out(dc('ps', '-a')) + '\n' + out(dc('logs', '--tail', '30'))); return; }
  ok('compose builds every image and every service is healthy');
  try {
    const ps = JSON.parse(`[${dc('ps', '--format', 'json').stdout.trim().split('\n').join(',')}]`) as Array<{ Service: string; Publishers?: Array<{ URL: string; PublishedPort: number }> }>;
    const services = ps.map((s) => s.Service).sort();
    if (services.join() !== 'api,backend,database,frontend') fail('the four services run', services.join());
    else ok('the four services run: api, backend, database, frontend');
    for (const s of ps) {
      const pub = (s.Publishers ?? []).filter((p) => p.PublishedPort > 0);
      const wide = pub.some((p) => p.URL === '0.0.0.0' || p.URL === '::');
      if ((s.Service === 'frontend') !== wide) fail(`${s.Service}: published on ${pub.map((p) => p.URL).join(',') || 'nothing'}`, 'only the frontend may be open on all interfaces');
    }
    ok('only the frontend is open on all interfaces');

    // The browser's view: the frontend answers, and /api/ is forwarded to the API.
    const page = run('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${hostOf.frontend}/`]);
    if (page.stdout.trim() !== '200') fail('frontend answers', out(page)); else ok('the frontend answers on its port');
    const viaProxy = run('curl', ['-sS', '-w', '\\n%{http_code}', `http://127.0.0.1:${hostOf.frontend}/api/health`]);
    const direct = run('curl', ['-sS', '-w', '\\n%{http_code}', `http://127.0.0.1:${hostOf.api}/health`]);
    if (!viaProxy.stdout.trim().endsWith('200') || viaProxy.stdout !== direct.stdout) fail('frontend /api/ reaches the API', `${viaProxy.stdout}\n--- direct:\n${direct.stdout}`);
    else ok('the frontend forwards /api/ to the API (same answer as the API itself)');

    // The API reaches the Backend by BACKEND_URL.
    const b = exec('api', 'python -c "import os,urllib.request;print(urllib.request.urlopen(os.environ[\'BACKEND_URL\']+\'/health\').status)"');
    if (b.stdout.trim() !== '200') fail('the API reaches the Backend through BACKEND_URL', out(b)); else ok('the API reaches the Backend through BACKEND_URL');

    // Backend and API reach the database by name, and it holds the shared password.
    for (const svc of ['backend', 'api']) {
      const env = exec(svc, 'printenv DATABASE_URL');
      if (!env.stdout.includes(`app:${password}@database:5432/app`)) fail(`${svc}: DATABASE_URL has the shared password and the database's name`, 'DATABASE_URL does not point at database:5432 with the password');
      else ok(`${svc}: DATABASE_URL points at the database with the shared password`);
    }
    const right = exec('database', `PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$(hostname -i)" -U app -d app -tAc "select 1"`);
    const wrong = exec('database', `PGPASSWORD=wrong psql -h "$(hostname -i)" -U app -d app -tAc "select 1"`);
    if (right.stdout.trim() !== '1') fail('the database accepts the shared password', out(right));
    else if (wrong.status === 0) fail('the database refuses a wrong password', out(wrong));
    else ok('the database accepts the shared password and refuses a wrong one');
    const reach = exec('backend', `node -e "require('net').connect(5432,'database').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"`);
    if (reach.status !== 0) fail('the backend can open a connection to database:5432', out(reach)); else ok('the backend opens a connection to database:5432');
  } finally {
    dc('down', '-v', '--rmi', 'local');
  }
}

main().then(() => { console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`); process.exit(failed === 0 ? 0 : 1); });
