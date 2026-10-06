/**
 * What the AWS role needs to deploy THIS architecture, worked out before anything is planned or deployed.
 *
 * The services come from the Terraform CloudCraft would actually generate for the saved design (every resource and data type it
 * writes), not from a hand-kept list of canvas types, so the policy follows the design and cannot drift from the generator. The state
 * storage (S3 bucket, and DynamoDB for locking) is always included because every deployment keeps its state there.
 *
 * "Check my access" asks AWS, without creating anything, whether the role may perform one representative create action per service
 * (iam:SimulatePrincipalPolicy). If AWS will not answer that question for this role, the result is "cannot check", never a guess.
 */
import { buildDeployPolicy, type DeployPolicy } from './deployPermissions';

/** The Terraform resource and data types a set of generated files uses. */
export function terraformTypesIn(files: { filename: string; content: string }[]): string[] {
  const found = new Set<string>();
  for (const f of files) {
    if (!f.filename.endsWith('.tf')) continue;
    for (const m of f.content.matchAll(/^\s*resource\s+"(aws_[a-z0-9_]+)"/gm)) found.add(m[1]!);
    for (const m of f.content.matchAll(/^\s*data\s+"(aws_[a-z0-9_]+)"/gm)) found.add(`data.${m[1]}`);
  }
  return [...found].sort();
}

/** Types the remote state storage always needs, whatever the design contains. */
const STATE_TYPES = ['aws_s3_bucket', 'aws_dynamodb_table'];

export interface RequiredPermissions extends DeployPolicy {
  /** The Terraform types the design produces (for transparency). */
  terraformTypes: string[];
}

export function requiredPermissionsFor(files: { filename: string; content: string }[]): RequiredPermissions {
  const terraformTypes = terraformTypesIn(files);
  const policy = buildDeployPolicy([...terraformTypes, ...STATE_TYPES]);
  return { ...policy, terraformTypes };
}

/** One create action per service, enough to tell "can create things here" from "cannot". */
export const PROBE_ACTIONS: Record<string, string[]> = {
  ec2: ['ec2:CreateVpc', 'ec2:CreateSecurityGroup', 'ec2:RunInstances'],
  ecs: ['ecs:CreateCluster', 'ecs:CreateService'],
  eks: ['eks:CreateCluster'],
  ecr: ['ecr:CreateRepository'],
  rds: ['rds:CreateDBInstance', 'rds:CreateDBSubnetGroup'],
  elasticache: ['elasticache:CreateCacheCluster'],
  elasticloadbalancing: ['elasticloadbalancing:CreateLoadBalancer'],
  autoscaling: ['autoscaling:CreateAutoScalingGroup'],
  s3: ['s3:CreateBucket'],
  dynamodb: ['dynamodb:CreateTable'],
  sqs: ['sqs:CreateQueue'],
  sns: ['sns:CreateTopic'],
  lambda: ['lambda:CreateFunction'],
  logs: ['logs:CreateLogGroup'],
  cloudwatch: ['cloudwatch:PutMetricAlarm'],
  events: ['events:PutRule'],
  cloudfront: ['cloudfront:CreateDistribution'],
  wafv2: ['wafv2:CreateWebACL'],
  route53: ['route53:CreateHostedZone'],
  kms: ['kms:CreateKey'],
  secretsmanager: ['secretsmanager:CreateSecret'],
  ssm: ['ssm:PutParameter'],
  acm: ['acm:RequestCertificate'],
  'application-autoscaling': ['application-autoscaling:RegisterScalableTarget'],
  iam: ['iam:CreateRole', 'iam:PassRole'],
};

export interface AccessCheck {
  /** ok: every service can be created in; partial: some cannot; cannot-check: AWS would not answer for this role. */
  state: 'ok' | 'partial' | 'cannot-check';
  services: { service: string; allowed: boolean | null }[];
  /** Plain words for the person, always set when the state is not ok. */
  message?: string;
}

/** The part of the IAM client this needs, so it can be tested without AWS. */
export interface SimulateClient {
  send(command: unknown): Promise<{ EvaluationResults?: { EvalActionName?: string; EvalDecision?: string }[] }>;
}

/**
 * Asks IAM whether `roleArn` may perform the probe actions. `makeCommand` builds the SimulatePrincipalPolicy command (injected so the
 * caller owns the SDK import). Never throws: any refusal or failure becomes `cannot-check` with a reason.
 */
export async function checkRoleAccess(args: {
  client: SimulateClient;
  makeCommand: (input: { PolicySourceArn: string; ActionNames: string[] }) => unknown;
  roleArn: string;
  services: string[];
}): Promise<AccessCheck> {
  const checkable = args.services.filter((s) => PROBE_ACTIONS[s]);
  const rows: AccessCheck['services'] = args.services.map((service) => ({ service, allowed: null }));
  if (checkable.length === 0) return { state: 'cannot-check', services: rows, message: 'None of the services can be checked in advance.' };

  const actions = checkable.flatMap((s) => PROBE_ACTIONS[s]!);
  const decisions = new Map<string, boolean>();
  try {
    // IAM accepts at most 100 actions per call; the largest design needs far fewer, but stay safe.
    for (let i = 0; i < actions.length; i += 100) {
      const out = await args.client.send(args.makeCommand({ PolicySourceArn: args.roleArn, ActionNames: actions.slice(i, i + 100) }));
      for (const r of out.EvaluationResults ?? []) if (r.EvalActionName) decisions.set(r.EvalActionName, r.EvalDecision === 'allowed');
    }
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    const denied = /AccessDenied|NotAuthorized|Unauthorized/i.test(name) || /not authorized|AccessDenied/i.test((err as Error).message ?? '');
    return {
      state: 'cannot-check', services: rows,
      message: denied
        ? 'AWS will not let this role ask what it is allowed to do (it lacks iam:SimulatePrincipalPolicy). That is fine: attach the policy above and deploy, or add that one permission to run this check.'
        : 'AWS did not answer the access check. Try again, or attach the policy above and deploy.',
    };
  }

  for (const row of rows) {
    const probes = PROBE_ACTIONS[row.service];
    if (!probes) continue;
    const answered = probes.filter((a) => decisions.has(a));
    row.allowed = answered.length === probes.length ? answered.every((a) => decisions.get(a) === true) : null;
  }
  const known = rows.filter((r) => r.allowed !== null);
  const missing = known.filter((r) => !r.allowed).map((r) => r.service);
  if (known.length === 0) return { state: 'cannot-check', services: rows, message: 'AWS returned no answers for this role.' };
  return missing.length === 0
    ? { state: 'ok', services: rows }
    : { state: 'partial', services: rows, message: `The role cannot yet create in: ${missing.join(', ')}. Attach the policy above, then check again.` };
}

