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
  /** Coverage-aware security score; null when no security check could be evaluated. */
  score: number | null;
}
