/**
 * The scan of the files CloudBuilder generates: reading Trivy's JSON, applying the policy (what is accepted, what is known and counted, what fails),
 * and writing the report. Pure: no process, no file, no network, so the rules for failing are tested on their own.
 *
 * A finding fails the scan when its severity reaches `failOn` and the policy has no entry for its rule. An entry is either `accept` (this is how
 * the product is meant to behave, and the reason says why) or `todo` (a known gap: it may not grow, `max` is the count today). An entry that matches
 * nothing any more must be removed, so the list never holds decisions about things that are gone.
 */
import type { WaPillarId } from '@/lib/engines/assessment/types';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export const SEVERITIES: readonly Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
const RANK: Record<Severity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
export const atLeast = (s: Severity, floor: Severity): boolean => RANK[s] >= RANK[floor];

export interface Finding {
  /** The generated case (a folder) the file belongs to, for example project-ecs. */
  caseName: string;
  /** The file inside that case. */
  file: string;
  /** What Trivy read it as: terraform, dockerfile, kubernetes, helm. */
  type: string;
  id: string;
  title: string;
  severity: Severity;
  resource: string;
  line: number | null;
  pillar: WaPillarId;
}

export interface PolicyRule { id: string; action: 'accept' | 'todo'; reason: string; /** For `todo`: the most findings of this rule there may be. */ max?: number }
export interface Policy { failOn: Severity; rules: PolicyRule[] }

/** A title for a table cell: some checks carry a whole paragraph as their title. */
const short = (t: string) => { const c = t.replace(/\|/g, '/').replace(/\s+/g, ' ').trim(); return c.length > 90 ? `${c.slice(0, 87)}…` : c; };

const ANSI = /\u001b\[[0-9;]*m/g;

/** The Well-Architected pillar a finding belongs to, from what it is about. Security unless its title says otherwise. */
export function pillarOf(title: string): WaPillarId {
  if (/\b(backup|retention|version(?:ing|ed)|immutable|replica|multi-?az|availability zone|redundan\w*|geo-?redundan\w*|deletion protection|soft.?delete|purge protection|recovery)/i.test(title)) return 'reliability';
  if (/\b(logging|log group|logs?|monitor|diagnostic|audit|trail|flow log|alarm|insights|metric)\b/i.test(title)) return 'operational_excellence';
  return 'security';
}

/** The failed checks in Trivy's JSON report (`trivy config --format json`). Passed checks and the code excerpts are not kept. */
export function parseTrivy(report: unknown): Finding[] {
  const results = (report as { Results?: unknown[] } | null)?.Results;
  if (!Array.isArray(results)) throw new Error('This is not a Trivy report: it has no Results.');
  const out: Finding[] = [];
  for (const r of results as Array<Record<string, unknown>>) {
    const target = String(r['Target'] ?? '');
    const [caseName = '', ...rest] = target.split('/');
    for (const m of (r['Misconfigurations'] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (m['Status'] !== 'FAIL') continue;
      const cause = (m['CauseMetadata'] as { Resource?: string; StartLine?: number } | undefined) ?? {};
      const sev = String(m['Severity'] ?? 'UNKNOWN').toUpperCase() as Severity;
      const title = String(m['Title'] ?? '').replace(ANSI, '');
      out.push({
        caseName, file: rest.join('/') || target, type: String(r['Type'] ?? ''), id: String(m['ID'] ?? ''), title, severity: SEVERITIES.includes(sev) ? sev : 'UNKNOWN',
        resource: String(cause.Resource ?? ''), line: typeof cause.StartLine === 'number' && cause.StartLine > 0 ? cause.StartLine : null, pillar: pillarOf(title),
      });
    }
  }
  return out;
}

/** Problems with the policy file itself (a reason too short to mean anything, a `todo` with no ceiling, a rule listed twice). */
export function validatePolicy(p: unknown): string[] {
  const problems: string[] = [];
  const pol = p as Partial<Policy> | null;
  if (!pol || typeof pol !== 'object') return ['The policy is not an object.'];
  if (!SEVERITIES.includes(pol.failOn as Severity) || pol.failOn === 'UNKNOWN') problems.push('failOn must be CRITICAL, HIGH, MEDIUM or LOW.');
  if (!Array.isArray(pol.rules)) return [...problems, 'rules must be a list.'];
  const seen = new Set<string>();
  for (const r of pol.rules) {
    const where = `rule ${r?.id ?? '(no id)'}`;
    if (!r || typeof r.id !== 'string' || !/^[A-Z]+-\d+$/.test(r.id)) problems.push(`${where}: id looks like AWS-0104.`);
    if (seen.has(r?.id)) problems.push(`${where}: listed twice.`);
    seen.add(r?.id);
    if (r?.action !== 'accept' && r?.action !== 'todo') problems.push(`${where}: action is accept or todo.`);
    if (typeof r?.reason !== 'string' || r.reason.trim().length < 30) problems.push(`${where}: give a reason of at least 30 characters.`);
    if (r?.action === 'todo' && !(Number.isInteger(r.max) && (r.max as number) > 0)) problems.push(`${where}: a todo needs max, the number of findings there are today.`);
    if (r?.action === 'accept' && r.max !== undefined) problems.push(`${where}: an accepted rule has no max.`);
  }
  return problems;
}

export interface RuleTally { id: string; title: string; severity: Severity; pillar: WaPillarId; count: number; cases: string[]; decision: PolicyRule | null }
export interface ScanResult {
  findings: Finding[];
  /** One entry per rule that fired, worst first. */
  rules: RuleTally[];
  /** Findings that fail the scan, and why. */
  failures: Array<{ id: string; title: string; severity: Severity; why: string; cases: string[] }>;
  /** Policy entries for rules that no longer fire: remove them. */
  stale: string[];
  bySeverity: Record<Severity, number>;
  byPillar: Record<string, number>;
  passed: boolean;
}

export function evaluate(findings: Finding[], policy: Policy): ScanResult {
  const byRule = new Map<string, Finding[]>();
  for (const f of findings) byRule.set(f.id, [...(byRule.get(f.id) ?? []), f]);
  const decisions = new Map(policy.rules.map((r) => [r.id, r]));
  const rules: RuleTally[] = [...byRule.entries()].map(([id, fs]) => ({
    id, title: fs[0]!.title, severity: fs[0]!.severity, pillar: fs[0]!.pillar, count: fs.length, cases: [...new Set(fs.map((f) => f.caseName))].sort(), decision: decisions.get(id) ?? null,
  })).sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.count - a.count || a.id.localeCompare(b.id));

  const failures: ScanResult['failures'] = [];
  for (const r of rules) {
    if (r.decision?.action === 'todo' && r.count > (r.decision.max ?? 0)) failures.push({ id: r.id, title: r.title, severity: r.severity, why: `${r.count} findings, more than the ${r.decision.max} the policy allows: something new made this worse`, cases: r.cases });
    else if (!r.decision && atLeast(r.severity, policy.failOn)) failures.push({ id: r.id, title: r.title, severity: r.severity, why: `${r.count} new ${r.severity} finding${r.count === 1 ? '' : 's'} with no decision in the policy: fix it, or add a reasoned entry`, cases: r.cases });
  }
  const stale = policy.rules.filter((p) => !byRule.has(p.id)).map((p) => p.id).sort();
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length])) as Record<Severity, number>;
  const byPillar: Record<string, number> = {};
  for (const f of findings) byPillar[f.pillar] = (byPillar[f.pillar] ?? 0) + 1;
  return { findings, rules, failures, stale, bySeverity, byPillar, passed: failures.length === 0 && stale.length === 0 };
}


