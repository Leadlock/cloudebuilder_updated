/**
 * Builds the generated sample app of every stack with Docker, runs it and calls its health check path; then starts one stack with every
 * companion service and the HTTPS proxy through docker compose and calls it over HTTPS. Needs Docker. Not part of `npm test`: it pulls base
 * images and takes several minutes. Run: npx tsx --tsconfig tsconfig.json scripts/build-samples.ts [dir] [stack ...]
 */
import fs, { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { defaultConfig, generateContainerFiles, STACKS, type ContainerConfig, type ContainerStack } from '../lib/engines/containers/dockerTemplates';

const root = process.argv[2] ?? '/tmp/build-samples';
const only = process.argv.slice(3) as ContainerStack[];
const sh = (cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, DOCKER_BUILDKIT: '1', ...env } });
const tail = (r: { stdout: string; stderr: string }, n = 40) => `${r.stdout}\n${r.stderr}`.split('\n').slice(-n).join('\n');

function write(c: ContainerConfig, dir: string): void {
  const res = generateContainerFiles(c);
  if (!res.ok) throw new Error(res.errors.join('; '));
  for (const f of res.files) { const p = join(dir, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }
}

async function waitFor(url: string, seconds: number, extra: string[] = []): Promise<boolean> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (spawnSync('curl', ['-fsS', '-m', '5', '-o', '/dev/null', ...extra, url]).status === 0) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

let failed = 0;
rmSync(root, { recursive: true, force: true });

async function sample(stack: ContainerStack): Promise<void> {
  const c: ContainerConfig = { ...defaultConfig(stack), appName: `cc-${stack}`, includeSample: true, healthPath: stack === 'dotnet' ? '/health' : '/' };
  if (stack === 'java') c.healthPath = '/actuator/health';
  const dir = join(root, stack);
  mkdirSync(dir, { recursive: true });
  write(c, dir);
  const image = `cc-sample-${stack}`;
  const build = sh('docker', ['build', '-t', image, '.'], dir);
  if (build.status !== 0) { failed++; console.log(`${stack}: BUILD FAILED\n${tail(build)}`); return; }
  const hostPort = 18000 + STACKS.indexOf(stack);
  const run = sh('docker', ['run', '-d', '--rm', '--name', image, '-p', `${hostPort}:${c.port}`, image], dir);
  if (run.status !== 0) { failed++; console.log(`${stack}: RUN FAILED\n${tail(run)}`); return; }
  try {
    const up = await waitFor(`http://127.0.0.1:${hostPort}${c.healthPath}`, 120);
    if (!up) { failed++; console.log(`${stack}: did not answer on ${c.healthPath}\n${tail(sh('docker', ['logs', image], dir))}`); return; }
    const user = sh('docker', ['exec', image, 'id', '-u'], dir).stdout.trim();
    if (user === '0') { failed++; console.log(`${stack}: runs as root`); return; }
    console.log(`${stack}: built, answers on ${c.healthPath}, runs as uid ${user}`);
  } finally { sh('docker', ['rm', '-f', image], dir); }
}

async function everything(): Promise<void> {
  const c: ContainerConfig = {
    ...defaultConfig('node'), appName: 'cc-all', includeSample: true, postgres: true, redis: true, mysql: true, mongodb: true, rabbitmq: true, proxy: true, proxyDomain: 'localhost',
  };
  const dir = join(root, 'all-services');
  mkdirSync(dir, { recursive: true });
  write(c, dir);
  const env = { POSTGRES_PASSWORD: 'pgpass1', MYSQL_PASSWORD: 'mysqlpass1', MONGODB_PASSWORD: 'mongopass1', RABBITMQ_PASSWORD: 'rabbitpass1' };
  const up = sh('docker', ['compose', 'up', '-d', '--build', '--wait', '--wait-timeout', '300'], dir, env);
  try {
    if (up.status !== 0) { failed++; console.log(`all-services: compose up FAILED\n${tail(up)}\n${tail(sh('docker', ['compose', 'ps', '-a'], dir, env))}`); return; }
    const ok = await waitFor('https://localhost/', 60, ['-k']);
    if (!ok) { failed++; console.log(`all-services: https://localhost/ did not answer\n${tail(sh('docker', ['compose', 'logs', '--tail', '40'], dir, env))}`); return; }
    const hostPorts = sh('docker', ['compose', 'ps', '--format', '{{.Service}} {{.Ports}}'], dir, env).stdout.split('\n').filter((l) => /->/.test(l) && !l.startsWith('proxy'));
    if (hostPorts.length > 0) { failed++; console.log(`all-services: published to the host: ${hostPorts.join('; ')}`); return; }
    console.log('all-services: five companions healthy, HTTPS through the proxy answers, only the proxy is published');
  } finally { sh('docker', ['compose', 'down', '-v', '--remove-orphans'], dir, env); }
}

/** A ready-made image: no Dockerfile is written, compose pulls the image and it answers. */
async function existingImage(): Promise<void> {
  const c: ContainerConfig = { ...defaultConfig('static'), appName: 'cc-existing', image: 'nginx:1.27', port: 80, healthPath: '/' };
  const dir = join(root, 'existing-image');
  mkdirSync(dir, { recursive: true });
  write(c, dir);
  if (fs.existsSync(join(dir, 'Dockerfile'))) { failed++; console.log('existing-image: a Dockerfile was written'); return; }
  // Published on another port so it cannot clash with the proxy test.
  const compose = fs.readFileSync(join(dir, 'docker-compose.yml'), 'utf8').replace('"80:80"', '"18080:80"');
  writeFileSync(join(dir, 'docker-compose.yml'), compose);
  const up = sh('docker', ['compose', 'up', '-d'], dir);
  try {
    if (up.status !== 0) { failed++; console.log(`existing-image: compose up FAILED\n${tail(up)}`); return; }
    if (!(await waitFor('http://127.0.0.1:18080/', 60))) { failed++; console.log(`existing-image: did not answer\n${tail(sh('docker', ['compose', 'logs', '--tail', '30'], dir))}`); return; }
    console.log('existing-image: nginx:1.27 pulled and answering, with no Dockerfile written');
  } finally { sh('docker', ['compose', 'down', '-v', '--remove-orphans'], dir); }
}

(async () => {
  for (const s of (only.length ? only : STACKS)) await sample(s);
  if (only.length === 0) await existingImage();
  if (only.length === 0) await everything();
  process.exit(failed ? 1 : 0);
})();
