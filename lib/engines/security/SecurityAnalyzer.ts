/**
 * SecurityAnalyzer — server-side entry point for persisted security scans.
 *
 * Converts the persisted ArchitectureResource/ArchitectureConnection rows into
 * the canvas graph (architectureRepository.toCanvas — the same mapping used to
 * load the canvas) and runs the unified assessment engine. The previous
 * standalone rule set (awsRules.ts / azureRules.ts) read config keys that do not
 * exist in CloudBuilder (e.g. `transparentDataEncryption`, `diskEncryption`,
 * `blockPublicAccess`) and fired NSG rules without checking the source address;
 * it has been removed in favour of the shared engine.
 */
import type { SecurityAnalysisInput, SecurityScanResult, SecurityFinding, FindingSeverity } from './types';
import { toCanvas } from '@/lib/domain/canvasMapping';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import type { AssessmentResult, FindingReview } from '@/lib/engines/assessment/types';

export class SecurityAnalyzer {
  assess(input: SecurityAnalysisInput & { reviews?: FindingReview[] }): AssessmentResult {
    const { nodes, edges } = toCanvas(input.resources, input.connections);
    return runAssessment({ nodes, edges, reviews: input.reviews });
  }

  analyze(input: SecurityAnalysisInput & { reviews?: FindingReview[] }): SecurityScanResult & { assessment: AssessmentResult } {
    const assessment = this.assess(input);
    const findings: SecurityFinding[] = assessment.findings
      .filter((f) => f.domain === 'SECURITY')
      .map((f) => ({
        id: f.findingId,
        ruleId: f.ruleId,
        severity: f.severity === 'INFORMATIONAL' ? 'info' : (f.severity.toLowerCase() as FindingSeverity),
        title: f.title,
        description: f.description,
        resourceId: f.resourceIds[0] ?? '',
        provider: f.provider,
        resourceType: f.resourceType ?? '',
        remediation: f.recommendation,
        meta: { status: f.status, evidence: f.evidence, observation: f.observation, autoFix: f.autoFix, references: f.references.map((r) => r.key) },
      }));
    return { findings, score: assessment.securityScore.score, assessment };
  }
}

export const securityAnalyzer = new SecurityAnalyzer();
