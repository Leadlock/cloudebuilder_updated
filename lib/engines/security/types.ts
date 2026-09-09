/**
 * Security Engine — shared types for Phase 2D real security analysis.
 */
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';

// ─── Input ────────────────────────────────────────────────────────────────────

export interface SecurityAnalysisInput {
  architectureId: string;
  projectId: string;
  versionId?: string;
  resources: DbArchitectureResource[];
  connections: DbArchitectureConnection[];
}

// ─── Finding ─────────────────────────────────────────────────────────────────

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface SecurityFinding {
  id: string;              // deterministic: ruleId + resourceId
  ruleId: string;          // e.g. AWS-S3-PUBLIC
  severity: FindingSeverity;
  title: string;
  description: string;
  resourceId: string;
  provider: string;
  resourceType: string;
  remediation: string;
  meta: Record<string, unknown>;
}

// ─── Scan result ─────────────────────────────────────────────────────────────

export interface SecurityScanResult {
  findings: SecurityFinding[];
  score: number;           // 0-100
}

// ─── Rule ────────────────────────────────────────────────────────────────────

export interface SecurityRule {
  ruleId: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  remediation: string;
  /**
   * Returns a finding if the rule fires, null if the resource passes.
   * May be called for every resource of the matching resourceTypes.
   */
  check(
    resource: DbArchitectureResource,
    config: Record<string, unknown>,
    context: SecurityAnalysisInput,
  ): Omit<SecurityFinding, 'id'> | null;
}

// ─── Weight map for score calculation ────────────────────────────────────────

export const SEVERITY_WEIGHTS: Record<FindingSeverity, number> = {
  critical: 25,
  high: 15,
  medium: 8,
  low: 3,
  info: 0,
};
