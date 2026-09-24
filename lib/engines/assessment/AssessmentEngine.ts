/**
 * CloudCraft Assessment Engine.
 *
 * Input: the SAME canvas graph (CanvasNode[] / CanvasEdge[]) that the canvas,
 * canonical architecture, cost engine and Terraform generator use — on the
 * client for live feedback and on the server (from persisted
 * ArchitectureResource rows via architectureRepository.toCanvas) for
 * persisted scans and reports. There is no second architecture model.
 *
 * Output: one Evaluation per (rule, resource) — including PASS,
 * NOT_APPLICABLE, NOT_EVALUATED and INSUFFICIENT_DATA — plus Findings
 * (FAIL/WARNING evaluations enriched with rule metadata), coverage-aware
 * scores, Well-Architected pillar results and SOC 1-oriented area results.
 */
import type { CanvasEdge, CanvasNode } from '@/types';
import { inferNodeProvider } from '@/types';
import { computeGraphHash, toCanonicalGraph } from '@/lib/domain/canonicalArchitecture';
import { ALL_RULES, RULES_BY_ID } from './rules';
import { resolveReferences } from './references';
import { scoreOf } from './scoring';
import { buildSoc1 } from './soc1';
import { pillarsFor, frameworkName } from './pillars';
import type {
  AssessContext, AssessEdge, AssessResource, AssessmentProvider, AssessmentResult, AutoFixAvailability,
  Evaluation, Finding, FindingReview, PillarResult, RuleDefinition, RuleOutcome, EvidenceProvenance,
} from './types';
import { ENGINE_NAME, RULESET_VERSION, SEVERITY_ORDER } from './types';

/** Node types that are layout/boundary helpers rather than cloud resources. */
const NON_RESOURCE_TYPES = new Set(['aws_cloud_boundary', 'azure_cloud_boundary']);

// ─── Deterministic short hash (isomorphic FNV-1a) ─────────────────────────────

export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function findingIdFor(ruleId: string, resourceId: string | null): string {
  return resourceId ? `${ruleId}-${fnv1a(resourceId).slice(0, 6).toUpperCase()}` : `${ruleId}-ARCH`;
}

// ─── Context ──────────────────────────────────────────────────────────────────

export function toAssessResources(nodes: CanvasNode[]): AssessResource[] {
  return nodes
    .filter((n) => !NON_RESOURCE_TYPES.has(n.resourceType))
    .map((n) => ({
      id: n.id,
      label: n.label || n.resourceType,
      resourceType: n.resourceType,
      provider: inferNodeProvider(n) as AssessmentProvider,
      region: (n.region as string | undefined) ?? (typeof n.config?.region === 'string' ? n.config.region : undefined),
      parentId: n.parentId ?? n.groupId,
      config: (n.config ?? {}) as Record<string, unknown>,
      importState: n.importState ?? (typeof n.config?.importState === 'string' ? n.config.importState as string : undefined),
    }));
}

export function buildContext(resources: AssessResource[], edges: AssessEdge[]): AssessContext {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    link(e.source, e.target);
    link(e.target, e.source);
  }
  for (const r of resources) {
    if (r.parentId && byId.has(r.parentId)) { link(r.id, r.parentId); link(r.parentId, r.id); }
  }
  const providers = Array.from(new Set(resources.map((r) => r.provider))).sort() as AssessmentProvider[];
  return {
    resources,
    edges,
    byId,
    providers,
    ofType: (...types: string[]) => resources.filter((r) => types.includes(r.resourceType)),
    neighbors: (id: string) => Array.from(adjacency.get(id) ?? []).map((x) => byId.get(x)!).filter(Boolean),
  };
}

// ─── Rule execution ───────────────────────────────────────────────────────────

function provenanceOf(r?: AssessResource): EvidenceProvenance {
  return r?.importState === 'imported' ? 'DISCOVERED_CONFIGURATION' : 'DESIGN_TIME';
}

