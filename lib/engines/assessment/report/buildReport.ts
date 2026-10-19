/**
 * Structured assessment report model.
 *
 * Built ONLY from an immutable assessment snapshot (architecture revision +
 * evaluations), never from live UI state, so every renderer (PDF, HTML, JSON)
 * shows identical content and a report regenerated from the same scan ID
 * does not change when the architecture changes later.
 */
import type { AiCommentary, AiWaCommentary } from '@/lib/ai/reportCommentary';
import { getResourceDefinition } from '@/lib/resources';
import { EVIDENCE_AVAILABILITY, EVIDENCE_CLASS_LABEL } from '../evidenceAvailability';
import { RULES_BY_ID } from '../rules';
import { REFERENCES } from '../references';
import { SCORE_METHODOLOGY, LOW_COVERAGE_THRESHOLD, coverageOf } from '../scoring';
import { SOC1_DISCLAIMER, SOC1_ORGANIZATIONAL_CONTROLS } from '../soc1';
import type {
  AssessmentResult, Evaluation, Finding, PillarResult, ScoreResult, Severity, SourceReference, Soc1AreaResult, AssessmentProvider,
} from '../types';
import { SEVERITY_ORDER } from '../types';
import type { CanvasEdge, CanvasNode } from '@/types';

export const REPORT_FORMAT_VERSION = '1.0';

export interface ReportSnapshotInput {
  scanId: string;
  createdAt: string;
  createdBy: string;
  project: { id: string; name: string; environment: string; region?: string };
  architecture: { architectureId: string; revision: number; graphHash: string; contentSha256: string; nodes: CanvasNode[]; edges: CanvasEdge[] };
  assessment: AssessmentResult;
}

export interface ComparisonSummary {
  previousScanId: string;
  previousCreatedAt: string;
  previousRevision: number;
  newFindings: Finding[];
  resolvedFindings: Finding[];
  unchangedCount: number;
  regressions: Finding[];
  securityScore: { previous: number | null; current: number | null };
  coverage: { previous: number | null; current: number | null };
  rulesetChanged: boolean;
}

export interface AutoFixHistoryEntry { timestamp: string; summary: string; author: string }

export interface InventoryRow {
  resource: string;
  type: string;
  provider: string;
  region: string;
  openFindings: number;
  encryption: string;
  exposure: string;
  identity: string;
  backup: string;
  monitoring: string;
}

export interface RecommendationGroup {
  ruleId: string;
  title: string;
  provider: AssessmentProvider;
  severity: Severity;
  priority: Finding['priority'];
  recommendation: string;
  resources: string[];
  findingIds: string[];
  autoFix: string;
}

export interface AssessmentReport {
  meta: {
    reportId: string;
    title: string;
    projectName: string;
    environment: string;
    providers: string[];
    regions: string[];
    assessmentDate: string;
    generatedAt: string;
    architectureRevision: number;
    graphHash: string;
    contentSha256: string;
    rulesetVersion: string;
    engine: string;
    reportFormatVersion: string;
    scanId: string;
    analysisMode: string;
    preparedFor: string;
  };
  executive: {
    overview: string;
    security: ScoreResult;
    overall: ScoreResult;
    wellArchitected: { provider: string; framework: string; pillars: { label: string; status: string; score: number | null; coverage: number | null; limited: boolean; checks: number }[] }[];
    soc1: { observed: number; gaps: number; partial: number; notEvaluated: number };
    strengths: string[];
    majorRisks: string[];
    immediatePriorities: string[];
    counts: Record<Severity, number>;
  };
  architecture: {
    resourceCount: number;
    resourceSummary: { provider: string; type: string; count: number }[];
    dataFlows: { from: string; to: string; label: string }[];
    nodes: CanvasNode[];
    edges: CanvasEdge[];
  };
  scope: { evaluated: string[]; notEvaluated: string[]; dataSources: string[]; limitations: string[] };
  wellArchitected: { provider: string; framework: string; pillars: (PillarResult & { findings: Finding[] })[] }[];
  security: { counts: Record<Severity, number>; findings: Finding[] };
  soc1: { disclaimer: string; areas: Soc1AreaResult[]; organizationalControls: string[] };
  bestPractices: { required: RecommendationGroup[]; recommended: RecommendationGroup[]; optional: RecommendationGroup[] };
  remediationPlan: { immediate: RecommendationGroup[]; shortTerm: RecommendationGroup[]; longTerm: RecommendationGroup[] };
  autoFix: {
    safe: Finding[];
    reviewRequired: Finding[];
    manual: Finding[];
    history: AutoFixHistoryEntry[];
    resolvedSincePrevious: Finding[];
  };
  inventory: InventoryRow[];
  mapping: { findingId: string; title: string; wellArchitected: string; securityGuidance: string; soc1: string }[];
  comparison?: ComparisonSummary;
  /** Optional AI wording, added by the route after the report is built — never part of scores or the content hash. */
  aiCommentary?: AiCommentary;
  /** Same idea for the Well-Architected report (pillar by pillar). */
  aiWaCommentary?: AiWaCommentary;
  appendix: {
    rules: { id: string; provider: string; service: string; title: string; severity: Severity; version: string; references: string }[];
    references: SourceReference[];
    methodology: string[];
    definitions: { term: string; definition: string }[];
    limitations: string[];
    notEvaluated: { id: string; control: string; resources: string; requiredData: string; availability: string }[];
  };
}

