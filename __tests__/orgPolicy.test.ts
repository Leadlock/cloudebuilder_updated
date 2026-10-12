/**
 * Organization policy (lib/engines/policy): evaluation and validation.
 * The policy is advisory for now — every violation is a warning, and an empty policy restricts nothing.
 */
import { evaluateOrgPolicy, globToRegExp, groupByResource } from '@/lib/engines/policy/evaluate';
import { OrgPolicyRulesSchema, parseStoredRules } from '@/lib/engines/policy/schema';
import { EMPTY_POLICY_RULES, type OrgPolicyRules, type PolicyNode } from '@/lib/engines/policy/types';
import { isInstanceSizeAllowed, isRegionAllowed, regionsRestrict } from '@/lib/engines/policy/allowed';

let seq = 0;
function node(resourceType: string, config: Record<string, unknown> = {}, over: Partial<PolicyNode> = {}): PolicyNode {
  seq += 1;
  return { id: `n${seq}`, label: over.label ?? `res-${seq}`, resourceType, config, ...over };
}
const rules = (over: Partial<OrgPolicyRules>): OrgPolicyRules => ({ ...EMPTY_POLICY_RULES, ...over });
const ids = (nodes: PolicyNode[], r: OrgPolicyRules) => evaluateOrgPolicy(nodes, r).map((v) => v.ruleId);

describe('empty policy', () => {
  it('restricts nothing', () => {
    const nodes = [node('aws_ec2', { instanceType: 'x1e.32xlarge' }, { region: 'eu-west-1' })];
    expect(evaluateOrgPolicy(nodes, EMPTY_POLICY_RULES)).toEqual([]);
    expect(evaluateOrgPolicy(nodes, null)).toEqual([]);
    expect(evaluateOrgPolicy(nodes, undefined)).toEqual([]);
  });
});

describe('approved regions', () => {
  const r = rules({ approvedRegions: ['ap-south-1', 'centralindia'] });

  it('flags a resource outside the approved regions, as a warning', () => {
    const [v] = evaluateOrgPolicy([node('aws_ec2', {}, { region: 'us-east-1', label: 'web' })], r);
    expect(v).toMatchObject({ ruleId: 'POLICY-REGION', severity: 'warning', resourceLabel: 'web', actual: 'us-east-1' });
    expect(v.expected).toContain('ap-south-1');
  });

  it('accepts AWS and Azure regions that are listed', () => {
    expect(ids([node('aws_ec2', {}, { region: 'ap-south-1' }), node('azure_vm', {}, { region: 'centralindia' })], r)).toEqual([]);
  });

  it('reads the region from the config when the node has none', () => {
    expect(ids([node('aws_s3', { region: 'eu-west-1' })], r)).toEqual(['POLICY-REGION']);
  });

  it('says nothing about a resource that has no region', () => {
    expect(ids([node('aws_s3')], r)).toEqual([]);
  });
});

describe('allowed instance types', () => {
  const r = rules({ allowedInstanceTypes: ['t3.*', 'db.t3.*', 'Standard_B*'] });

  it('flags a size that matches no pattern', () => {
    const [v] = evaluateOrgPolicy([node('aws_ec2', { instanceType: 'm5.4xlarge' })], r);
    expect(v).toMatchObject({ ruleId: 'POLICY-INSTANCE-TYPE', actual: 'm5.4xlarge' });
  });

  it('accepts matching sizes across EC2, RDS and Azure VMs (case-insensitive)', () => {
    const nodes = [
      node('aws_ec2', { instanceType: 't3.medium' }),
      node('aws_rds', { instanceClass: 'db.t3.large' }),
      node('azure_vm', { size: 'standard_b2s' }),
    ];
    expect(ids(nodes, r)).toEqual([]);
  });

  it('checks the right field for each resource type', () => {
    expect(ids([node('aws_rds', { instanceClass: 'db.r5.large' }), node('azure_vmss', { sku: 'Standard_D4s_v5' })], r))
      .toEqual(['POLICY-INSTANCE-TYPE', 'POLICY-INSTANCE-TYPE']);
  });

  it('ignores resource types that have no size, and resources with no size set', () => {
    expect(ids([node('aws_s3', { instanceType: 'm5.4xlarge' }), node('aws_ec2', {})], r)).toEqual([]);
  });

  it('treats everything except * literally', () => {
    expect(globToRegExp('t3.*').test('t3.medium')).toBe(true);
    expect(globToRegExp('t3.*').test('t3xmedium')).toBe(false); // "." is not a wildcard
    expect(globToRegExp('t3.*').test('xt3.medium')).toBe(false); // anchored
  });
});

