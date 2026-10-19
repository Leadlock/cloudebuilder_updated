/**
 * What the AWS role needs in order to DEPLOY, built from the resources in the plan, and a reader for "not authorized" errors.
 *
 * CloudBuilder's role is read-only by default (it only needs to look at your account to import it). Terraform has to create things, so
 * the first apply fails with "User: …assumed-role/CloudBuilder/… is not authorized to perform: ec2:CreateVpc". Pure (no Node imports) so the
 * panel can use it in the browser.
 */

export interface AccessDenied {
  /** Distinct IAM actions AWS refused, in the order they appeared. */
  actions: string[];
  /** The role Terraform ran as ("CloudBuilder"), when the message names it. */
  roleName?: string;
  accountId?: string;
}

/** Reads AWS "not authorized to perform: service:Action" refusals out of Terraform's output. Returns null when there are none. */
export function parseAccessDenied(text: string | null | undefined): AccessDenied | null {
  const t = (text ?? '').replace(/\s+/g, ' ');
  const actions = [...new Set([...t.matchAll(/not authorized to perform:? ([a-z0-9-]+:[A-Za-z0-9*]+)/g)].map((m) => m[1]!))];
  if (actions.length === 0) return null;
  const role = /arn:aws:sts::(\d{12}):assumed-role\/([^/\s]+)\//.exec(t);
  return { actions, ...(role ? { accountId: role[1], roleName: role[2] } : {}) };
}

/** Terraform resource-type prefix → the IAM service whose actions create it. Longest prefix wins. */
const SERVICE_BY_PREFIX: [string, string[]][] = [
  ['aws_vpc', ['ec2']], ['aws_subnet', ['ec2']], ['aws_internet_gateway', ['ec2']], ['aws_nat_gateway', ['ec2']], ['aws_eip', ['ec2']],
  ['aws_route_table', ['ec2']], ['aws_route', ['ec2']], ['aws_security_group', ['ec2']], ['aws_network_acl', ['ec2']], ['aws_instance', ['ec2']],
  ['aws_launch_template', ['ec2']], ['aws_ebs', ['ec2']], ['aws_vpc_endpoint', ['ec2']], ['aws_flow_log', ['ec2', 'logs']], ['aws_key_pair', ['ec2']],
  ['aws_ecs', ['ecs']], ['aws_ecr', ['ecr']], ['aws_eks', ['eks', 'ec2']],
  ['aws_cloudwatch_log', ['logs']], ['aws_cloudwatch_metric', ['cloudwatch']], ['aws_cloudwatch_dashboard', ['cloudwatch']], ['aws_cloudwatch_event', ['events']],
  ['aws_dynamodb', ['dynamodb']], ['aws_sqs', ['sqs']], ['aws_sns', ['sns']], ['aws_s3', ['s3']],
  ['aws_lambda', ['lambda', 'logs']], ['aws_db', ['rds']], ['aws_rds', ['rds']], ['aws_elasticache', ['elasticache']],
  ['aws_lb', ['elasticloadbalancing']], ['aws_alb', ['elasticloadbalancing']], ['aws_autoscaling', ['autoscaling', 'ec2']],
  ['aws_appautoscaling', ['application-autoscaling']], ['aws_cloudfront', ['cloudfront']], ['aws_wafv2', ['wafv2']],
  ['aws_route53', ['route53']], ['aws_kms', ['kms']], ['aws_secretsmanager', ['secretsmanager']], ['aws_ssm', ['ssm']], ['aws_acm', ['acm']],
  ['aws_iam', ['iam']], ['data.aws_vpc', ['ec2']], ['data.aws_ssm', ['ssm']], ['data.aws_subnet', ['ec2']], ['data.aws_availability_zones', ['ec2']],
];

const IAM_ACTIONS = [
  'iam:CreateRole', 'iam:DeleteRole', 'iam:GetRole', 'iam:UpdateRole', 'iam:TagRole', 'iam:UntagRole', 'iam:PassRole',
  'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:GetRolePolicy',
  'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies', 'iam:ListInstanceProfilesForRole',
  'iam:CreatePolicy', 'iam:DeletePolicy', 'iam:GetPolicy', 'iam:GetPolicyVersion', 'iam:ListPolicyVersions', 'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion',
  'iam:CreateInstanceProfile', 'iam:DeleteInstanceProfile', 'iam:GetInstanceProfile', 'iam:AddRoleToInstanceProfile', 'iam:RemoveRoleFromInstanceProfile',
  'iam:CreateServiceLinkedRole',
];

/** The IAM service(s) a Terraform resource type needs, or null when CloudBuilder does not know the type. */
export function servicesForResourceType(type: string): string[] | null {
  let best: [string, string[]] | null = null;
  for (const entry of SERVICE_BY_PREFIX) if (type.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  return best ? best[1] : null;
}

export interface DeployPolicy {
  /** The JSON to paste as an inline policy on the role. */
  json: string;
  /** IAM services covered, e.g. ["ec2", "ecs", "iam", "logs"]. */
  services: string[];
  /** Resource types the plan contains that CloudBuilder could not map to a service (they may still be denied). */
  unknownTypes: string[];
  /** True when the policy lets the role create IAM roles: needed for this plan, and powerful. */
  includesIam: boolean;
}

/**
 * A policy for exactly the services in the plan: full access to each of those services (create, change, delete, tag, describe), and
 * nothing else. IAM is limited to managing roles, policies and instance profiles.
 */
export function buildDeployPolicy(resourceTypes: string[]): DeployPolicy {
  const services = new Set<string>();
  const unknown = new Set<string>();
  for (const type of resourceTypes) {
    const s = servicesForResourceType(type);
    if (s) s.forEach((x) => services.add(x)); else unknown.add(type);
  }
  const wildcard = [...services].filter((s) => s !== 'iam').sort().map((s) => `${s}:*`);
  const includesIam = services.has('iam');
  const statements: object[] = [];
  if (wildcard.length > 0) statements.push({ Sid: 'CloudBuilderDeployServices', Effect: 'Allow', Action: wildcard, Resource: '*' });
  if (includesIam) statements.push({ Sid: 'CloudBuilderDeployIamRoles', Effect: 'Allow', Action: IAM_ACTIONS, Resource: '*' });
  return {
    json: JSON.stringify({ Version: '2012-10-17', Statement: statements }, null, 2),
    services: [...services].sort(),
    unknownTypes: [...unknown].sort(),
    includesIam,
  };
}
