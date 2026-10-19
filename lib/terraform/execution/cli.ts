/**
 * Thin wrapper around spawning the real `terraform` binary.
 *
 * Nothing to install: when no Terraform is found, runTerraform downloads the pinned release, checks it against the checksum built into
 * binary.ts and keeps it for next time (the Next.js server for `plan`, and the worker for `apply`, share the same copy).
 */
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { ensureTerraform, locateTerraform, TerraformDownloadError } from './binary';

const execFileAsync = promisify(execFile);

import fs from 'fs';
import path from 'path';

/** The Terraform to run right now (see binary.ts); the name `terraform` when none exists yet, in which case runTerraform downloads one first. */
function getTerraformBinary(): string {
  return locateTerraform()?.path ?? 'terraform';
}

export class TerraformNotInstalledError extends Error {
  constructor(reason?: string) {
    super(`The \`terraform\` CLI is not installed or not on PATH${reason ? ` and could not be downloaded: ${reason}` : ''}. Install it from https://developer.hashicorp.com/terraform/install and ensure it is reachable from this process.`);
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
  return process.env['CLOUDBUILDER_TF_PLUGIN_CACHE_DIR'] || path.join(os.tmpdir(), 'cloudbuilder-tf-plugin-cache');
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
  // eslint-disable-next-line no-control-regex
  const detail = (e.stderr || e.stdout || e.message || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').slice(0, 4000);   // no colour codes in what the user reads
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
    // Nothing installed: fetch the pinned release (once; later runs find it). The person is told what is happening while they wait.
    if (!locateTerraform()) {
      try { await ensureTerraform({ log: (line) => { try { options.onOutput?.(`${line}\n`); } catch { /* listener errors never break a run */ } } }); }
      catch (e) { throw new TerraformNotInstalledError(e instanceof TerraformDownloadError ? e.message : e instanceof Error ? e.message : String(e)); }
    }
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
