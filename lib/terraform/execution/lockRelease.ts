/**
 * "Check lock" / "Release lock" for a Terraform state lock left behind by an interrupted run.
 *
 * A lock is released here ONLY when every one of these is true — otherwise the user is told why not:
 *   - the lock was taken by THIS machine (its "Who" names this host), not a teammate's laptop or a pipeline;
 *   - no Terraform process is running on this machine, and no apply/teardown is running on this server for the project;
 *   - the lock is at least two minutes old (a run that is only just starting is not "stale");
 *   - the lock id being released is the one currently held (re-checked at release time, never trusted from the browser).
 *
 * Breaking a lock that a live run still holds lets two writers loose on the same state, which can corrupt it.
 */
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import os from 'os';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { resolveExecutionCredentials } from '@/lib/cloud/credentials/resolveExecutionCredentials';
import type { CloudCredentials } from '@/lib/cloud/types';
import { runTerraform, type TerraformRunOptions, type TerraformRunResult } from './cli';
import { renderBackendConfig } from './backendConfig';
import { initWithRetry } from './runSupport';
import { isLockFromThisMachine } from './stateLock';
import { isStateLockError, parseLockInfo, type LockInfo } from './stateLockParse';
import { isProjectLocked } from './projectLock';
import type { TerraformStateBackendConfig } from './types';

export const MANUAL_RELEASE_MIN_AGE_MS = 2 * 60 * 1000;

export interface LockCheckContext { now: number; host: string; processRunning: boolean | null; projectBusy: boolean }
export type ReleaseDecision = { allowed: true } | { allowed: false; reason: string };

export function decideManualRelease(info: LockInfo, ctx: LockCheckContext): ReleaseDecision {
  if (!isLockFromThisMachine(info, ctx.host)) return { allowed: false, reason: `The lock was taken by ${info.who ?? 'another machine'}, not by this server. Ask whoever runs it, or check that machine or pipeline, before releasing it from there.` };
  if (ctx.projectBusy) return { allowed: false, reason: 'An apply or teardown is running right now for this project on this server. Wait for it to finish.' };
  if (ctx.processRunning === null) return { allowed: false, reason: 'CloudBuilder could not check whether Terraform is running on this machine, so it will not release the lock.' };
  if (ctx.processRunning) return { allowed: false, reason: 'A Terraform process is running on this machine right now. Wait for it to finish — releasing its lock would let two runs write the state at once.' };
  if (!info.created) return { allowed: false, reason: 'The lock has no readable creation time, so CloudBuilder cannot tell whether it is stale.' };
  const ageMs = ctx.now - info.created.getTime();
  if (ageMs < MANUAL_RELEASE_MIN_AGE_MS) return { allowed: false, reason: `The lock is only ${Math.max(0, Math.round(ageMs / 1000))} seconds old. Give a run that just started a moment, then check again.` };
  return { allowed: true };
}

/** Is a `terraform` process running on this machine? `null` when that cannot be determined. */
export function terraformProcessRunning(): Promise<boolean | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', 'IMAGENAME eq terraform.exe', '/NH'], { windowsHide: true, timeout: 10_000 }, (err, stdout) => resolve(err ? null : /terraform\.exe/i.test(stdout)));
    } else {
      execFile('pgrep', ['-x', 'terraform'], { timeout: 10_000 }, (err) => {
        if (!err) return resolve(true);
        resolve((err as { code?: number | string }).code === 1 ? false : null);   // pgrep exits 1 when nothing matches
      });
    }
  });
}

export interface LockInspection {
  locked: boolean;
  lock?: { id: string; who?: string; operation?: string; createdAt?: string; ageMinutes?: number; path?: string };
  releasable?: boolean;
  reason?: string;
}

export interface LockDeps {
  run?: (args: string[], options: TerraformRunOptions) => Promise<TerraformRunResult>;
  processRunning?: () => Promise<boolean | null>;
  now?: () => number;
  host?: string;
}

interface LockTarget { orgId: string; projectId: string; cloudAccountId: string; stateBackend: TerraformStateBackendConfig }

async function loadEnv(target: LockTarget): Promise<Record<string, string>> {
  const json = await cloudAccountRepository.getCredentials(target.cloudAccountId, target.orgId);
  if (!json) throw Object.assign(new Error('CloudAccount credentials not found'), { statusCode: 404 });
  return resolveExecutionCredentials(JSON.parse(json) as CloudCredentials);
}

async function withBackendDir<T>(target: LockTarget, env: Record<string, string>, deps: LockDeps, fn: (dir: string) => Promise<T>): Promise<T> {
  const run = deps.run ?? runTerraform;
  const dir = await mkdtemp(join(tmpdir(), 'cloudcraft-tf-lock-'));
  try {
    await writeFile(join(dir, 'backend.tf'), renderBackendConfig(target.stateBackend), 'utf-8');
    await initWithRetry(dir, env, { run });
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Looks at the state lock without changing anything, and says whether it may be released. */
export async function inspectStateLock(target: LockTarget, deps: LockDeps = {}): Promise<LockInspection> {
  const run = deps.run ?? runTerraform;
  const env = await loadEnv(target);
  return withBackendDir(target, env, deps, async (dir) => {
    let message = '';
    try {
      // Taking the lock is the first thing a plan does, so if the state is locked this fails with the lock's details.
      // (This folder holds only the backend, so nothing here can change any resource.)
      await run(['plan', '-input=false', '-no-color', '-lock-timeout=0s'], { cwd: dir, env, timeoutMs: 60_000 });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    if (!message || !isStateLockError(message)) return { locked: false };
    const info = parseLockInfo(message);
    if (!info) return { locked: true, releasable: false, reason: 'The state is locked, but CloudBuilder could not read the lock details.' };

    const now = (deps.now ?? Date.now)();
    const decision = decideManualRelease(info, {
      now, host: deps.host ?? os.hostname(), processRunning: await (deps.processRunning ?? terraformProcessRunning)(), projectBusy: isProjectLocked(target.projectId),
    });
    return {
      locked: true,
      lock: { id: info.id, who: info.who, operation: info.operation, path: info.path, createdAt: info.created?.toISOString(), ageMinutes: info.created ? Math.round((now - info.created.getTime()) / 60000) : undefined },
      releasable: decision.allowed,
      ...(decision.allowed ? {} : { reason: decision.reason }),
    };
  });
}

/** Releases the lock — but only after checking again, now, that it is the one the user saw and that it is safe. */
export async function releaseStateLock(target: LockTarget & { lockId: string }, deps: LockDeps = {}): Promise<{ released: true }> {
  const run = deps.run ?? runTerraform;
  const inspection = await inspectStateLock(target, deps);
  const refuse = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
  if (!inspection.locked || !inspection.lock) throw refuse('The state is not locked any more — there is nothing to release.');
  if (inspection.lock.id !== target.lockId) throw refuse('The lock changed since you looked at it (a different run holds it now). Check it again.');
  if (!inspection.releasable) throw refuse(inspection.reason ?? 'This lock cannot be released safely.');

  const env = await loadEnv(target);
  await withBackendDir(target, env, deps, (dir) => run(['force-unlock', '-force', target.lockId], { cwd: dir, env, timeoutMs: 60_000 }));
  return { released: true };
}
