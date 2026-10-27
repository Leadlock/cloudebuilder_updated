/**
 * Evidence over time. A SOC 2 Type 2 examination asks whether controls kept operating across a period (usually 3 to 12 months), not only on one day.
 * A snapshot is a dated, compact record of every control's score and failing checks; this file turns a report into one and reads a run of them back.
 * Pure functions: the repository stores them, the worker takes them.
 */
import type { ReadinessReport } from './report';
import type { FrameworkId } from './types';

export const SNAPSHOT_TRIGGERS = ['scheduled', 'manual', 'issue'] as const;
export type SnapshotTrigger = (typeof SNAPSHOT_TRIGGERS)[number];

/** A period with no snapshot for longer than this is shown as a gap: the examiner cannot tell what happened in it. */
export const MAX_GAP_DAYS = 7;

export interface SnapshotControl { id: string; score: number | null; confidence: string; failing: string[]; evidence: number }
export interface SnapshotRecord { id: string; takenAt: string; trigger: SnapshotTrigger; readiness: string; controls: SnapshotControl[] }

export function controlsOf(report: ReadinessReport): SnapshotControl[] {
  return report.results.map((r) => ({ id: r.id, score: r.score, confidence: r.confidence, failing: r.signals.filter((s) => s.result === 'fail').map((s) => s.ref), evidence: r.evidence.length }));
}

export function summaryOf(report: ReadinessReport) {
  return { total: report.summary.total, notApplicable: report.summary.notApplicable, notAssessed: report.summary.notAssessed, coveragePct: report.summary.coveragePct, average: report.summary.average, byScore: report.summary.byScore, findings: report.findings.length };
}

export interface PeriodControl {
  id: string; snapshots: number; operating: number; failing: number; minScore: number | null; lastScore: number | null;
  /** Operating (score 3 or more) in every snapshot of the period. */
  continuous: boolean;
}
export interface Gap { from: string; to: string; days: number }
export interface PeriodAnalysis {
  framework: FrameworkId;
  from: string; to: string;
  snapshotCount: number; first: string | null; last: string | null;
  /** Days between the first and last snapshot. */
  spanDays: number;
  gaps: Gap[]; longestGapDays: number;
  controls: PeriodControl[];
  continuousControls: number; assessedControls: number;
}

const DAY = 86_400_000;
const dayOf = (iso: string) => iso.slice(0, 10);

/** What the snapshots in [from, to] show. Not-applicable and never-assessed controls (score null throughout) are left out of the counts. */
export function analyzePeriod(framework: FrameworkId, snapshots: readonly SnapshotRecord[], from: Date, to: Date): PeriodAnalysis {
  const inside = snapshots.filter((s) => { const t = Date.parse(s.takenAt); return t >= from.getTime() && t <= to.getTime(); }).sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const gaps: Gap[] = [];
  // The period's edges count too: no snapshot at all in the first or last week is a gap.
  const marks = [from.toISOString(), ...inside.map((s) => s.takenAt), to.toISOString()];
  for (let i = 1; i < marks.length; i++) {
    const days = Math.floor((Date.parse(marks[i]!) - Date.parse(marks[i - 1]!)) / DAY);
    if (days > MAX_GAP_DAYS) gaps.push({ from: dayOf(marks[i - 1]!), to: dayOf(marks[i]!), days });
  }
  const ids = [...new Set(inside.flatMap((s) => s.controls.map((c) => c.id)))];
  const controls: PeriodControl[] = ids.map((id) => {
    const rows = inside.map((s) => s.controls.find((c) => c.id === id)).filter((c): c is SnapshotControl => !!c);
    const scored = rows.filter((c) => c.score !== null);
    const scores = scored.map((c) => c.score as number);
    return {
      id, snapshots: rows.length, operating: scored.filter((c) => (c.score as number) >= 3).length, failing: rows.filter((c) => c.failing.length > 0).length,
      minScore: scores.length ? Math.min(...scores) : null, lastScore: rows.length ? rows[rows.length - 1]!.score : null,
      continuous: rows.length > 0 && rows.length === inside.length && scored.length === rows.length && scored.every((c) => (c.score as number) >= 3 && c.failing.length === 0),
    };
  });
  const assessed = controls.filter((c) => c.minScore !== null);
  return {
    framework, from: dayOf(from.toISOString()), to: dayOf(to.toISOString()), snapshotCount: inside.length, first: inside[0]?.takenAt ?? null, last: inside[inside.length - 1]?.takenAt ?? null,
    spanDays: inside.length > 1 ? Math.floor((Date.parse(inside[inside.length - 1]!.takenAt) - Date.parse(inside[0]!.takenAt)) / DAY) : 0,
    gaps, longestGapDays: gaps.reduce((m, g) => Math.max(m, g.days), 0), controls,
    continuousControls: assessed.filter((c) => c.continuous).length, assessedControls: assessed.length,
  };
}

/** One sentence the report can open the section with. */
export function periodSentence(a: PeriodAnalysis): string {
  if (a.snapshotCount === 0) return 'No snapshots were taken in this period, so nothing can be said about how the controls operated over time.';
  const gaps = a.gaps.length ? ` There ${a.gaps.length === 1 ? 'is 1 gap' : `are ${a.gaps.length} gaps`} longer than ${MAX_GAP_DAYS} days (the longest is ${a.longestGapDays} days).` : ` There is no gap longer than ${MAX_GAP_DAYS} days.`;
  return `${a.snapshotCount} ${a.snapshotCount === 1 ? 'snapshot was' : 'snapshots were'} taken between ${a.from} and ${a.to}, over ${a.spanDays} days.${gaps} ${a.continuousControls} of ${a.assessedControls} assessed controls operated (score 3 or more, no failing check) in every snapshot.`;
}

/** Rows for the report's "operating over time" table: the controls that were not continuous, worst first, then a count of the rest. */
export function periodRows(a: PeriodAnalysis, titleOf: (id: string) => string, limit = 40): { rows: string[][]; more: number } {
  const bad = a.controls.filter((c) => c.minScore !== null && !c.continuous).sort((x, y) => (x.minScore ?? 9) - (y.minScore ?? 9) || y.failing - x.failing || x.id.localeCompare(y.id));
  return {
    rows: bad.slice(0, limit).map((c) => [c.id, titleOf(c.id), `${c.operating} of ${c.snapshots}`, String(c.failing), c.minScore === null ? 'n/a' : String(c.minScore), c.lastScore === null ? 'n/a' : String(c.lastScore)]),
    more: Math.max(0, bad.length - limit),
  };
}
