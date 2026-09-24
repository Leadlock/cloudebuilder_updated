/**
 * WellArchitectedRuleEngine
 *
 * Presents the unified assessment engine's evaluations
 * (lib/engines/assessment) through the provider-specific Well-Architected
 * lens: six AWS pillars, five Azure pillars. It no longer owns a separate rule
 * set — the former awsWaRules/azureWaRules duplicated security checks with
 * different config keys and contained incorrect rules (e.g. flagging every RDS
 * instance for "on-demand pricing" with no evidence, recommending NAT gateway
 * consolidation that conflicts with Multi-AZ resilience, and Azure rules that
 * looked for resource types that do not exist in CloudCraft).
 *
 * Scores are coverage-aware: a pillar with no evaluable checks reports
 * `scored: false` ("Insufficient evidence") instead of a default 100.
 */
import type {
  WaFinding, WaAssessment, WaPillarScore, WaAnalysisInput, WaSeverity, WaPillar, WaProvider,
} from './types';
import { getFramework } from './frameworkDefinitions';
import type { CanvasNode, CanvasEdge } from '@/types';
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';
import { toCanvas } from '@/lib/domain/canvasMapping';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { scoreOf, SCORE_METHODOLOGY } from '@/lib/engines/assessment/scoring';
import type { AssessmentResult, Finding } from '@/lib/engines/assessment/types';

function toWaSeverity(s: Finding['severity']): WaSeverity {
  return s === 'INFORMATIONAL' ? 'info' : (s.toLowerCase() as WaSeverity);
}

function toWaFinding(f: Finding, importStates: Map<string, string | undefined>): WaFinding {
  const pillarRef = f.references.find((r) => r.key.startsWith('AWS-WA-') || r.key.startsWith('AZ-WA-'))?.url ?? '';
  const frameworkName = f.provider === 'aws' ? 'AWS Well-Architected Framework' : 'Microsoft Azure Well-Architected Framework';
  return {
    id: f.findingId,
    ruleId: f.ruleId,
    provider: f.provider,
    pillar: f.pillar as WaPillar,
    pillarLabel: labelOf(f.provider, f.pillar),
    pillarRef,
    severity: toWaSeverity(f.severity),
    title: f.title,
    description: f.description,
    affectedResourceIds: f.resourceIds,
    affectedResourceLabels: f.resourceLabels,
    evidence: Object.fromEntries(f.evidence.map((e) => [e.label, e.observed])),
    recommendation: f.recommendation,
    remediation: f.manualSteps.join(' '),
    frameworkReference: `${frameworkName} — ${labelOf(f.provider, f.pillar)}${f.practice ? ` (${f.practice})` : ''}`,
    source: 'DESIGN_TIME',
    sourceLabel: f.provenance === 'DISCOVERED_CONFIGURATION' ? 'Design-time assessment (discovered configuration)' : 'Design-time assessment',
    detectedAt: f.evaluatedAt,
    resourceState: (importStates.get(f.resourceIds[0] ?? '') as WaFinding['resourceState']) ?? 'new',
    status: f.status as 'FAIL' | 'WARNING',
    observation: f.observation,
    references: f.references.map((r) => ({ title: r.title, identifier: r.identifier, url: r.url, framework: r.framework })),
    practice: f.practice,
  };
}

function labelOf(provider: WaProvider, pillar: string): string {
  return getFramework(provider).pillars.find((p) => p.id === pillar)?.label ?? pillar;
}

function nodesFrom(input: {
  architectureId: string;
  nodes?: CanvasNode[];
  edges?: CanvasEdge[];
  resources?: DbArchitectureResource[];
  connections?: DbArchitectureConnection[];
}): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  if (input.resources) return toCanvas(input.resources, input.connections ?? []);
  return { nodes: input.nodes ?? [], edges: input.edges ?? [] };
}

export class WellArchitectedRuleEngine {
  private _importStates = new Map<string, string | undefined>();

  analyze(input: {
    architectureId: string;
    projectId?: string;
    provider?: WaProvider | 'multi';
    nodes?: CanvasNode[];
    edges?: CanvasEdge[];
    resources?: DbArchitectureResource[];
    connections?: DbArchitectureConnection[];
  }): WaAssessment {
    const { nodes, edges } = nodesFrom(input);
    this._rememberStates(nodes);
    const assessment = runAssessment({ nodes, edges });
    const projectId = input.projectId ?? 'proj-default';
    const prov = input.provider
      ?? (assessment.providers.length > 1 ? 'multi' : (assessment.providers[0] ?? 'aws'));
    if (prov === 'multi') return this._multi(assessment, input.architectureId, projectId);
    return this._forProvider(assessment, prov, input.architectureId, projectId);
  }

  analyzeAws(input: WaAnalysisInput): WaAssessment {
    const { nodes, edges } = toCanvas(input.resources, input.connections);
    this._rememberStates(nodes);
    return this._forProvider(runAssessment({ nodes, edges }), 'aws', input.architectureId, input.projectId);
  }

