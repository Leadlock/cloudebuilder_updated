/**
 * The dependency audit gate: reads `npm audit --json` and decides what fails the build.
 *
 * Every high or critical advisory fails unless security/audit-policy.json accepts that package WITH A REASON. The list can only shrink on its own: an accepted package
 * that no longer has a high or critical advisory fails too ("remove it from the policy"), so an exception can neither hide a new problem nor outlive the one it explained.
 * Moderate and low advisories are listed, never failing.
 */
export interface AuditPolicy { accepted: Array<{ package: string; reason: string }> }
export interface AuditVulnerability { severity: string; isDirect?: boolean; via?: Array<string | { title?: string; url?: string; severity?: string }>; fixAvailable?: unknown }
export interface AuditJson { vulnerabilities?: Record<string, AuditVulnerability> }

export interface AuditVerdict {
  /** high / critical, not accepted: these fail. */
  failing: Array<{ package: string; severity: string; why: string; direct: boolean }>;
  /** high / critical and accepted (with the reason). */
  accepted: Array<{ package: string; severity: string; reason: string }>;
  /** accepted in the policy but no longer high or critical: these fail until removed. */
  stale: string[];
  /** moderate and low, for the report only. */
  other: Array<{ package: string; severity: string }>;
  ok: boolean;
}

const SERIOUS = new Set(['high', 'critical']);

export function validateAuditPolicy(p: AuditPolicy): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const a of p.accepted ?? []) {
    if (!a.package) problems.push('an entry has no package name');
    if (seen.has(a.package)) problems.push(`${a.package} is listed twice`);
    seen.add(a.package);
    if (!a.reason || a.reason.trim().length < 20) problems.push(`${a.package}: say why it is accepted (at least a sentence)`);
  }
  return problems;
}

const whyOf = (v: AuditVulnerability): string => {
  const first = (v.via ?? []).find((x) => typeof x !== 'string') as { title?: string } | undefined;
  const viaPkg = (v.via ?? []).find((x) => typeof x === 'string') as string | undefined;
  return first?.title ?? (viaPkg ? `through ${viaPkg}` : 'an advisory');
};

export function evaluateAudit(audit: AuditJson, policy: AuditPolicy): AuditVerdict {
  const accepted = new Map((policy.accepted ?? []).map((a) => [a.package, a.reason]));
  const verdict: AuditVerdict = { failing: [], accepted: [], stale: [], other: [], ok: true };
  const serious = new Set<string>();
  for (const [name, v] of Object.entries(audit.vulnerabilities ?? {})) {
    if (!SERIOUS.has(v.severity)) { verdict.other.push({ package: name, severity: v.severity }); continue; }
    serious.add(name);
    const reason = accepted.get(name);
    if (reason) verdict.accepted.push({ package: name, severity: v.severity, reason });
    else verdict.failing.push({ package: name, severity: v.severity, why: whyOf(v), direct: v.isDirect === true });
  }
  verdict.stale = [...accepted.keys()].filter((p) => !serious.has(p)).sort();
  verdict.ok = verdict.failing.length === 0 && verdict.stale.length === 0;
  return verdict;
}

export function auditReport(v: AuditVerdict): string {
  const lines = ['## Dependency audit', ''];
  if (v.failing.length) { lines.push(`**${v.failing.length} high or critical advisor${v.failing.length === 1 ? 'y has' : 'ies have'} no decision in security/audit-policy.json:**`, '', ...v.failing.map((f) => `- ${f.severity.toUpperCase()} ${f.package}${f.direct ? ' (a direct dependency)' : ''}: ${f.why}`), '', 'Upgrade it, or accept it in the policy with a reason.', ''); }
  if (v.stale.length) lines.push(`**Remove from the policy (no longer high or critical):** ${v.stale.join(', ')}`, '');
  if (v.accepted.length) lines.push('Accepted, with a reason:', '', ...v.accepted.map((a) => `- ${a.severity} ${a.package}: ${a.reason}`), '');
  if (v.other.length) lines.push(`${v.other.length} moderate or low advisor${v.other.length === 1 ? 'y' : 'ies'} (not failing): ${v.other.map((o) => o.package).sort().join(', ')}`, '');
  lines.push(v.ok ? '**The audit gate passes.**' : '**The audit gate fails.**');
  return lines.join('\n') + '\n';
}
