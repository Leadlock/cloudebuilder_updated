/**
 * Account-level evidence: facts about the cloud ACCOUNT rather than the architecture (CloudTrail, GuardDuty, root MFA, AWS Config).
 *
 * A diagram cannot show them, so the account-level rules (AWS-ACCT-001…004) were always NOT EVALUATED. They can now be read, read-only,
 * through a connected AWS account (lib/cloud/accountControls) and stored with the project. This is the shape the engine takes them in.
 *
 * Honesty rules:
 *  - evidence is dated, and is only used for seven days: an old reading says "check again", it does not keep passing;
 *  - a control the account refused to let CloudBuilder read is NOT EVALUATED with the reason, never a pass;
 *  - nothing is assumed for a control that was not read.
 */
export type AccountEvidenceStatus = 'PASS' | 'WARNING' | 'FAIL' | 'UNAVAILABLE';

export interface AccountEvidence {
  status: AccountEvidenceStatus;
  /** What was read, in words (never raw API output). For UNAVAILABLE: why it could not be read. */
  observation: string;
  /** ISO time the account was read. */
  observedAt: string;
  /** Name of the connected account it was read from. */
  accountLabel?: string;
}

/** Keyed by rule id (AWS-ACCT-001 …). */
export type AccountEvidenceMap = Record<string, AccountEvidence>;

export const ACCOUNT_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const ACCOUNT_CONTROL_IDS = ['AWS-ACCT-001', 'AWS-ACCT-002', 'AWS-ACCT-003', 'AWS-ACCT-004'] as const;
export type AccountControlId = (typeof ACCOUNT_CONTROL_IDS)[number];

export function evidenceAgeMs(e: Pick<AccountEvidence, 'observedAt'>, now: string): number {
  const t = Date.parse(e.observedAt);
  const n = Date.parse(now);
  return Number.isFinite(t) && Number.isFinite(n) ? n - t : Number.POSITIVE_INFINITY;
}

export const isFresh = (e: Pick<AccountEvidence, 'observedAt'>, now: string): boolean => evidenceAgeMs(e, now) <= ACCOUNT_EVIDENCE_MAX_AGE_MS;

export function dayOf(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : 'an unknown date';
}
