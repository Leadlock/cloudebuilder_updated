/**
 * Security / Well-Architected Auto-Fix.
 *
 * A fix is a deterministic patch to the resource configuration in the
 * canonical graph (the same CanvasNode config the canvas, cost engine and
 * Terraform generator read). It is never a UI-only change:
 *
 *   plan (preview) → safety gate → patch canonical config
 *   → canonical validation → re-run the rule → full re-assessment (regressions)
 *   → regenerate Terraform and verify the remediation is rendered
 *   → RESOLVED, or AUTO_FIX_FAILED with the original graph returned (rollback)
 *
 * Persistence happens through the normal canvas save path (the caller dispatches
 * the returned nodes), and the server re-runs the same engine on the persisted
 * architecture — so a finding disappears from a persisted scan only when the
 * saved configuration actually passes.
 */
import type { CanvasEdge, CanvasNode } from '@/types';
import { calculateCosts } from '@/lib/analysis';
import { terraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import { toCanonicalGraph, validateCanonicalArchitecture } from '@/lib/domain/canonicalArchitecture';
import { runAssessment, autoFixAvailability, toAssessResources } from './AssessmentEngine';
import { RULES_BY_ID } from './rules';
import { fieldLabel, fmt } from './ruleHelpers';
import type { AssessmentResult, AutoFixSafety, CostImpact, Evaluation, Finding } from './types';

export interface FieldChange { field: string; label: string; current: string; proposed: string }

export interface AutoFixPlan {
  findingId: string;
  ruleId: string;
  title: string;
  resourceId: string;
  resourceLabel: string;
  resourceType: string;
  safety: AutoFixSafety;
  safetyReason: string;
  description: string;
  changes: FieldChange[];
  affectedResources: string[];
  why: string;
  securityImprovement: string;
  architectureImpact: string;
  cost: { impact: CostImpact; beforeMonthly: number; afterMonthly: number; deltaMonthly: number; basis: string };
  terraform: { added: string[]; removed: string[]; expectationMet: boolean | null };
}

export type AutoFixStatus = 'RESOLVED' | 'AUTO_FIX_FAILED' | 'REJECTED' | 'ALREADY_RESOLVED';

export interface AutoFixResult {
  status: AutoFixStatus;
  findingId: string;
  ruleId?: string;
  reason: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  plan?: AutoFixPlan;
  before?: Evaluation;
  after?: Evaluation | null;
  newFindings: Finding[];
  appliedAt?: string;
}

/**
 * Generate Terraform with the SAME production generator used by the Terraform
 * view, plan/apply and GitOps (TerraformGenerator), from the canonical graph.
 */
export function generateCanonicalTerraform(nodes: CanvasNode[], edges: CanvasEdge[]): string {
  try {
    const res = terraformGenerator.generate({
      architectureId: 'autofix-verification',
      projectId: 'autofix-verification',
      projectName: 'cloudbuilder-infra',
      resources: nodes.map((n) => ({
        id: n.id,
        resourceType: n.resourceType,
        provider: n.provider || (n.resourceType.startsWith('azure_') ? 'azure' : 'aws'),
        label: n.label,
        positionX: n.position?.x ?? 0,
        positionY: n.position?.y ?? 0,
        configJson: JSON.stringify(n.config || {}),
        region: (n.region as string) || null,
        groupId: n.groupId || n.parentId || null,
        locked: Boolean(n.locked),
        architectureId: 'autofix-verification',
      })),
      connections: edges.map((e) => ({
        id: e.id, sourceId: e.source, targetId: e.target, label: e.label || null,
        edgeType: (e.relationshipType || e.edgeType || 'network') as string, architectureId: 'autofix-verification',
      })),
    });
    return res.files.map((f) => `# ── ${f.filename}\n${f.content}`).join('\n');
  } catch (e) {
    return `# terraform generation failed: ${(e as Error).message}`;
  }
}

const tf = generateCanonicalTerraform;

function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const count = (s: string) => {
    const m = new Map<string, number>();
    for (const l of s.split('\n').map((x) => x.trimEnd()).filter((x) => x.trim())) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const b = count(before); const a = count(after);
  const added: string[] = []; const removed: string[] = [];
  for (const [l, n] of a) for (let i = 0; i < n - (b.get(l) ?? 0); i++) added.push(l.trim());
  for (const [l, n] of b) for (let i = 0; i < n - (a.get(l) ?? 0); i++) removed.push(l.trim());
  return { added, removed };
}

function monthly(nodes: CanvasNode[], ids: string[]): number {
  try {
    return calculateCosts(nodes.filter((n) => ids.includes(n.id))).reduce((s, c) => s + c.monthlyCost, 0);
  } catch { return 0; }
}

function patchNodes(nodes: CanvasNode[], resourceId: string, patch: Record<string, unknown>): CanvasNode[] {
  return nodes.map((n) => (n.id === resourceId ? { ...n, config: { ...n.config, ...patch }, importState: n.importState === 'imported' || n.importState === 'cloudbuilder-managed' ? 'modified' : n.importState } : n));
}

/** Precomputed state of the graph a fix starts from (avoids recomputing it per step). */
interface BaseState {
  assessment: AssessmentResult;
  terraform: string;
  validationKeys: Set<string>;
}

const issueKey = (i: { code: string; affectedResourceIds: string[] }) => `${i.code}:${i.affectedResourceIds.join(',')}`;
const severeKeys = (nodes: CanvasNode[], edges: CanvasEdge[]) =>
  new Set(validateCanonicalArchitecture(toCanonicalGraph(nodes, edges)).issues.filter((i) => i.severity === 'critical' || i.severity === 'high').map(issueKey));

function baseState(nodes: CanvasNode[], edges: CanvasEdge[]): BaseState {
  return { assessment: runAssessment({ nodes, edges }), terraform: tf(nodes, edges), validationKeys: severeKeys(nodes, edges) };
}

interface PlanInternal { plan: AutoFixPlan; patched: CanvasNode[]; tfAfter: string }

function planInternal(nodes: CanvasNode[], edges: CanvasEdge[], findingId: string, base: Pick<BaseState, 'assessment' | 'terraform'>): PlanInternal | { error: string } {
  const finding = base.assessment.findings.find((f) => f.findingId === findingId);
  if (!finding) return { error: 'Finding is not present in the current architecture (it may already be resolved).' };
  const rule = RULES_BY_ID.get(finding.ruleId)!;
  const node = nodes.find((n) => n.id === finding.resourceIds[0]);
  if (!rule.autoFix || rule.scope !== 'resource' || !node) return { error: 'No automated remediation exists for this finding.' };

  const resource = toAssessResources([node])[0];
  const avail = autoFixAvailability(rule, resource);
  const patch = rule.autoFix.patch(node.config ?? {}, resource);
  const changes: FieldChange[] = Object.entries(patch).map(([field, value]) => ({
    field, label: fieldLabel(node.resourceType, field), current: fmt(node.config?.[field]), proposed: fmt(value),
  }));
  const patched = patchNodes(nodes, node.id, patch);
  const before$ = monthly(nodes, [node.id]);
  const after$ = monthly(patched, [node.id]);
  const tfAfter = tf(patched, edges);
  const diff = lineDiff(base.terraform, tfAfter);
  const expect = rule.autoFix.terraformExpect;

  return {
    patched, tfAfter,
    plan: {
      findingId, ruleId: rule.id, title: rule.title,
      resourceId: node.id, resourceLabel: node.label, resourceType: node.resourceType,
      safety: avail.safety, safetyReason: avail.safetyReason,
      description: rule.autoFix.description,
      changes,
      affectedResources: [node.label],
      why: rule.risk,
      securityImprovement: `Resolves ${rule.id}: ${rule.title}.`,
      architectureImpact: rule.autoFix.architectureImpact,
      cost: {
        impact: rule.autoFix.costImpact,
        beforeMonthly: Math.round(before$ * 100) / 100,
        afterMonthly: Math.round(after$ * 100) / 100,
        deltaMonthly: Math.round((after$ - before$) * 100) / 100,
        basis: 'CloudBuilder static list-price estimate for the affected resource (USD/month); live pricing may differ.',
      },
      terraform: { added: diff.added, removed: diff.removed, expectationMet: expect ? diff.added.some((l) => expect.test(l)) : null },
    },
  };
}

export function planAutoFix(nodes: CanvasNode[], edges: CanvasEdge[], findingId: string): AutoFixPlan | { error: string } {
  const r = planInternal(nodes, edges, findingId, { assessment: runAssessment({ nodes, edges }), terraform: tf(nodes, edges) });
  return 'error' in r ? r : r.plan;
}

/**
 * Monthly cost change of a fix for the affected resource only — no assessment or
 * Terraform generation, so it is cheap enough to sum across many findings in the UI.
 */
export function autoFixCostDelta(nodes: CanvasNode[], finding: Finding): number {
  const rule = RULES_BY_ID.get(finding.ruleId);
  const node = nodes.find((n) => n.id === finding.resourceIds[0]);
  if (!rule?.autoFix || rule.scope !== 'resource' || !node) return 0;
  const patched = patchNodes([node], node.id, rule.autoFix.patch(node.config ?? {}, toAssessResources([node])[0]));
  return Math.round((monthly(patched, [node.id]) - monthly([node], [node.id])) * 100) / 100;
}

export interface ApplyOptions {
  /** Required for REVIEW_REQUIRED fixes: the user saw the preview and confirmed. */
  confirmed?: boolean;
  now?: string;
}

interface ApplyInternal { result: AutoFixResult; next?: BaseState }

function applyInternal(nodes: CanvasNode[], edges: CanvasEdge[], findingId: string, opts: ApplyOptions, base: BaseState): ApplyInternal {
  const baseResult = { findingId, nodes, edges, newFindings: [] as Finding[] };
  const finding = base.assessment.findings.find((f) => f.findingId === findingId);
  if (!finding) {
    return { result: { ...baseResult, status: 'ALREADY_RESOLVED', reason: 'The finding is not present in the current architecture; nothing was changed.' } };
  }
  const pi = planInternal(nodes, edges, findingId, base);
  if ('error' in pi) return { result: { ...baseResult, ruleId: finding.ruleId, status: 'REJECTED', reason: pi.error } };
  const { plan, patched, tfAfter } = pi;
  if (plan.safety === 'MANUAL_ONLY') return { result: { ...baseResult, ruleId: plan.ruleId, plan, status: 'REJECTED', reason: `Manual remediation only: ${plan.safetyReason}` } };
  if (plan.safety === 'REVIEW_REQUIRED' && !opts.confirmed) {
    return { result: { ...baseResult, ruleId: plan.ruleId, plan, status: 'REJECTED', reason: 'This fix requires review. Confirm the proposed change before applying.' } };
  }

  const rule = RULES_BY_ID.get(plan.ruleId)!;
  const fail = (reason: string, after?: Evaluation | null, newFindings: Finding[] = []): ApplyInternal =>
    ({ result: { ...baseResult, ruleId: plan.ruleId, plan, before: finding, after, newFindings, status: 'AUTO_FIX_FAILED', reason: `${reason} The architecture was left unchanged.` } });

  // 1. Canonical validation must not get worse.
  const vAfter = validateCanonicalArchitecture(toCanonicalGraph(patched, edges));
  const afterKeys = new Set(vAfter.issues.filter((i) => i.severity === 'critical' || i.severity === 'high').map(issueKey));
  const introduced = vAfter.issues.filter((i) => (i.severity === 'critical' || i.severity === 'high') && !base.validationKeys.has(issueKey(i)));
  if (introduced.length > 0) return fail(`Architecture validation failed after the change: ${introduced.map((i) => i.message).join('; ')}.`);

  // 2. + 3. Re-run the rule on the resource, and the full re-assessment (regressions).
  const afterAssessment = runAssessment({ nodes: patched, edges });
  const after = afterAssessment.evaluations.find((e) => e.ruleId === plan.ruleId && e.resourceIds.length === 1 && e.resourceIds[0] === plan.resourceId) ?? null;
  if (!after || (after.status !== 'PASS' && after.status !== 'NOT_APPLICABLE')) {
    return fail(`Verification failed: ${plan.ruleId} still evaluates to ${after?.status ?? 'UNKNOWN'} (${after?.observation ?? 'no evaluation'}).`, after);
  }
  const oldIds = new Set(base.assessment.findings.map((f) => f.findingId));
  const newFindings = afterAssessment.findings.filter((f) => !oldIds.has(f.findingId));
  const severeNew = newFindings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');
  if (severeNew.length > 0) return fail(`The change would introduce new ${severeNew.map((f) => `${f.severity} finding ${f.ruleId}`).join(', ')}.`, after, newFindings);

  // 4. Terraform must render the remediation (diff computed once, in the plan).
  if (plan.terraform.added.length === 0 && plan.terraform.removed.length === 0) return fail('Terraform verification failed: the generated Terraform did not change.', after, newFindings);
  const expect = rule.autoFix!.terraformExpect;
  if (expect && !plan.terraform.expectationMet) return fail(`Terraform verification failed: expected ${expect} in the regenerated Terraform.`, after, newFindings);

  return {
    result: {
      findingId, ruleId: plan.ruleId, plan, before: finding, after, newFindings,
      nodes: patched, edges,
      status: 'RESOLVED',
      reason: `Verified: ${plan.ruleId} now evaluates to ${after.status}; Terraform updated (${plan.terraform.added.length} line(s) added, ${plan.terraform.removed.length} removed).`,
      appliedAt: opts.now ?? new Date().toISOString(),
    },
    next: { assessment: afterAssessment, terraform: tfAfter, validationKeys: afterKeys },
  };
}

export function applyAutoFix(nodes: CanvasNode[], edges: CanvasEdge[], findingId: string, opts: ApplyOptions = {}): AutoFixResult {
  return applyInternal(nodes, edges, findingId, opts, baseState(nodes, edges)).result;
}

export interface BulkFixSummary {
  results: AutoFixResult[];
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  resolved: number;
  failed: number;
}

/** Findings eligible for "Fix all safe issues" — SAFE_AUTOFIX only, never REVIEW_REQUIRED/MANUAL_ONLY. */
export function safeFixCandidates(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.autoFix.available && f.autoFix.safety === 'SAFE_AUTOFIX');
}