/** The report: what was found, what the policy decided, and what fails. Markdown, so it reads in a terminal and in a CI summary. */
export function report(r: ScanResult, meta: { cases: number; trivy: string; failOn: Severity }): string {
  const lines: string[] = [];
  lines.push(`# Scan of the generated files`, '', `${meta.cases} generated cases scanned with Trivy ${meta.trivy}. The scan fails on ${meta.failOn} and above when the policy has no decision for the rule.`, '');
  lines.push(`Findings: ${SEVERITIES.filter((s) => s !== 'UNKNOWN').map((s) => `${r.bySeverity[s]} ${s.toLowerCase()}`).join(', ')}.`);
  lines.push(`By Well-Architected pillar: ${Object.entries(r.byPillar).sort().map(([p, n]) => `${p.replace('_', ' ')} ${n}`).join(', ') || 'none'}.`, '');
  lines.push(`| Rule | Severity | Pillar | Count | Cases | Decision |`, `| --- | --- | --- | ---: | ---: | --- |`);
  for (const x of r.rules) {
    const d = x.decision ? (x.decision.action === 'accept' ? 'accepted' : `known gap (up to ${x.decision.max})`) : atLeast(x.severity, 'HIGH') ? '**no decision**' : 'counted';
    lines.push(`| ${x.id} ${short(x.title)} | ${x.severity} | ${x.pillar.replace('_', ' ')} | ${x.count} | ${x.cases.length} | ${d} |`);
  }
  lines.push('');
  if (r.failures.length > 0) {
    lines.push('## Fails', '');
    for (const f of r.failures) lines.push(`- ${f.id} (${f.severity}) ${f.title}: ${f.why}. In: ${f.cases.slice(0, 8).join(', ')}${f.cases.length > 8 ? ` and ${f.cases.length - 8} more` : ''}.`);
    lines.push('');
  }
  if (r.stale.length > 0) lines.push('## Remove from the policy (they no longer match anything)', '', ...r.stale.map((s) => `- ${s}`), '');
  lines.push(r.passed ? '**The scan passes.**' : '**The scan fails.**');
  return lines.join('\n');
}

