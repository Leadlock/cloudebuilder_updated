/**
 * Builds and starts a combined project (Frontend + Backend + API + Database) from the files Container Templates generates, and checks for real that
 * the parts are connected the way the README says. It does this twice:
 *  A. the local compose file (`docker compose up --build`), exactly as downloaded;
 *  B. the compose file an EC2 server runs (ec2/compose.deploy.yml): the images are built, tagged as the server's registry names them (registry and tag
 *     filled in the way the server's start-up script does through its .env file), and started from those tags with nothing built by compose.
 * For each: every service becomes healthy; the Frontend's nginx forwards /api/ to the API; the API reaches the Backend through BACKEND_URL; the Backend and
 * the API reach the Database by name with the shared password and the database refuses a wrong one; only the public service is on all interfaces.
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
let nextPort = 21000 + Math.floor(Math.random() * 20000);

type Case = 'local' | 'ec2';

async function verify(which: Case): Promise<void> {
  const tag = which === 'local' ? 'A (local compose file)' : 'B (the compose file an EC2 server runs)';
  console.log(`\n== ${tag}`);
  const project = defaultProject();
  project.name = which === 'local' ? 'vsp' : 'vspd';
  for (const l of LAYERS) { project.layers[l].enabled = true; project.layers[l].config = { ...project.layers[l].config, includeSample: true }; }
  project.deploy.target = which === 'ec2' ? 'ec2' : 'none';
  const res = generateProjectFiles(project);
  if (!res.ok) { fail(`${tag}: generate`, res.errors.join('; ')); return; }

  const dir = mkdtempSync(join(tmpdir(), `verify-stack-${which}-`));
  const layout = projectLayout(project);
  const composePath = which === 'local' ? 'docker-compose.yml' : 'ec2/compose.deploy.yml';
  // Only the host side of the ports is moved, so ports already in use on this machine do not get in the way.
  const hostOf: Record<string, number> = {};
  let compose = res.files.find((f) => f.path === composePath)!.content;
  for (const l of LAYERS) {
    const inner = project.layers[l].config.port;
    const from = layout.hostPort[l]!;
    hostOf[l] = nextPort++;
    compose = compose.replace(new RegExp(`"((?:127\\.0\\.0\\.1:)?)${from}:${inner}"`), `"$1${hostOf[l]}:${inner}"`);
  }
  for (const f of res.files) {
    const p = join(dir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.path === composePath ? compose : f.content);
  }
  const password = randomBytes(12).toString('hex');
  const registry = 'vsp-local-registry';
  // The server writes REGISTRY, the tag and the secrets into .env next to the compose file. Here the same, and the images are tagged the way the
  // repositories name them ("<registry>/<project>-<service>:<tag>") instead of being pushed.
  // The server keeps compose.yml and .env side by side in /opt/<project> and runs compose from there: the same layout here, in its own folder.
  const runDir = which === 'local' ? dir : join(dir, 'server');
  if (which === 'ec2') { mkdirSync(runDir, { recursive: true }); writeFileSync(join(runDir, 'compose.yml'), compose); }
  writeFileSync(join(runDir, '.env'), which === 'local' ? `POSTGRES_PASSWORD=${password}\n` : `REGISTRY=${registry}\nTAG=latest\nPOSTGRES_PASSWORD='${password}'\n`);
  const projectName = project.name;
  const dc = (...args: string[]) => run('docker', ['compose', '-p', projectName, '-f', which === 'local' ? composePath : 'compose.yml', ...args], runDir);
  const exec = (service: string, line: string) => dc('exec', '-T', service, 'sh', '-c', line);

  if (which === 'ec2') {
    for (const l of ['frontend', 'backend', 'api']) {
      const b = run('docker', ['build', '-q', '-t', `${registry}/${projectName}-${l}:latest`, `./${l}`], dir);
      if (b.status !== 0) { fail(`${tag}: build ${l}`, out(b)); return; }
    }
    ok('the three images are built and tagged as the registry would name them');
  }
  const up = which === 'local' ? dc('up', '-d', '--build', '--wait', '--wait-timeout', '600') : dc('up', '-d', '--wait', '--wait-timeout', '600');
  if (up.status !== 0) { fail(`${tag}: compose up --wait: every service becomes healthy`, `${out(up)}\n${out(dc('ps', '-a'))}\n${out(dc('logs', '--tail', '30'))}`); dc('down', '-v'); return; }
  ok(which === 'local' ? 'compose builds every image and every service is healthy' : 'compose starts every service from the tagged images and every service is healthy');
  try {
    if (which === 'ec2') {
      const cfg = run('docker', ['inspect', '--format', '{{.Config.Image}}', `${projectName}-frontend-1`]);
      if (cfg.stdout.trim() !== `${registry}/${projectName}-frontend:latest`) fail(`${tag}: the frontend runs the registry-named image`, cfg.stdout);
      else ok('the frontend runs the image named <registry>/<project>-frontend:<tag>');
    }
    const ps = JSON.parse(`[${dc('ps', '--format', 'json').stdout.trim().split('\n').join(',')}]`) as Array<{ Service: string; Publishers?: Array<{ URL: string; PublishedPort: number }> }>;
    const services = ps.map((s) => s.Service).sort();
    if (services.join() !== 'api,backend,database,frontend') fail(`${tag}: the four services run`, services.join()); else ok('the four services run: api, backend, database, frontend');
    for (const s of ps) {
      const pub = (s.Publishers ?? []).filter((p) => p.PublishedPort > 0);
      const wide = pub.some((p) => p.URL === '0.0.0.0' || p.URL === '::');
      if ((s.Service === 'frontend') !== wide) fail(`${tag}: ${s.Service} published on ${pub.map((p) => p.URL).join(',') || 'nothing'}`, 'only the frontend may be open on all interfaces');
    }
    ok('only the frontend is open on all interfaces');

    const page = run('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${hostOf.frontend}/`]);
    if (page.stdout.trim() !== '200') fail(`${tag}: frontend answers`, out(page)); else ok('the frontend answers on its port');
    const viaProxy = run('curl', ['-sS', '-w', '\\n%{http_code}', `http://127.0.0.1:${hostOf.frontend}/api/health`]);
    const direct = run('curl', ['-sS', '-w', '\\n%{http_code}', `http://127.0.0.1:${hostOf.api}/health`]);
    if (!viaProxy.stdout.trim().endsWith('200') || viaProxy.stdout !== direct.stdout) fail(`${tag}: frontend /api/ reaches the API`, `${viaProxy.stdout}\n--- direct:\n${direct.stdout}`);
    else ok('the frontend forwards /api/ to the API (same answer as the API itself)');

    const b = exec('api', 'python -c "import os,urllib.request;print(urllib.request.urlopen(os.environ[\'BACKEND_URL\']+\'/health\').status)"');
    if (b.stdout.trim() !== '200') fail(`${tag}: the API reaches the Backend through BACKEND_URL`, out(b)); else ok('the API reaches the Backend through BACKEND_URL');

    for (const svc of ['backend', 'api']) {
      const env = exec(svc, 'printenv DATABASE_URL');
      if (!env.stdout.includes(`app:${password}@database:5432/app`)) fail(`${tag}: ${svc}: DATABASE_URL has the shared password and the database's name`, 'DATABASE_URL does not point at database:5432 with the password');
      else ok(`${svc}: DATABASE_URL points at the database with the shared password`);
    }
    const right = exec('database', `PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$(hostname -i)" -U app -d app -tAc "select 1"`);
    const wrong = exec('database', `PGPASSWORD=wrong psql -h "$(hostname -i)" -U app -d app -tAc "select 1"`);
    if (right.stdout.trim() !== '1') fail(`${tag}: the database accepts the shared password`, out(right));
    else if (wrong.status === 0) fail(`${tag}: the database refuses a wrong password`, out(wrong));
    else ok('the database accepts the shared password and refuses a wrong one');
    const reach = exec('backend', `node -e "require('net').connect(5432,'database').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"`);
    if (reach.status !== 0) fail(`${tag}: the backend can open a connection to database:5432`, out(reach)); else ok('the backend opens a connection to database:5432');

    // The data must survive the services being stopped and started again (the server's restart): the volume is on the machine's disk.
    const w = exec('database', `PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U app -d app -tAc "create table if not exists kept(v text); insert into kept values ('yes')"`);
    if (w.status !== 0) fail(`${tag}: write to the database`, out(w));
    else {
      dc('down');
      const up2 = dc('up', '-d', '--wait', '--wait-timeout', '600');
      const r = up2.status === 0 ? exec('database', `PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U app -d app -tAc "select v from kept"`) : up2;
      if (up2.status !== 0 || r.stdout.trim() !== 'yes') fail(`${tag}: data survives stop and start`, out(r)); else ok('the database keeps its data when the services are stopped and started again');
    }
  } finally {
    dc('down', '-v', '--rmi', 'local');
    if (which === 'ec2') for (const l of ['frontend', 'backend', 'api']) run('docker', ['rmi', '-f', `${registry}/${projectName}-${l}:latest`]);
  }
}

(async () => {
  await verify('local');
  await verify('ec2');
  console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