/**
 * Apply SAFE_AUTOFIX findings. Fast path: apply every patch, then verify the combined result
 * once (each rule re-evaluates to PASS, each fix's Terraform expectation is present in the
 * combined diff, no new HIGH/CRITICAL findings, validation not worse). If anything fails,
 * fall back to applying the fixes one at a time so each is verified and rolled back
 * independently. Either way, only verified changes are returned.
 */
export function applySafeFixes(nodes: CanvasNode[], edges: CanvasEdge[], findingIds?: string[], now?: string): BulkFixSummary {
  const base = baseState(nodes, edges);
  const candidates = new Set(safeFixCandidates(base.assessment.findings).map((f) => f.findingId));
  const ids = (findingIds ?? [...candidates]).filter((id) => candidates.has(id));

  if (ids.length > 1) {
    const batch = tryBatch(nodes, edges, ids, base, now);
    if (batch) return batch;
  }

  let current = nodes;
  let state = base;
  const results: AutoFixResult[] = [];
  for (const id of ids) {
    const r = applyInternal(current, edges, id, { now }, state);
    results.push(r.result);
    if (r.result.status === 'RESOLVED' && r.next) { current = r.result.nodes; state = r.next; }
  }
  return summarize(results, current, edges);
}

function summarize(results: AutoFixResult[], nodes: CanvasNode[], edges: CanvasEdge[]): BulkFixSummary {
  return {
    results, nodes, edges,
    resolved: results.filter((r) => r.status === 'RESOLVED').length,
    failed: results.filter((r) => r.status === 'AUTO_FIX_FAILED').length,
  };
}

