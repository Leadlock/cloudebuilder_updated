/**
 * Well-Architected Framework Engine — Core Types
 *
 * Supports AWS (6 pillars) and Azure (5 pillars) with no forced alignment.
 * All findings are deterministic and carry full source attribution.
 * No fake data is ever generated.
 */

// ─── Providers ────────────────────────────────────────────────────────────────

export type WaProvider = 'aws' | 'azure';

// ─── Pillars ─────────────────────────────────────────────────────────────────

/** AWS Well-Architected Framework pillars (6) */
export type AwsPillar =
  | 'operational_excellence'
  | 'security'
  | 'reliability'
  | 'performance_efficiency'
  | 'cost_optimization'
  | 'sustainability';

/** Azure Well-Architected Framework pillars (5) */
export type AzurePillar =
  | 'reliability'
  | 'security'
  | 'cost_optimization'
  | 'operational_excellence'
  | 'performance_efficiency';

export type WaPillar = AwsPillar | AzurePillar;

// ─── Source Attribution ───────────────────────────────────────────────────────

/**
 * Every recommendation must identify its source.
 * Never claim live cloud intelligence when credentials are unavailable.
 */
export type AnalysisSource =
  | 'DESIGN_TIME'            // Local rule engine — design-time analysis only
  | 'CLOUDCRAFT_RULE';       // CloudCraft architecture rule (not framework-attributed)

// ─── Resource State ───────────────────────────────────────────────────────────

/**
 * Whether the affected resource exists in cloud already or is planned.
 * Findings must indicate this so users can fix architecture problems before deployment.
 */
export type ResourceState =
  | 'imported'              // Exists in cloud, was discovered and imported
  | 'cloudcraft-managed'    // Was deployed via CloudCraft
  | 'new'                   // New, planned, not yet deployed
  | 'modified'              // Exists but config was modified locally
  | 'planned'               // Planned for future deployment
  | 'deleted'               // Marked for deletion
  | 'unknown';              // State not determined

// ─── Severity ────────────────────────────────────────────────────────────────

export type WaSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_WEIGHTS: Record<WaSeverity, number> = {
  critical: 30,
  high: 20,
  medium: 10,
  low: 5,
  info: 0,
};

// ─── Finding ─────────────────────────────────────────────────────────────────

export interface WaFinding {
  id: string;                    // Deterministic: sha256(ruleId + resourceId)[0:16]
  ruleId: string;                // e.g. 'AWS-WAF-SEC-01'
  provider: WaProvider;
  pillar: WaPillar;
  pillarLabel: string;           // e.g. 'Security'
  pillarRef: string;             // Official documentation URL
  severity: WaSeverity;
  title: string;
  description: string;
  affectedResourceIds: string[];
  affectedResourceLabels: string[];
  evidence: Record<string, unknown>; // Config fields that triggered the finding
  recommendation: string;
  remediation: string;
  frameworkReference: string;    // e.g. 'AWS Well-Architected Framework — Security Pillar'
  source: AnalysisSource;
  sourceLabel: string;           // Human-readable source for UI display
  detectedAt: string;            // ISO timestamp
  resourceState?: ResourceState; // Is this resource already deployed or just planned?
  /** Evaluation status from the assessment engine (FAIL or WARNING). */
  status?: 'FAIL' | 'WARNING';
  /** What CloudCraft observed, in plain language. */
  observation?: string;
  /** Official references (title/identifier/url) supporting the finding. */
  references?: { title: string; identifier?: string; url?: string; framework: string }[];
  practice?: string;
}

// ─── Pillar Score ─────────────────────────────────────────────────────────────

export interface WaPillarScore {
  pillar: WaPillar;
  pillarLabel: string;
  /** 0-100. Meaningless when `scored` is false — render "Insufficient evidence" instead. */
  score: number;
  findingCount: number;
  criticalCount: number;
  highCount: number;
  provider?: WaProvider;
  /** False when no check in this pillar could be evaluated (never shown as 100%). */
  scored?: boolean;
  coveragePct?: number | null;
  evaluatedChecks?: number;
  notEvaluatedChecks?: number;
  /** How many DIFFERENT rules were evaluated for this pillar (a rule checked on six subnets is still one check). */
  evaluatedRules?: number;
  /** True when fewer than THIN_PILLAR_RULES different rules were evaluated: the score is an indication, not a verdict. */
  limitedEvidence?: boolean;
  status?: 'No issues observed' | 'Observations only' | 'Issues found' | 'Critical issues' | 'Insufficient evidence';
}

// ─── Assessment ───────────────────────────────────────────────────────────────

export interface WaAssessment {
  architectureId: string;
  projectId: string;
  provider: WaProvider | 'multi';
  framework: string;             // e.g. 'AWS Well-Architected Framework'
  frameworkVersion: string;      // e.g. '2024'
  frameworkSource: string;       // Official documentation URL
  overallScore: number;          // 0-100, weighted average of pillar scores
  pillarScores: WaPillarScore[];
  findings: WaFinding[];
  evaluatedAt: string;           // ISO timestamp
  source: AnalysisSource;
  sourceLabel: string;           // e.g. 'Design-time assessment'
  confidence: 'design-time';
  isStale: boolean;              // True when the canvas changed after this analysis, or it was made with an older ruleset
  staleReason?: 'architecture' | 'ruleset';
  awsAssessment?: WaAssessment;  // For multi-cloud, the AWS-specific assessment
  azureAssessment?: WaAssessment; // For multi-cloud, the Azure-specific assessment
  /** False when nothing could be evaluated — `overallScore` must not be displayed as a score. */
  overallScored?: boolean;
  coveragePct?: number | null;
  notEvaluatedCount?: number;
  rulesetVersion?: string;
  scoreMethodology?: string;
}

// ─── Analysis Input ───────────────────────────────────────────────────────────

import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';

export interface WaAnalysisInput {
  architectureId: string;
  projectId: string;
  versionId?: string;
  resources: DbArchitectureResource[];
  connections: DbArchitectureConnection[];
}

// ─── Rule Interface ───────────────────────────────────────────────────────────

export interface WaRule {
  ruleId: string;
  provider: WaProvider;
  pillar: WaPillar;
  pillarLabel: string;
  pillarRef: string;
  severity: WaSeverity;
  title: string;
  description: string;
  frameworkReference: string;
  source: AnalysisSource;
  remediation: string;
  /**
   * Returns a partial finding (without id/detectedAt) if the rule fires, null otherwise.
   * Must ONLY fire when there is sufficient evidence in the config.
   * Must NOT fire when the relevant field is absent/unknown.
   */
  check(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    allResources: DbArchitectureResource[],
    connections: DbArchitectureConnection[],
  ): Omit<WaFinding, 'id' | 'detectedAt'> | null;
}
