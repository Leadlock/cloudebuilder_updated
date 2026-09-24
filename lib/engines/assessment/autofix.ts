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
import { runAssessment, evaluateRuleForResource, autoFixAvailability, toAssessResources } from './AssessmentEngine';
import { RULES_BY_ID } from './rules';
import { fieldLabel, fmt } from './ruleHelpers';
import type { AutoFixSafety, CostImpact, Evaluation, Finding } from './types';

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
      projectName: 'cloudcraft-infra',
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
  return nodes.map((n) => (n.id === resourceId ? { ...n, config: { ...n.config, ...patch }, importState: n.importState === 'imported' || n.importState === 'cloudcraft-managed' ? 'modified' : n.importState } : n));
}

export function planAutoFix(nodes: CanvasNode[], edges: CanvasEdge[], findingId: string): AutoFixPlan | { error: string } {
  const assessment = runAssessment({ nodes, edges });
  const finding = assessment.findings.find((f) => f.findingId === findingId);
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
  const after = patchNodes(nodes, node.id, patch);
  const before$ = monthly(nodes, [node.id]);
  const after$ = monthly(after, [node.id]);
  const diff = lineDiff(tf(nodes, edges), tf(after, edges));
  const expect = rule.autoFix.terraformExpect;

  return {
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
      basis: 'CloudCraft static list-price estimate for the affected resource (USD/month); live pricing may differ.',
    },
    terraform: { added: diff.added, removed: diff.removed, expectationMet: expect ? diff.added.some((l) => expect.test(l)) : null },
  };
}

export interface ApplyOptions {
  /** Required for REVIEW_REQUIRED fixes: the user saw the preview and confirmed. */
  confirmed?: boolean;
  now?: string;
}

export function applyAutoFix(nodes: CanvasNode[], edges: CanvasEdge[], findingId: string, opts: ApplyOptions = {}): AutoFixResult {
  const base = { findingId, nodes, edges, newFindings: [] as Finding[] };
  const beforeAssessment = runAssessment({ nodes, edges });
  const finding = beforeAssessment.findings.find((f) => f.findingId === findingId);
  if (!finding) {
    return { ...base, status: 'ALREADY_RESOLVED', reason: 'The finding is not present in the current architecture; nothing was changed.' };
  }
  const plan = planAutoFix(nodes, edges, findingId);
  if ('error' in plan) return { ...base, ruleId: finding.ruleId, status: 'REJECTED', reason: plan.error };
  if (plan.safety === 'MANUAL_ONLY') return { ...base, ruleId: plan.ruleId, plan, status: 'REJECTED', reason: `Manual remediation only: ${plan.safetyReason}` };
  if (plan.safety === 'REVIEW_REQUIRED' && !opts.confirmed) {
    return { ...base, ruleId: plan.ruleId, plan, status: 'REJECTED', reason: 'This fix requires review. Confirm the proposed change before applying.' };
  }

  const rule = RULES_BY_ID.get(plan.ruleId)!;
  const node = nodes.find((n) => n.id === plan.resourceId)!;
  const resource = toAssessResources([node])[0];
  const patched = patchNodes(nodes, node.id, rule.autoFix!.patch(node.config ?? {}, resource));
  const fail = (reason: string, after?: Evaluation | null, newFindings: Finding[] = []): AutoFixResult =>
    ({ ...base, ruleId: plan.ruleId, plan, before: finding, after, newFindings, status: 'AUTO_FIX_FAILED', reason: `${reason} The architecture was left unchanged.` });

  // 1. Canonical validation must not get worse.
  const vBefore = validateCanonicalArchitecture(toCanonicalGraph(nodes, edges));
  const vAfter = validateCanonicalArchitecture(toCanonicalGraph(patched, edges));
  const key = (i: { code: string; affectedResourceIds: string[] }) => `${i.code}:${i.affectedResourceIds.join(',')}`;
  const beforeKeys = new Set(vBefore.issues.filter((i) => i.severity === 'critical' || i.severity === 'high').map(key));
  const introduced = vAfter.issues.filter((i) => (i.severity === 'critical' || i.severity === 'high') && !beforeKeys.has(key(i)));
  if (introduced.length > 0) return fail(`Architecture validation failed after the change: ${introduced.map((i) => i.message).join('; ')}.`);

  // 2. Re-run the rule on the resource.
  const after = evaluateRuleForResource(plan.ruleId, plan.resourceId, patched, edges);
  if (!after || (after.status !== 'PASS' && after.status !== 'NOT_APPLICABLE')) {
    return fail(`Verification failed: ${plan.ruleId} still evaluates to ${after?.status ?? 'UNKNOWN'} (${after?.observation ?? 'no evaluation'}).`, after);
  }

  // 3. Full re-assessment — reject fixes that introduce new HIGH/CRITICAL findings.
  const afterAssessment = runAssessment({ nodes: patched, edges });
  const oldIds = new Set(beforeAssessment.findings.map((f) => f.findingId));
  const newFindings = afterAssessment.findings.filter((f) => !oldIds.has(f.findingId));
  const severeNew = newFindings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');
  if (severeNew.length > 0) return fail(`The change would introduce new ${severeNew.map((f) => `${f.severity} finding ${f.ruleId}`).join(', ')}.`, after, newFindings);

  // 4. Terraform must render the remediation.
  const diff = lineDiff(tf(nodes, edges), tf(patched, edges));
  if (diff.added.length === 0 && diff.removed.length === 0) return fail('Terraform verification failed: the generated Terraform did not change.', after, newFindings);
  const expect = rule.autoFix!.terraformExpect;
  if (expect && !diff.added.some((l) => expect.test(l))) return fail(`Terraform verification failed: expected ${expect} in the regenerated Terraform.`, after, newFindings);

  return {
    findingId, ruleId: plan.ruleId, plan, before: finding, after, newFindings,
    nodes: patched, edges,
    status: 'RESOLVED',
    reason: `Verified: ${plan.ruleId} now evaluates to ${after.status}; Terraform updated (${diff.added.length} line(s) added, ${diff.removed.length} removed).`,
    appliedAt: opts.now ?? new Date().toISOString(),
  };
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

/** Apply SAFE_AUTOFIX findings sequentially; each fix is verified independently and rolled back on failure. */
export function applySafeFixes(nodes: CanvasNode[], edges: CanvasEdge[], findingIds?: string[], now?: string): BulkFixSummary {
  const initial = runAssessment({ nodes, edges });
  const ids = (findingIds ?? safeFixCandidates(initial.findings).map((f) => f.findingId))
    .filter((id) => safeFixCandidates(initial.findings).some((f) => f.findingId === id));
  let current = nodes;
  const results: AutoFixResult[] = [];
  for (const id of ids) {
    const r = applyAutoFix(current, edges, id, { now });
    results.push(r);
    if (r.status === 'RESOLVED') current = r.nodes;
  }
  return {
    results, nodes: current, edges,
    resolved: results.filter((r) => r.status === 'RESOLVED').length,
    failed: results.filter((r) => r.status === 'AUTO_FIX_FAILED').length,
  };
}
