/**
 * `npm run dev` — starts the web server AND the background workers together, so a deployment queued from the web app is never left
 * waiting for a worker nobody started. Output of each process is labelled ([web], [worker:terraform-apply], ...). Ctrl+C stops all of them.
 *
 *   CLOUDCRAFT_DEV_WORKERS=off   web server only (same as `npm run dev:web`)
 *
 * A worker that crashes is restarted a few times; one that keeps crashing is left stopped with a message, and the web server keeps running.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { LinePrefixer, RestartPolicy, selectDevProcesses, tsxArgs, type DevProcessSpec } from '../lib/dev/devProcesses';

// npm runs scripts with the app folder as the working directory.
const appDir = process.cwd();
const require_ = createRequire(path.join(appDir, 'package.json'));
const hasEnvFile = fs.existsSync(path.join(appDir, '.env'));

let shuttingDown = false;
const children = new Map<string, ChildProcess>();

function resolveBin(pkg: string, relative: string): string {
  return path.join(path.dirname(require_.resolve(`${pkg}/package.json`)), relative);
}

function commandFor(spec: DevProcessSpec): { cmd: string; args: string[] } {
  if (spec.script === null) return { cmd: process.execPath, args: [resolveBin('next', 'dist/bin/next'), 'dev'] };
  return { cmd: process.execPath, args: [resolveBin('tsx', 'dist/cli.mjs'), ...tsxArgs(spec.script, hasEnvFile)] };
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children.values()) killTree(c);
  setTimeout(() => process.exit(code), 500).unref();
}

function start(spec: DevProcessSpec, policy: RestartPolicy): void {
  const { cmd, args } = commandFor(spec);
  const child = spawn(cmd, args, { cwd: appDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.set(spec.name, child);
  const out = new LinePrefixer(spec.name);
  const err = new LinePrefixer(spec.name);
  child.stdout?.on('data', (b: Buffer) => out.push(b.toString('utf8')).forEach((l) => console.log(l)));
  child.stderr?.on('data', (b: Buffer) => err.push(b.toString('utf8')).forEach((l) => console.error(l)));

  child.on('error', (e) => console.error(`[${spec.name}] could not start: ${e.message}`));
  child.on('close', (code) => {
    out.end().forEach((l) => console.log(l));
    err.end().forEach((l) => console.error(l));
    children.delete(spec.name);
    if (shuttingDown) return;
    if (spec.essential) {
      console.error(`[${spec.name}] stopped (exit ${code ?? 'unknown'}); stopping everything.`);
      shutdown(code ?? 1);
      return;
    }
    const d = policy.onExit(code);
    if (d.giveUp) { console.error(`[${spec.name}] ${d.giveUp}`); return; }
    if (d.restart) {
      console.error(`[${spec.name}] stopped (exit ${code ?? 'unknown'}); restarting in ${Math.round(d.delayMs / 1000)}s…`);
      setTimeout(() => { if (!shuttingDown) start(spec, policy); }, d.delayMs);
    }
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => { for (const c of children.values()) killTree(c); });

const specs = selectDevProcesses();
if (!hasEnvFile && specs.some((s) => !s.essential)) {
  console.warn('[dev] No .env file found: the workers need DATABASE_URL and the encryption key, so they may stop with an error. The web server is unaffected.');
}
console.log(`[dev] Starting: ${specs.map((s) => s.name).join(', ')}  (Ctrl+C stops all)`);
for (const spec of specs) start(spec, new RestartPolicy());
