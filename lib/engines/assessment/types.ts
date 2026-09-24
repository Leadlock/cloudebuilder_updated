/**
 * CloudCraft Assessment Engine — shared domain types.
 *
 * One technical rule → one evaluation per (rule, resource) → at most one
 * finding → many framework mappings (Well-Architected pillar, security
 * control references, SOC 1-oriented control areas). The Security view, the
 * Well-Architected review, the SOC 1-oriented analysis, Auto-Fix and the
 * assessment report all read the SAME evaluations, so the same fact can never
 * be rated differently in two places.
 *
 * This module is isomorphic (browser + server): no Node-only imports.
 */

export const RULESET_VERSION = '2026.09.2';
export const ENGINE_NAME = 'CloudCraft Assessment Engine';

export type AssessmentProvider = 'aws' | 'azure';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL';
export const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'];

/**
 * Evaluation status. Missing data is NEVER a PASS:
 *  - NOT_EVALUATED     — the control is outside what an architecture design can show
 *                        (account-level settings, organizational process).
 *  - INSUFFICIENT_DATA — the control is resource-level, but the configuration fields
 *                        the rule needs are absent (common for imported resources).
 */
export type EvaluationStatus =
  | 'PASS'
  | 'FAIL'
  | 'WARNING'
  | 'NOT_APPLICABLE'
  | 'NOT_EVALUATED'
  | 'INSUFFICIENT_DATA';

export type Domain =
  | 'SECURITY'
  | 'RELIABILITY'
  | 'OPERATIONAL_EXCELLENCE'
  | 'PERFORMANCE_EFFICIENCY'
  | 'COST_OPTIMIZATION'
  | 'SUSTAINABILITY';

export type SecurityCategory =
  | 'Network exposure'
  | 'Identity & access'
  | 'Encryption at rest'
  | 'Encryption in transit'
  | 'Logging & audit'
  | 'Threat detection'
  | 'Edge protection'
  | 'Key management'
  | 'Workload hardening'
  | 'Data protection'
  | 'Resilience'
  | 'Monitoring'
  | 'Performance'
  | 'Cost'
  | 'Sustainability'
  | 'Operations';

export type AutoFixSafety = 'SAFE_AUTOFIX' | 'REVIEW_REQUIRED' | 'MANUAL_ONLY';
export type RemediationPriority = 'REQUIRED_REMEDIATION' | 'RECOMMENDED_IMPROVEMENT' | 'OPTIONAL_OPTIMIZATION';
export type CostImpact = 'NONE' | 'POSSIBLE_INCREASE' | 'POSSIBLE_DECREASE';

/** How a piece of evidence was obtained. */
export type EvidenceBasis = 'CONFIGURATION' | 'RELATIONSHIP' | 'TOPOLOGY' | 'NOT_MODELLED';

/**
 * Provenance of the configuration the rule evaluated.
 *  - DESIGN_TIME: configuration authored in CloudCraft (not deployed/confirmed).
 *  - DISCOVERED_CONFIGURATION: resource imported from a provider API and not modified
 *    since. Point-in-time and without field-level provenance, so NOT "live verified".
 *  - LIVE_VERIFIED: reserved — only set when a provider API confirmed the exact field.
 *    CloudCraft does not currently record field-level provenance, so no evaluation is
 *    marked LIVE_VERIFIED today.
 */
export type EvidenceProvenance = 'DESIGN_TIME' | 'DISCOVERED_CONFIGURATION' | 'LIVE_VERIFIED';

/** Human review state of a finding. Never changes the technical evaluation. */
export type ReviewStatus = 'OPEN' | 'RESOLVED' | 'ACCEPTED_RISK' | 'FALSE_POSITIVE' | 'NOT_APPLICABLE';

export type WaPillarId =
  | 'operational_excellence'
  | 'security'
  | 'reliability'
  | 'performance_efficiency'
  | 'cost_optimization'
  | 'sustainability';

export type Soc1AreaId =
  | 'SOC1-LA-01'
  | 'SOC1-LA-02'
  | 'SOC1-LA-03'
  | 'SOC1-DP-01'
  | 'SOC1-DP-02'
  | 'SOC1-OP-01'
  | 'SOC1-OP-02'
  | 'SOC1-OP-03'
  | 'SOC1-OP-04'
  | 'SOC1-CM-01'
  | 'SOC1-CM-02';

