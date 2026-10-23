/**
 * OPA / Rego Policy as Code definitions for CloudBuilder.
 */

export type PolicySeverity = 'deny' | 'warn' | 'info';
export type PolicyCategory = 'security' | 'cost' | 'blast_radius' | 'compliance' | 'reliability';

export interface OpaViolation {
  id: string;
  ruleTitle: string;
  severity: PolicySeverity;
  category: PolicyCategory;
  resourceAddress?: string;
  resourceType?: string;
  message: string;
  remediation?: string;
  docUrl?: string;
}

export interface OpaPolicyDefinition {
  id: string;
  name: string;
  description: string;
  category: PolicyCategory;
  severity: PolicySeverity;
  enabled: boolean;
  isBuiltIn: boolean;
  regoCode: string;
  metadata?: {
    benchmark?: string;
    cisControl?: string;
    costImpact?: string;
  };
}

export interface OpaEvaluationInput {
  plan?: {
    resource_changes?: Array<{
      address: string;
      type: string;
      mode?: string;
      change: {
        actions: string[];
        before?: Record<string, unknown> | null;
        after?: Record<string, unknown> | null;
        after_unknown?: Record<string, unknown> | null;
      };
    }>;
    configuration?: {
      provider_config?: Record<string, { expressions?: Record<string, { constant_value?: unknown }> }>;
    };
  };
  canvas?: {
    nodes: Array<{
      id: string;
      label: string;
      resourceType: string;
      provider?: string;
      config: Record<string, unknown>;
    }>;
    edges?: Array<{
      id: string;
      source: string;
      target: string;
      edgeType?: string;
    }>;
  };
  cost?: {
    monthlyTotalUsd: number;
    annualTotalUsd: number;
    deltaMonthlyUsd?: number;
    currency: string;
    resourceCosts?: Array<{
      nodeId: string;
      monthlyCostUsd: number;
    }>;
  };
  environment?: string;
  user?: {
    id: string;
    role: string;
    email?: string;
  };
}

export interface OpaEvaluationResult {
  passed: boolean;
  violations: OpaViolation[];
  warnings: OpaViolation[];
  infos: OpaViolation[];
  rulesEvaluated: number;
  durationMs: number;
  evaluatedAt: string;
}
