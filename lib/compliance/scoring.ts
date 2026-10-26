/**
 * How a control gets its score. The rules are short on purpose, so the person reading a report can check them against the control.
 *
 *   Not assessed   nobody has answered and no check applies. Not a score: it is listed as a limitation, and the control counts as open.
 *   0 Missing      the owner says there is no such control, or it is only planned.
 *   1 Informal     the owner says it is in place (or partly), and there is no evidence and no check to show it.
 *   2 Implemented  there is something behind it: a check on the design, or evidence that is old (past the window) or partial.
 *   3 Operating    dated evidence from inside the window, or a check that read the cloud account (not just the design), and nothing against it.
 *   4 Audit-ready  operating, AND a live or system-generated source, AND reviewed by someone other than the owner, inside the window.
 *
 * A failing check caps the score at 2 whatever the owner says: a report cannot call a control operating while the configuration shows it is not.
 * "Partly" never scores above 2. An answer on its own (a self-attestation) never scores above 1.
 */
import type { Confidence, ControlRecord, ControlResult, EvidenceRef, Score, Signal } from './types';
import { SCORE_LABEL } from './types';

/** Evidence older than this, counted from the assessment date, is "old". A SOC 2 Type 1 report is about one date, so a year is generous. */
export const EVIDENCE_WINDOW_DAYS = 365;

export interface ScoreInput {
  record?: ControlRecord;
  evidence: EvidenceRef[];
  signals: Signal[];
  asOf: Date;
  windowDays?: number;
}

export interface Scored { score: Score | null; confidence: Confidence; reasons: string[]; nextStep: string; fresh: EvidenceRef[]; stale: EvidenceRef[]; failing: Signal[] }