export interface EvidenceItem {
  /** Config key — internal; the report shows `label`. */
  field?: string;
  label: string;
  observed: string;
  expected?: string;
  basis: EvidenceBasis;
}

// ─── Rule inputs ──────────────────────────────────────────────────────────────

export interface AssessResource {
  id: string;
  label: string;
  resourceType: string;
  provider: AssessmentProvider;
  region?: string;
  parentId?: string;
  config: Record<string, unknown>;
  importState?: string;
}

export interface AssessEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface AssessContext {
  resources: AssessResource[];
  edges: AssessEdge[];
  byId: Map<string, AssessResource>;
  ofType(...types: string[]): AssessResource[];
  /** Resources directly connected to `id` by an edge (either direction) or containment. */
  neighbors(id: string): AssessResource[];
  providers: AssessmentProvider[];
}

export interface RuleOutcome {
  status: EvaluationStatus;
  observation: string;
  evidence: EvidenceItem[];
  /** Only when context changes severity (documented in the rule). */
  severity?: Severity;
  /** For architecture/account-scoped rules. */
  resourceIds?: string[];
  /** What CloudCraft would need to evaluate the control (NOT_EVALUATED / INSUFFICIENT_DATA). */
  requiredData?: string;
}

export interface AutoFixSpec {
  /** Static or resource-dependent safety (e.g. encryption on a deployed DB needs review). */
  safety: AutoFixSafety | ((r: AssessResource) => AutoFixSafety);
  safetyReason: string | ((r: AssessResource) => string);
  description: string;
  /** Partial config patch — merged into the canonical resource configuration. */
  patch: (config: Record<string, unknown>, r: AssessResource) => Record<string, unknown>;
  architectureImpact: string;
  costImpact: CostImpact;
  /** Expected line in the regenerated Terraform after the fix (verification). */
  terraformExpect?: RegExp;
}

export interface RuleDefinition {
  id: string;
  version: string;
  lastReviewed: string;
  provider: AssessmentProvider;
  service: string;
  scope: 'resource' | 'architecture' | 'account';
  resourceTypes?: string[];
  domain: Domain;
  category: SecurityCategory;
  title: string;
  description: string;
  rationale: string;
  risk: string;
  impact: string;
  severity: Severity;
  priority: RemediationPriority;
  wellArchitected: { pillar: WaPillarId; practice?: string };
  /** Keys into the reference catalog (references.ts). */
  references: string[];
  soc1: Soc1AreaId[];
  remediation: {
    recommendation: string;
    manualSteps: string[];
    terraform?: string;
  };
  autoFix?: AutoFixSpec;
  evaluate?: (r: AssessResource, ctx: AssessContext) => RuleOutcome;
  evaluateArchitecture?: (ctx: AssessContext) => RuleOutcome[];
}

// ─── References ───────────────────────────────────────────────────────────────

/**
 * How the reference itself was checked while building the ruleset.
 *  - VERIFIED_OFFICIAL_SOURCE: identifier/title checked against an official
 *    machine-readable publication (e.g. Microsoft's Azure Policy MCSB initiative,
 *    HashiCorp provider docs).
 *  - CROSS_CHECKED_SECONDARY: identifier/title cross-checked against a maintained
 *    machine-readable mapping of the official standard; official page not reachable
 *    from the build environment.
 *  - NOT_VERIFIED_IN_BUILD: URL/identifier taken from existing CloudCraft metadata;
 *    must be re-checked by a reviewer.
 */
export type ReferenceVerification = 'VERIFIED_OFFICIAL_SOURCE' | 'CROSS_CHECKED_SECONDARY' | 'NOT_VERIFIED_IN_BUILD';

export interface SourceReference {
  key: string;
  organization: 'AWS' | 'Microsoft' | 'HashiCorp' | 'AICPA';
  framework: string;
  identifier?: string;
  title: string;
  url?: string;
  verification: ReferenceVerification;
  verificationNote?: string;
  officialSeverity?: string;
}

