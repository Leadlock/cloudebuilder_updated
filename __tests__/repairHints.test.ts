import { withHints, withRuleHints, withConnectivityHints } from '@/lib/ai/repairHints';

describe('repair hints tell the model how to fix, not just what is wrong', () => {
  it('appends the rule\'s own remediation to an assessment finding', () => {
    const [out] = withRuleHints([{ code: 'ASSESSMENT', message: 'MEDIUM AWS-ELB-003: Internet-facing Application Load Balancer has no AWS WAF web ACL (API ALB)' }]);
    expect(out!.message).toContain('How to fix: ');
    expect(out!.message.length).toBeGreaterThan(120);
  });

  it('shows the Terraform setting a rule maps to when it has one', () => {
    const [out] = withRuleHints([{ code: 'ASSESSMENT', message: 'MEDIUM AWS-VPC-001: Subnet automatically assigns public IP addresses (Public Subnet A)' }]);
    expect(out!.message).toContain('map_public_ip_on_launch');
  });

  it('leaves messages without a rule id alone, and never adds a fix twice', () => {
    const plain = { code: 'X', message: 'Something unrelated happened' };
    expect(withRuleHints([plain])).toEqual([plain]);
    const once = withRuleHints([{ code: 'A', message: 'MEDIUM AWS-VPC-001: x' }]);
    expect(withRuleHints(once)).toEqual(once);
    expect(withRuleHints([{ code: 'A', message: 'MEDIUM ZZZ-NOPE-999: unknown rule' }])[0]!.message).toBe('MEDIUM ZZZ-NOPE-999: unknown rule');
  });

  it('adds one connection rule when anything is unconnected, and nothing otherwise', () => {
    const issues = [{ code: 'CONNECTIVITY', message: '"WAF" (aws_waf) is not connected to anything.' }, { code: 'CONNECTIVITY', message: 'split into disconnected parts' }];
    const out = withConnectivityHints(issues);
    expect(out).toHaveLength(3);
    expect(out[2]!.message).toContain('caller to callee');
    expect(withConnectivityHints([{ code: 'OTHER', message: 'x' }])).toHaveLength(1);
  });

  it('withHints applies all of them', () => {
    const out = withHints([{ code: 'ASSESSMENT', message: 'MEDIUM AWS-VPC-001: Subnet automatically assigns public IP addresses (A)' }, { code: 'CONNECTIVITY', message: 'x is not connected to anything.' }]);
    expect(out[0]!.message).toContain('How to fix');
    expect(out.some((i) => i.message.startsWith('Connection rule'))).toBe(true);
  });
});
