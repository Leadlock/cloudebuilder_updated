import { soc2Rules, hipaaRules, pciRules, type ComplianceRule, type ComplianceFinding } from './rules';
import type { CanvasNode } from '@/types';

export interface ComplianceResultItem {
  ruleId: string;
  framework: 'SOC2' | 'HIPAA' | 'PCI-DSS';
  controlId: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'pass' | 'fail';
  affectedResourceIds: string[];
  /** Exact config values/conditions that triggered this finding */
  evidence: string[];
  recommendation: string;
  remediation: string;
  /** Official documentation reference URL */
  reference: string;
  /** Cloud providers covered by this finding */
  providers: string[];
}

export interface ComplianceAssessmentResult {
  score: number;
  totalRules: number;
  passing: number;
  failing: number;
  results: ComplianceResultItem[];
}

export class ComplianceEngine {
  /**
   * Evaluates the architecture against selected compliance frameworks.
   * Findings are based on actual resource configurations — not generic placeholders.
   */
  static async evaluateArchitecture(
    projectId: string,
    architectureId: string,
    resources: CanvasNode[],
    frameworks: ('SOC2' | 'HIPAA' | 'PCI-DSS')[]
  ): Promise<ComplianceAssessmentResult> {
    const rulesToRun: ComplianceRule[] = [];
    if (frameworks.includes('SOC2')) rulesToRun.push(...soc2Rules);
    if (frameworks.includes('HIPAA')) rulesToRun.push(...hipaaRules);
    if (frameworks.includes('PCI-DSS')) rulesToRun.push(...pciRules);

    const results: ComplianceResultItem[] = rulesToRun.map(rule => {
      const finding: ComplianceFinding = rule.evaluate(resources);
      return {
        ruleId: rule.id,
        framework: rule.framework,
        controlId: rule.controlId,
        title: rule.title,
        description: rule.description,
        severity: rule.severity,
        status: finding.passed ? 'pass' : 'fail',
        affectedResourceIds: finding.affectedResourceIds,
        evidence: finding.evidence,
        recommendation: finding.recommendation,
        remediation: finding.remediation,
        reference: rule.reference,
        providers: finding.providers,
      };
    });

    const failing = results.filter(r => r.status === 'fail');
    const passing = results.filter(r => r.status === 'pass');

    // Weighted score: critical=30pts, high=15pts, medium=8pts, low=3pts
    const weights: Record<string, number> = { critical: 30, high: 15, medium: 8, low: 3 };
    const maxDeduction = 100;
    const totalDeduction = failing.reduce((sum, r) => sum + (weights[r.severity] ?? 5), 0);
    const score = Math.max(0, 100 - Math.min(totalDeduction, maxDeduction));

    // Persist to DB if available (graceful degradation if DB is down)
    if (architectureId && architectureId !== 'draft') {
      try {
        const { db } = await import('../../../src/prisma/db');

      await Promise.all(frameworks.map(async (framework) => {
        const frameworkResults = results.filter(r => r.framework === framework);
        const frameworkFailed = frameworkResults.filter(r => r.status === 'fail');
        const frameworkScore = Math.max(0, 100 - frameworkFailed.reduce((sum, r) => sum + (weights[r.severity] ?? 5), 0));

        const assessment = await db.orm.public.ComplianceAssessment.create({
          id: crypto.randomUUID(),
          projectId,
          architectureId,
          framework,
          overallScore: frameworkScore,
          createdAt: new Date().toISOString(),
        });

        await Promise.all(frameworkResults
          .filter((result) => result.status === 'fail')
          .map((result) => db.orm.public.ComplianceFinding.create({
            id: crypto.randomUUID(),
            assessmentId: assessment.id,
            ruleId: result.ruleId,
            controlId: result.controlId,
            severity: result.severity,
            title: result.title,
            description: result.description,
            affectedResourceIds: JSON.stringify(result.affectedResourceIds),
            recommendation: result.recommendation,
            remediation: result.remediation,
            createdAt: new Date().toISOString(),
          })));
      }));
      } catch (err) {
        // DB unavailable — return results without persisting
        console.warn('[ComplianceEngine] DB unavailable, findings not persisted:', (err as Error)?.message);
      }
    }

    return {
      score,
      totalRules: results.length,
      passing: passing.length,
      failing: failing.length,
      results,
    };
  }
}
