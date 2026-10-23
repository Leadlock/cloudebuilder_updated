import { evaluateOpaPolicies, RegoInterpreter } from '@/lib/opa/regoEngine';
import { BUILT_IN_OPA_POLICIES } from '@/lib/opa/builtInPolicies';
import type { OpaEvaluationInput } from '@/lib/opa/types';

describe('OPA / Rego Policy as Code Engine', () => {
  it('detects world-open SSH rule in Terraform plan', async () => {
    const input: OpaEvaluationInput = {
      plan: {
        resource_changes: [
          {
            address: 'aws_security_group_rule.ssh_inbound',
            type: 'aws_security_group_rule',
            change: {
              actions: ['create'],
              after: {
                type: 'ingress',
                from_port: 22,
                to_port: 22,
                cidr_blocks: ['0.0.0.0/0'],
              },
            },
          },
        ],
      },
    };

    const sshPolicy = BUILT_IN_OPA_POLICIES.find((p) => p.id === 'sec-open-admin-ports')!;
    const interpreter = new RegoInterpreter();
    const violations = interpreter.evaluatePolicy(sshPolicy, input);

    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].severity).toBe('deny');
    expect(violations[0].resourceAddress).toBe('aws_security_group_rule.ssh_inbound');
  });

  it('detects monthly budget ceiling violation', async () => {
    const input: OpaEvaluationInput = {
      cost: {
        monthlyTotalUsd: 2150,
        annualTotalUsd: 25800,
        currency: 'USD',
      },
    };

    const budgetPolicy = BUILT_IN_OPA_POLICIES.find((p) => p.id === 'cost-monthly-budget-ceiling')!;
    const interpreter = new RegoInterpreter();
    const violations = interpreter.evaluatePolicy(budgetPolicy, input);

    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain('exceeds organization budget limit');
  });

  it('detects database destruction blast radius violation', async () => {
    const input: OpaEvaluationInput = {
      plan: {
        resource_changes: [
          {
            address: 'aws_db_instance.main_postgres',
            type: 'aws_db_instance',
            change: {
              actions: ['delete'],
            },
          },
        ],
      },
    };

    const dbDestroyPolicy = BUILT_IN_OPA_POLICIES.find((p) => p.id === 'blast-deny-database-destruction')!;
    const interpreter = new RegoInterpreter();
    const violations = interpreter.evaluatePolicy(dbDestroyPolicy, input);

    expect(violations.length).toBe(1);
    expect(violations[0].severity).toBe('deny');
    expect(violations[0].message).toContain('destruction of stateful database');
  });

  it('passes when no policies are violated', async () => {
    const input: OpaEvaluationInput = {
      plan: {
        resource_changes: [
          {
            address: 'aws_security_group_rule.https_inbound',
            type: 'aws_security_group_rule',
            change: {
              actions: ['create'],
              after: {
                type: 'ingress',
                from_port: 443,
                to_port: 443,
                cidr_blocks: ['0.0.0.0/0'],
              },
            },
          },
        ],
      },
      cost: {
        monthlyTotalUsd: 140,
        annualTotalUsd: 1680,
        currency: 'USD',
      },
    };

    const result = await evaluateOpaPolicies(BUILT_IN_OPA_POLICIES, input);
    expect(result.passed).toBe(true);
    expect(result.violations.length).toBe(0);
  });
});
