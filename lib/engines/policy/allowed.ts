/**
 * "Is this choice allowed by the organization policy?" — the one place that answers it.
 *
 * The same answers drive the warnings (evaluate.ts) and the greyed-out options in the dropdowns, so what a user is told is wrong and what
 * they are prevented from picking can never disagree. Nothing here blocks anything; callers decide what to do with a "no".
 *
 * A rule only speaks about what it names. A region policy that lists only AWS regions says nothing about Azure; an empty rule allows all.
 */
import { AUTHORITATIVE_AWS_REGIONS, AUTHORITATIVE_AZURE_REGIONS } from '@/lib/cloud/regions/CloudRegionService';
import type { OrgPolicyRules } from './types';

export type PolicyProvider = 'aws' | 'azure';

/** Which configuration field holds the instance size, per resource type. */
export const INSTANCE_SIZE_FIELD: Record<string, { key: string; label: string }> = {
  aws_ec2: { key: 'instanceType', label: 'instance type' },
  aws_auto_scaling: { key: 'instanceType', label: 'instance type' },
  aws_container_service: { key: 'instanceType', label: 'instance type' },
  aws_rds: { key: 'instanceClass', label: 'instance class' },
  aws_elasticache: { key: 'nodeType', label: 'node type' },
  azure_vm: { key: 'size', label: 'VM size' },
  azure_container_service: { key: 'vmSize', label: 'VM size' },
  azure_vmss: { key: 'sku', label: 'VM size' },
};

const REGION_IDS: Record<PolicyProvider, Set<string>> = {
  aws: new Set(AUTHORITATIVE_AWS_REGIONS.map((r) => r.id)),
  azure: new Set(AUTHORITATIVE_AZURE_REGIONS.map((r) => r.id)),
};

export const providerOf = (resourceType: string): PolicyProvider => (resourceType.startsWith('azure') ? 'azure' : 'aws');

/** `t3.*` → /^t3\..*$/i — `*` is the only wildcard; everything else is literal. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(value));
}

/** True when the policy restricts regions for this cloud, i.e. it names at least one of the cloud's regions. */
export function regionsRestrict(rules: OrgPolicyRules | null | undefined, provider: PolicyProvider): boolean {
  return Boolean(rules?.approvedRegions.some((r) => REGION_IDS[provider].has(r)));
}

export function isRegionAllowed(rules: OrgPolicyRules | null | undefined, provider: PolicyProvider, region: string): boolean {
  if (!rules || !regionsRestrict(rules, provider)) return true;
  return rules.approvedRegions.includes(region);
}

/** Whether `value` may be chosen for this field. Only instance-size fields are restricted; every other field allows everything. */
export function isInstanceSizeAllowed(rules: OrgPolicyRules | null | undefined, resourceType: string, fieldKey: string, value: string): boolean {
  if (!rules || rules.allowedInstanceTypes.length === 0) return true;
  if (INSTANCE_SIZE_FIELD[resourceType]?.key !== fieldKey) return true;
  return matchesAny(value, rules.allowedInstanceTypes);
}