function tryBatch(nodes: CanvasNode[], edges: CanvasEdge[], ids: string[], base: BaseState, now?: string): BulkFixSummary | null {
  let patched = nodes;
  const applied: { finding: Finding; plan: AutoFixPlan }[] = [];
  for (const id of ids) {
    const finding = base.assessment.findings.find((f) => f.findingId === id)!;
    const rule = RULES_BY_ID.get(finding.ruleId)!;
    const node = patched.find((n) => n.id === finding.resourceIds[0]);
    if (!rule.autoFix || rule.scope !== 'resource' || !node) return null;
    const resource = toAssessResources([node])[0];
    const avail = autoFixAvailability(rule, resource);
    if (avail.safety !== 'SAFE_AUTOFIX') return null;
    const patch = rule.autoFix.patch(node.config ?? {}, resource);
    const before$ = monthly([node], [node.id]);
    const next = patchNodes(patched, node.id, patch);
    const after$ = monthly(next, [node.id]);
    patched = next;
    applied.push({
      finding,
      plan: {
        findingId: id, ruleId: rule.id, title: rule.title, resourceId: node.id, resourceLabel: node.label, resourceType: node.resourceType,
        safety: 'SAFE_AUTOFIX', safetyReason: avail.safetyReason,
        description: rule.autoFix.description,
        changes: Object.entries(patch).map(([field, value]) => ({ field, label: fieldLabel(node.resourceType, field), current: fmt(node.config?.[field]), proposed: fmt(value) })),
        affectedResources: [node.label], why: rule.risk, securityImprovement: `Resolves ${rule.id}: ${rule.title}.`,
        architectureImpact: rule.autoFix.architectureImpact,
        cost: { impact: rule.autoFix.costImpact, beforeMonthly: Math.round(before$ * 100) / 100, afterMonthly: Math.round(after$ * 100) / 100, deltaMonthly: Math.round((after$ - before$) * 100) / 100, basis: 'CloudBuilder static list-price estimate for the affected resource (USD/month); live pricing may differ.' },
        terraform: { added: [], removed: [], expectationMet: null },
      },
    });
  }

  // Validation must not get worse.
  const vAfter = validateCanonicalArchitecture(toCanonicalGraph(patched, edges));
  if (vAfter.issues.some((i) => (i.severity === 'critical' || i.severity === 'high') && !base.validationKeys.has(issueKey(i)))) return null;

  // Every fixed rule passes on its resource; no new HIGH/CRITICAL findings anywhere.
  const afterAssessment = runAssessment({ nodes: patched, edges });
  const evalById = new Map(afterAssessment.evaluations.map((e) => [e.findingId, e]));
  for (const a of applied) {
    const e = evalById.get(a.finding.findingId);
    if (!e || (e.status !== 'PASS' && e.status !== 'NOT_APPLICABLE')) return null;
  }
  const oldIds = new Set(base.assessment.findings.map((f) => f.findingId));
  if (afterAssessment.findings.some((f) => !oldIds.has(f.findingId) && (f.severity === 'CRITICAL' || f.severity === 'HIGH'))) return null;

  // Terraform: each fix's expected line must be present, counted per fix.
  const diff = lineDiff(base.terraform, tf(patched, edges));
  if (diff.added.length === 0 && diff.removed.length === 0) return null;
  const byRule = new Map<string, number>();
  for (const a of applied) byRule.set(a.plan.ruleId, (byRule.get(a.plan.ruleId) ?? 0) + 1);
  for (const [ruleId, count] of byRule) {
    const expect = RULES_BY_ID.get(ruleId)!.autoFix!.terraformExpect;
    if (!expect) continue;
    const matching = diff.added.filter((l) => expect.test(l));
    if (matching.length < count) return null;
    for (const a of applied.filter((x) => x.plan.ruleId === ruleId)) a.plan.terraform = { added: matching, removed: [], expectationMet: true };
  }

  const newFindings = afterAssessment.findings.filter((f) => !oldIds.has(f.findingId));
  const appliedAt = now ?? new Date().toISOString();
  const results: AutoFixResult[] = applied.map((a) => ({
    findingId: a.finding.findingId, ruleId: a.plan.ruleId, plan: a.plan, before: a.finding, after: evalById.get(a.finding.findingId) ?? null,
    newFindings, nodes: patched, edges, status: 'RESOLVED',
    reason: `Verified with ${applied.length - 1} other safe fix(es): ${a.plan.ruleId} now evaluates to ${evalById.get(a.finding.findingId)?.status}; Terraform updated.`,
    appliedAt,
  }));
  return summarize(results, patched, edges);
}