function toEvaluation(rule: RuleDefinition, outcome: RuleOutcome, ctx: AssessContext, resource?: AssessResource): Evaluation {
  const ids = resource ? [resource.id] : (outcome.resourceIds ?? []);
  const resources = ids.map((id) => ctx.byId.get(id)).filter((r): r is AssessResource => Boolean(r));
  return {
    findingId: findingIdFor(rule.id, resource ? resource.id : null),
    ruleId: rule.id,
    ruleVersion: rule.version,
    provider: rule.provider,
    resourceIds: ids,
    resourceLabels: resources.map((r) => r.label),
    resourceType: resource?.resourceType,
    region: resource?.region,
    status: outcome.status,
    severity: outcome.severity ?? rule.severity,
    observation: outcome.observation,
    evidence: outcome.evidence,
    requiredData: outcome.requiredData,
    provenance: resource ? provenanceOf(resource) : (resources.every((r) => r.importState === 'imported') && resources.length > 0 ? 'DISCOVERED_CONFIGURATION' : 'DESIGN_TIME'),
  };
}

export function evaluateRule(rule: RuleDefinition, ctx: AssessContext): Evaluation[] {
  if (!ctx.providers.includes(rule.provider)) return [];
  if (rule.scope === 'resource') {
    const targets = ctx.resources.filter((r) => r.provider === rule.provider && rule.resourceTypes!.includes(r.resourceType));
    return targets.map((r) => {
      let outcome: RuleOutcome;
      try {
        outcome = rule.evaluate!(r, ctx);
      } catch (err) {
        outcome = { status: 'INSUFFICIENT_DATA', observation: `The rule could not evaluate this configuration (${(err as Error).message}).`, evidence: [], requiredData: 'Valid configuration values.' };
      }
      return toEvaluation(rule, outcome, ctx, r);
    });
  }
  const outcomes = rule.evaluateArchitecture!(ctx);
  return outcomes.map((o) => toEvaluation(rule, o, ctx));
}

export function autoFixAvailability(rule: RuleDefinition, resource?: AssessResource): AutoFixAvailability {
  if (!rule.autoFix) {
    return { available: false, safety: 'MANUAL_ONLY', safetyReason: 'No deterministic configuration change exists for this control; follow the manual remediation steps.' };
  }
  const safety = typeof rule.autoFix.safety === 'function' ? (resource ? rule.autoFix.safety(resource) : 'REVIEW_REQUIRED') : rule.autoFix.safety;
  const safetyReason = typeof rule.autoFix.safetyReason === 'function' ? (resource ? rule.autoFix.safetyReason(resource) : '') : rule.autoFix.safetyReason;
  return {
    available: safety !== 'MANUAL_ONLY' && rule.scope === 'resource' && Boolean(resource),
    safety,
    safetyReason,
    description: rule.autoFix.description,
    costImpact: rule.autoFix.costImpact,
    architectureImpact: rule.autoFix.architectureImpact,
  };
}

function toFinding(e: Evaluation, rule: RuleDefinition, ctx: AssessContext, evaluatedAt: string, review?: FindingReview): Finding {
  const resource = e.resourceIds.length === 1 && rule.scope === 'resource' ? ctx.byId.get(e.resourceIds[0]) : undefined;
  const reviewActive = review && (!review.expiresAt || review.expiresAt > evaluatedAt);
  return {
    ...e,
    title: rule.title,
    description: rule.description,
    rationale: rule.rationale,
    risk: rule.risk,
    impact: rule.impact,
    domain: rule.domain,
    category: rule.category,
    service: rule.service,
    pillar: rule.wellArchitected.pillar,
    practice: rule.wellArchitected.practice,
    priority: rule.priority,
    recommendation: rule.remediation.recommendation,
    manualSteps: rule.remediation.manualSteps,
    terraform: rule.remediation.terraform,
    autoFix: autoFixAvailability(rule, resource),
    references: resolveReferences(rule.references),
    soc1Areas: rule.soc1,
    evaluatedAt,
    rulesetVersion: RULESET_VERSION,
    reviewStatus: reviewActive ? review!.status : 'OPEN',
    review: reviewActive ? review : undefined,
  };
}

