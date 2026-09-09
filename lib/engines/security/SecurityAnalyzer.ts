/**
 * SecurityAnalyzer — real rule-based security engine for Phase 2D.
 *
 * Source of truth: persisted ArchitectureResource/ArchitectureConnection rows.
 * Findings are deterministic: identical inputs produce identical outputs.
 * No finding is emitted when the relevant config field is absent/unknown.
 */
import { createHash } from 'crypto';
import type { SecurityAnalysisInput, SecurityScanResult, SecurityFinding } from './types';
import { SEVERITY_WEIGHTS } from './types';
import { awsSecurityRules } from './awsRules';
import { azureSecurityRules } from './azureRules';
import type { SecurityRule } from './types';

// ─── All rules ───────────────────────────────────────────────────────────────

const ALL_RULES: SecurityRule[] = [...awsSecurityRules, ...azureSecurityRules];

// ─── Deterministic finding ID ────────────────────────────────────────────────

function findingId(ruleId: string, resourceId: string): string {
  return createHash('sha256')
    .update(`${ruleId}:${resourceId}`)
    .digest('hex')
    .substring(0, 16);
}

// ─── Analyzer ────────────────────────────────────────────────────────────────

export class SecurityAnalyzer {
  analyze(input: SecurityAnalysisInput): SecurityScanResult {
    const findings: SecurityFinding[] = [];

    for (const resource of input.resources) {
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(resource.configJson) as Record<string, unknown>;
      } catch {
        config = {};
      }

      for (const rule of ALL_RULES) {
        const raw = rule.check(resource, config, input);
        if (raw !== null) {
          findings.push({
            ...raw,
            id: findingId(rule.ruleId, resource.id),
          });
        }
      }
    }

    const score = this._calculateScore(findings);
    return { findings, score };
  }

  private _calculateScore(findings: SecurityFinding[]): number {
    if (findings.length === 0) return 100;
    const totalDeduction = findings.reduce(
      (acc, f) => acc + (SEVERITY_WEIGHTS[f.severity] ?? 0),
      0,
    );
    return Math.max(0, 100 - totalDeduction);
  }
}

export const securityAnalyzer = new SecurityAnalyzer();
