/**
 * Plain-code quality checks on every priced line, so a number is never shown without saying how far it can be trusted.
 *
 * No AI and no network here. Each line gets one status:
 *  - verified: the price came from the official price list in this run (or a cached copy of it) and passed every check.
 *  - estimate: the price is CloudBuilder's built-in table, not the official list. It is kept in the total but named as an estimate.
 *  - check:    something is wrong or not comparable (a meter counted twice, a different size on the other side, an implausible
 *              amount). The line says what, so the person can judge it.
 *  - unpriced: no usable price. It is never counted as zero.
 */
import type { CostLineItem } from '@/lib/engines/cost/types';
import { findCostAnomalies } from './../ai/plausibility';

export type LineQualityStatus = 'verified' | 'estimate' | 'check' | 'unpriced';

export interface LineQuality {
  status: LineQualityStatus;
  notes: string[];
  /** Usage-based charges the price does not include (data transfer, requests, ...), taken from the price's own assumptions. */
  excludes: string[];
  /** Assumptions the amount rests on, such as the traffic assumed for a CDN (taken from assumptions that start with "Assumed"). */
  assumes: string[];
}

export interface QualitySummary {
  /** Lines priced from the official list. */
  verified: number;
  /** Lines priced from the built-in table. */
  estimates: number;
  /** Lines with something to check. */
  check: number;
  unpriced: number;
  /** Monthly USD in each group, so the screen can say how much of the total is estimated. */
  verifiedUsd: number;
  estimateUsd: number;
  checkUsd: number;
}

/** "name: $x per Hour × 1 = $y/mo" lines that appear more than once are one meter counted twice. */
function repeatedMeterLines(assumptions: string[]): string[] {
  const meters = assumptions.filter((l) => / per .+ × \d/.test(l));
  return [...new Set(meters.filter((l, i) => meters.indexOf(l) !== i))];
}

/** The usage-based charges a line says it does not count, shortened to what is missing ("Data transfer and request-volume charges not included" becomes "Data transfer and request-volume charges"). */
export function excludedCharges(assumptions: string[]): string[] {
  return assumptions
    .filter((a) => /not included/i.test(a))
    .map((a) => a.replace(/\s*[—-]\s*\$.*$/, '').replace(/\s*not included\.?$/i, '').replace(/\s+not included\b.*$/i, '').replace(/[\s,;.]+$/, '').trim())
    .filter((a) => a.length > 0);
}

export function assessLine(item: CostLineItem): LineQuality {
  if (item.confidence === 'unsupported' || item.pricingTier === 'UNAVAILABLE') {
    return { status: 'unpriced', notes: ['No usable price was found for this service, so it is left out of the total.'], excludes: [], assumes: [] };
  }
  const notes: string[] = [];
  let status: LineQualityStatus = item.pricingTier === 'FALLBACK_ESTIMATE' ? 'estimate' : 'verified';
  if (status === 'estimate') notes.push('Built-in estimate: the official price list was not used for this line.');

  const repeated = repeatedMeterLines(item.assumptions ?? []);
  if (repeated.length > 0) {
    status = 'check';
    notes.push(`The same price line appears twice, so the total may be double (${repeated[0]!.split(':')[0]}).`);
  }
  if (item.resourceType === 'azure_sql' && (item.assumptions ?? []).some((a) => /Database [A-Z]\d+ list price|DTU/i.test(a))) {
    status = 'check';
    notes.push('Priced as a DTU tier, which is not the same size as an AWS instance (vCPU and memory), so compare with care.');
  }
  const anomaly = findCostAnomalies([{ resourceId: item.resourceId, resourceLabel: item.resourceLabel, resourceType: item.resourceType, monthlyUsd: item.monthlyUsd, confidence: item.confidence }])[0];
  if (anomaly) {
    status = 'check';
    notes.push(anomaly.reason);
  }
  if (item.pricingIsStale) notes.push('Saved copy of the official price, past its refresh time. Use Refresh prices to update it.');
  return { status, notes, excludes: excludedCharges(item.assumptions ?? []), assumes: (item.assumptions ?? []).filter((a) => /^Assumed /i.test(a)) };
}

export function assessResult(items: CostLineItem[]): { lines: Record<string, LineQuality>; summary: QualitySummary } {
  const lines: Record<string, LineQuality> = {};
  const summary: QualitySummary = { verified: 0, estimates: 0, check: 0, unpriced: 0, verifiedUsd: 0, estimateUsd: 0, checkUsd: 0 };
  for (const item of items) {
    const q = assessLine(item);
    lines[item.resourceId] = q;
    const usd = Number.isFinite(item.monthlyUsd) ? item.monthlyUsd : 0;
    if (q.status === 'verified') { summary.verified++; summary.verifiedUsd += usd; }
    else if (q.status === 'estimate') { summary.estimates++; summary.estimateUsd += usd; }
    else if (q.status === 'check') { summary.check++; summary.checkUsd += usd; }
    else summary.unpriced++;
  }
  return { lines, summary };
}

/** The oldest time any price on this side was fetched from the official list, or null when none is known. */
export function oldestPriceTime(items: CostLineItem[]): string | null {
  const times = items.map((i) => i.pricingRetrievedAt).filter((t): t is string => !!t && Number.isFinite(Date.parse(t)));
  return times.length === 0 ? null : times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}
