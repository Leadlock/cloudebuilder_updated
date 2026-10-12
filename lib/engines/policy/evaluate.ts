/**
 * Evaluate an organization policy against an architecture. Pure: no I/O, so it runs identically in the browser (live warnings on the
 * canvas) and on the server (reports, and later enforcement at deploy).
 *
 * A rule only speaks when it has evidence. A resource with no region is not "outside the approved regions"; a resource type that has
 * no instance-size field is not "using a disallowed size". Missing data is never a violation.
 */
import { getResourceDefinition } from '@/lib/resources';
import { INSTANCE_SIZE_FIELD, isInstanceSizeAllowed, isRegionAllowed, providerOf } from './allowed';
import type { OrgPolicyRules, PolicyNode, PolicyViolation } from './types';

export { globToRegExp, matchesAny } from './allowed';

/** Placeholders and region boundaries are not deployable resources, so naming and tag rules do not apply to them. */
const NON_RESOURCE = /_(boundary|unsupported|unknown)$/;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function tagsOf(config: Record<string, unknown>): Record<string, string> {
  const raw = config['tags'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = typeof v === 'string' ? v : String(v ?? '');
  return out;
}

function isTaggable(resourceType: string): boolean {
  return Boolean(getResourceDefinition(resourceType)?.configSchema.some((f) => f.key === 'tags'));
}

export function evaluateOrgPolicy(nodes: PolicyNode[], rules: OrgPolicyRules | null | undefined): PolicyViolation[] {
  if (!rules) return [];
  const violations: PolicyViolation[] = [];

  let naming: RegExp | null = null;
  if (rules.namingPattern) {
    try { naming = new RegExp(rules.namingPattern); } catch { naming = null; } // an invalid stored pattern restricts nothing
  }

  for (const node of nodes) {
    const base = { severity: 'warning' as const, resourceId: node.id, resourceLabel: node.label, resourceType: node.resourceType };
    const deployable = !NON_RESOURCE.test(node.resourceType);

    // Region
    const region = node.region || str(node.config['region']);
    if (region && !isRegionAllowed(rules, providerOf(node.resourceType), region)) {
      violations.push({
        ...base, ruleId: 'POLICY-REGION',
        message: `${node.label} is in ${region}, which is not an approved region.`,
        expected: `One of: ${rules.approvedRegions.join(', ')}`, actual: region,
      });
    }

    // Instance size
    const sizeField = INSTANCE_SIZE_FIELD[node.resourceType];
    if (sizeField) {
      const size = str(node.config[sizeField.key]);
      if (size && !isInstanceSizeAllowed(rules, node.resourceType, sizeField.key, size)) {
        violations.push({
          ...base, ruleId: 'POLICY-INSTANCE-TYPE',
          message: `${node.label} uses ${size}, which is not an allowed ${sizeField.label}.`,
          expected: `Matching: ${rules.allowedInstanceTypes.join(', ')}`, actual: size,
        });
      }
    }

    // Required tags
    if (deployable && rules.requiredTags.length > 0 && isTaggable(node.resourceType)) {
      const tags = tagsOf(node.config);
      for (const req of rules.requiredTags) {
        const value = (tags[req.key] ?? '').trim();
        if (value === '') {
          violations.push({
            ...base, ruleId: 'POLICY-TAG',
            message: `${node.label} is missing the required tag "${req.key}".`,
            expected: req.allowedValues?.length ? `${req.key} = ${req.allowedValues.join(' | ')}` : `${req.key} set to any value`, actual: 'Not set',
          });
        } else if (req.allowedValues?.length && !req.allowedValues.includes(value)) {
          violations.push({
            ...base, ruleId: 'POLICY-TAG',
            message: `${node.label} has tag "${req.key}" = "${value}", which is not an approved value.`,
            expected: `${req.key} = ${req.allowedValues.join(' | ')}`, actual: `${req.key} = ${value}`,
          });
        }
      }
    }

    // Naming
    if (naming && deployable) {
      const name = (str(node.config['name']) || node.label).slice(0, 256);
      if (!naming.test(name)) {
        violations.push({
          ...base, ruleId: 'POLICY-NAMING',
          message: `${node.label}: the name "${name}" does not follow the naming standard.`,
          expected: `Matches ${rules.namingPattern}`, actual: name,
        });
      }
    }
  }

  return violations;
}

/** Violations grouped by resource id — what the properties panel and canvas badges need. */
export function groupByResource(violations: PolicyViolation[]): Map<string, PolicyViolation[]> {
  const map = new Map<string, PolicyViolation[]>();
  for (const v of violations) map.set(v.resourceId, [...(map.get(v.resourceId) ?? []), v]);
  return map;
}
