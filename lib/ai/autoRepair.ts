/**
 * Fixes a freshly generated design with CloudCraft's own verified remediations, instead of asking the model again.
 *
 * Most rejected designs fail on something mechanical that the assessment engine already knows how to fix ("subnet assigns public
 * IPs": set one setting to false). Sending that back to a language model is slow and unreliable; applying the rule's own fix is
 * exact. Each fix goes through applyAutoFix, which re-runs the rule, the validation and the Terraform check and refuses (leaving the
 * design unchanged) if a fix would make anything worse. Fixes that need a review are applied too, because nothing has been deployed
 * yet: the person sees what was changed. Only findings that would fail the deploy-readiness gate (MEDIUM or worse, or any with a
 * safe fix) are touched.
 */
import type { CanvasEdge, CanvasNode } from '@/types';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { applyAutoFix } from '@/lib/engines/assessment/autofix';

export interface AutoRepairResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Plain-language list of what was changed, e.g. "AWS-VPC-001 on Public Subnet A: Disable automatic public IP assignment." */
  applied: string[];
}

const MAX_ROUNDS = 4;
const MAX_FIXES = 40;

export function autoRepairGraph(nodes: CanvasNode[], edges: CanvasEdge[]): AutoRepairResult {
  let current = nodes;
  const applied: string[] = [];
  const triedAndFailed = new Set<string>();

  for (let round = 0; round < MAX_ROUNDS && applied.length < MAX_FIXES; round++) {
    const assessment = runAssessment({ nodes: current, edges });
    const candidates = assessment.findings.filter((f) =>
      (f.status === 'FAIL' || f.status === 'WARNING')
      && f.autoFix.available
      && !triedAndFailed.has(f.findingId)
      && (['CRITICAL', 'HIGH', 'MEDIUM'].includes(f.severity) || f.autoFix.safety === 'SAFE_AUTOFIX'));
    if (candidates.length === 0) break;

    let progressed = false;
    for (const finding of candidates) {
      const result = applyAutoFix(current, edges, finding.findingId, { confirmed: true });
      if (result.status === 'RESOLVED') {
        current = result.nodes;
        applied.push(`${finding.ruleId} on ${finding.resourceLabels.join(', ') || 'the architecture'}: ${result.plan?.description ?? finding.title}`);
        progressed = true;      // the graph changed; the next fix is verified against it
      } else if (result.status !== 'ALREADY_RESOLVED') triedAndFailed.add(finding.findingId);
    }
    if (!progressed) break;
  }
  return { nodes: current, edges, applied };
}
