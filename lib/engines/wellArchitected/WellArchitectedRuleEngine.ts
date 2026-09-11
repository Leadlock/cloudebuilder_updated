/**
 * WellArchitectedRuleEngine
 *
 * Deterministic rule engine for AWS and Azure WAF analysis.
 * Same inputs → same outputs.
 * No live API calls — all analysis is design-time.
 * Every finding carries full source attribution.
 */
import { createHash } from 'crypto';
import type {
  WaRule, WaFinding, WaAssessment, WaPillarScore, WaAnalysisInput,
  WaSeverity, WaPillar, WaProvider,
} from './types';
import { SEVERITY_WEIGHTS } from './types';
import { awsWaRules } from './rules/awsWaRules';
import { azureWaRules } from './rules/azureWaRules';
import {
  AWS_PILLARS, AZURE_PILLARS, getFramework,
  type PillarDefinition,
} from './frameworkDefinitions';
import type { CanvasNode, CanvasEdge } from '@/types';
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';

// ─── Deterministic Finding ID ─────────────────────────────────────────────────

function findingId(ruleId: string, resourceId: string): string {
  return createHash('sha256')
    .update(`waf:${ruleId}:${resourceId}`)
    .digest('hex')
    .substring(0, 16);
}

// ─── Pillar Score Calculator ──────────────────────────────────────────────────

function scorePillars(
  findings: WaFinding[],
  pillars: PillarDefinition[],
): WaPillarScore[] {
  return pillars.map((p) => {
    const pillarFindings = findings.filter((f) => f.pillar === p.id);
    const criticalCount = pillarFindings.filter((f) => f.severity === 'critical').length;
    const highCount = pillarFindings.filter((f) => f.severity === 'high').length;
    const totalDeduction = pillarFindings.reduce(
      (acc, f) => acc + (SEVERITY_WEIGHTS[f.severity] ?? 0),
      0,
    );
    const score = Math.max(0, Math.round(100 - totalDeduction));
    return {
      pillar: p.id as WaPillar,
      pillarLabel: p.label,
      score,
      findingCount: pillarFindings.length,
      criticalCount,
      highCount,
    };
  });
}

function calculateOverall(pillarScores: WaPillarScore[]): number {
  if (pillarScores.length === 0) return 100;
  const total = pillarScores.reduce((acc, p) => acc + p.score, 0);
  return Math.round(total / pillarScores.length);
}

// ─── Rule Engine ─────────────────────────────────────────────────────────────

export class WellArchitectedRuleEngine {

  analyze(input: {
    architectureId: string;
    projectId?: string;
    provider?: WaProvider | 'multi';
    nodes?: CanvasNode[];
    edges?: CanvasEdge[];
    resources?: DbArchitectureResource[];
    connections?: DbArchitectureConnection[];
  }): WaAssessment {
    const resources: DbArchitectureResource[] = input.resources ?? (input.nodes ?? []).map((n) => ({
      id: n.id,
      architectureId: input.architectureId,
      resourceType: n.resourceType,
      provider: n.provider ?? (n.resourceType.startsWith('azure_') ? 'azure' : 'aws'),
      label: n.label,
      positionX: n.position.x,
      positionY: n.position.y,
      region: (n.config?.region as string) ?? null,
      groupId: n.groupId ?? null,
      locked: false,
      configJson: JSON.stringify({
        ...(n.config ?? {}),
        ...(n.importState ? { importState: n.importState } : {}),
      }),
    }));

    const connections: DbArchitectureConnection[] = input.connections ?? (input.edges ?? []).map((e) => ({
      id: e.id,
      architectureId: input.architectureId,
      sourceId: e.source,
      targetId: e.target,
      edgeType: e.edgeType ?? 'traffic',
      label: e.label ?? null,
    }));

    const fullInput: WaAnalysisInput = {
      architectureId: input.architectureId,
      projectId: input.projectId ?? 'proj-default',
      resources,
      connections,
    };

    const prov = input.provider ?? (resources.some((r) => r.provider === 'azure') && resources.some((r) => r.provider === 'aws') ? 'multi' : resources[0]?.provider ?? 'aws');
    if (prov === 'azure') return this.analyzeAzure(fullInput);
    if (prov === 'multi') return this.analyzeMultiCloud(fullInput);
    return this.analyzeAws(fullInput);
  }

  runRules(
    rules: WaRule[],
    input: WaAnalysisInput,
  ): WaFinding[] {
    const findings: WaFinding[] = [];
    const now = new Date().toISOString();

    for (const resource of input.resources) {
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(resource.configJson) as Record<string, unknown>;
      } catch {
        config = {};
      }

      for (const rule of rules) {
        const raw = rule.check(resource, config, input.resources, input.connections);
        if (raw !== null) {
          // Deduplicate: each (ruleId, resource[0]) pair produces only one finding
          const primaryId = raw.affectedResourceIds[0] ?? resource.id;
          const id = findingId(rule.ruleId, primaryId);
          if (!findings.some((f) => f.id === id)) {
            findings.push({
              ...raw,
              id,
              resourceState: raw.resourceState ?? (config.importState as any) ?? ((resource as any).importState) ?? (config.imported ? 'imported' : 'new'),
              detectedAt: now,
            });
          }
        }
      }
    }

