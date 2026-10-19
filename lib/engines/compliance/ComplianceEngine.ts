import { soc2Rules, hipaaRules, pciRules, type ComplianceRule, type ComplianceFramework } from './rules';
import type { CanvasEdge, CanvasNode } from '@/types';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import type { Evaluation } from '@/lib/engines/assessment/types';

/**
 * Status of the technical indicators mapped to a framework control area.
 *  - 'fail': at least one mapped technical check fails or warns.
 *  - 'pass': mapped checks were evaluated and none failed — technical indicators
 *            only; this is NOT a statement that the control is met.
 *  - 'not_evaluated': no mapped check could be evaluated from the architecture.
 */
export type ComplianceStatus = 'pass' | 'fail' | 'not_evaluated';

export interface ComplianceResultItem {
  ruleId: string;
  framework: ComplianceFramework;
  controlId: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: ComplianceStatus;
  affectedResourceIds: string[];
  affectedResourceLabels: string[];
  /** Technical evidence lines: "<finding ID> — <observation>". */
  evidence: string[];
  notEvaluated: string[];
  recommendation: string;
  remediation: string;
  reference: string;
  providers: string[];
  mappedAssessmentRules: string[];
}

export interface ComplianceAssessmentResult {
  /** Share of evaluated control areas with no failing technical indicator; null when none could be evaluated. */
  score: number | null;
  totalRules: number;
  passing: number;
  failing: number;
  notEvaluated: number;
  results: ComplianceResultItem[];
  disclaimer: string;
}

export const COMPLIANCE_DISCLAIMER =
  'Technical indicator mapping only. CloudBuilder is not an auditor, QSA or assessor and does not determine SOC 2, HIPAA or PCI DSS compliance. ' +
  '"Technical indicators passed" means the mapped architecture checks that could be evaluated did not fail; organizational, procedural and ' +
  'operating-effectiveness requirements are not assessed.';

export function evaluateControls(rules: ComplianceRule[], evaluations: Evaluation[]): ComplianceResultItem[] {
  return rules.map((rule) => {
    const evals = evaluations.filter((e) => rule.assessmentRules.includes(e.ruleId));
    const failing = evals.filter((e) => e.status === 'FAIL' || e.status === 'WARNING');
    const evaluated = evals.filter((e) => e.status === 'PASS' || e.status === 'FAIL' || e.status === 'WARNING');
    const unknown = evals.filter((e) => e.status === 'NOT_EVALUATED' || e.status === 'INSUFFICIENT_DATA');
    const status: ComplianceStatus = failing.length > 0 ? 'fail' : evaluated.length > 0 ? 'pass' : 'not_evaluated';
    return {
      ruleId: rule.id,
      framework: rule.framework,
      controlId: rule.controlId,
      title: rule.title,
      description: rule.description,
      severity: rule.severity,
      status,
      affectedResourceIds: Array.from(new Set(failing.flatMap((e) => e.resourceIds))),
      affectedResourceLabels: Array.from(new Set(failing.flatMap((e) => e.resourceLabels))),
      evidence: (status === 'fail' ? failing : evaluated).slice(0, 25).map((e) => `${e.findingId} — ${e.observation}`),
      notEvaluated: Array.from(new Set(unknown.map((e) => `${e.ruleId}: ${e.requiredData ?? e.observation}`))),
      recommendation: status === 'fail'
        ? `Resolve the ${failing.length} failing technical check(s) listed as evidence.`
        : status === 'pass' ? 'No failing technical indicators. Organizational controls still require assessor review.'
          : 'Provide the evidence listed under "Not evaluated" to assess this control area.',
      remediation: 'See the linked CloudBuilder findings for resource-specific remediation and Auto-Fix availability.',
      reference: rule.reference,
      providers: Array.from(new Set(evals.map((e) => e.provider))),
      mappedAssessmentRules: rule.assessmentRules,
    };
  });
}

export class ComplianceEngine {
  static evaluate(nodes: CanvasNode[], edges: CanvasEdge[], frameworks: ComplianceFramework[]): ComplianceAssessmentResult {
    const rules: ComplianceRule[] = [];
    if (frameworks.includes('SOC2')) rules.push(...soc2Rules);
    if (frameworks.includes('HIPAA')) rules.push(...hipaaRules);
    if (frameworks.includes('PCI-DSS')) rules.push(...pciRules);
    const { evaluations } = runAssessment({ nodes, edges });
    const results = evaluateControls(rules, evaluations);
    const passing = results.filter((r) => r.status === 'pass').length;
    const failing = results.filter((r) => r.status === 'fail').length;
    const evaluated = passing + failing;
    return {
      score: evaluated === 0 ? null : Math.round((passing / evaluated) * 100),
      totalRules: results.length,
      passing,
      failing,
      notEvaluated: results.length - evaluated,
      results,
      disclaimer: COMPLIANCE_DISCLAIMER,
    };
  }

  /**
   * Evaluate and persist (best effort). Persistence stores failing control
   * areas as ComplianceFinding rows for history.
   */
  static async evaluateArchitecture(
    projectId: string,
    architectureId: string,
    nodes: CanvasNode[],
    frameworks: ComplianceFramework[],
    edges: CanvasEdge[] = [],
  ): Promise<ComplianceAssessmentResult> {
    const result = ComplianceEngine.evaluate(nodes, edges, frameworks);
    if (architectureId && architectureId !== 'draft') {
      try {
        const { db } = await import('../../../src/prisma/db');
        const now = new Date().toISOString();
        for (const framework of frameworks) {
          const items = result.results.filter((r) => r.framework === framework);
          const evaluated = items.filter((r) => r.status !== 'not_evaluated');
          const assessment = await db.orm.public.ComplianceAssessment.create({
            id: crypto.randomUUID(),
            projectId,
            architectureId,
            framework,
            overallScore: evaluated.length === 0 ? 0 : Math.round((evaluated.filter((r) => r.status === 'pass').length / evaluated.length) * 100),
            findingsJson: JSON.stringify(items),
            createdAt: now,
          });
          for (const item of items.filter((r) => r.status === 'fail')) {
            await db.orm.public.ComplianceFinding.create({
              id: crypto.randomUUID(),
              assessmentId: assessment.id,
              ruleId: item.ruleId,
              controlId: item.controlId,
              severity: item.severity,
              title: item.title,
              description: item.description,
              affectedResourceIds: JSON.stringify(item.affectedResourceIds),
              recommendation: item.recommendation,
              remediation: item.remediation,
              createdAt: now,
            });
          }
        }
      } catch (err) {
        console.warn('[ComplianceEngine] DB unavailable, results not persisted:', (err as Error)?.message);
      }
    }
    return result;
  }
}
