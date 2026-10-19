/**
 * One Terraform apply at a time per project. Two applies against the same state would race each other and can corrupt
 * real infrastructure, so the apply route takes this lock before queueing a job and the worker releases it when done.
 *
 * It is an exclusive-create lock file in the OS temp directory, which the web server and the worker (same host) share.
 * A lock older than the job's own expiry is treated as abandoned (a crashed worker), so a failure can never block a
 * project forever.
 */
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';

const LOCK_DIR = path.join(tmpdir(), 'cloudbuilder-tf-locks');
const STALE_AFTER_MS = 35 * 60 * 1000; // apply jobs expire after 30 minutes

const lockPath = (projectId: string) => path.join(LOCK_DIR, `${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}.lock`);

/** True when the lock was taken; false when another apply for this project is still running. */
export function acquireProjectLock(projectId: string): boolean {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const file = lockPath(projectId);
  try {
    fs.closeSync(fs.openSync(file, 'wx'));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > STALE_AFTER_MS) {
        fs.rmSync(file, { force: true });
        fs.closeSync(fs.openSync(file, 'wx'));
        return true;
      }
    } catch { /* lost a race with another process: treat as held */ }
    return false;
  }
}

/** True while an apply holds the lock (and the lock is not stale). Does not take or change the lock. */
export function isProjectLocked(projectId: string): boolean {
  try { return Date.now() - fs.statSync(lockPath(projectId)).mtimeMs <= STALE_AFTER_MS; } catch { return false; }
}

export function releaseProjectLock(projectId: string): void {
  try { fs.rmSync(lockPath(projectId), { force: true }); } catch { /* nothing to release */ }
}