describe('required tags', () => {
  const r = rules({ requiredTags: [{ key: 'CostCenter' }, { key: 'Environment', allowedValues: ['prod', 'dev'] }] });

  it('flags every missing tag on a taggable resource', () => {
    const vs = evaluateOrgPolicy([node('aws_ec2', { tags: {} })], r);
    expect(vs.map((v) => v.ruleId)).toEqual(['POLICY-TAG', 'POLICY-TAG']);
    expect(vs[0].message).toContain('CostCenter');
  });

  it('flags a value that is not approved, and an empty value as missing', () => {
    const vs = evaluateOrgPolicy([node('aws_ec2', { tags: { CostCenter: ' ', Environment: 'qa' } })], r);
    expect(vs.map((v) => v.message)).toEqual([
      expect.stringContaining('missing the required tag "CostCenter"'),
      expect.stringContaining('not an approved value'),
    ]);
  });

  it('passes a fully tagged resource', () => {
    expect(ids([node('aws_ec2', { tags: { CostCenter: '1234', Environment: 'prod' } })], r)).toEqual([]);
  });

  it('does not apply to resource types that cannot carry tags', () => {
    expect(ids([node('aws_igw', {}), node('aws_unknown', {}), node('aws_cloud_boundary', {})], r)).toEqual([]);
  });
});

describe('naming pattern', () => {
  const r = rules({ namingPattern: '^(prod|dev)-[a-z0-9-]+$' });

  it('flags a name that does not match, using config.name over the label', () => {
    const [v] = evaluateOrgPolicy([node('aws_ec2', { name: 'MyServer' }, { label: 'prod-web' })], r);
    expect(v).toMatchObject({ ruleId: 'POLICY-NAMING', actual: 'MyServer' });
  });

  it('falls back to the label and accepts a matching name', () => {
    expect(ids([node('aws_ec2', {}, { label: 'prod-web-1' })], r)).toEqual([]);
  });

  it('does not apply to placeholders and boundaries', () => {
    expect(ids([node('aws_cloud_boundary', {}, { label: 'AWS' })], r)).toEqual([]);
  });

  it('restricts nothing when a stored pattern is not a valid expression', () => {
    expect(ids([node('aws_ec2', {}, { label: 'x' })], rules({ namingPattern: '([' }))).toEqual([]);
  });
});

describe('groupByResource', () => {
  it('groups violations under the resource they concern', () => {
    const a = node('aws_ec2', { instanceType: 'm5.large', tags: {} }, { region: 'us-east-1' });
    const grouped = groupByResource(evaluateOrgPolicy([a], rules({ approvedRegions: ['ap-south-1'], allowedInstanceTypes: ['t3.*'], requiredTags: [{ key: 'Owner' }] })));
    expect(grouped.get(a.id)?.map((v) => v.ruleId).sort()).toEqual(['POLICY-INSTANCE-TYPE', 'POLICY-REGION', 'POLICY-TAG']);
  });
});

