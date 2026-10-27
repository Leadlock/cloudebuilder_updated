/**
 * The readiness report as data. One structure feeds the Word report (SOC 2) and the PDF control reports (AWS and Azure), so they never disagree.
 * Nothing in it is invented: every statement comes from a control's result, a person's record, an attached piece of evidence or the architecture.
 */
import { createHash } from 'crypto';
import type { Evaluation } from '@/lib/engines/assessment/types';
import { RULESET_VERSION } from '@/lib/engines/assessment/types';
import { deriveFindings, deriveLimitations, evaluateControls, readinessOf, summarize, type ControlDef, type Summary } from './model';
import { defsFor, FRAMEWORK_LABEL } from './frameworks';
import type { PlatformFacts } from './signals';
import type { ControlRecord, ControlResult, EvidenceRef, Finding, FindingRecord, FrameworkId, Limitation, Readiness, Signoff } from './types';
import type { ConfigRow } from './configuration';
import { emptyTeam, type TeamRecords } from './entries';
import type { PeriodAnalysis } from './snapshots';
import type { Soc2Category } from './soc2/criteria';
import { SOC2_CATEGORY_LABEL } from './soc2/criteria';

export interface SystemFacts {
  name: string;
  description: string;
  environment: string;
  providers: Array<'aws' | 'azure'>;
  regions: string[];
  /** The kinds of cloud service in the design, by count: "Database x3". */
  services: string[];
  /** Third-party services drawn in the design, with the vendor's name and what it is used for. */
  thirdParties: Array<{ vendor: string; use: string; dataHeld: string }>;
}

export interface ReportInput {
  framework: FrameworkId;
  company: string;
  system: SystemFacts;
  asOf: Date;
  generatedAt: Date;
  version: number;
  categories?: Soc2Category[];
  /** Why a category is out of scope (SOC 2). */
  exclusions?: Partial<Record<Soc2Category, string>>;
  records: Record<string, ControlRecord>;
  evidence: Array<EvidenceRef & { controls: string[] }>;
  evaluations: readonly Evaluation[];
  facts?: PlatformFacts;
  findingRecords?: Record<string, FindingRecord>;
  signoffs?: Signoff[];
  /** True when the cloud account was read (an account check has run). */
  accountRead: boolean;
  preparedBy: string;
  history?: Array<{ version: string; date: string; by: string; change: string }>;
  /** What the snapshots over the period show (SOC 2 Type 2 preparation). */
  period?: PeriodAnalysis;
  /** The settings of every resource the assessment examined (the configuration appendix). */
  configuration?: ConfigRow[];
  /** What the team recorded beyond control answers (changes, walkthroughs, complementary controls, provider reviews ...). */
  team?: TeamRecords;
  /** Versions of the architecture up to the assessment date, offered as a starting point for the significant-changes log. */
  architectureHistory?: ArchitectureChange[];
}

export interface ArchitectureChange { date: string; label: string; summary: string; author: string }

export interface EvidenceIndexRow extends EvidenceRef { ref: string; controls: string[] }

export interface CpaCheck { label: string; done: boolean; detail: string }

export interface ReadinessReport {
  framework: FrameworkId;
  title: string;
  company: string;
  system: SystemFacts;
  asOf: string;
  generatedAt: string;
  version: string;
  reportId: string;
  rulesetVersion: string;
  categories: Soc2Category[];
  exclusions: Array<{ category: string; reason: string }>;
  defs: ControlDef[];
  results: ControlResult[];
  summary: Summary;
  findings: Finding[];
  limitations: Limitation[];
  readiness: Readiness;
  signoffs: Signoff[];
  evidenceIndex: EvidenceIndexRow[];
  accountRead: boolean;
  preparedBy: string;
  history: Array<{ version: string; date: string; by: string; change: string }>;
  cpaChecks: CpaCheck[];
  period?: PeriodAnalysis;
  configuration: ConfigRow[];
  team: TeamRecords;
  architectureHistory: ArchitectureChange[];
}

const ALL: Soc2Category[] = ['security', 'availability', 'confidentiality'];

