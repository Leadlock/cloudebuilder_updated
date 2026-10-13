/**
 * The "Container service" canvas node: its definition, how the form and the node turn into each other, cost, review, Terraform,
 * relationships and the organization policy.
 */
import { getResourceDefinition } from '@/lib/resources';
import { defaultConfig, generateContainerFiles } from '@/lib/engines/containers/dockerTemplates';
import { containerConfigFromNode, defaultNodeConfig, encodeContainerConfig, nodeConfigFromContainer, nodeProblems } from '@/lib/engines/containers/nodeConfig';
import { awsPricingProvider } from '@/lib/engines/cost/awsPricing';
import { generateCanonicalTerraform } from '@/lib/engines/assessment/autofix';
import { runAssessment, findingIdFor } from '@/lib/engines/assessment/AssessmentEngine';
import { relationshipEngine } from '@/lib/engines/relationship/RelationshipEngine';
import { evaluateOrgPolicy } from '@/lib/engines/policy/evaluate';
import { EMPTY_POLICY_RULES } from '@/lib/engines/policy/types';
import { CATALOG_TYPES, ARCHITECT_SYSTEM_PROMPT } from '@/lib/ai/architectureSpec';
import { sendToContainerTemplates, takeContainerHandoff } from '@/components/panels/containerHandoff';
import { servicesForResourceType } from '@/lib/terraform/execution/deployPermissions';
import type { CanvasNode, CanvasEdge } from '@/types';

const T = 'aws_container_service';
let seq = 0;
function node(type: string, over: Record<string, unknown> = {}, extra: Partial<CanvasNode> = {}): CanvasNode {
  const def = getResourceDefinition(type)!;
  const id = extra.id ?? `n-${type}-${++seq}`;
  return { id, type: 'cloudNode', resourceType: type, provider: 'aws', label: extra.label ?? `${def.label} ${seq}`, position: { x: 0, y: 0 }, config: { ...def.defaultConfig, ...over }, ...extra } as CanvasNode;
}
const edge = (a: CanvasNode, b: CanvasNode): CanvasEdge => ({ id: `e-${a.id}-${b.id}`, source: a.id, target: b.id });

describe('definition', () => {
  const def = getResourceDefinition(T)!;
  it('is a compute resource that fits in a subnet, with the same defaults the node config helper gives', () => {
    expect(def.provider).toBe('aws');
    expect(def.category).toBe('compute');
    expect(getResourceDefinition('aws_subnet')!.allowedChildren).toContain(T);
    expect(def.defaultConfig).toEqual(defaultNodeConfig());
  });
  it('every default is a valid choice of its own field, and the default node is a valid configuration', () => {
    for (const f of def.configSchema) {
      if (f.options) expect(f.options.map((o) => o.value)).toContain(def.defaultConfig[f.key]);
    }
    expect(nodeProblems(def.defaultConfig)).toEqual([]);
  });
  it('starts private, not open to the internet, with a version tag', () => {
    expect(def.defaultConfig['allowedCidr']).toBe('10.0.0.0/16');
    expect(def.defaultConfig['imageTag']).not.toBe('latest');
  });
  it('is not offered to the AI architect, and the AI prompt does not change', () => {
    expect(CATALOG_TYPES).not.toContain(T);
    expect(ARCHITECT_SYSTEM_PROMPT).not.toContain(T);
  });
});

