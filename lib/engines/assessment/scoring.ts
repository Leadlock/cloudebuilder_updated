/**
 * Explainable, coverage-aware scoring.
 *
 * Score = 100 × (1 − weighted failures ÷ weighted evaluated checks)
 *   weights: CRITICAL 10, HIGH 6, MEDIUM 3, LOW 1 (INFORMATIONAL checks are not scored)
 *   a WARNING counts as half a failure.
 * Caps: any failing CRITICAL check caps the score at 40; any failing HIGH at 70.
 * Only PASS / FAIL / WARNING count as evaluated. NOT_EVALUATED and
 * INSUFFICIENT_DATA reduce COVERAGE, never the score — and they never count as
 * passes. With nothing evaluated the score is null ("Not scored"), not 100.
 * Coverage below 60% is flagged, and a score that would rate Strong or Good is
 * rated "Limited evidence" instead, so a high score on thin evidence is never
 * presented as a strong posture. Score and coverage are always reported separately.
 * Accepted-risk findings still count as failing.
 */
import type { CoverageSummary, Evaluation, ScoreResult, Severity } from './types';

export const SCORE_WEIGHTS: Record<Severity, number> = { CRITICAL: 10, HIGH: 6, MEDIUM: 3, LOW: 1, INFORMATIONAL: 0 };
export const LOW_COVERAGE_THRESHOLD = 60;

export const SCORE_METHODOLOGY =
  'Score = 100 × (1 − Σ weight of failed checks ÷ Σ weight of evaluated checks), with weights CRITICAL 10, HIGH 6, MEDIUM 3, LOW 1; ' +
  'warnings count as half a failure; informational checks are not scored. Any failing CRITICAL check caps the score at 40 and any failing ' +
  'HIGH check at 70. Checks that were not evaluated or lacked data are excluded from the score and reported as reduced coverage; ' +
  'they are never treated as passes. Coverage = evaluated checks ÷ applicable checks. When coverage is below 60%, a score that would ' +
  'rate Strong or Good is rated "Limited evidence": the checks that could be evaluated passed, but too few could be evaluated to ' +
  'describe the overall posture.';

export function coverageOf(evals: Evaluation[]): CoverageSummary {
  const c = { applicable: 0, evaluated: 0, passed: 0, failed: 0, warnings: 0, notEvaluated: 0, insufficientData: 0, notApplicable: 0 };
  for (const e of evals) {
    switch (e.status) {
      case 'PASS': c.passed++; c.evaluated++; c.applicable++; break;
      case 'FAIL': c.failed++; c.evaluated++; c.applicable++; break;
      case 'WARNING': c.warnings++; c.evaluated++; c.applicable++; break;
      case 'NOT_EVALUATED': c.notEvaluated++; c.applicable++; break;
      case 'INSUFFICIENT_DATA': c.insufficientData++; c.applicable++; break;
      case 'NOT_APPLICABLE': c.notApplicable++; break;
    }
  }
  return { ...c, coveragePct: c.applicable === 0 ? null : Math.round((c.evaluated / c.applicable) * 100) };
}

export function scoreOf(evals: Evaluation[]): ScoreResult {
  const coverage = coverageOf(evals);
  const scored = evals.filter((e) => (e.status === 'PASS' || e.status === 'FAIL' || e.status === 'WARNING') && SCORE_WEIGHTS[e.severity] > 0);
  const lowCoverage = coverage.coveragePct !== null && coverage.coveragePct < LOW_COVERAGE_THRESHOLD;

  if (scored.length === 0) {
    return { score: null, rating: 'Not scored', coverage, lowCoverage, methodology: SCORE_METHODOLOGY };
  }

  let total = 0; let failed = 0;
  for (const e of scored) {
    const w = SCORE_WEIGHTS[e.severity];
    total += w;
    if (e.status === 'FAIL') failed += w;
    else if (e.status === 'WARNING') failed += w / 2;
  }
  let score = Math.round(100 * (1 - failed / total));
  let capApplied: string | undefined;
  const failing = scored.filter((e) => e.status === 'FAIL');
  if (failing.some((e) => e.severity === 'CRITICAL') && score > 40) { score = 40; capApplied = 'Capped at 40: at least one CRITICAL check is failing.'; }
  else if (failing.some((e) => e.severity === 'HIGH') && score > 70) { score = 70; capApplied = 'Capped at 70: at least one HIGH check is failing.'; }

  let rating: ScoreResult['rating'] = score >= 90 ? 'Strong' : score >= 75 ? 'Good' : score >= 50 ? 'Needs improvement' : 'Weak';
  // Thin evidence never reads as a strong posture; poor results stay visible as they are.
  if (lowCoverage && (rating === 'Strong' || rating === 'Good')) rating = 'Limited evidence';
  return { score, rating, coverage, capApplied, lowCoverage, methodology: SCORE_METHODOLOGY };
}
