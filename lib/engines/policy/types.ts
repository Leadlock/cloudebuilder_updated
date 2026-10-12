/**
 * Organization policy — the rules an organization wants every architecture to follow.
 *
 * A policy is a set of constraints, not a set of findings: "production runs only in ap-south-1", "every taggable resource carries
 * CostCenter". Evaluating a policy against an architecture (evaluate.ts) yields violations. For now violations are WARNINGS only —
 * nothing is blocked — so an organization can roll a policy out and see its impact before enforcing anything.
 *
 * An empty rule means "no restriction": a missing or empty policy never produces a violation.
 */

export interface TagRequirement {
  /** Tag key, matched exactly (AWS and Azure tag keys are case-sensitive). */
  key: string;
  /** When set, the tag's value must be one of these. When omitted, any non-empty value is accepted. */
  allowedValues?: string[];
}

export interface OrgPolicyRules {
  /** Regions resources may be placed in (AWS `ap-south-1`, Azure `centralindia`, …). Empty = any region. */
  approvedRegions: string[];
  /** Allowed instance sizes as case-insensitive patterns where `*` matches anything: `t3.*`, `db.t3.*`, `Standard_B*`. Empty = any size. */
  allowedInstanceTypes: string[];
  /** Tags every taggable resource must carry. */
  requiredTags: TagRequirement[];
  /** Regular expression a resource name must match, e.g. `^(prod|stg|dev)-[a-z0-9-]+$`. Empty = any name. */
  namingPattern: string;
}

export interface OrgPolicy extends OrgPolicyRules {
  /** Increases by one on every save. */
  version: number;
  updatedAt?: string;
  updatedBy?: string;
}

export const EMPTY_POLICY_RULES: OrgPolicyRules = {
  approvedRegions: [],
  allowedInstanceTypes: [],
  requiredTags: [],
  namingPattern: '',
};

export type PolicyRuleId = 'POLICY-REGION' | 'POLICY-INSTANCE-TYPE' | 'POLICY-TAG' | 'POLICY-NAMING';

export interface PolicyViolation {
  ruleId: PolicyRuleId;
  /** Violations are advisory for now; `block` will be added when enforcement exists. */
  severity: 'warning';
  resourceId: string;
  resourceLabel: string;
  resourceType: string;
  message: string;
  /** What the policy allows, in words. */
  expected: string;
  /** What the resource has. */
  actual: string;
}

/** The slice of a canvas node the policy needs (keeps the evaluator independent of the canvas types). */
export interface PolicyNode {
  id: string;
  label: string;
  resourceType: string;
  region?: string;
  config: Record<string, unknown>;
}
