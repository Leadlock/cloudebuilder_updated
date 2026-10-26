/**
 * Scores a set of controls and turns the result into what a report needs: one result per control, findings, limitations and an overall readiness.
 * Used by SOC 2 (Type 1 readiness) and by the AWS and Azure Well-Architected control reports, so all three read the same way.
 * Pure: the same inputs always give the same output.
 */
import type { Evaluation } from '@/lib/engines/assessment/types';
import { platformSignal, signalsFromEvaluations, type PlatformCheck, type PlatformFacts } from './signals';
import { resultFor } from './scoring';
import type { ControlRecord, ControlResult, EvidenceRef, Finding, FindingRecord, FindingSeverity, Limitation, Readiness, Score, Signal } from './types';

/** One control, in any framework. */
export interface ControlDef {
  id: string;
  /** The group it is listed under: a criterion (CC6.1), a pillar (Security). */
  group: string;
  title: string;
  ownerRole: string;
  /** Plain statement of what would be true if the control were in place and working. */
  activity?: string;
  frequency?: string;
  evidence: string[];
  rules?: string[];
  platform?: PlatformCheck[];
  /** Why a failure matters, used in findings. */
  effect: string;
}

export interface ReadinessInput {
  records: Record<string, ControlRecord>;
  /** Evidence attached to each control id. */
  evidence: Record<string, EvidenceRef[]>;
  evaluations: readonly Evaluation[];
  facts?: PlatformFacts;
  findingRecords?: Record<string, FindingRecord>;
  asOf: Date;
}

export function evaluateControls(defs: readonly ControlDef[], input: ReadinessInput): ControlResult[] {
  return defs.map((d) => {
    const signals: Signal[] = [
      ...signalsFromEvaluations(input.evaluations, d.rules ?? []),
      ...(d.platform ?? []).map((p) => platformSignal(p, input.facts, input.asOf)).filter((s): s is Signal => s !== null),
    ];
    return resultFor({ id: d.id, title: d.title, group: d.group }, { record: input.records[d.id], evidence: input.evidence[d.id] ?? [], signals, asOf: input.asOf });
  });
}

export interface GroupSummary { group: string; controls: number; scored: number; average: number | null; notAssessed: number; belowTarget: number; confidence: 'High' | 'Medium' | 'Low' }
export interface Summary { total: number; scored: number; notApplicable: number; notAssessed: number; byScore: Record<Score, number>; average: number | null; coveragePct: number; groups: GroupSummary[] }

const mode = (xs: Array<'High' | 'Medium' | 'Low'>): 'High' | 'Medium' | 'Low' => {
  if (xs.length === 0) return 'Low';
  const c = { High: 0, Medium: 0, Low: 0 }; xs.forEach((x) => c[x]++);
  return c.Low >= c.Medium && c.Low >= c.High ? 'Low' : c.Medium >= c.High ? 'Medium' : 'High';   // ties go to the more cautious
};
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

export function summarize(results: readonly ControlResult[]): Summary {
  const byScore: Record<Score, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  let notApplicable = 0; let notAssessed = 0;
  for (const r of results) {
    if (r.score !== null) byScore[r.score]++;
    else if (r.scoreLabel === 'Not applicable') notApplicable++;
    else notAssessed++;
  }
  const scored = results.filter((r) => r.score !== null);
  const inScope = results.length - notApplicable;
  const order = [...new Set(results.map((r) => r.group))];
  const groups: GroupSummary[] = order.map((g) => {
    const rs = results.filter((r) => r.group === g);
    const sc = rs.filter((r) => r.score !== null);
    return { group: g, controls: rs.length, scored: sc.length, average: avg(sc.map((r) => r.score as number)), notAssessed: rs.filter((r) => r.score === null && r.scoreLabel !== 'Not applicable').length, belowTarget: sc.filter((r) => (r.score as number) < 3).length, confidence: mode(sc.map((r) => r.confidence)) };
  });
  return { total: results.length, scored: scored.length, notApplicable, notAssessed, byScore, average: avg(scored.map((r) => r.score as number)), coveragePct: inScope === 0 ? 0 : Math.round((scored.length / inScope) * 100), groups };
}

