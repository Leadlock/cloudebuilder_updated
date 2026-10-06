import { terraformTypesIn, requiredPermissionsFor, checkRoleAccess, PROBE_ACTIONS } from '@/lib/terraform/execution/requiredPermissions';

const HCL = `
resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }
resource "aws_subnet" "a" {}
resource "aws_lb" "alb" {}
resource "aws_ecs_service" "svc" {}
resource "aws_iam_role" "task" {}
resource "aws_db_instance" "db" {}
data "aws_availability_zones" "available" {}
  resource   "aws_sqs_queue"   "q" {}
# resource "aws_kms_key" "commented_out_is_still_matched_only_if_at_line_start" {}
`;
const files = [{ filename: 'main.tf', content: HCL }, { filename: 'notes.md', content: 'resource "aws_lambda_function" "x" {}' }];

describe('terraformTypesIn', () => {
  it('lists resource and data types from .tf files only, sorted and without duplicates', () => {
    const types = terraformTypesIn(files);
    expect(types).toEqual(['aws_db_instance', 'aws_ecs_service', 'aws_iam_role', 'aws_lb', 'aws_sqs_queue', 'aws_subnet', 'aws_vpc', 'data.aws_availability_zones']);
    expect(types).not.toContain('aws_lambda_function');          // a .md file is not Terraform
    expect(types).not.toContain('aws_kms_key');                  // a comment is not a resource
  });
});

describe('requiredPermissionsFor', () => {
  const p = requiredPermissionsFor(files);

  it('covers exactly the services in the design, plus the state storage', () => {
    expect(p.services).toEqual(['dynamodb', 'ec2', 'ecs', 'elasticloadbalancing', 'iam', 'rds', 's3', 'sqs']);   // s3 + dynamodb are the state storage
    const policy = JSON.parse(p.json) as { Statement: { Action: string[] }[] };
    expect(policy.Statement[0]!.Action).toEqual(['dynamodb:*', 'ec2:*', 'ecs:*', 'elasticloadbalancing:*', 'rds:*', 's3:*', 'sqs:*']);
    expect(p.includesIam).toBe(true);
    expect(p.unknownTypes).toEqual([]);
  });

  it('does not include a service the design does not use', () => {
    const small = requiredPermissionsFor([{ filename: 'main.tf', content: 'resource "aws_sqs_queue" "q" {}' }]);
    expect(small.services).toEqual(['dynamodb', 's3', 'sqs']);
    expect(small.includesIam).toBe(false);
    expect(JSON.parse(small.json).Statement).toHaveLength(2);        // the services, and the read-only self-check
    expect(JSON.parse(small.json).Statement[0].Sid).toBe('CloudCraftDeployServices');
  });

  it('also lets the role ask IAM what it may do, read-only and limited to the role itself when its ARN is known', () => {
    const arn = 'arn:aws:iam::123456789012:role/CloudCraft';
    const withArn = JSON.parse(requiredPermissionsFor(files, arn).json) as { Statement: { Sid: string; Action: string[]; Resource: string }[] };
    const check = withArn.Statement.find((x) => x.Sid === 'CloudCraftCheckOwnAccess')!;
    expect(check.Action).toEqual(['iam:SimulatePrincipalPolicy']);
    expect(check.Resource).toBe(arn);
    const without = JSON.parse(requiredPermissionsFor(files).json) as { Statement: { Sid: string; Resource: string }[] };
    expect(without.Statement.find((x) => x.Sid === 'CloudCraftCheckOwnAccess')!.Resource).toBe('*');
    // The deploy statement itself never grants the check action or anything beyond the design's services.
    expect(withArn.Statement[0]!.Action.some((a) => a.startsWith('iam:'))).toBe(false);
  });

  it('reports a type it cannot map instead of ignoring it', () => {
    const odd = requiredPermissionsFor([{ filename: 'main.tf', content: 'resource "aws_made_up_thing" "x" {}' }]);
    expect(odd.unknownTypes).toEqual(['aws_made_up_thing']);
  });
});

describe('checkRoleAccess', () => {
  const makeCommand = (input: unknown) => input;
  const answer = (allowedServices: string[]) => ({
    send: async (input: unknown) => ({
      EvaluationResults: (input as { ActionNames: string[] }).ActionNames.map((a) => ({ EvalActionName: a, EvalDecision: allowedServices.includes(a.split(':')[0]!) ? 'allowed' : 'implicitDeny' })),
    }),
  });

  it('is ok when every probe action is allowed', async () => {
    const r = await checkRoleAccess({ client: answer(['ec2', 'sqs']), makeCommand, roleArn: 'arn:aws:iam::123456789012:role/CloudCraft', services: ['ec2', 'sqs'] });
    expect(r.state).toBe('ok');
    expect(r.services).toEqual([{ service: 'ec2', allowed: true }, { service: 'sqs', allowed: true }]);
  });

  it('is partial and names the services still missing', async () => {
    const r = await checkRoleAccess({ client: answer(['ec2']), makeCommand, roleArn: 'arn:aws:iam::123456789012:role/CloudCraft', services: ['ec2', 'rds', 'sqs'] });
    expect(r.state).toBe('partial');
    expect(r.services.filter((s) => !s.allowed).map((s) => s.service)).toEqual(['rds', 'sqs']);
    expect(r.message).toMatch(/rds, sqs/);
  });

  it('needs every probe action of a service, not just one', async () => {
    const client = { send: async (input: unknown) => ({ EvaluationResults: (input as { ActionNames: string[] }).ActionNames.map((a) => ({ EvalActionName: a, EvalDecision: a === 'ec2:CreateVpc' ? 'allowed' : 'implicitDeny' })) }) };
    const r = await checkRoleAccess({ client, makeCommand, roleArn: 'r', services: ['ec2'] });
    expect(r.state).toBe('partial');
    expect(PROBE_ACTIONS['ec2']!.length).toBeGreaterThan(1);
  });

  it('says it cannot check (and why) when AWS refuses to answer, never a guess', async () => {
    const denied = { send: async () => { throw Object.assign(new Error('User is not authorized to perform: iam:SimulatePrincipalPolicy'), { name: 'AccessDenied' }); } };
    const r = await checkRoleAccess({ client: denied, makeCommand, roleArn: 'r', services: ['ec2'] });
    expect(r.state).toBe('cannot-check');
    expect(r.message).toMatch(/SimulatePrincipalPolicy/);
    expect(r.services).toEqual([{ service: 'ec2', allowed: null }]);
  });

  it('cannot check a service it has no probe for', async () => {
    const r = await checkRoleAccess({ client: answer([]), makeCommand, roleArn: 'r', services: ['some-new-service'] });
    expect(r.state).toBe('cannot-check');
  });
});