describe('form <-> node', () => {
  it('round-trips the form state, and never carries a secret value', () => {
    const c = { ...defaultConfig('python'), appName: 'orders-api', port: 8000, env: [{ key: 'LOG_LEVEL', value: 'info' }, { key: 'API_TOKEN', value: 'should-not-travel', secret: true }] };
    c.ec2 = { ...c.ec2, enabled: true, instanceType: 't3.medium', volumeGb: 40, imageTag: 'v7', allowedCidr: '10.1.0.0/16' };
    const n = nodeConfigFromContainer(c);
    expect(JSON.stringify(n)).not.toContain('should-not-travel');
    const back = containerConfigFromNode(n);
    expect(back).toMatchObject({ stack: 'python', appName: 'orders-api', port: 8000 });
    expect(back.ec2).toMatchObject({ enabled: true, instanceType: 't3.medium', volumeGb: 40, imageTag: 'v7', allowedCidr: '10.1.0.0/16' });
    expect(back.env).toEqual([{ key: 'LOG_LEVEL', value: 'info' }, { key: 'API_TOKEN', value: '', secret: true }]);
  });
  it('the plain fields win over the stored JSON, because the properties panel edits those', () => {
    const n = { ...nodeConfigFromContainer({ ...defaultConfig('node'), appName: 'a' }), port: 4000, instanceType: 't3.large', stack: 'java' };
    const back = containerConfigFromNode(n);
    expect(back.port).toBe(4000);
    expect(back.ec2.instanceType).toBe('t3.large');
    expect(back.stack).toBe('java');
  });
  it('the stored form survives the escaping every design string gets before Terraform (quotes, backslashes, ${})', () => {
    const c = { ...defaultConfig('node'), appName: 'a', env: [{ key: 'X', value: 'q"uote \\ back ${y} %{z} ünï' }] };
    const blob = nodeConfigFromContainer(c)['containerConfig'] as string;
    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(containerConfigFromNode({ containerConfig: blob }).env).toEqual(c.env);
    expect(containerConfigFromNode({ containerConfig: 'not base64 !!' })).toEqual(containerConfigFromNode({}));
  });
  it('a form that had another deployment target switched on still gives a valid EC2 node', () => {
    const c = { ...defaultConfig('node'), appName: 'a' };
    c.ecs = { ...c.ecs, enabled: true };
    const back = containerConfigFromNode(nodeConfigFromContainer(c));
    expect([back.ec2.enabled, back.ecs.enabled, back.aca.enabled, back.k8s.enabled]).toEqual([true, false, false, false]);
    expect(nodeProblems(nodeConfigFromContainer(c))).toEqual([]);
  });
  it('a node with only some fields fills the rest from safe defaults', () => {
    const c = containerConfigFromNode({ name: 'site' });
    expect(c.ec2.allowedCidr).toBe('10.0.0.0/16');
    expect(c.ec2.enabled).toBe(true);
    expect(generateContainerFiles(c).ok).toBe(true);
  });
  it('reports invalid settings instead of generating anything', () => {
    expect(nodeProblems({ ...defaultNodeConfig(), name: 'Bad Name!' }).join(' ')).toMatch(/App name/);
    expect(nodeProblems({ ...defaultNodeConfig(), port: 70000 }).length).toBeGreaterThan(0);
    expect(nodeProblems({ ...defaultNodeConfig(), allowedCidr: 'everyone' }).length).toBeGreaterThan(0);
  });
  it('hands a configuration to Container Templates exactly once', () => {
    const c = defaultConfig('node');
    sendToContainerTemplates(c, 'node-1');
    expect(takeContainerHandoff()).toEqual({ config: c, nodeId: 'node-1' });
    expect(takeContainerHandoff()).toBeNull();
  });
});

describe('cost', () => {
  const price = (c: Record<string, unknown>) => awsPricingProvider.estimateResource({ id: 'r', label: 'r', resourceType: T, provider: 'aws' } as never, { ...defaultNodeConfig(), ...c }, 'us-east-1')!;
  it('is the instance plus its disk at list price', () => {
    const p = price({ instanceType: 't3.small', storageGb: 20 });
    expect(p.monthlyUsd).toBeCloseTo(15.184 + 1.6, 2);
    expect(p.breakdown.map((b) => b.label)).toEqual(['EC2 t3.small (on-demand, Linux)', 'EBS gp3 storage (20GB)']);
  });
  it('adds the public IPv4 charge only for a fixed public IP', () => {
    expect(price({ elasticIp: true }).monthlyUsd - price({ elasticIp: false }).monthlyUsd).toBeCloseTo(3.65, 2);
  });
  it('a bigger instance costs more', () => {
    expect(price({ instanceType: 'm5.large' }).monthlyUsd).toBeGreaterThan(price({ instanceType: 't3.small' }).monthlyUsd);
  });
});

describe('review', () => {
  const statusOf = (n: CanvasNode, ruleId: string) => runAssessment({ nodes: [n], edges: [] }).evaluations.find((e) => e.ruleId === ruleId && e.resourceIds[0] === n.id)?.status;
  it('the default node passes all of its rules', () => {
    const n = node(T);
    for (const id of ['AWS-CTR-001', 'AWS-CTR-002', 'AWS-CTR-003', 'AWS-CTR-004']) expect(statusOf(n, id)).toBe('PASS');
  });
  it('each rule fails on the setting it is about', () => {
    expect(statusOf(node(T, { runAsNonRoot: false }), 'AWS-CTR-001')).toBe('FAIL');
    expect(statusOf(node(T, { allowedCidr: '0.0.0.0/0' }), 'AWS-CTR-002')).toBe('FAIL');
    expect(statusOf(node(T, { scanImage: false }), 'AWS-CTR-003')).toBe('FAIL');
    expect(statusOf(node(T, { imageTag: 'latest' }), 'AWS-CTR-004')).toBe('FAIL');
  });
  it('an open database port is rated higher than an open web port', () => {
    const sev = (port: number) => {
      const n = node(T, { allowedCidr: '0.0.0.0/0', port });
      return runAssessment({ nodes: [n], edges: [] }).findings.find((f) => f.findingId === findingIdFor('AWS-CTR-002', n.id))?.severity;
    };
    expect(sev(5432)).toBe('HIGH');
    expect(sev(3000)).toBe('MEDIUM');
  });
});

