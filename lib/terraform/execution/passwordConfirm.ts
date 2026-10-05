/**
 * Confirming a deploy or teardown with the person's own login password.
 *
 * The password is checked against the signed-in user's stored hash, and only then is a single-use approval recorded for exactly this
 * plan (same id and hash), good for a few minutes. Running the plan spends it, exactly as with any approval, so a confirmation cannot
 * be reused or moved to another plan. Wrong passwords are counted: after a few the person is locked out for a while, and a correct
 * password clears the count. Nothing about the password is ever logged or returned.
 */
import { requestApproval, decideApproval, PASSWORD_CONFIRM_TTL_MS, type Approval, type ApprovalAction } from './approvals';
import { checkRateLimit, peekRateLimit, resetRateLimit } from '@/lib/api/rateLimit';

export const PASSWORD_TRIES = { limit: 5, windowMs: 15 * 60_000 } as const;

export interface PasswordCheckDeps {
  /** The user's stored password hash, or null if they have no password (for example a development or single-sign-on identity). */
  getPasswordHash(userId: string): Promise<string | null>;
  verifyPassword(password: string, hash: string): Promise<boolean>;
}

export type ConfirmResult =
  | { ok: true; approval: Approval }
  | { ok: false; code: 'locked' | 'no_password' | 'wrong_password' | 'not_recorded'; message: string; retryAfterSeconds?: number; triesLeft?: number };

const key = (userId: string) => `${userId}:terraform-password`;

export async function confirmWithPassword(
  input: { orgId: string; projectId: string; userId: string; action: ApprovalAction; planId: string; planHash: string; summary: string; password: string },
  deps: PasswordCheckDeps,
): Promise<ConfirmResult> {
  // Locked out? Refuse before even looking at the password, so a lockout cannot be tested for with a correct one.
  const peek = await peekRateLimit(key(input.userId), PASSWORD_TRIES.limit, PASSWORD_TRIES.windowMs);
  if (peek.remaining <= 0) {
    const minutes = Math.max(1, Math.ceil(peek.resetsInSeconds / 60));
    return { ok: false, code: 'locked', retryAfterSeconds: peek.resetsInSeconds, message: `Too many wrong passwords. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.` };
  }

  const hash = await deps.getPasswordHash(input.userId);
  if (!hash) {
    return { ok: false, code: 'no_password', message: 'Your account has no password to confirm with (you may have signed in another way). Ask the server operator to set CLOUDCRAFT_TERRAFORM_APPROVAL=self-ok, or sign in with an email and password.' };
  }
  if (!(await deps.verifyPassword(input.password, hash))) {
    const after = await checkRateLimit(key(input.userId), PASSWORD_TRIES.limit, PASSWORD_TRIES.windowMs);   // counts this failure
    return { ok: false, code: 'wrong_password', triesLeft: Math.max(0, after.remaining), message: after.remaining > 0 ? `That password is not right. ${after.remaining} ${after.remaining === 1 ? 'try' : 'tries'} left.` : 'That password is not right, and there are no tries left for a while.' };
  }
  await resetRateLimit(key(input.userId));

  const { approval } = await requestApproval({ orgId: input.orgId, projectId: input.projectId, action: input.action, planId: input.planId, planHash: input.planHash, requestedBy: input.userId, summary: input.summary });
  if (approval.status === 'approved') return { ok: true, approval };      // already confirmed and still valid: nothing more to do
  const decided = await decideApproval({ id: approval.id, orgId: input.orgId, decidedBy: input.userId, decision: 'approve', comment: 'Confirmed with password', ttlMs: PASSWORD_CONFIRM_TTL_MS });
  if (!decided.ok) return { ok: false, code: 'not_recorded', message: decided.reason };
  return { ok: true, approval: decided.approval };
}
