/**
 * POST /api/projects/[id]/terraform/permissions: what the connected role needs for the saved design, before anything is planned.
 */
const mockIdentity = jest.fn();
const mockOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockOrgRole(...a) }));
const mockResolveOrg = jest.fn();
const mockResolveArch = jest.fn();
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockResolveOrg(...a), resolveArchitecture: (...a: unknown[]) => mockResolveArch(...a) }));
jest.mock('@/lib/api/rateLimit', () => ({ checkRateLimit: async () => ({ allowed: true, remaining: 9, retryAfterSeconds: 0 }) }));
const mockFind = jest.fn();
const mockCreds = jest.fn();
jest.mock('@/lib/repositories/cloudAccountRepository', () => ({ cloudAccountRepository: { findById: (...a: unknown[]) => mockFind(...a), getCredentials: (...a: unknown[]) => mockCreds(...a) } }));
const mockResolveCreds = jest.fn();
jest.mock('@/lib/cloud/credentials/resolveExecutionCredentials', () => ({ resolveExecutionCredentials: (...a: unknown[]) => mockResolveCreds(...a) }));
const mockGenerate = jest.fn();
jest.mock('@/lib/engines/terraform/TerraformGenerator', () => ({ terraformGenerator: { generate: (...a: unknown[]) => mockGenerate(...a) } }));
const mockIamSend = jest.fn();
jest.mock('@aws-sdk/client-iam', () => ({
  IAMClient: jest.fn().mockImplementation(() => ({ send: (...a: unknown[]) => mockIamSend(...a) })),
  SimulatePrincipalPolicyCommand: jest.fn().mockImplementation((input: unknown) => input),
}));

jest.mock('@azure/identity', () => ({ ClientSecretCredential: jest.fn().mockImplementation(() => ({ getToken: async () => ({ token: 'azure-token' }) })) }));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/projects/[id]/terraform/permissions/route';
import { CredentialsExpiredError } from '@/lib/cloud/credentialLifetime';

const ROLE = 'arn:aws:iam::123456789012:role/CloudBuilder';
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/projects/p1/terraform/permissions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'p1' }) });
const data = async (res: Response) => (await res.json()) as { data?: Record<string, any>; error?: { code: string; message: string } };
const account = (authMethod: string, provider = 'aws') => ({ id: 'acct-1', provider, name: 'A', status: 'active', identity: { authMethod, connection: { roleArn: ROLE } } });

