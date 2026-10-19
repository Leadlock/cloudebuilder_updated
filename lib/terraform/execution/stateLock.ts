/**
 * Remote state locks: when is it safe to break one?
 *
 * Terraform locks the remote state while it plans, applies or destroys, so two runs can never write it at once. If a run
 * is killed, its lock stays behind. Breaking a lock that is NOT stale — one held by a run that is still going, on this
 * server or on someone else's machine — lets two writers loose on the same state, which can duplicate or lose
 * infrastructure. So CloudBuilder only clears a lock automatically when ALL of these hold:
 *
 *   - the lock was taken by this very machine (the lock's "Who" names this host), so it is CloudBuilder's own run that
 *     died, not a teammate's laptop or a pipeline;
 *   - it is older than the longest run CloudBuilder allows (plus a margin), so that run cannot still be working;
 *   - the operation is a plan or an apply — never a destroy.
 *
 * Anything else is reported with who holds the lock, since when, and how to release it by hand once it is confirmed dead.
 */
import os from 'os';
import { isStateLockError, parseLockInfo, type LockInfo } from './stateLockParse';

export { isStateLockError, parseLockInfo, type LockInfo };

/** Longest CloudBuilder allows an apply (45 min) plus a safety margin. */
export const AUTO_UNLOCK_MIN_AGE_MS = 60 * 60 * 1000;

export type LockedOperation = 'plan' | 'apply' | 'destroy';

/** True when the lock's "Who" (for example "DOMAIN\\user@HOST") names this machine. */
export function isLockFromThisMachine(info: LockInfo, host = os.hostname()): boolean {
  if (!info.who) return false;
  const at = info.who.lastIndexOf('@');
  return at >= 0 && info.who.slice(at + 1).trim().toLowerCase() === host.toLowerCase();
}

export type UnlockDecision = { unlock: true; id: string } | { unlock: false; reason: string; info: LockInfo | null };

export function decideAutoUnlock(message: string, operation: LockedOperation, now = Date.now(), host = os.hostname()): UnlockDecision {
  const info = parseLockInfo(message);
  if (!info) return { unlock: false, reason: 'the lock details could not be read', info: null };
  if (operation === 'destroy') return { unlock: false, reason: 'a destroy never breaks a lock automatically', info };
  if (!isLockFromThisMachine(info, host)) return { unlock: false, reason: 'the lock was taken by another machine, which may still be running', info };
  if (!info.created) return { unlock: false, reason: 'the lock has no readable creation time', info };
  const age = now - info.created.getTime();
  if (age < AUTO_UNLOCK_MIN_AGE_MS) return { unlock: false, reason: `the lock is only ${Math.max(0, Math.round(age / 60000))} minutes old, so its run may still be going`, info };
  return { unlock: true, id: info.id };
}

/** The message shown instead of an automatic unlock: who holds the lock, how long, and the safe way to release it. */
export function describeHeldLock(originalMessage: string, decision: Extract<UnlockDecision, { unlock: false }>, now = Date.now()): string {
  const i = decision.info;
  const held = i
    ? `The remote state is locked${i.who ? ` by ${i.who}` : ''}${i.operation ? ` (running: ${i.operation})` : ''}${i.created ? `, since ${i.created.toISOString().replace('T', ' ').slice(0, 16)} UTC (${Math.round((now - i.created.getTime()) / 60000)} min ago)` : ''}.`
    : 'The remote state is locked.';
  const how = i
    ? `CloudBuilder did not break it because ${decision.reason}. First confirm that run has finished or died (ask whoever holds it, or check their machine / pipeline). Only then release it with: terraform force-unlock ${i.id}`
    : `CloudBuilder did not break it because ${decision.reason}.`;
  return `${held} ${how}\n\nTerraform said: ${originalMessage.slice(0, 600)}`;
}