describe('policy validation', () => {
  const valid = { approvedRegions: ['ap-south-1'], allowedInstanceTypes: ['t3.*'], requiredTags: [{ key: 'Owner' }], namingPattern: '^prod-' };

  it('accepts a well-formed policy and the empty policy', () => {
    expect(OrgPolicyRulesSchema.safeParse(valid).success).toBe(true);
    expect(OrgPolicyRulesSchema.safeParse(EMPTY_POLICY_RULES).success).toBe(true);
  });

  it('rejects an invalid naming pattern, so a pattern that matches nothing can never be saved', () => {
    expect(OrgPolicyRulesSchema.safeParse({ ...valid, namingPattern: '([' }).success).toBe(false);
  });

  it('rejects duplicate tag keys and blank entries', () => {
    expect(OrgPolicyRulesSchema.safeParse({ ...valid, requiredTags: [{ key: 'Owner' }, { key: 'Owner' }] }).success).toBe(false);
    expect(OrgPolicyRulesSchema.safeParse({ ...valid, approvedRegions: [' '] }).success).toBe(false);
  });

  it('parseStoredRules falls back to no restriction for unreadable data', () => {
    expect(parseStoredRules(null)).toEqual(EMPTY_POLICY_RULES);
    expect(parseStoredRules('not json')).toEqual(EMPTY_POLICY_RULES);
    expect(parseStoredRules(JSON.stringify({ approvedRegions: 'oops' }))).toEqual(EMPTY_POLICY_RULES);
    expect(parseStoredRules(JSON.stringify(valid))).toEqual(valid);
  });
});

describe('allowed choices (what the dropdowns grey out)', () => {
  const r = rules({ approvedRegions: ['ap-south-1'], allowedInstanceTypes: ['t3.*', 'db.t3.*'] });

  it('allows everything when there is no policy or the rule is empty', () => {
    expect(isRegionAllowed(null, 'aws', 'eu-west-1')).toBe(true);
    expect(isRegionAllowed(EMPTY_POLICY_RULES, 'aws', 'eu-west-1')).toBe(true);
    expect(isInstanceSizeAllowed(null, 'aws_ec2', 'instanceType', 'm5.large')).toBe(true);
    expect(isInstanceSizeAllowed(EMPTY_POLICY_RULES, 'aws_ec2', 'instanceType', 'm5.large')).toBe(true);
  });

  it('allows only approved regions for a cloud the policy names', () => {
    expect(isRegionAllowed(r, 'aws', 'ap-south-1')).toBe(true);
    expect(isRegionAllowed(r, 'aws', 'us-east-1')).toBe(false);
  });

  it('says nothing about a cloud the policy does not name', () => {
    expect(regionsRestrict(r, 'aws')).toBe(true);
    expect(regionsRestrict(r, 'azure')).toBe(false);
    expect(isRegionAllowed(r, 'azure', 'eastus')).toBe(true); // an AWS-only region list does not grey out every Azure region
    expect(isRegionAllowed(rules({ approvedRegions: ['centralindia'] }), 'aws', 'us-east-1')).toBe(true);
  });

  it('restricts instance sizes only on the size field of a sized resource', () => {
    expect(isInstanceSizeAllowed(r, 'aws_ec2', 'instanceType', 't3.medium')).toBe(true);
    expect(isInstanceSizeAllowed(r, 'aws_ec2', 'instanceType', 'm5.large')).toBe(false);
    expect(isInstanceSizeAllowed(r, 'aws_rds', 'instanceClass', 'db.r5.large')).toBe(false);
    expect(isInstanceSizeAllowed(r, 'aws_ec2', 'keyName', 'anything')).toBe(true); // a different field
    expect(isInstanceSizeAllowed(r, 'aws_s3', 'instanceType', 'm5.large')).toBe(true); // a resource with no size field
  });

  it('agrees with the warnings: whatever is greyed out is what would be flagged', () => {
    for (const size of ['t3.medium', 'm5.large', 'c5.xlarge']) {
      const flagged = evaluateOrgPolicy([node('aws_ec2', { instanceType: size })], r).length > 0;
      expect(isInstanceSizeAllowed(r, 'aws_ec2', 'instanceType', size)).toBe(!flagged);
    }
    for (const region of ['ap-south-1', 'us-east-1']) {
      const flagged = evaluateOrgPolicy([node('aws_ec2', {}, { region })], r).length > 0;
      expect(isRegionAllowed(r, 'aws', region)).toBe(!flagged);
    }
  });

  it('does not flag an Azure resource when the policy lists only AWS regions', () => {
    expect(ids([node('azure_vm', {}, { region: 'eastus' })], r)).toEqual([]);
    expect(ids([node('aws_ec2', {}, { region: 'us-east-1' })], rules({ approvedRegions: ['centralindia'] }))).toEqual([]);
  });
});