const PROVIDER_LABEL: Record<string, string> = { aws: 'Amazon Web Services (AWS)', azure: 'Microsoft Azure' };

function typeLabel(t: string): string {
  return getResourceDefinition(t)?.label ?? t;
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const c = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFORMATIONAL: 0 } as Record<Severity, number>;
  for (const f of findings) c[f.severity]++;
  return c;
}

function groupRecommendations(findings: Finding[]): RecommendationGroup[] {
  const m = new Map<string, RecommendationGroup>();
  for (const f of findings) {
    const g = m.get(f.ruleId);
    const af = f.autoFix.available ? (f.autoFix.safety === 'SAFE_AUTOFIX' ? 'Safe Auto-Fix available' : 'Auto-Fix available (review required)') : 'Manual remediation';
    if (g) {
      g.resources.push(...f.resourceLabels);
      g.findingIds.push(f.findingId);
      if (SEVERITY_ORDER.indexOf(f.severity) < SEVERITY_ORDER.indexOf(g.severity)) g.severity = f.severity;
    } else {
      m.set(f.ruleId, { ruleId: f.ruleId, title: f.title, provider: f.provider, severity: f.severity, priority: f.priority, recommendation: f.recommendation, resources: [...f.resourceLabels], findingIds: [f.findingId], autoFix: af });
    }
  }
  return [...m.values()].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

function inventoryCell(evals: Evaluation[], categories: string[]): string {
  const rel = evals.filter((e) => categories.includes(RULES_BY_ID.get(e.ruleId)?.category ?? ''));
  if (rel.length === 0) return '—';
  if (rel.some((e) => e.status === 'FAIL')) return 'Gap';
  if (rel.some((e) => e.status === 'WARNING')) return 'Warning';
  if (rel.every((e) => e.status === 'NOT_APPLICABLE')) return '—';
  if (rel.some((e) => e.status === 'PASS') && !rel.some((e) => e.status === 'NOT_EVALUATED' || e.status === 'INSUFFICIENT_DATA')) return 'Pass';
  if (rel.some((e) => e.status === 'PASS')) return 'Partial';
  return 'Not evaluated';
}

export function buildReport(snap: ReportSnapshotInput, opts: { comparison?: ComparisonSummary; autoFixHistory?: AutoFixHistoryEntry[]; generatedAt?: string } = {}): AssessmentReport {
  const a = snap.assessment;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const openFindings = a.findings;
  const securityFindings = openFindings.filter((f) => f.domain === 'SECURITY');
  const nodes = snap.architecture.nodes.filter((n) => !['aws_cloud_boundary', 'azure_cloud_boundary'].includes(n.resourceType));
  const labelOf = new Map(nodes.map((n) => [n.id, n.label]));

  // ── Executive summary ──
  const counts = countBySeverity(openFindings);
  const critHigh = openFindings.filter((f) => (f.severity === 'CRITICAL' || f.severity === 'HIGH') && f.status === 'FAIL');
  const majorRisks = groupRecommendations(critHigh).slice(0, 6).map((g) => `${g.title} (${g.ruleId}; ${g.resources.slice(0, 3).join(', ')}${g.resources.length > 3 ? ` and ${g.resources.length - 3} more` : ''}).`);
  const strengths = Array.from(new Set(a.evaluations
    .filter((e) => e.status === 'PASS' && RULES_BY_ID.get(e.ruleId)?.domain === 'SECURITY' && ['CRITICAL', 'HIGH'].includes(e.severity))
    .map((e) => `${RULES_BY_ID.get(e.ruleId)!.service}${e.resourceLabels[0] ? ` (${e.resourceLabels[0]})` : ''}: ${e.observation.replace(/\.$/, '')} (${e.provenance === 'DESIGN_TIME' ? 'design-time configuration' : e.provenance === 'LIVE_VERIFIED' ? 'live-verified' : 'discovered configuration'}).`))).slice(0, 6);
  const immediatePriorities = groupRecommendations(openFindings.filter((f) => f.priority === 'REQUIRED_REMEDIATION' && (f.severity === 'CRITICAL' || f.severity === 'HIGH')))
    .slice(0, 5).map((g) => `${g.recommendation} [${g.ruleId}]`);
  const providersLabel = a.providers.map((p) => PROVIDER_LABEL[p] ?? p).join(' and ') || 'no cloud provider';
  const sec = a.securityScore;
  const discoveredChecks = a.evaluations.filter((e) => e.provenance === 'DISCOVERED_CONFIGURATION' || e.provenance === 'LIVE_VERIFIED').length;
  const overview =
    `Based on the architecture configuration available to CloudBuilder${discoveredChecks > 0 ? ' (design-time configuration, plus configuration discovered from the cloud provider for some resources)' : ' (design-time configuration only; no live cloud evidence)'}, ` +
    `this assessment evaluated ${a.resourceCount} resource${a.resourceCount === 1 ? '' : 's'} on ${providersLabel}` +
    `${a.regions.length ? ` in ${a.regions.join(', ')}` : ''} (architecture revision ${snap.architecture.revision}). ` +
    `${sec.coverage.evaluated} applicable security check${sec.coverage.evaluated === 1 ? ' was' : 's were'} evaluated; ` +
    `${sec.coverage.notEvaluated + sec.coverage.insufficientData} could not be evaluated from the available architecture data (security assessment coverage ${sec.coverage.coveragePct ?? 0}%). ` +
    `${counts.CRITICAL} critical, ${counts.HIGH} high, ${counts.MEDIUM} medium and ${counts.LOW} low severity findings are open across security and Well-Architected checks.` +
    (sec.lowCoverage ? ` Coverage is below ${LOW_COVERAGE_THRESHOLD}%, so the score describes only part of the architecture and is rated "Limited evidence" rather than as a strong posture.` : '') +
    ' A passed check means the evaluated configuration met that check; it does not provide assurance about the security of the deployed environment.';

  const waSummary = a.providers.map((p) => ({
    provider: PROVIDER_LABEL[p] ?? p,
    framework: p === 'aws' ? 'AWS Well-Architected Framework' : 'Azure Well-Architected Framework',
    pillars: a.pillarResults.filter((r) => r.provider === p).map((r) => ({ label: r.label, status: r.status, score: r.score.score, coverage: r.score.coverage.coveragePct, limited: r.limitedEvidence, checks: r.evaluatedRules })),
  }));

  // ── Architecture ──
  const summary = new Map<string, { provider: string; type: string; count: number }>();
  for (const n of nodes) {
    const key = `${n.provider}:${n.resourceType}`;
    const e = summary.get(key) ?? { provider: (n.provider === 'azure' ? 'Azure' : 'AWS'), type: typeLabel(n.resourceType), count: 0 };
    e.count++; summary.set(key, e);
  }
  const dataFlows = snap.architecture.edges
    .filter((e) => labelOf.has(e.source) && labelOf.has(e.target))
    .map((e) => ({ from: labelOf.get(e.source)!, to: labelOf.get(e.target)!, label: [e.label, e.protocol, e.port].filter(Boolean).join(' · ') || 'Connection' }));

  // ── Scope ──
  const notEval = a.evaluations.filter((e) => e.status === 'NOT_EVALUATED' || e.status === 'INSUFFICIENT_DATA');
  const evaluatedServices = Array.from(new Set(a.evaluations.filter((e) => ['PASS', 'FAIL', 'WARNING'].includes(e.status)).map((e) => RULES_BY_ID.get(e.ruleId)!.service))).sort();
  const scope = {
    evaluated: [
      `Resource configuration of ${a.resourceCount} resources as modelled in CloudBuilder (revision ${snap.architecture.revision})${discoveredChecks > 0 ? ', including configuration discovered from the cloud provider where recorded' : ''}.`,
      `Relationships and topology in the architecture diagram (${snap.architecture.edges.length} connections).`,
      `Services with evaluated checks: ${evaluatedServices.join(', ') || 'none'}.`,
      `Provider-native rules: ${a.providers.map((p) => p.toUpperCase()).join(', ')} (ruleset ${a.rulesetVersion}).`,
    ],
    notEvaluated: Array.from(new Set(notEval.map((e) => RULES_BY_ID.get(e.ruleId)!.title))).slice(0, 40),
    dataSources: [
      'CloudBuilder canonical architecture graph (resource configuration, containment and connections).',
      (() => {
        const evaluated = a.evaluations.filter((e) => e.status !== 'NOT_APPLICABLE');
        const n = (p: string) => evaluated.filter((e) => e.provenance === p).length;
        const live = n('LIVE_VERIFIED'); const disc = n('DISCOVERED_CONFIGURATION'); const design = n('DESIGN_TIME');
        if (live === 0 && disc === 0) return `Evidence provenance: all ${design} applicable checks used design-time configuration authored in CloudBuilder. No value was read from, or verified against, a live cloud account.`;
        return `Evidence provenance: ${design} applicable checks used design-time configuration, ${disc} used only configuration returned by AWS/Azure discovery (point-in-time, as of the discovery run)`
          + `, and ${live} used values confirmed by a provider API read made for this assessment (live verified).`;
      })(),
      'Official guidance metadata: AWS Security Hub (FSBP) controls, AWS Well-Architected, Microsoft cloud security benchmark and Azure Policy definitions, Azure Well-Architected, HashiCorp provider documentation.',
    ],
    limitations: [
      'This is a DESIGN-TIME assessment of the architecture as modelled. It does not observe the deployed environment unless resources were imported, and imported configuration is point-in-time.',
      'Account-, subscription- and tenant-level controls (e.g. CloudTrail, GuardDuty, Defender for Cloud, MFA) are reported as NOT EVALUATED unless evidence is available.',
      'Absence of a finding for a control means only that the modelled configuration passed that check; it is not an assurance that the control is effective.',
      'Severity reflects design-time exposure and official guidance; data sensitivity is not known unless modelled.',
      'CloudBuilder is not an auditor. Nothing in this report is an audit opinion, attestation, certification or compliance determination.',
    ],
  };

  // ── Well-Architected ──
  const wellArchitected = a.providers.map((p) => ({
    provider: PROVIDER_LABEL[p] ?? p,
    framework: p === 'aws' ? 'AWS Well-Architected Framework' : 'Azure Well-Architected Framework',
    pillars: a.pillarResults.filter((r) => r.provider === p).map((r) => ({ ...r, findings: openFindings.filter((f) => r.findingIds.includes(f.findingId)) })),
  }));

  // ── SOC 1 ──
  const soc1 = { disclaimer: SOC1_DISCLAIMER, areas: a.soc1, organizationalControls: SOC1_ORGANIZATIONAL_CONTROLS };

  // ── Best practices & plan ──
  const required = groupRecommendations(openFindings.filter((f) => f.priority === 'REQUIRED_REMEDIATION'));
  const recommended = groupRecommendations(openFindings.filter((f) => f.priority === 'RECOMMENDED_IMPROVEMENT'));
  const optional = groupRecommendations(openFindings.filter((f) => f.priority === 'OPTIONAL_OPTIMIZATION'));
  const all = groupRecommendations(openFindings);
  const remediationPlan = {
    immediate: all.filter((g) => g.severity === 'CRITICAL' || (g.severity === 'HIGH' && g.priority === 'REQUIRED_REMEDIATION')),
    shortTerm: all.filter((g) => (g.severity === 'HIGH' && g.priority !== 'REQUIRED_REMEDIATION') || g.severity === 'MEDIUM'),
    longTerm: all.filter((g) => g.severity === 'LOW' || g.severity === 'INFORMATIONAL'),
  };

  // ── Auto-Fix ──
  const autoFix = {
    safe: openFindings.filter((f) => f.autoFix.available && f.autoFix.safety === 'SAFE_AUTOFIX'),
    reviewRequired: openFindings.filter((f) => f.autoFix.available && f.autoFix.safety === 'REVIEW_REQUIRED'),
    manual: openFindings.filter((f) => !f.autoFix.available),
    history: opts.autoFixHistory ?? [],
    resolvedSincePrevious: opts.comparison?.resolvedFindings ?? [],
  };

  // ── Inventory ──
  const evalsByResource = new Map<string, Evaluation[]>();
  for (const e of a.evaluations) for (const id of e.resourceIds) evalsByResource.set(id, [...(evalsByResource.get(id) ?? []), e]);
  const inventory: InventoryRow[] = nodes
    .filter((n) => !['aws_internet', 'aws_unsupported', 'aws_unknown', 'azure_unsupported', 'azure_unknown'].includes(n.resourceType))
    .map((n) => {
      const evs = evalsByResource.get(n.id) ?? [];
      return {
        resource: n.label,
        type: typeLabel(n.resourceType),
        provider: n.provider === 'azure' ? 'Azure' : 'AWS',
        region: (n.region as string) || (typeof n.config?.region === 'string' ? n.config.region : '') || '—',
        openFindings: evs.filter((e) => e.status === 'FAIL' || e.status === 'WARNING').length,
        encryption: inventoryCell(evs, ['Encryption at rest', 'Encryption in transit', 'Key management']),
        exposure: inventoryCell(evs, ['Network exposure', 'Edge protection']),
        identity: inventoryCell(evs, ['Identity & access']),
        backup: inventoryCell(evs, ['Data protection']),
        monitoring: inventoryCell(evs, ['Logging & audit', 'Monitoring', 'Threat detection']),
      };
    });

  // ── Mapping ──
  const mapping = openFindings.map((f) => ({
    findingId: f.findingId,
    title: f.title,
    wellArchitected: `${f.provider === 'aws' ? 'AWS' : 'Azure'} WAF — ${a.pillarResults.find((p) => p.provider === f.provider && p.pillar === f.pillar)?.label ?? f.pillar}${f.practice ? ` (${f.practice})` : ''}`,
    securityGuidance: f.references.filter((r) => r.identifier && !r.key.startsWith('TF-') && !r.key.startsWith('AICPA')).map((r) => r.key.startsWith('AZPOLICY') ? `Azure Policy ${r.identifier}` : `${r.framework.includes('Security Hub') ? 'Security Hub' : 'MCSB'} ${r.identifier}`).join('; ') || '—',
    soc1: f.soc1Areas.join(', ') || '—',
  }));

  // ── Appendix ──
  const usedRuleIds = Array.from(new Set(a.evaluations.map((e) => e.ruleId)));
  const rules = usedRuleIds.map((id) => RULES_BY_ID.get(id)!).map((r) => ({
    id: r.id, provider: r.provider.toUpperCase(), service: r.service, title: r.title, severity: r.severity, version: r.version,
    references: r.references.map((k) => REFERENCES[k]).filter(Boolean).filter((x) => x.identifier).map((x) => x.identifier!).join(', ') || 'Well-Architected guidance',
  }));
  const refKeys = Array.from(new Set(usedRuleIds.flatMap((id) => RULES_BY_ID.get(id)!.references).concat(['AICPA-SOC1'])));
  const references = refKeys.map((k) => REFERENCES[k]).filter(Boolean);
  const cov = coverageOf(a.evaluations);

  return {
    meta: {
      reportId: `CC-${snap.scanId.slice(0, 8).toUpperCase()}`,
      title: 'CloudBuilder Architecture & Security Assessment',
      projectName: snap.project.name,
      environment: snap.project.environment,
      providers: a.providers.map((p) => PROVIDER_LABEL[p] ?? p),
      regions: a.regions.length ? a.regions : (snap.project.region ? [`${snap.project.region} (project default region)`] : []),
      assessmentDate: snap.createdAt,
      generatedAt,
      architectureRevision: snap.architecture.revision,
      graphHash: snap.architecture.graphHash,
      contentSha256: snap.architecture.contentSha256,
      rulesetVersion: a.rulesetVersion,
      engine: a.engine,
      reportFormatVersion: REPORT_FORMAT_VERSION,
      scanId: snap.scanId,
      analysisMode: a.analysisMode === 'DESIGN_TIME' ? 'Design-time analysis'
        : a.analysisMode === 'INCLUDES_LIVE_VERIFIED_EVIDENCE' ? 'Design-time analysis with discovered and live-verified configuration'
          : 'Design-time analysis with discovered configuration',
      preparedFor: snap.project.name,
    },
    executive: {
      overview,
      security: a.securityScore,
      overall: a.overallScore,
      wellArchitected: waSummary,
      soc1: {
        observed: a.soc1.filter((s) => s.status === 'Technical evidence observed').length,
        gaps: a.soc1.filter((s) => s.status === 'Gaps identified').length,
        partial: a.soc1.filter((s) => s.status === 'Partially evaluated').length,
        notEvaluated: a.soc1.filter((s) => s.status === 'Not evaluated').length,
      },
      strengths,
      majorRisks,
      immediatePriorities,
      counts,
    },
    architecture: { resourceCount: a.resourceCount, resourceSummary: [...summary.values()].sort((x, y) => y.count - x.count), dataFlows, nodes: snap.architecture.nodes, edges: snap.architecture.edges },
    scope,
    wellArchitected,
    security: { counts: countBySeverity(securityFindings), findings: securityFindings },
    soc1,
    bestPractices: { required, recommended, optional },
    remediationPlan,
    autoFix,
    inventory,
    mapping,
    comparison: opts.comparison,
    appendix: {
      rules,
      references,
      methodology: [
        `Security score: ${SCORE_METHODOLOGY}`,
        'Well-Architected pillar scores use the same formula restricted to the checks mapped to that pillar; a pillar with no evaluable checks is reported as "Insufficient evidence" rather than scored.',
        `Assessment coverage (all checks): ${cov.evaluated} of ${cov.applicable} applicable checks evaluated (${cov.coveragePct ?? 0}%); ${cov.notApplicable} checks were not applicable to the resources present.`,
        'Each finding has a stable ID of the form <RULE-ID>-<resource hash> that is identical in the CloudBuilder UI, Auto-Fix, this report and later assessments of the same resource.',
        'Auto-Fix safety: safe fixes are deterministic, non-destructive configuration changes; fixes that need review may affect connectivity or cost, or require resource replacement, and are applied only after explicit confirmation; manual-only findings require human design decisions. Every applied fix is verified by re-running the rule and regenerating Terraform; failed verification leaves the architecture unchanged.',
      ],
      definitions: [
        { term: 'PASS', definition: 'The modelled configuration satisfies the check.' },
        { term: 'FAIL', definition: 'The modelled configuration violates the check; a finding is raised.' },
        { term: 'WARNING', definition: 'A weaker signal or best-practice gap; counts as half a failure in scoring.' },
        { term: 'NOT APPLICABLE', definition: 'The check does not apply to this resource configuration.' },
        { term: 'NOT EVALUATED', definition: 'The control cannot be observed from an architecture design (e.g. account-level settings). Never treated as a pass.' },
        { term: 'INSUFFICIENT DATA', definition: 'The check applies but required configuration values are missing. Never treated as a pass.' },
        { term: 'ACCEPTED RISK / FALSE POSITIVE', definition: 'A human review decision recorded against a finding. The finding remains technically failing and still counts against the score.' },
        { term: 'DESIGN-TIME', definition: 'Evidence comes from the architecture as designed in CloudBuilder, not from the deployed environment.' },
        { term: 'DISCOVERED CONFIGURATION', definition: 'Every value the check used was returned by AWS/Azure discovery (recorded per field). Point-in-time: it describes the resource when discovery ran.' },
        { term: 'LIVE VERIFIED', definition: 'Every value the check used was confirmed by a provider API read made for this assessment (at most 15 minutes old) and matched the assessed configuration. Not claimed unless that evidence exists.' },
        { term: 'INSUFFICIENT DATA', definition: 'A value the check needs was not specified in the design or not returned by discovery. Never counted as passing.' },
      ],
      limitations: scope.limitations,
      notEvaluated: notEval.map((e) => ({
        id: e.findingId,
        control: RULES_BY_ID.get(e.ruleId)!.title,
        resources: e.resourceLabels.join(', ') || (e.resourceIds.length === 0 ? 'Account / subscription' : '—'),
        requiredData: e.requiredData ?? e.observation,
        availability: e.status === 'NOT_EVALUATED'
          ? (() => { const a = EVIDENCE_AVAILABILITY[e.ruleId]; return a ? `${a.classes.map((c) => EVIDENCE_CLASS_LABEL[c]).join(' + ')}. ${a.explanation} Evidence: ${a.evidenceSource}` : 'Not evaluated.'; })()
          : 'Insufficient data: the value can be set in the design or imported by discovery.',
      })),
    },
  };
}