const sevOf = (r: ControlResult): FindingSeverity => {
  const worst = r.signals.filter((s) => s.result === 'fail').map((s) => s.severity);
  if (worst.includes('CRITICAL') || worst.includes('HIGH')) return 'High';
  if (r.score === 0) return 'High';
  if (worst.includes('MEDIUM') || r.score === 1) return 'Medium';
  return 'Low';
};

/** A finding for every control that is missing, informal, only partly implemented, or has a failing check. The words on it are derived; the response is the team's. */
export function deriveFindings(defs: readonly ControlDef[], results: readonly ControlResult[], records: Record<string, FindingRecord> = {}): Finding[] {
  const def = new Map(defs.map((d) => [d.id, d]));
  const out: Finding[] = [];
  for (const r of results) {
    if (r.score === null) continue;
    const failing = r.signals.filter((s) => s.result === 'fail');
    if (r.score >= 3 && failing.length === 0) continue;
    const d = def.get(r.id)!;
    const rec = records[r.id];
    out.push({
      id: `F-${r.id}`, controlId: r.id, group: r.group, severity: sevOf(r),
      title: `${r.title.replace(/[?:.]+$/, '')} — ${failing.length ? 'a check found a problem' : r.score === 0 ? 'not in place' : 'not yet supported by evidence'}`,
      condition: failing.length ? failing.slice(0, 3).map((s) => s.text).join(' ') : r.reasons.join(' '),
      cause: failing.length ? 'The configuration does not meet what the check expects.' : r.score === 0 ? 'The control has not been put in place.' : 'The control is not documented or evidenced well enough to rely on.',
      effect: d.effect,
      recommendation: r.nextStep,
      owner: rec?.owner ?? r.owner, targetDate: rec?.targetDate, status: rec?.status ?? 'open',
      managementResponse: rec?.managementResponse ?? '', acceptedBy: rec?.acceptedBy ?? '', retestedBy: rec?.retestedBy ?? '', retestedAt: rec?.retestedAt,
    });
  }
  const rank = { High: 0, Medium: 1, Low: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.controlId.localeCompare(b.controlId));
}

export function deriveLimitations(results: readonly ControlResult[], opts: { cloudAccountRead: boolean }): Limitation[] {
  const out: Limitation[] = [];
  let n = 0; const add = (item: string, effect: string, controlId?: string) => out.push({ id: `L-${String(++n).padStart(2, '0')}`, item, effect, ...(controlId ? { controlId } : {}) });
  if (!opts.cloudAccountRead) add('The checks read the architecture design only, not the cloud account.', 'The real configuration may differ from the design. Connect the cloud account and run an account check to confirm it.');
  for (const r of results) {
    if (r.score === null && r.scoreLabel === 'Not applicable' && /without a reason/.test(r.reasons[0] ?? '')) add(`${r.id} ${r.title} is marked not applicable without a reason.`, 'It counts as not assessed until the reason is written.', r.id);
    else if (r.score === null && r.scoreLabel !== 'Not applicable') add(`${r.id} ${r.title} has not been assessed.`, 'No conclusion can be given for it.', r.id);
    else if (r.score !== null && r.confidence === 'Low' && r.score >= 1) add(`${r.id} ${r.title} rests on a statement alone.`, 'Nothing was provided that could be checked independently.', r.id);
    if (r.evidence.length > 0 && r.reasons.some((x) => /older than|expired/.test(x))) add(`${r.id} ${r.title} has evidence that is old or expired.`, 'It is not counted as current evidence.', r.id);
  }
  return out;
}

export function readinessOf(summary: Summary, findings: readonly Finding[]): Readiness {
  if (summary.notAssessed > 0) return 'Incomplete';
  const open = findings.filter((f) => f.status === 'open' || f.status === 'in_progress');
  const lowest = Object.entries(summary.byScore).filter(([, n]) => n > 0).map(([s]) => Number(s)).sort((a, b) => a - b)[0] ?? 0;
  if (summary.scored === 0) return 'Incomplete';
  if (lowest >= 3 && !open.some((f) => f.severity === 'High' || f.severity === 'Medium')) return 'Ready';
  if (lowest >= 2 && !open.some((f) => f.severity === 'High')) return 'Ready with conditions';
  return 'Not ready';
}