beforeEach(() => {
  [mockIdentity, mockOrgRole, mockResolveOrg, mockResolveArch, mockFind, mockCreds, mockResolveCreds, mockGenerate, mockIamSend].forEach((m) => m.mockReset());
  mockIdentity.mockReturnValue({ userId: 'alice', role: 'admin', orgIds: ['org-1'] });
  mockOrgRole.mockResolvedValue('owner');
  mockResolveOrg.mockResolvedValue('org-1');
  mockResolveArch.mockResolvedValue({ arch: { id: 'arch-1', resources: [], connections: [] }, project: { name: 'Shop App' } });
  mockGenerate.mockReturnValue({ files: [{ filename: 'main.tf', content: 'resource "aws_vpc" "v" {}\nresource "aws_ecs_service" "s" {}\nresource "aws_iam_role" "r" {}' }] });
  mockFind.mockResolvedValue(account('key-and-role'));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('permissions route', () => {
  it('returns the services and a policy for the saved design without calling AWS', async () => {
    const res = await post({ cloudAccountId: 'acct-1' });
    expect(res.status).toBe(200);
    const d = (await data(res)).data!;
    expect(d.needed).toBe(true);
    expect(d.roleArn).toBe(ROLE);
    expect(d.services).toEqual(['dynamodb', 'ec2', 'ecs', 'iam', 's3']);
    expect(d.includesIam).toBe(true);
    expect(JSON.parse(d.policy).Statement[0].Action).toEqual(['dynamodb:*', 'ec2:*', 'ecs:*', 's3:*']);
    const selfCheck = JSON.parse(d.policy).Statement.find((x: { Sid: string }) => x.Sid === 'CloudBuilderCheckOwnAccess');
    expect(selfCheck).toMatchObject({ Action: ['iam:SimulatePrincipalPolicy'], Resource: ROLE });     // so "Check my access" can answer once attached
    expect(mockCreds).not.toHaveBeenCalled();
    expect(mockIamSend).not.toHaveBeenCalled();
  });

  it('says nothing is needed for an account whose own key can deploy, and does not even read the design', async () => {
    mockFind.mockResolvedValue(account('access-key-deploy'));
    const d = (await data(await post({ cloudAccountId: 'acct-1' }))).data!;
    expect(d).toEqual({ needed: false, authMethod: 'access-key-deploy' });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('refuses a member who is not an owner or admin, and a cloud that is neither AWS nor Azure', async () => {
    mockOrgRole.mockResolvedValue('member');
    expect((await post({ cloudAccountId: 'acct-1' })).status).toBe(403);
    mockOrgRole.mockResolvedValue('owner');
    mockFind.mockResolvedValue(account('service-principal', 'gcp'));
    expect((await post({ cloudAccountId: 'acct-1' })).status).toBe(400);
  });

  it('with check: asks AWS whether the role can create in each service and returns the answer', async () => {
    mockCreds.mockResolvedValue(JSON.stringify({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 's', roleArn: ROLE, region: 'us-east-1' }));
    mockResolveCreds.mockResolvedValue({ AWS_ACCESS_KEY_ID: 'ASIA', AWS_SECRET_ACCESS_KEY: 'x', AWS_SESSION_TOKEN: 't' });
    mockIamSend.mockImplementation(async (input: { PolicySourceArn: string; ActionNames: string[] }) => ({
      EvaluationResults: input.ActionNames.map((a) => ({ EvalActionName: a, EvalDecision: a.startsWith('ec2:') || a.startsWith('s3:') ? 'allowed' : 'implicitDeny' })),
    }));
    const d = (await data(await post({ cloudAccountId: 'acct-1', check: true }))).data!;
    expect(mockIamSend.mock.calls[0]![0].PolicySourceArn).toBe(ROLE);
    expect(d.access.state).toBe('partial');
    expect(d.access.services.filter((s: { allowed: boolean }) => s.allowed).map((s: { service: string }) => s.service)).toEqual(['ec2', 's3']);
    expect(JSON.stringify(d)).not.toContain('AKIAIOSFODNN7EXAMPLE');    // credentials never leave the server
  });

  it('with check and credentials that expired: a plain 410, not a 500', async () => {
    mockCreds.mockRejectedValue(new CredentialsExpiredError('expired'));
    expect((await post({ cloudAccountId: 'acct-1', check: true })).status).toBe(410);
  });
});

describe('permissions route for Azure', () => {
  const azureAccount = () => ({ id: 'acct-az', provider: 'azure', name: 'Az', status: 'active', identity: { authMethod: 'service-principal', connection: { clientId: 'client-1', subscriptionId: 'sub-1', tenantId: 't' } } });
  const azureHcl = ['resource "azurerm_resource_group" "rg" {}', 'resource "azurerm_virtual_network" "v" {}', 'resource "azurerm_mssql_server" "s" {}'].join(String.fromCharCode(10));
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  beforeEach(() => {
    mockFind.mockResolvedValue(azureAccount());
    mockGenerate.mockReturnValue({ files: [{ filename: 'main.tf', content: azureHcl }] });
  });

  it('returns the role, the providers and the CLI command for this principal, without calling Azure', async () => {
    global.fetch = jest.fn() as never;
    const d = (await data(await post({ cloudAccountId: 'acct-az' }))).data!;
    expect(d).toMatchObject({ needed: true, cloud: 'azure', clientId: 'client-1', subscriptionId: 'sub-1', needsRoleAssignment: false });
    expect(d.roles.map((r: { name: string }) => r.name)).toEqual(['Contributor']);
    expect(d.providers).toEqual(['Microsoft.Network', 'Microsoft.Resources', 'Microsoft.Sql', 'Microsoft.Storage']);
    expect(d.commands).toBe('az role assignment create --assignee client-1 --role "Contributor" --scope /subscriptions/sub-1');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(d.policy).toBeUndefined();                     // an Azure account gets roles, not an AWS policy
  });

  it('with check: reads the effective permissions of the principal and reports Reader as missing the providers', async () => {
    mockCreds.mockResolvedValue(JSON.stringify({ tenantId: 't', clientId: 'client-1', clientSecret: 'super-secret-value', subscriptionId: 'sub-1' }));
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ value: [{ actions: ['*/read'], notActions: [] }] }) })) as never;
    const res = await post({ cloudAccountId: 'acct-az', check: true });
    const d = (await data(res)).data!;
    expect(d.access.state).toBe('partial');
    expect(d.access.services.map((x: { service: string; allowed: boolean }) => [x.service, x.allowed]).slice(0, 2)).toEqual([['Microsoft.Network', false], ['Microsoft.Resources', false]]);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('/subscriptions/sub-1/providers/Microsoft.Authorization/permissions');
    expect((global.fetch as jest.Mock).mock.calls[0][1].headers.Authorization).toBe('Bearer azure-token');
    expect(JSON.stringify(d)).not.toContain('super-secret-value');
  });

  it('with check and Contributor: everything ticks', async () => {
    mockCreds.mockResolvedValue(JSON.stringify({ tenantId: 't', clientId: 'client-1', clientSecret: 's', subscriptionId: 'sub-1' }));
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ value: [{ actions: ['*'], notActions: ['Microsoft.Authorization/*/Write'] }] }) })) as never;
    const d = (await data(await post({ cloudAccountId: 'acct-az', check: true }))).data!;
    expect(d.access.state).toBe('ok');
  });
});