  analyzeAzure(input: WaAnalysisInput): WaAssessment {
    const { nodes, edges } = toCanvas(input.resources, input.connections);
    this._rememberStates(nodes);
    return this._forProvider(runAssessment({ nodes, edges }), 'azure', input.architectureId, input.projectId);
  }

  analyzeMultiCloud(input: WaAnalysisInput): WaAssessment {
    const { nodes, edges } = toCanvas(input.resources, input.connections);
    this._rememberStates(nodes);
    return this._multi(runAssessment({ nodes, edges }), input.architectureId, input.projectId);
  }

  private _rememberStates(nodes: CanvasNode[]) {
    this._importStates = new Map(nodes.map((n) => [n.id, n.importState ?? (n.config?.imported ? 'imported' : undefined)]));
  }

  /** Assessment for one provider; empty architectures are reported as not scored. */
  _forProvider(a: AssessmentResult, provider: WaProvider, architectureId: string, projectId: string): WaAssessment {
    const framework = getFramework(provider);
    const evals = a.evaluations.filter((e) => e.provider === provider);
    const findings = a.findings.filter((f) => f.provider === provider).map((f) => toWaFinding(f, this._importStates));
    const overall = scoreOf(evals);
    const pillarScores: WaPillarScore[] = framework.pillars.map((p) => {
      const pr = a.pillarResults.find((x) => x.provider === provider && x.pillar === p.id);
      const pf = findings.filter((f) => f.pillar === p.id);
      return {
        pillar: p.id as WaPillar,
        pillarLabel: p.label,
        provider,
        score: pr?.score.score ?? 0,
        scored: pr ? pr.score.score !== null : false,
        coveragePct: pr?.score.coverage.coveragePct ?? null,
        evaluatedChecks: pr?.score.coverage.evaluated ?? 0,
        notEvaluatedChecks: pr ? pr.score.coverage.notEvaluated + pr.score.coverage.insufficientData : 0,
        status: pr?.status ?? 'Insufficient evidence',
        findingCount: pf.length,
        criticalCount: pf.filter((f) => f.severity === 'critical').length,
        highCount: pf.filter((f) => f.severity === 'high').length,
      };
    });
    const hasResources = evals.length > 0;
    return {
      architectureId,
      projectId,
      provider,
      framework: framework.framework,
      frameworkVersion: framework.frameworkVersion,
      frameworkSource: framework.documentationUrl,
      overallScore: overall.score ?? 0,
      overallScored: overall.score !== null,
      coveragePct: overall.coverage.coveragePct,
      notEvaluatedCount: overall.coverage.notEvaluated + overall.coverage.insufficientData,
      pillarScores,
      findings,
      evaluatedAt: a.evaluatedAt,
      source: 'DESIGN_TIME',
      sourceLabel: hasResources
        ? (a.analysisMode === 'DESIGN_TIME' ? 'Design-time assessment' : a.analysisMode === 'INCLUDES_LIVE_VERIFIED_EVIDENCE' ? 'Design-time assessment (includes live-verified configuration)' : 'Design-time assessment (includes discovered configuration)')
        : 'Design-time assessment (no resources)',
      confidence: 'design-time',
      isStale: false,
      rulesetVersion: a.rulesetVersion,
      scoreMethodology: SCORE_METHODOLOGY,
    };
  }

  _multi(a: AssessmentResult, architectureId: string, projectId: string): WaAssessment {
    const awsAssessment = this._forProvider(a, 'aws', architectureId, projectId);
    const azureAssessment = this._forProvider(a, 'azure', architectureId, projectId);
    const overall = scoreOf(a.evaluations);
    return {
      architectureId,
      projectId,
      provider: 'multi',
      framework: 'AWS + Azure Well-Architected Frameworks',
      frameworkVersion: awsAssessment.frameworkVersion === azureAssessment.frameworkVersion
        ? awsAssessment.frameworkVersion
        : `AWS ${awsAssessment.frameworkVersion} / Azure ${azureAssessment.frameworkVersion}`,
      frameworkSource: 'https://docs.aws.amazon.com/wellarchitected/ | https://learn.microsoft.com/azure/well-architected/',
      overallScore: overall.score ?? 0,
      overallScored: overall.score !== null,
      coveragePct: overall.coverage.coveragePct,
      notEvaluatedCount: overall.coverage.notEvaluated + overall.coverage.insufficientData,
      // Provider-specific pillars are kept separate (AWS 6 + Azure 5), never merged.
      pillarScores: [...awsAssessment.pillarScores, ...azureAssessment.pillarScores],
      findings: [...awsAssessment.findings, ...azureAssessment.findings],
      evaluatedAt: a.evaluatedAt,
      source: 'DESIGN_TIME',
      sourceLabel: 'Design-time assessment (multi-cloud)',
      confidence: 'design-time',
      isStale: false,
      awsAssessment,
      azureAssessment,
      rulesetVersion: a.rulesetVersion,
      scoreMethodology: SCORE_METHODOLOGY,
    };
  }
}

export const wellArchitectedRuleEngine = new WellArchitectedRuleEngine();
