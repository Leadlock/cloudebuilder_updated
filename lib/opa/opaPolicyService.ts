/**
 * OPA Policy Service: manages policy lifecycle, custom Rego policies,
 * and runs evaluations against plans, canvas graphs, and cost estimates.
 */

import { orgPolicyRepository } from '@/lib/repositories/orgPolicyRepository';
import { BUILT_IN_OPA_POLICIES } from './builtInPolicies';
import { evaluateOpaPolicies } from './regoEngine';
import type { OpaEvaluationInput, OpaEvaluationResult, OpaPolicyDefinition } from './types';

export class OpaPolicyService {
  /**
   * Retrieves all policies for the given organization (built-ins + custom).
   */
  public async getPolicies(orgId?: string): Promise<OpaPolicyDefinition[]> {
    if (!orgId) return [...BUILT_IN_OPA_POLICIES];

    try {
      const orgPolicy = await orgPolicyRepository.get(orgId);
      if (!orgPolicy) return [...BUILT_IN_OPA_POLICIES];

      // Custom policies or overrides stored in extended policyJson
      const anyRules = orgPolicy as any;
      const customPolicies: OpaPolicyDefinition[] = Array.isArray(anyRules.opaPolicies)
        ? anyRules.opaPolicies
        : [];

      // Merge overrides on built-in policies
      const disabledSet = new Set<string>(anyRules.disabledPolicyIds ?? []);

      const activeBuiltIns = BUILT_IN_OPA_POLICIES.map((p) => ({
        ...p,
        enabled: !disabledSet.has(p.id),
      }));

      return [...activeBuiltIns, ...customPolicies];
    } catch {
      return [...BUILT_IN_OPA_POLICIES];
    }
  }

  /**
   * Evaluates input against all applicable policies.
   */
  public async evaluate(input: OpaEvaluationInput, orgId?: string): Promise<OpaEvaluationResult> {
    const policies = await this.getPolicies(orgId);
    return evaluateOpaPolicies(policies, input);
  }

  /**
   * Saves updated policy definitions (toggles or custom policies) for an organization.
   */
  public async savePolicyOverrides(
    orgId: string,
    overrides: { disabledPolicyIds?: string[]; customPolicies?: OpaPolicyDefinition[] },
    userId: string,
  ): Promise<OpaPolicyDefinition[]> {
    const current = (await orgPolicyRepository.get(orgId)) ?? ({} as any);

    const updated = {
      ...current,
      disabledPolicyIds: overrides.disabledPolicyIds ?? (current as any).disabledPolicyIds ?? [],
      opaPolicies: overrides.customPolicies ?? (current as any).opaPolicies ?? [],
    };

    await orgPolicyRepository.save(orgId, updated, userId);
    return this.getPolicies(orgId);
  }
}

export const opaPolicyService = new OpaPolicyService();
