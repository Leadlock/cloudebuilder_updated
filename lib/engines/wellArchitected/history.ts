/**
 * Review history: what changed since the last review.
 *
 * Every "Run Review" is saved as its own row, so the raw history already existed but nothing read it. This turns the saved reviews
 * of one architecture into (a) a short list of past reviews and (b) a plain "what changed" comparison of the latest review with the
 * one before it, so a score is never just a number: it says which findings appeared and which were fixed.
 *
 * Pure functions only (no database), so they are easy to test.
 */
import type { WaAssessment, WaFinding, WaPillar, WaProvider } from './types';

export interface ReviewHistoryEntry {
  evaluatedAt: string;
  overallScore: number;
  overallScored: boolean;
  findingCount: number;
  rulesetVersion: string;
  /** How many identical consecutive reviews this entry stands for (a re-run with nothing changed is not a new entry). */
  repeats: number;
}

export interface FindingChange {
  ruleId: string;
  title: string;
  severity: string;
  pillar: string;
  provider: string;
  resources: string[];
}

export interface PillarChange {
  provider: WaProvider;
  pillar: WaPillar;
  pillarLabel: string;
  before: number | null;
  after: number | null;
  delta: number | null;
}

export interface ReviewChanges {
  /** When the review being compared against was made. */
  since: string;
  overallBefore: number | null;
  overallAfter: number | null;
  overallDelta: number | null;
  pillars: PillarChange[];
  newFindings: FindingChange[];
  resolvedFindings: FindingChange[];
  /** True when the two reviews were made with different rulesets, so a score change may come from new or changed rules, not from the design. */
  rulesetChanged: boolean;
  previousRulesetVersion: string;
  currentRulesetVersion: string;
}

export interface ReviewHistory {
  entries: ReviewHistoryEntry[];
  /** Latest review against the previous one that actually differed; null when there is only one review (or none differ). */
  changes: ReviewChanges | null;
}

/** A finding is "the same finding" across reviews when the same rule fires on the same resources. */
export function findingKey(f: Pick<WaFinding, 'ruleId' | 'affectedResourceIds'>): string {
  return `${f.ruleId}|${[...(f.affectedResourceIds ?? [])].sort().join(',')}`;
}

function toChange(f: WaFinding): FindingChange {
  return {
    ruleId: f.ruleId, title: f.title, severity: f.severity, pillar: f.pillar, provider: f.provider,
    resources: (f.affectedResourceLabels?.length ? f.affectedResourceLabels : f.affectedResourceIds) ?? [],
  };
}

const score = (a: WaAssessment): number | null => (a.overallScored === false ? null : a.overallScore);

/** Two reviews are "the same" when nothing visible changed: same ruleset, same score, same pillar scores, same findings. */
export function sameReview(a: WaAssessment, b: WaAssessment): boolean {
  if ((a.rulesetVersion ?? '') !== (b.rulesetVersion ?? '')) return false;
  if (a.overallScore !== b.overallScore) return false;
  const pa = JSON.stringify((a.pillarScores ?? []).map((p) => [p.provider, p.pillar, p.score, p.scored]));
  const pb = JSON.stringify((b.pillarScores ?? []).map((p) => [p.provider, p.pillar, p.score, p.scored]));
  if (pa !== pb) return false;
  const ka = [...new Set((a.findings ?? []).map(findingKey))].sort().join(';');
  const kb = [...new Set((b.findings ?? []).map(findingKey))].sort().join(';');
  return ka === kb;
}

export function compareReviews(latest: WaAssessment, previous: WaAssessment): ReviewChanges {
  const prevKeys = new Map((previous.findings ?? []).map((f) => [findingKey(f), f]));
  const nowKeys = new Map((latest.findings ?? []).map((f) => [findingKey(f), f]));
  const pillarKey = (p: { provider?: WaProvider; pillar: WaPillar }) => `${p.provider ?? 'aws'}:${p.pillar}`;
  const before = new Map((previous.pillarScores ?? []).map((p) => [pillarKey(p), p]));

  const pillars: PillarChange[] = (latest.pillarScores ?? []).map((p) => {
    const b = before.get(pillarKey(p));
    const after = p.scored === false ? null : p.score;
    const prior = b ? (b.scored === false ? null : b.score) : null;
    return { provider: p.provider ?? 'aws', pillar: p.pillar, pillarLabel: p.pillarLabel, before: prior, after, delta: after !== null && prior !== null ? after - prior : null };
  });

  const overallBefore = score(previous);
  const overallAfter = score(latest);
  return {
    since: previous.evaluatedAt,
    overallBefore,
    overallAfter,
    overallDelta: overallBefore !== null && overallAfter !== null ? overallAfter - overallBefore : null,
    pillars,
    newFindings: [...nowKeys].filter(([k]) => !prevKeys.has(k)).map(([, f]) => toChange(f)),
    resolvedFindings: [...prevKeys].filter(([k]) => !nowKeys.has(k)).map(([, f]) => toChange(f)),
    rulesetChanged: (latest.rulesetVersion ?? '') !== (previous.rulesetVersion ?? ''),
    previousRulesetVersion: previous.rulesetVersion ?? '',
    currentRulesetVersion: latest.rulesetVersion ?? '',
  };
}

/**
 * `reviews` newest first. Consecutive identical reviews collapse into one entry (re-running a review with nothing changed does not
 * pad the history), and the comparison is against the most recent review that actually differs from the latest.
 */
export function buildHistory(reviews: WaAssessment[], maxEntries = 8): ReviewHistory {
  const entries: ReviewHistoryEntry[] = [];
  let previousDistinct: WaAssessment | null = null;
  let last: WaAssessment | null = null;
  const latest = reviews[0];

  for (const r of reviews) {
    if (last && sameReview(last, r)) {
      entries[entries.length - 1]!.repeats += 1;
    } else {
      entries.push({
        evaluatedAt: r.evaluatedAt, overallScore: r.overallScore, overallScored: r.overallScored !== false,
        findingCount: (r.findings ?? []).length, rulesetVersion: r.rulesetVersion ?? '', repeats: 1,
      });
      if (last && !previousDistinct && latest && !sameReview(latest, r)) previousDistinct = r;
    }
    last = r;
  }

  return {
    entries: entries.slice(0, maxEntries),
    changes: latest && previousDistinct ? compareReviews(latest, previousDistinct) : null,
  };
}
