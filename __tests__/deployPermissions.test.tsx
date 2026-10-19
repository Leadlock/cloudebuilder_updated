import { renderToStaticMarkup } from 'react-dom/server';
import { parseAccessDenied, buildDeployPolicy, servicesForResourceType } from '@/lib/terraform/execution/deployPermissions';
import { explainTerraformError } from '@/lib/terraform/execution/errorHints';
import { ApplyProgressTracker, newQueuedRecord, type RunProgressRecord } from '@/lib/terraform/execution/applyProgress';
import { maybeCreatedResources, createdResources } from '@/components/panels/CreatedResourcesList';
import TerraformPermissionHelp from '@/components/panels/TerraformPermissionHelp';

// Trimmed from the real failure: the connected role could only read, so every create was refused.
const REAL = `terraform apply failed (exit 1): Error: creating EC2 VPC: operation error EC2: CreateVpc, https response error StatusCode: 403, RequestID: a197fd25, api error UnauthorizedOperation: You are not authorized to perform this operation. User: arn:aws:sts::460195068628:assumed-role/CloudBuilder/cloudbuilder-terraform-execution is not authorized to perform: ec2:CreateVpc on resource: arn:aws:ec2:us-east-1:460195068628:vpc/* because no identity-based policy allows the ec2:CreateVpc action. Encoded authorization failure message: YVMihtes0uYgu with aws_vpc.production_vpc, on main.tf line 8: Error: creating ECS Cluster: AccessDeniedException: User: arn:aws:sts::460195068628:assumed-role/CloudBuilder/cloudbuilder-terraform-execution is not authorized to perform: ecs:CreateCluster on resource: arn:aws:ecs:us-east-1:460195068628:cluster/x because no identity-based policy allows the ecs:CreateCluster action Error: creating CloudWatch Logs Log Group: User: arn:aws:sts::460195068628:assumed-role/CloudBuilder/cloudbuilder-terraform-execution is not authorized to perform: logs:CreateLogGroup on resource: x Error: creating IAM Role: AccessDenied: User: arn:aws:sts::460195068628:assumed-role/CloudBuilder/cloudbuilder-terraform-execution is not authorized to perform: iam:CreateRole on resource: x`;

describe('parseAccessDenied', () => {
  test('reads the refused actions and the role from the real error', () => {
    const d = parseAccessDenied(REAL)!;
    expect(d.actions).toEqual(['ec2:CreateVpc', 'ecs:CreateCluster', 'logs:CreateLogGroup', 'iam:CreateRole']);
    expect(d.roleName).toBe('CloudBuilder');
    expect(d.accountId).toBe('460195068628');
  });
  test('repeats collapse, and other errors give null', () => {
    expect(parseAccessDenied('x is not authorized to perform: ec2:CreateVpc and is not authorized to perform: ec2:CreateVpc')!.actions).toEqual(['ec2:CreateVpc']);
    expect(parseAccessDenied('Error: Reference to undeclared resource')).toBeNull();
    expect(parseAccessDenied('')).toBeNull();
    expect(parseAccessDenied(undefined)).toBeNull();
  });
});

describe('buildDeployPolicy', () => {
  const planTypes = ['aws_vpc', 'aws_subnet', 'aws_ecs_cluster', 'aws_cloudwatch_log_group', 'aws_dynamodb_table', 'aws_sqs_queue', 'aws_iam_role', 'aws_iam_role_policy_attachment'];

  test('covers exactly the services in the plan, and nothing else', () => {
    const p = buildDeployPolicy(planTypes);
    expect(p.services).toEqual(['dynamodb', 'ec2', 'ecs', 'iam', 'logs', 'sqs']);
    const doc = JSON.parse(p.json) as { Statement: { Action: string[] }[] };
    const actions = doc.Statement.flatMap((s) => s.Action);
    for (const a of ['ec2:*', 'ecs:*', 'logs:*', 'dynamodb:*', 'sqs:*', 'iam:CreateRole', 'iam:PassRole', 'iam:AttachRolePolicy']) expect(actions).toContain(a);
    expect(actions).not.toContain('s3:*');
    expect(actions).not.toContain('iam:*');           // IAM is limited to managing roles, policies and instance profiles
    expect(actions.filter((a) => /^iam:(CreateUser|CreateAccessKey|DeleteUser|PutUserPolicy)/.test(a))).toEqual([]);
  });

  test('it covers the actions the real failure was refused', () => {
    const actions = JSON.parse(buildDeployPolicy(planTypes).json).Statement.flatMap((s: { Action: string[] }) => s.Action) as string[];
    const covered = (a: string) => actions.includes(a) || actions.includes(`${a.split(':')[0]}:*`);
    for (const a of parseAccessDenied(REAL)!.actions) expect(covered(a)).toBe(true);
  });

  test('IAM is only included when the plan creates IAM resources', () => {
    expect(buildDeployPolicy(['aws_vpc']).includesIam).toBe(false);
    expect(JSON.stringify(JSON.parse(buildDeployPolicy(['aws_vpc']).json))).not.toContain('iam:');
    expect(buildDeployPolicy(['aws_iam_role']).includesIam).toBe(true);
  });

  test('unknown types are reported, not guessed', () => {
    expect(buildDeployPolicy(['aws_vpc', 'aws_made_up_thing']).unknownTypes).toEqual(['aws_made_up_thing']);
  });

  test('the longest matching prefix wins (a log group is logs, not cloudwatch)', () => {
    expect(servicesForResourceType('aws_cloudwatch_log_group')).toEqual(['logs']);
    expect(servicesForResourceType('aws_cloudwatch_metric_alarm')).toEqual(['cloudwatch']);
    expect(servicesForResourceType('aws_vpc_endpoint')).toEqual(['ec2']);
    expect(servicesForResourceType('azurerm_virtual_network')).toBeNull();
  });

  test('stays under the 10,240-character inline policy limit even with every service', () => {
    const all = ['aws_vpc', 'aws_ecs_cluster', 'aws_eks_cluster', 'aws_lambda_function', 'aws_db_instance', 'aws_elasticache_cluster', 'aws_lb', 'aws_autoscaling_group', 'aws_cloudfront_distribution', 'aws_wafv2_web_acl', 'aws_route53_zone', 'aws_kms_key', 'aws_iam_role', 'aws_s3_bucket', 'aws_sqs_queue', 'aws_dynamodb_table', 'aws_sns_topic'];
    expect(buildDeployPolicy(all).json.replace(/\s/g, '').length).toBeLessThan(10_240);
  });
});

