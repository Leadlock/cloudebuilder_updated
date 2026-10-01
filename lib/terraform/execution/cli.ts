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
import { execFile } from 'child_process';
import { promisify } from 'util';

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

/**
 * Runs `terraform <args>` in `cwd` with `env` merged over a minimal base
 * environment (PATH only — deliberately not process.env, so nothing beyond
 * what's explicitly passed ever reaches the child process). Throws
 * TerraformNotInstalledError on ENOENT, or a plain Error with stdout+stderr
 * attached on any non-zero exit (except where the caller explicitly expects
 * one, e.g. `plan -detailed-exitcode`).
 */
export async function runTerraform(
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs?: number; allowExitCodes?: number[] },
): Promise<TerraformRunResult> {
  const { cwd, env, timeoutMs = 300_000, allowExitCodes = [0] } = options;
  const binary = getTerraformBinary();
  const binDir = path.dirname(binary);
  const currentPath = process.env['PATH'] ?? '';
  const fullPath = binDir !== '.' ? `${binDir}${path.delimiter}${currentPath}` : currentPath;

  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      cwd,
      env: { NODE_ENV: process.env['NODE_ENV'] ?? 'production', PATH: fullPath, ...env },
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    if (e.code === 'ENOENT') throw new TerraformNotInstalledError();
    if (typeof e.code === 'number' && allowExitCodes.includes(e.code)) {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
    const message = `terraform ${args[0]} failed (exit ${e.code ?? 'unknown'}): ${(e.stderr || e.message || '').slice(0, 4000)}`;
    throw new Error(message);
  }
}
