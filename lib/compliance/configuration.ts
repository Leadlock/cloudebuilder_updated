/**
 * The configuration appendix: for every resource in the saved architecture, the security-relevant settings the assessment looked at, what was observed, what was
 * expected, and whether the value was authored in the design, read from the cloud account, or verified live. It is taken from the assessment's own evidence, so the
 * report cannot say something the checks did not see, and a setting that could hold a secret never appears (the snapshot redacts those before assessment).
 */
import type { Evaluation, EvaluationStatus } from '@/lib/engines/assessment/types';

export interface ConfigRow {
  resourceId: string;
  resource: string;
  type: string;
  provider: 'AWS' | 'Azure';
  region: string;
  setting: string;
  observed: string;
  expected: string;
  result: 'Pass' | 'Fail' | 'Unclear';
  source: 'Design' | 'Discovered' | 'Live';
  /** When the account value was read, for Discovered and Live. */
  readAt?: string;
  /** What the cloud account holds when it differs from what the design says (a planned change, or drift). */
  accountValue?: string;
}

export interface ConfigNode { id: string; label: string; resourceType: string; provider: string; region?: string; config?: Record<string, unknown> }

const humanize = (t: string) => t.replace(/^(aws|azure)_/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const RANK: Record<ConfigRow['result'], number> = { Fail: 3, Unclear: 2, Pass: 1 };
const resultOf = (s: EvaluationStatus): ConfigRow['result'] | null => (s === 'PASS' ? 'Pass' : s === 'FAIL' || s === 'WARNING' ? 'Fail' : s === 'INSUFFICIENT_DATA' ? 'Unclear' : null);
const SOURCE: Record<string, ConfigRow['source']> = { DESIGN: 'Design', DISCOVERED: 'Discovered', LIVE: 'Live' };
const PROVENANCE: Record<string, ConfigRow['source']> = { DESIGN_TIME: 'Design', DISCOVERED_CONFIGURATION: 'Discovered', LIVE_VERIFIED: 'Live' };

export function configRows(nodes: readonly ConfigNode[], evaluations: readonly Evaluation[]): ConfigRow[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rows = new Map<string, ConfigRow>();
  for (const e of evaluations) {
    const result = resultOf(e.status);
    if (!result) continue;
    for (const id of e.resourceIds) {
      const n = byId.get(id);
      if (!n) continue;
      for (const ev of e.evidence) {
        if ((ev.basis !== 'CONFIGURATION' && ev.basis !== 'ACCOUNT_API') || !ev.label) continue;
        const key = `${id}|${ev.label}`;
        const row: ConfigRow = {
          resourceId: id, resource: n.label, type: humanize(n.resourceType), provider: n.provider === 'azure' ? 'Azure' : 'AWS', region: n.region || (typeof n.config?.['region'] === 'string' ? n.config['region'] as string : '') || 'not set',
          setting: ev.label, observed: ev.observed, expected: ev.expected ?? '', result, source: (ev.source && SOURCE[ev.source]) || PROVENANCE[e.provenance] || 'Design',
          ...(ev.observedAt ? { readAt: ev.observedAt } : {}), ...(ev.discoveredValue !== undefined && ev.discoveredValue !== ev.observed ? { accountValue: ev.discoveredValue } : {}),
        };
        const prev = rows.get(key);
        // The same setting can be examined by several rules. Keep the worst result, and the strongest source.
        if (!prev || RANK[result] > RANK[prev.result] || (RANK[result] === RANK[prev.result] && row.source !== 'Design' && prev.source === 'Design')) rows.set(key, { ...row, ...(prev?.accountValue && !row.accountValue ? { accountValue: prev.accountValue } : {}) });
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.resource.localeCompare(b.resource) || a.setting.localeCompare(b.setting));
}

export interface ConfigSummary { resources: number; settings: number; failing: number; unclear: number; fromAccount: number; designOnly: number; differing: number }
export function configSummary(rows: readonly ConfigRow[]): ConfigSummary {
  return {
    resources: new Set(rows.map((r) => r.resourceId)).size, settings: rows.length, failing: rows.filter((r) => r.result === 'Fail').length, unclear: rows.filter((r) => r.result === 'Unclear').length,
    fromAccount: rows.filter((r) => r.source !== 'Design').length, designOnly: rows.filter((r) => r.source === 'Design').length, differing: rows.filter((r) => r.accountValue !== undefined).length,
  };
}