    return findings;
  }

  analyzeAws(input: WaAnalysisInput): WaAssessment {
    const awsResources = input.resources.filter((r) => r.provider === 'aws');
    if (awsResources.length === 0) {
      return this._emptyAssessment(input, 'aws');
    }

    const awsInput: WaAnalysisInput = { ...input, resources: awsResources };
    const findings = this.runRules(awsWaRules, awsInput);
    const pillarScores = scorePillars(findings, AWS_PILLARS);
    const overallScore = calculateOverall(pillarScores);
    const framework = getFramework('aws');

    return {
      architectureId: input.architectureId,
      projectId: input.projectId,
      provider: 'aws',
      framework: framework.framework,
      frameworkVersion: framework.frameworkVersion,
      frameworkSource: framework.documentationUrl,
      overallScore,
      pillarScores,
      findings,
      evaluatedAt: new Date().toISOString(),
      source: 'DESIGN_TIME',
      sourceLabel: 'Design-time assessment',
      confidence: 'design-time',
      isStale: false,
    };
  }

  analyzeAzure(input: WaAnalysisInput): WaAssessment {
    const azureResources = input.resources.filter((r) => r.provider === 'azure');
    if (azureResources.length === 0) {
      return this._emptyAssessment(input, 'azure');
    }

    const azureInput: WaAnalysisInput = { ...input, resources: azureResources };
    const findings = this.runRules(azureWaRules, azureInput);
    const pillarScores = scorePillars(findings, AZURE_PILLARS);
    const overallScore = calculateOverall(pillarScores);
    const framework = getFramework('azure');

    return {
      architectureId: input.architectureId,
      projectId: input.projectId,
      provider: 'azure',
      framework: framework.framework,
      frameworkVersion: framework.frameworkVersion,
      frameworkSource: framework.documentationUrl,
      overallScore,
      pillarScores,
      findings,
      evaluatedAt: new Date().toISOString(),
      source: 'DESIGN_TIME',
      sourceLabel: 'Design-time assessment',
      confidence: 'design-time',
      isStale: false,
    };
  }

  /**
   * Analyze a multi-cloud architecture.
   * Returns a combined assessment with both AWS and Azure sub-assessments.
   */
  analyzeMultiCloud(input: WaAnalysisInput): WaAssessment {
    const awsAssessment = this.analyzeAws(input);
    const azureAssessment = this.analyzeAzure(input);

    // Merge findings and compute combined score
    const allFindings = [...awsAssessment.findings, ...azureAssessment.findings];

    // For multi-cloud, use the average of both overall scores (if both have resources)
    const hasAws = input.resources.some((r) => r.provider === 'aws');
    const hasAzure = input.resources.some((r) => r.provider === 'azure');

    let combinedScore = 100;
    if (hasAws && hasAzure) {
      combinedScore = Math.round((awsAssessment.overallScore + azureAssessment.overallScore) / 2);
    } else if (hasAws) {
      combinedScore = awsAssessment.overallScore;
    } else {
      combinedScore = azureAssessment.overallScore;
    }

    // Combined pillar scores = AWS scores + Azure scores (separate sections)
    const combinedPillarScores = [...awsAssessment.pillarScores, ...azureAssessment.pillarScores];

    return {
      architectureId: input.architectureId,
      projectId: input.projectId,
      provider: 'multi',
      framework: 'AWS + Azure Well-Architected Frameworks',
      frameworkVersion: '2024',
      frameworkSource: 'https://docs.aws.amazon.com/wellarchitected/ | https://learn.microsoft.com/azure/well-architected/',
      overallScore: combinedScore,
      pillarScores: combinedPillarScores,
      findings: allFindings,
      evaluatedAt: new Date().toISOString(),
      source: 'DESIGN_TIME',
      sourceLabel: 'Design-time assessment (multi-cloud)',
      confidence: 'design-time',
      isStale: false,
      awsAssessment,
      azureAssessment,
    };
  }

  private _emptyAssessment(input: WaAnalysisInput, provider: WaProvider): WaAssessment {
    const framework = getFramework(provider);
    const pillars = provider === 'aws' ? AWS_PILLARS : AZURE_PILLARS;
    return {
      architectureId: input.architectureId,
      projectId: input.projectId,
      provider,
      framework: framework.framework,
      frameworkVersion: framework.frameworkVersion,
      frameworkSource: framework.documentationUrl,
      overallScore: 100,
      pillarScores: pillars.map((p) => ({
        pillar: p.id as WaPillar,
        pillarLabel: p.label,
        score: 100,
        findingCount: 0,
        criticalCount: 0,
        highCount: 0,
      })),
      findings: [],
      evaluatedAt: new Date().toISOString(),
      source: 'DESIGN_TIME',
      sourceLabel: 'Design-time assessment (no resources)',
      confidence: 'design-time',
      isStale: false,
    };
  }
}

export const wellArchitectedRuleEngine = new WellArchitectedRuleEngine();