export function buildReadinessReport(i: ReportInput): ReadinessReport {
  const categories = i.framework === 'soc2' ? (i.categories?.length ? i.categories : ALL) : [];
  const defs = defsFor(i.framework, categories.length ? categories : undefined);
  const ids = new Set(defs.map((d) => d.id));
  // Evidence that belongs to a control outside the scope is not shown.
  const byControl: Record<string, EvidenceRef[]> = {};
  const index: EvidenceIndexRow[] = [];
  const sorted = [...i.evidence].filter((e) => e.controls.some((c) => ids.has(c))).sort((a, b) => a.collectedAt.localeCompare(b.collectedAt) || a.title.localeCompare(b.title));
  sorted.forEach((e, n) => {
    const ref = `EV-${String(n + 1).padStart(3, '0')}`;
    const controls = e.controls.filter((c) => ids.has(c)).sort();
    index.push({ ...e, ref, controls });
    for (const c of controls) (byControl[c] ??= []).push({ ...e, id: ref });
  });
  const results = evaluateControls(defs, { records: i.records, evidence: byControl, evaluations: i.evaluations, facts: i.facts, findingRecords: i.findingRecords, asOf: i.asOf });
  const summary = summarize(results);
  const findings = deriveFindings(defs, results, i.findingRecords);
  const limitations = deriveLimitations(results, { cloudAccountRead: i.accountRead });
  const readiness = readinessOf(summary, findings);
  const signoffs = (i.signoffs ?? []).filter((s) => ['preparer', 'reviewer', 'management'].includes(s.role));
  const exclusions = (Object.entries(i.exclusions ?? {}) as Array<[Soc2Category, string]>).filter(([c]) => !categories.includes(c)).map(([c, reason]) => ({ category: SOC2_CATEGORY_LABEL[c], reason }));

  const core = { f: i.framework, v: i.version, asOf: i.asOf.toISOString().slice(0, 10), r: results.map((r) => [r.id, r.score, r.confidence, r.evidence.map((e) => e.id)]), fi: findings.map((f) => [f.id, f.status]), ev: index.map((e) => [e.ref, e.sha256 ?? e.title]), tm: JSON.stringify(i.team ?? null), cf: (i.configuration ?? []).map((c) => [c.resourceId, c.setting, c.observed, c.result, c.source]) };
  const reportId = `${i.framework === 'soc2' ? 'S2' : i.framework === 'aws-waf' ? 'AW' : 'AZ'}-${createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 10).toUpperCase()}`;

  const report: ReadinessReport = {
    framework: i.framework, title: `${FRAMEWORK_LABEL[i.framework]}${i.framework === 'soc2' ? ' report' : ' control report'}`, company: i.company, system: i.system,
    asOf: i.asOf.toISOString().slice(0, 10), generatedAt: i.generatedAt.toISOString(), version: `v${i.version}`, reportId, rulesetVersion: RULESET_VERSION,
    categories, exclusions, defs, results, summary, findings, limitations, readiness, signoffs, evidenceIndex: index, accountRead: i.accountRead, preparedBy: i.preparedBy,
    history: i.history ?? [{ version: `v${i.version}`, date: i.generatedAt.toISOString().slice(0, 10), by: i.preparedBy, change: i.version === 1 ? 'First version' : 'Regenerated' }],
    cpaChecks: [],
    ...(i.period ? { period: i.period } : {}),
    configuration: i.configuration ?? [],
    team: i.team ?? emptyTeam(),
    architectureHistory: i.architectureHistory ?? [],
  };
  report.cpaChecks = cpaChecks(report);
  return report;
}

/** What the CPA firm will want before it starts, as a checklist the report ticks itself where it can. */
export function cpaChecks(r: ReadinessReport): CpaCheck[] {
  const open = r.findings.filter((f) => f.status === 'open' || f.status === 'in_progress');
  const noOwner = r.results.filter((x) => x.score !== null && !x.owner.trim());
  const undated = r.results.filter((x) => x.score !== null && x.score >= 2 && x.evidence.length === 0 && !x.signals.some((s) => s.result === 'pass' && s.basis !== 'answer'));
  const signed = (role: Signoff['role']) => r.signoffs.some((s) => s.role === role);
  const yes = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    { label: 'Every control in scope has been assessed', done: r.summary.notAssessed === 0, detail: r.summary.notAssessed === 0 ? `All ${r.summary.total - r.summary.notApplicable} controls in scope have a score.` : `${yes(r.summary.notAssessed, 'control has', 'controls have')} not been assessed.` },
    { label: 'Every assessed control has a named owner', done: noOwner.length === 0, detail: noOwner.length === 0 ? 'Every assessed control has an owner.' : `${yes(noOwner.length, 'control has', 'controls have')} no owner.` },
    { label: 'Every control has evidence or a check behind it', done: undated.length === 0, detail: undated.length === 0 ? 'Nothing rests on a statement alone.' : `${yes(undated.length, 'control rests', 'controls rest')} on a statement alone.` },
    { label: 'No control is missing', done: r.summary.byScore[0] === 0, detail: r.summary.byScore[0] === 0 ? 'No control scores 0.' : `${yes(r.summary.byScore[0], 'control scores', 'controls score')} 0 (missing).` },
    { label: 'Findings are closed or accepted by management', done: open.length === 0, detail: open.length === 0 ? 'No finding is open.' : `${yes(open.length, 'finding is', 'findings are')} still open.` },
    { label: 'The cloud account was read, not only the design', done: r.accountRead, detail: r.accountRead ? 'An account check has run.' : 'Only the architecture design was checked.' },
    { label: 'Prepared by', done: signed('preparer'), detail: signed('preparer') ? 'Signed.' : 'Not signed.' },
    { label: 'Reviewed by someone independent of the controls', done: signed('reviewer'), detail: signed('reviewer') ? 'Signed.' : 'Not signed.' },
    { label: 'Acknowledged by management', done: signed('management'), detail: signed('management') ? 'Signed.' : 'Not signed.' },
  ];
}

/** Words that would claim an assurance the company does not have. Reports are checked against this before they leave. */
export const FORBIDDEN_CLAIMS = /\b(soc ?2[- ]compliant|certified|attested|cpa[- ]approved|passed (the )?soc ?2)\b/i;