// ─── Outputs ──────────────────────────────────────────────────────────────────

export interface Evaluation {
  /** Stable, display-safe ID: `<ruleId>-<6 hex of resource id>` or `<ruleId>-ARCH`. */
  findingId: string;
  ruleId: string;
  ruleVersion: string;
  provider: AssessmentProvider;
  resourceIds: string[];
  resourceLabels: string[];
  resourceType?: string;
  region?: string;
  status: EvaluationStatus;
  severity: Severity;
  observation: string;
  evidence: EvidenceItem[];
  requiredData?: string;
  provenance: EvidenceProvenance;
}

export interface AutoFixAvailability {
  available: boolean;
  safety: AutoFixSafety;
  safetyReason: string;
  description?: string;
  costImpact?: CostImpact;
  architectureImpact?: string;
}

export interface Finding extends Evaluation {
  title: string;
  description: string;
  rationale: string;
  risk: string;
  impact: string;
  domain: Domain;
  category: SecurityCategory;
  service: string;
  pillar: WaPillarId;
  practice?: string;
  priority: RemediationPriority;
  recommendation: string;
  manualSteps: string[];
  terraform?: string;
  autoFix: AutoFixAvailability;
  references: SourceReference[];
  soc1Areas: Soc1AreaId[];
  evaluatedAt: string;
  rulesetVersion: string;
  /** Human review overlay; OPEN unless a review record exists. */
  reviewStatus: ReviewStatus;
  review?: FindingReview;
}

export interface FindingReview {
  findingId: string;
  status: Exclude<ReviewStatus, 'OPEN' | 'RESOLVED'>;
  reason: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt?: string;
}

export interface CoverageSummary {
  applicable: number;
  evaluated: number;
  passed: number;
  failed: number;
  warnings: number;
  notEvaluated: number;
  insufficientData: number;
  notApplicable: number;
  /** evaluated / applicable, 0-100; null when nothing is applicable. */
  coveragePct: number | null;
}

export interface ScoreResult {
  /** null when nothing could be evaluated — never a default 100. */
  score: number | null;
  rating: 'Strong' | 'Good' | 'Needs improvement' | 'Weak' | 'Not scored';
  coverage: CoverageSummary;
  capApplied?: string;
  lowCoverage: boolean;
  methodology: string;
}

export interface PillarResult {
  provider: AssessmentProvider;
  framework: string;
  pillar: WaPillarId;
  label: string;
  referenceUrl: string;
  score: ScoreResult;
  status: 'No issues observed' | 'Observations only' | 'Issues found' | 'Critical issues' | 'Insufficient evidence';
  strengths: string[];
  findingIds: string[];
}

export type Soc1EvidenceType =
  | 'TECHNICALLY_OBSERVED'
  | 'CONFIGURATION_BASED_EVIDENCE'
  | 'USER_PROVIDED_EVIDENCE'
  | 'NOT_EVALUATED'
  | 'REQUIRES_ORGANIZATIONAL_EVIDENCE'
  | 'REQUIRES_AUDITOR_ASSESSMENT';

export interface Soc1AreaResult {
  id: Soc1AreaId;
  name: string;
  objective: string;
  status: 'Technical evidence observed' | 'Gaps identified' | 'Partially evaluated' | 'Not evaluated';
  evidenceTypes: Soc1EvidenceType[];
  technicalEvidence: string[];
  gaps: string[];
  relatedResourceLabels: string[];
  relatedFindingIds: string[];
  recommendedActions: string[];
  organizationalEvidenceRequired: string[];
  limitations: string;
}

export interface AssessmentResult {
  engine: string;
  rulesetVersion: string;
  evaluatedAt: string;
  graphHash: string;
  providers: AssessmentProvider[];
  regions: string[];
  resourceCount: number;
  evaluations: Evaluation[];
  findings: Finding[];
  securityScore: ScoreResult;
  overallScore: ScoreResult;
  pillarResults: PillarResult[];
  soc1: Soc1AreaResult[];
  analysisMode: 'DESIGN_TIME' | 'DESIGN_TIME_WITH_DISCOVERED_CONFIGURATION';
}
