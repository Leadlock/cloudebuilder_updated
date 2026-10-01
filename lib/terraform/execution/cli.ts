/**
 * Thin wrapper around spawning the real `terraform` binary.
 *
 * Operational prerequisite: the `terraform` CLI must be installed and on
 * PATH wherever this runs (the Next.js server process for `plan`, and the
 * worker process for `apply` — see workers/terraformApplyWorker.ts). This
 * is a real external dependency CloudCraft does not bundle or install
 * itself, the same way the AWS Pricing API integration requires a
 * separately-provisioned IAM credential — see .env.example.
 */
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execFileAsync = promisify(execFile);

import fs from 'fs';
import path from 'path';

function getTerraformBinary(): string {
  if (process.env.TERRAFORM_BINARY_PATH && fs.existsSync(process.env.TERRAFORM_BINARY_PATH)) {
    return process.env.TERRAFORM_BINARY_PATH;
  }
  const userHome = process.env.USERPROFILE || process.env.HOME || '';
  if (userHome) {
    const candidate = path.join(userHome, 'bin', process.platform === 'win32' ? 'terraform.exe' : 'terraform');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'terraform';
}

export class TerraformNotInstalledError extends Error {
  constructor() {
    super('The `terraform` CLI is not installed or not on PATH. Install it from https://developer.hashicorp.com/terraform/install and ensure it is reachable from this process.');
    this.name = 'TerraformNotInstalledError';
  }
}

export interface TerraformRunResult {
  stdout: string;
  stderr: string;
}

export interface TerraformRunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  allowExitCodes?: number[];
  /** Called with each chunk of output as Terraform prints it (for live progress). The full output is still returned. */
  onOutput?: (chunk: string) => void;
  /** `init` shares downloaded providers between runs (default true). Turn off to force a fresh download. */
  pluginCache?: boolean;
}

/** Where downloaded providers are shared between runs, so each `init` does not fetch the (large) cloud provider again. */
export function pluginCacheDir(): string {
  return process.env['CLOUDCRAFT_TF_PLUGIN_CACHE_DIR'] || path.join(os.tmpdir(), 'cloudcraft-tf-plugin-cache');
}

// Terraform's plugin cache is not safe for two `init`s at once in one cache, so inits in this process take turns.
let initQueue: Promise<unknown> = Promise.resolve();

const MAX_BUFFER = 16 * 1024 * 1024;

/** Environment for one run: a minimal base, the caller's values, and (for init) the shared provider cache. */
function buildEnv(args: string[], env: Record<string, string>, pluginCache: boolean): Record<string, string> {
  const binDir = path.dirname(getTerraformBinary());
  const currentPath = process.env['PATH'] ?? '';
  const fullPath = binDir !== '.' ? `${binDir}${path.delimiter}${currentPath}` : currentPath;
  const cache: Record<string, string> = {};
  if (pluginCache && args[0] === 'init') {
    const dir = pluginCacheDir();
    try { fs.mkdirSync(dir, { recursive: true }); cache['TF_PLUGIN_CACHE_DIR'] = dir; cache['TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE'] = 'true'; } catch { /* no cache: init just downloads */ }
  }
  return { NODE_ENV: process.env['NODE_ENV'] ?? 'production', PATH: fullPath, TF_IN_AUTOMATION: '1', ...cache, ...env };
}

function failure(args: string[], timeoutMs: number, e: { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; message?: string }): Error {
  const detail = (e.stderr || e.stdout || e.message || '').slice(0, 4000);
  return new Error(e.killed
    ? `terraform ${args[0]} timed out after ${Math.round(timeoutMs / 60000)} minutes.`
    : `terraform ${args[0]} failed (exit ${e.code ?? 'unknown'}): ${detail}`);
}

/** Streaming variant: same result and errors as the buffered one, plus a callback for every chunk of output. */
function runStreaming(args: string[], options: TerraformRunOptions & { timeoutMs: number; allowExitCodes: number[] }, env: Record<string, string>): Promise<TerraformRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(getTerraformBinary(), args, { cwd: options.cwd, env: env as NodeJS.ProcessEnv, windowsHide: true });
    let stdout = ''; let stderr = ''; let killed = false; let settled = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, options.timeoutMs);
    const push = (target: 'out' | 'err') => (b: Buffer) => {
      const text = b.toString('utf8');
      if (target === 'out') stdout = (stdout + text).slice(-MAX_BUFFER); else stderr = (stderr + text).slice(-MAX_BUFFER);
      try { options.onOutput?.(text); } catch { /* a faulty listener must never break the run */ }
    };
    child.stdout.on('data', push('out'));
    child.stderr.on('data', push('err'));
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    child.on('error', (err: NodeJS.ErrnoException) => done(() => reject(err.code === 'ENOENT' ? new TerraformNotInstalledError() : failure(args, options.timeoutMs, { message: err.message, code: err.code }))));
    child.on('close', (code) => done(() => {
      if (!killed && code !== null && options.allowExitCodes.includes(code)) return resolve({ stdout, stderr });
      reject(failure(args, options.timeoutMs, { code: code ?? 'unknown', killed, stdout, stderr }));
    }));
  });
}

/**
 * Runs `terraform <args>` in `cwd` with `env` merged over a minimal base
 * environment (PATH only — deliberately not process.env, so nothing beyond
 * what's explicitly passed ever reaches the child process). Throws
 * TerraformNotInstalledError on ENOENT, or a plain Error with stdout+stderr
 * attached on any non-zero exit (except where the caller explicitly expects
 * one, e.g. `plan -detailed-exitcode`).
 */
export async function runTerraform(args: string[], options: TerraformRunOptions): Promise<TerraformRunResult> {
  const { cwd, env, timeoutMs = 300_000, allowExitCodes = [0], pluginCache = true } = options;

  const run = async (): Promise<TerraformRunResult> => {
    const fullEnv = buildEnv(args, env, pluginCache);
    if (options.onOutput) return runStreaming(args, { ...options, timeoutMs, allowExitCodes }, fullEnv);
    try {
      const { stdout, stderr } = await execFileAsync(getTerraformBinary(), args, { cwd, env: fullEnv as NodeJS.ProcessEnv, timeout: timeoutMs, maxBuffer: MAX_BUFFER });
      return { stdout, stderr };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
      if (e.code === 'ENOENT') throw new TerraformNotInstalledError();
      if (typeof e.code === 'number' && allowExitCodes.includes(e.code)) {
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      }
      throw failure(args, timeoutMs, e);
    }
  };

  if (args[0] === 'init' && pluginCache) {
    const turn = initQueue.then(run, run);
    initQueue = turn.catch(() => undefined);
    return turn;
  }
  return run();
}