const DAY = 86_400_000;
const ageDays = (iso: string, asOf: Date) => (asOf.getTime() - new Date(iso).getTime()) / DAY;
const word = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function scoreControl(i: ScoreInput): Scored {
  const window = i.windowDays ?? EVIDENCE_WINDOW_DAYS;
  const reasons: string[] = [];
  const failing = i.signals.filter((s) => s.result === 'fail');
  const passing = i.signals.filter((s) => s.result === 'pass');
  const unclear = i.signals.filter((s) => s.result === 'unclear');
  const readFromAccount = passing.filter((s) => s.basis === 'discovered' || s.basis === 'live' || s.basis === 'platform');
  const designPass = passing.filter((s) => s.basis === 'design');
  const answered = passing.filter((s) => s.basis === 'answer');
  const fresh = i.evidence.filter((e) => ageDays(e.collectedAt, i.asOf) <= window && (!e.validUntil || new Date(e.validUntil).getTime() >= i.asOf.getTime()) && new Date(e.collectedAt).getTime() <= i.asOf.getTime() + DAY);
  const stale = i.evidence.filter((e) => !fresh.includes(e));
  const status = i.record?.status;

  if (status === 'not_applicable') {
    return i.record?.naReason.trim()
      ? { score: null, confidence: 'Medium', reasons: [`Marked not applicable: ${i.record.naReason.trim()}`], nextStep: 'Agree the reason with the CPA firm.', fresh, stale, failing }
      : { score: null, confidence: 'Low', reasons: ['Marked not applicable without a reason, so it counts as not assessed.'], nextStep: 'Write why the control does not apply.', fresh, stale, failing };
  }

  // The owner's answer, or, when nobody answered, what the checks alone say.
  const effective = status ?? (readFromAccount.length + designPass.length > 0 && failing.length === 0 ? 'implemented' : undefined);
  if (!effective) {
    if (failing.length === 0) return { score: null, confidence: 'Low', reasons: ['Nobody has assessed this control and no check applies to it.'], nextStep: 'Name an owner and record whether the control is in place.', fresh, stale, failing };
    reasons.push('A check found a problem, and nobody has answered for this control.');
  }

  // Nobody answered but a check found a problem: the control is not demonstrably in place.
  const answer = effective ?? 'none';
  let score: Score;
  if (answer === 'none' || answer === 'planned') {
    score = 0;
    reasons.push(answer === 'planned' ? 'The control is planned, not yet in place.' : effective ? 'The owner says the control does not exist.' : 'No owner has answered, so the control is not demonstrably in place.');
  } else if (answer === 'partial') {
    score = i.evidence.length > 0 || designPass.length + readFromAccount.length > 0 ? 2 : 1;
    reasons.push(`The owner says the control is in place only in part${score === 1 ? ', and nothing is attached to show how far' : ''}.`);
  } else {
    // implemented (asserted by the owner, or implied by passing checks)
    const supported = fresh.length > 0 || stale.length > 0 || designPass.length > 0 || readFromAccount.length > 0;
    const operating = unclear.length === 0 && (fresh.length > 0 || readFromAccount.length > 0);
    const reviewedFresh = !!i.record?.reviewer && i.record.reviewer.trim().toLowerCase() !== (i.record.owner ?? '').trim().toLowerCase() && !!i.record.reviewedAt && ageDays(i.record.reviewedAt, i.asOf) <= window;
    const strongSource = readFromAccount.length > 0 || fresh.some((e) => e.origin === 'system');
    score = !supported ? 1 : !operating ? 2 : strongSource && reviewedFresh ? 4 : 3;
    if (!supported) reasons.push('The control is said to be in place, but nothing is attached and no check supports it.');
    else if (!operating) reasons.push(unclear.length ? 'Something supports it, but a related check could not be completed.' : 'Something supports it, but not evidence from inside the window or a reading of the cloud account.');
    else reasons.push(readFromAccount.length ? 'A check read this from the cloud account or the platform.' : `${word(fresh.length, 'piece')} of dated evidence from the last ${window} days.`);
    if (score === 3 && strongSource && !reviewedFresh) reasons.push('Not audit-ready yet: it has not been reviewed by someone other than its owner, within the window.');
    if (score === 3 && !strongSource && reviewedFresh) reasons.push('Not audit-ready yet: the evidence is hand-made; a system-generated source or a live check is needed.');
  }

  if (failing.length > 0 && score > 2) {
    score = 2;
    reasons.push(`Capped at 2: ${word(failing.length, 'check')} found a problem, whatever the answer says.`);
  }
  if (answered.length > 0 && score > 1 && designPass.length + readFromAccount.length === 0 && i.evidence.length === 0) score = 1;
  if (stale.length > 0 && fresh.length === 0 && i.evidence.length > 0) reasons.push(`${word(stale.length, 'attachment')} ${stale.length === 1 ? 'is' : 'are'} older than ${window} days or expired.`);

  const confidence: Confidence = readFromAccount.length > 0 || (fresh.some((e) => e.origin === 'system') && !!i.record?.reviewer) ? 'High'
    : fresh.length > 0 || designPass.length > 0 ? 'Medium' : 'Low';

  const nextStep =
    failing.length > 0 ? `Fix what the check found: ${failing[0]!.text}`
    : score === 0 ? 'Put the control in place, then record it as implemented with evidence.'
    : score === 1 ? 'Attach dated evidence (a configuration export, a policy, a log extract) that shows the control working.'
    : score === 2 ? (unclear.length ? 'Complete the related check, or attach evidence that answers it.' : 'Attach evidence dated within the window, or connect the cloud account so a check can read it.')
    : score === 3 ? 'Have someone other than the owner review it, and add a system-generated source (a live check or an export).'
    : 'Keep the evidence current: review it again before the window ends.';

  return { score, confidence, reasons, nextStep, fresh, stale, failing };
}

export function resultFor(base: { id: string; title: string; group: string }, i: ScoreInput): ControlResult {
  const s = scoreControl(i);
  const status = i.record?.status;
  return {
    id: base.id, title: base.title, group: base.group, owner: i.record?.owner ?? '', status,
    score: s.score, scoreLabel: s.score === null ? (status === 'not_applicable' ? 'Not applicable' : 'Not assessed') : SCORE_LABEL[s.score],
    confidence: s.confidence, signals: i.signals, evidence: i.evidence, reasons: s.reasons, nextStep: s.nextStep,
    reviewer: i.record?.reviewer ?? '', reviewedAt: i.record?.reviewedAt, note: i.record?.note ?? '',
  };
}