describe('Terraform', () => {
  const vpc = () => node('aws_vpc', { cidrBlock: '10.0.0.0/16' }, { id: 'vpc' });
  const sub = () => node('aws_subnet', { cidrBlock: '10.0.1.0/24' }, { id: 'sub', groupId: 'vpc' });
  const tf = (over: Record<string, unknown> = {}, nodes?: CanvasNode[]) => generateCanonicalTerraform(nodes ?? [vpc(), sub(), node(T, { name: 'orders-api', ...over }, { groupId: 'sub' })], []);

  it('creates the instance, its repository, role and a security group for the app port', () => {
    const out = tf();
    for (const r of ['aws_instance', 'aws_ecr_repository', 'aws_iam_role', 'aws_iam_role_policy', 'aws_iam_instance_profile', 'aws_security_group']) expect(out).toContain(`resource "${r}"`);
    expect(out).toMatch(/subnet_id\s+= aws_subnet\.\w+\.id/);
    expect(out).toMatch(/vpc_id\s+= aws_subnet\.\w+\.vpc_id/);
    expect(out).toContain('cidr_blocks = ["10.0.0.0/16"]');
  });
  it('is safe by default: IMDSv2 only, encrypted disk, scan on push, no SSH, no key pair, no password', () => {
    const out = tf();
    expect(out).toContain('http_tokens   = "required"');
    expect(out).toMatch(/encrypted\s*=\s*true/);
    expect(out).toContain('scan_on_push = true');
    expect(out).not.toMatch(/from_port\s*=\s*22\b/);
    expect(out).not.toContain('key_name');
    const start = out.indexOf('data "aws_ssm_parameter"');
    const mine = out.slice(start, out.indexOf('\n# ── ', start) === -1 ? undefined : out.indexOf('\n# ── ', start));
    // "get-login-password" and "--password-stdin" are the ECR login commands, not a stored password.
    expect(mine.replace('get-login-password', '').replace('--password-stdin', '')).not.toMatch(/password/i);
  });
  it('the start-up script cannot start a Terraform interpolation, and the heredoc is closed', () => {
    const out = tf({ name: 'orders-api' });
    const body = out.slice(out.indexOf('<<-EOT'), out.indexOf('EOT\n', out.indexOf('<<-EOT') + 6));
    expect(body).not.toMatch(/(?<!\$)\$\{/);
    expect(body).not.toMatch(/%\{/);
    expect((out.match(/<<-EOT/g) ?? []).length).toBe(1);
  });
  it('escapes an interpolation even if one reaches the script (a plain env value with ${x})', () => {
    const cfg = { name: 'orders-api', containerConfig: encodeContainerConfig({ ...defaultConfig('node'), appName: 'orders-api', env: [{ key: 'GREETING', value: 'hi ${HOME} %{x}' }] }) };
    const out = generateCanonicalTerraform([node(T, cfg)], []);
    const body = out.slice(out.indexOf('<<-EOT'), out.indexOf('EOT\n', out.indexOf('<<-EOT') + 6));
    expect(body).toContain('GREETING=hi $${HOME} %%{x}');
    expect(body).not.toMatch(/(?<!\$)\$\{/);
  });
  it('uses the connected security group instead of making one, and adds a fixed IP only when asked', () => {
    const sg = node('aws_sg', {}, { id: 'mysg', groupId: 'vpc' });
    const app = node(T, { name: 'orders-api' }, { groupId: 'sub' });
    const out = generateCanonicalTerraform([vpc(), sub(), sg, app], [edge(sg, app)]);
    expect(out).not.toContain('resource "aws_security_group" "orders_api"');
    expect(tf()).not.toContain('aws_eip');
    expect(tf({ elasticIp: true })).toContain('resource "aws_eip" "orders_api"');
  });
  it('an invalid node is left out with a comment saying why, never half-generated', () => {
    const out = tf({ name: 'Bad Name!' });
    expect(out).toContain('was not generated');
    expect(out).not.toContain('resource "aws_ecr_repository"');
  });
  it('works without a subnet (default VPC)', () => {
    const out = generateCanonicalTerraform([node(T, { name: 'site' })], []);
    expect(out).toContain('resource "aws_instance" "site"');
    expect(out).not.toContain('subnet_id');
  });
  it('its resource types are known to the deploy role builder', () => {
    for (const t of ['aws_instance', 'aws_ecr_repository', 'aws_iam_role', 'aws_iam_role_policy', 'aws_iam_instance_profile', 'aws_eip', 'data.aws_ssm_parameter']) expect(servicesForResourceType(t)).not.toBeNull();
  });
});

describe('relationships and policy', () => {
  it('a load balancer can send traffic to it and it can reach a database, like an EC2 instance', () => {
    const alb = node('aws_alb'); const app = node(T); const rds = node('aws_rds');
    expect(relationshipEngine.validateConnection(alb, app, [alb, app]).isValid).toBe(true);
    expect(relationshipEngine.validateConnection(app, rds, [app, rds]).isValid).toBe(true);
    expect(relationshipEngine.validateConnection(alb, rds, [alb, rds]).isValid).toBe(false);
  });
  it('the organization instance-type policy applies to it', () => {
    const n = node(T, { instanceType: 'm5.large' });
    const v = evaluateOrgPolicy([{ id: n.id, label: n.label, resourceType: T, config: n.config }], { ...EMPTY_POLICY_RULES, allowedInstanceTypes: ['t3.*'] });
    expect(v.map((x) => x.ruleId)).toContain('POLICY-INSTANCE-TYPE');
  });
});