describe('failures caused by missing permission', () => {
  const PLANNED = [{ address: 'aws_vpc.main', type: 'aws_vpc' }, { address: 'aws_ecs_cluster.c', type: 'aws_ecs_cluster' }, { address: 'aws_s3_bucket.b', type: 'aws_s3_bucket' }];
  const OUTPUT = [
    'aws_vpc.main: Creating...', 'aws_ecs_cluster.c: Creating...', 'aws_s3_bucket.b: Creating...', 'aws_s3_bucket.b: Creation complete after 1s [id=b]',
    '╷', '│ Error: creating EC2 VPC: operation error EC2: CreateVpc, api error UnauthorizedOperation:', '│ You are not authorized to perform this operation. User: arn:aws:sts::1:assumed-role/CloudBuilder/x is not authorized to perform: ec2:CreateVpc', '│ ', '│   with aws_vpc.main,', '│   on main.tf line 8, in resource "aws_vpc" "main":', '╵',
    '╷', '│ Error: creating ECS Cluster: InvalidParameterException: the name is not valid', '│ ', '│   with aws_ecs_cluster.c,', '╵',
  ].join('\n') + '\n';
  const rec = (): RunProgressRecord => {
    const t = new ApplyProgressTracker(PLANNED); t.feed(OUTPUT); t.finish(false);
    return { ...newQueuedRecord({ runId: 'r', orgId: 'o', projectId: 'p' }, PLANNED), status: 'failed', ...t.snapshot() };
  };

  test('a permission refusal is marked denied; another failure is not', () => {
    const by = Object.fromEntries(rec().resources.map((r) => [r.address, r]));
    expect(by['aws_vpc.main']).toMatchObject({ state: 'failed', denied: true });
    expect(by['aws_vpc.main']!.error).toMatch(/UnauthorizedOperation/);
    expect(by['aws_ecs_cluster.c']).toMatchObject({ state: 'failed', denied: false });
  });

  test('a refused resource was never created, so it is not listed as "may exist"; a different failure still is', () => {
    expect(maybeCreatedResources(rec()).map((r) => r.address)).toEqual(['aws_ecs_cluster.c']);
    expect(createdResources(rec()).map((r) => r.address)).toEqual(['aws_s3_bucket.b']);
  });
});

describe('error explanation', () => {
  test('a permission refusal gets its own plain explanation with the role and actions', () => {
    const e = explainTerraformError(REAL)!;
    expect(e.kind).toBe('insufficient-permissions');
    expect(e.summary).toContain('"CloudBuilder"');
    expect(e.summary).toContain('ec2:CreateVpc');
    expect(e.summary).toMatch(/nothing was created/);
  });
  test('other credential problems keep the generic explanation', () => {
    expect(explainTerraformError('ExpiredToken: the security token included in the request is expired')!.kind).toBe('credentials');
  });
});

describe('TerraformPermissionHelp', () => {
  test('leads with the simple fix (one built-in AWS policy, nothing to write) and keeps the narrower policy underneath', () => {
    const html = renderToStaticMarkup(<TerraformPermissionHelp message={REAL} resourceTypes={['aws_vpc', 'aws_ecs_cluster', 'aws_iam_role']} />);
    expect(html).toContain('CloudBuilder');
    expect(html).toContain('AdministratorAccess');
    expect(html).toContain('Nothing to write or paste');
    expect(html.indexOf('AdministratorAccess')).toBeLessThan(html.indexOf('ecs:*'));   // the simple way comes before the custom policy
    expect(html).toContain('<details');                                              // and the custom policy is folded away
    expect(html).toContain('Create inline policy');
    expect(html).toContain('can grant itself more access');
  });
  test('renders nothing for a failure that is not about permissions', () => {
    expect(renderToStaticMarkup(<TerraformPermissionHelp message="Error: Reference to undeclared resource" resourceTypes={['aws_vpc']} />)).toBe('');
  });
});