export interface AssessInput {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  reviews?: FindingReview[];
  /** Override for deterministic tests / snapshot re-rendering. */
  evaluatedAt?: string;
  rules?: RuleDefinition[];
}

export function runAssessment(input: AssessInput): AssessmentResult {
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const rules = input.rules ?? ALL_RULES;
  const resources = toAssessResources(input.nodes ?? []);
  const edges: AssessEdge[] = (input.edges ?? []).map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.label }));
  const ctx = buildContext(resources, edges);

  const evaluations: Evaluation[] = [];
  for (const rule of rules) evaluations.push(...evaluateRule(rule, ctx));

  const reviews = new Map((input.reviews ?? []).map((r) => [r.findingId, r]));
  const findings = evaluations
    .filter((e) => e.status === 'FAIL' || e.status === 'WARNING')
    .map((e) => toFinding(e, RULES_BY_ID.get(e.ruleId)!, ctx, evaluatedAt, reviews.get(e.findingId)))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.findingId.localeCompare(b.findingId));

  const ruleOf = (e: Evaluation) => RULES_BY_ID.get(e.ruleId)!;
  const securityEvals = evaluations.filter((e) => ruleOf(e).domain === 'SECURITY');

  const pillarResults: PillarResult[] = [];
  for (const provider of ctx.providers) {
    for (const p of pillarsFor(provider)) {
      const evals = evaluations.filter((e) => e.provider === provider && ruleOf(e).wellArchitected.pillar === p.id);
      const score = scoreOf(evals);
      const failing = evals.filter((e) => e.status === 'FAIL' || e.status === 'WARNING');
      const status: PillarResult['status'] = score.coverage.evaluated === 0
        ? 'Insufficient evidence'
        : failing.some((e) => e.status === 'FAIL' && e.severity === 'CRITICAL') ? 'Critical issues'
          : failing.some((e) => e.severity !== 'INFORMATIONAL') ? 'Issues found'
            : failing.length > 0 ? 'Observations only' : 'No issues observed';
      const strengths = Array.from(new Set(evals.filter((e) => e.status === 'PASS' && e.resourceLabels.length > 0)
        .map((e) => `${e.resourceLabels[0]}: ${e.observation}`))).slice(0, 6);
      pillarResults.push({
        provider, framework: frameworkName(provider), pillar: p.id, label: p.label, referenceUrl: p.referenceUrl,
        score, status, strengths, findingIds: failing.map((e) => e.findingId),
      });
    }
  }

  const soc1 = buildSoc1(rules, evaluations, findings);
  const regions = Array.from(new Set(resources.map((r) => r.region).filter((r): r is string => Boolean(r)))).sort();
  const graph = toCanonicalGraph(input.nodes ?? [], input.edges ?? []);

  return {
    engine: ENGINE_NAME,
    rulesetVersion: RULESET_VERSION,
    evaluatedAt,
    graphHash: computeGraphHash(graph),
    providers: ctx.providers,
    regions,
    resourceCount: resources.length,
    evaluations,
    findings,
    securityScore: scoreOf(securityEvals),
    overallScore: scoreOf(evaluations),
    pillarResults,
    soc1,
    analysisMode: resources.some((r) => r.importState === 'imported') ? 'DESIGN_TIME_WITH_DISCOVERED_CONFIGURATION' : 'DESIGN_TIME',
  };
}

/** Re-evaluate a single rule for a single resource (used by Auto-Fix verification). */
export function evaluateRuleForResource(ruleId: string, resourceId: string, nodes: CanvasNode[], edges: CanvasEdge[]): Evaluation | null {
  const rule = RULES_BY_ID.get(ruleId);
  if (!rule) return null;
  const ctx = buildContext(toAssessResources(nodes), edges.map((e) => ({ id: e.id, source: e.source, target: e.target })));
  const evals = evaluateRule(rule, ctx);
  return evals.find((e) => e.resourceIds.includes(resourceId) && (rule.scope !== 'resource' || e.resourceIds.length === 1)) ?? null;
}
