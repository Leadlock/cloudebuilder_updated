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

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/projects/[id]/terraform/permissions/route';
import { CredentialsExpiredError } from '@/lib/cloud/credentialLifetime';

const ROLE = 'arn:aws:iam::123456789012:role/CloudCraft';
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
    expect(mockCreds).not.toHaveBeenCalled();
    expect(mockIamSend).not.toHaveBeenCalled();
  });

  it('says nothing is needed for an account whose own key can deploy, and does not even read the design', async () => {
    mockFind.mockResolvedValue(account('access-key-deploy'));
    const d = (await data(await post({ cloudAccountId: 'acct-1' }))).data!;
    expect(d).toEqual({ needed: false, authMethod: 'access-key-deploy' });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('refuses a member who is not an owner or admin, and an Azure account', async () => {
    mockOrgRole.mockResolvedValue('member');
    expect((await post({ cloudAccountId: 'acct-1' })).status).toBe(403);
    mockOrgRole.mockResolvedValue('owner');
    mockFind.mockResolvedValue(account('service-principal', 'azure'));
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
