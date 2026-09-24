/**
 * Compatibility layer for callers that still address fixes by rule ID.
 *
 * Remediation patches now live on the assessment rules themselves
 * (lib/engines/assessment/rules), so the fix, the check and the Terraform
 * verification can never drift apart. Legacy rule IDs are resolved through
 * LEGACY_RULE_IDS. New code should use lib/engines/assessment/autofix, which
 * also enforces safety levels and verifies the result.
 */
import { RULES_BY_ID, resolveRuleId } from '@/lib/engines/assessment/rules';
import type { AssessResource } from '@/lib/engines/assessment/types';

function ruleFor(ruleId: string) {
  const id = resolveRuleId(ruleId);
  return id ? RULES_BY_ID.get(id) : undefined;
}

/** True when the rule has a deterministic configuration fix that is not MANUAL_ONLY by definition. */
export function isRuleFixable(ruleId: string): boolean {
  const rule = ruleFor(ruleId);
  if (!rule?.autoFix || rule.scope !== 'resource') return false;
  return typeof rule.autoFix.safety === 'function' || rule.autoFix.safety !== 'MANUAL_ONLY';
}

/** Apply the rule's configuration patch (no verification — prefer applyAutoFix). */
export function applyRuleRemediation(
  config: Record<string, unknown>,
  ruleId: string,
  resource?: Partial<AssessResource>,
): Record<string, unknown> {
  const rule = ruleFor(ruleId);
  if (!rule || !isRuleFixable(ruleId)) return config;
  const r: AssessResource = {
    id: resource?.id ?? 'resource', label: resource?.label ?? 'resource', resourceType: resource?.resourceType ?? rule.resourceTypes?.[0] ?? '',
    provider: rule.provider, config, importState: resource?.importState,
  };
  return { ...config, ...rule.autoFix!.patch(config, r) };
}
