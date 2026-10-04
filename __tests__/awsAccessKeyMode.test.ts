/**
 * Connecting an AWS account with a read-only access key: the quick method that needs no AWS identity on the CloudCraft server.
 * It is for DISCOVERY ONLY — a stored key must never run Terraform, root keys are refused, and the secret never comes back out.
 */
const mockStsSend = jest.fn();
const stsConstructed: unknown[] = [];
jest.mock('@aws-sdk/client-sts', () => ({
  __esModule: true,
  STSClient: class { constructor(public config: unknown) { stsConstructed.push(config); } send(...a: unknown[]) { return mockStsSend(...a); } },
  AssumeRoleCommand: class { constructor(public input: unknown) {} },
  GetCallerIdentityCommand: class { constructor(public input?: unknown) {} },
}));
const mockEc2Send = jest.fn();
// Every other AWS client the adapter imports is a harmless stub; only EC2 (the lightweight permission check) answers.
jest.mock('@aws-sdk/client-ec2', () => new Proxy({ __esModule: true }, {
  get: (t, name) => (name in t ? (t as Record<string | symbol, unknown>)[name] : name === 'EC2Client' ? class { send(...a: unknown[]) { return mockEc2Send(...a); } } : class { constructor(public input?: unknown) {} }),
}));

const mockIdentity = jest.fn();
const mockOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({
  extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockOrgRole(...a), resolveOrgIds: async () => ['org-1'],
}));
jest.mock('@/lib/repositories/orgRepository', () => ({ orgRepository: {} }));
const mockResolveOrg = jest.fn();
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockResolveOrg(...a) }));
const mockCreate = jest.fn();
const mockFind = jest.fn();
const mockCreds = jest.fn();
const mockUpdate = jest.fn();
jest.mock('@/lib/repositories/cloudAccountRepository', () => ({
  cloudAccountRepository: {
    create: (...a: unknown[]) => mockCreate(...a), findById: (...a: unknown[]) => mockFind(...a),
    getCredentials: (...a: unknown[]) => mockCreds(...a), updateStatus: (...a: unknown[]) => mockUpdate(...a),
  },
}));

import { NextRequest } from 'next/server';
import { authMethodOf, isAwsCredentials, isAwsKeyCredentials, isAwsRoleCredentials, isAzureCredentials, type CloudCredentials } from '@/lib/cloud/types';
import { AwsDiscoveryAdapter, REQUIRED_AWS_PERMISSIONS } from '@/lib/cloud/adapters/awsAdapter';
import { AWS_DISCOVERY_ACTIONS, buildDiscoveryPolicy } from '@/lib/cloud/discoveryPolicy';
import { assertTerraformCapable, ACCESS_KEY_NOT_FOR_TERRAFORM } from '@/lib/cloud/terraformCapability';
import { resolveExecutionCredentials } from '@/lib/cloud/credentials/resolveExecutionCredentials';
import { explainValidationFailure } from '@/lib/cloud/validationExplain';
import { POST as createPost } from '@/app/api/cloud-accounts/route';
import { POST as validatePost } from '@/app/api/cloud-accounts/[id]/validate/route';

const KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';      // 40 characters
const keys = { accessKeyId: KEY_ID, secretAccessKey: SECRET, region: 'us-east-1' };
const role = { roleArn: 'arn:aws:iam::123456789012:role/CloudCraftReadOnly', externalId: 'abc123', region: 'us-east-1' };
const azure = { tenantId: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), clientId: 'b'.repeat(8) + '-bbbb-bbbb-bbbb-' + 'b'.repeat(12), clientSecret: 's', subscriptionId: 'c'.repeat(8) + '-cccc-cccc-cccc-' + 'c'.repeat(12) };

describe('credential kinds', () => {
  it('tells role, access key and service principal apart', () => {
    expect(authMethodOf(role)).toBe('role');
    expect(authMethodOf(keys)).toBe('access-key');
    expect(authMethodOf(azure)).toBe('service-principal');
    expect([isAwsRoleCredentials(role), isAwsKeyCredentials(keys), isAzureCredentials(azure)]).toEqual([true, true, true]);
    expect([isAwsCredentials(role), isAwsCredentials(keys), isAwsCredentials(azure)]).toEqual([true, true, false]);
  });
});

describe('POST /api/cloud-accounts — connecting with an access key', () => {
  const call = (body: unknown) => createPost(new NextRequest('http://localhost/api/cloud-accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  beforeEach(() => {
    [mockIdentity, mockOrgRole, mockCreate].forEach((m) => m.mockReset());
    mockIdentity.mockReturnValue({ userId: 'u1', role: 'admin', orgIds: ['org-1'] });
    mockOrgRole.mockResolvedValue('owner');
    mockCreate.mockResolvedValue({ id: 'acct-1', provider: 'aws', name: 'Key account', identity: { authMethod: 'access-key' }, status: 'pending' });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('accepts a long-term key, stores it with how the account signs in, and never returns the secret', async () => {
    const res = await call({ provider: 'aws', name: 'Key account', credentials: keys });
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET);
    const input = mockCreate.mock.calls[0]![0] as { credentialsJson: string; identityJson: string; orgId: string };
    expect(JSON.parse(input.credentialsJson)).toMatchObject(keys);
    expect(JSON.parse(input.identityJson)).toEqual({ authMethod: 'access-key' });
    expect(input.orgId).toBe('org-1');
  });

  it('a role connection is recorded as a role, and still works as before', async () => {
    expect((await call({ provider: 'aws', name: 'Role account', credentials: role })).status).toBe(201);
    expect(JSON.parse((mockCreate.mock.calls[0]![0] as { identityJson: string }).identityJson)).toEqual({ authMethod: 'role' });
  });

  it.each([
    ['a temporary key (ASIA…), which needs a session token', { ...keys, accessKeyId: 'ASIAIOSFODNN7EXAMPLE' }],
    ['a key id of the wrong length', { ...keys, accessKeyId: 'AKIA123' }],
    ['a secret that is not 40 characters', { ...keys, secretAccessKey: 'too-short' }],
    ['a region that is not a region', { ...keys, region: 'moon-base-1' }],
    ['no secret', { accessKeyId: KEY_ID, region: 'us-east-1' }],
  ])('refuses %s', async (_name, credentials) => {
    expect((await call({ provider: 'aws', name: 'x', credentials })).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses credentials that do not belong to the selected cloud (keys saved as Azure, Azure saved as AWS)', async () => {
    expect((await call({ provider: 'azure', name: 'x', credentials: keys })).status).toBe(400);
    expect((await call({ provider: 'aws', name: 'x', credentials: azure })).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('still needs a signed-in user who is not a viewer', async () => {
    mockIdentity.mockReturnValue(null);
    expect((await call({ provider: 'aws', name: 'x', credentials: keys })).status).toBe(401);
    mockIdentity.mockReturnValue({ userId: 'u1', role: 'admin', orgIds: ['org-1'] }); mockOrgRole.mockResolvedValue('viewer');
    expect((await call({ provider: 'aws', name: 'x', credentials: keys })).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('the AWS adapter with an access key', () => {
  beforeEach(() => { mockStsSend.mockReset(); mockEc2Send.mockReset(); stsConstructed.length = 0; });

  it('signs in with the key directly: nothing to assume, no AWS identity needed on the server', async () => {
    mockStsSend.mockResolvedValue({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/cloudcraft-readonly', UserId: 'AIDAEXAMPLE' });
    mockEc2Send.mockResolvedValue({ Vpcs: [] });
    const adapter = new AwsDiscoveryAdapter(keys);
    const result = await adapter.validateAccount();
    expect(result).toMatchObject({ valid: true, permissionsOk: true, identity: { accountId: '123456789012' } });
    // every STS call used the key itself as its credentials, and none was an AssumeRole
    expect(mockStsSend.mock.calls.every((c) => !('RoleArn' in ((c[0] as { input?: object }).input ?? {})))).toBe(true);
    expect(stsConstructed.some((c) => (c as { credentials?: { accessKeyId?: string } }).credentials?.accessKeyId === KEY_ID)).toBe(true);
    await adapter.dispose();
  });

  it('refuses a root-user key outright', async () => {
    mockStsSend.mockResolvedValue({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:root', UserId: '123456789012' });
    const result = await new AwsDiscoveryAdapter(keys).validateAccount();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/ROOT_ACCESS_KEY/);
    expect(mockEc2Send).not.toHaveBeenCalled();                  // it never even tried to read with it
  });

  it('a key that AWS rejects is invalid, with the key id removed from the message', async () => {
    mockStsSend.mockRejectedValue(new Error(`The security token included in the request is invalid. (${KEY_ID})`));
    const result = await new AwsDiscoveryAdapter(keys).validateAccount();
    expect(result.valid).toBe(false);
    expect(result.error).not.toContain(KEY_ID);
  });

  it('a valid key whose user cannot read anything is reported as missing permissions', async () => {
    mockStsSend.mockResolvedValue({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/x', UserId: 'AIDAEXAMPLE' });
    mockEc2Send.mockRejectedValue(new Error('UnauthorizedOperation'));
    const result = await new AwsDiscoveryAdapter(keys).validateAccount();
    expect(result).toMatchObject({ valid: false, permissionsOk: false });
    expect(result.missingPermissions).toContain('ec2:DescribeVpcs');
  });
});

describe('an access key never runs Terraform', () => {
  beforeEach(() => mockStsSend.mockReset());
  it('assertTerraformCapable refuses a key (HTTP 400, with the reason) and allows a role and a service principal', () => {
    try { assertTerraformCapable(keys); throw new Error('should have thrown'); } catch (e) {
      expect((e as Error).message).toBe(ACCESS_KEY_NOT_FOR_TERRAFORM);
      expect((e as { statusCode?: number }).statusCode).toBe(400);
    }
    expect(() => assertTerraformCapable(role)).not.toThrow();
    expect(() => assertTerraformCapable(azure)).not.toThrow();
    expect(ACCESS_KEY_NOT_FOR_TERRAFORM).toMatch(/access key and an IAM role/i);
  });

  it('the environment Terraform would run with is never built from a key (defence in depth)', async () => {
    await expect(resolveExecutionCredentials(keys as CloudCredentials)).rejects.toThrow(/access key/i);
    expect(mockStsSend).not.toHaveBeenCalled();
  });
});

describe('POST /api/cloud-accounts/[id]/validate for an access-key account', () => {
  const call = () => validatePost(new NextRequest('http://localhost/api/cloud-accounts/acct-1/validate', { method: 'POST' }), { params: Promise.resolve({ id: 'acct-1' }) });
  beforeEach(() => {
    [mockStsSend, mockEc2Send, mockIdentity, mockOrgRole, mockResolveOrg, mockFind, mockCreds, mockUpdate].forEach((m) => m.mockReset());
    mockIdentity.mockReturnValue({ userId: 'u1', role: 'admin', orgIds: ['org-1'] });
    mockResolveOrg.mockResolvedValue('org-1'); mockOrgRole.mockResolvedValue('owner');
    mockFind.mockResolvedValue({ id: 'acct-1', provider: 'aws' });
    mockCreds.mockResolvedValue(JSON.stringify(keys));
    mockUpdate.mockResolvedValue({});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('a working key makes the account active and keeps "access-key" with it, so the app knows what it may be used for', async () => {
    mockStsSend.mockResolvedValue({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/cloudcraft-readonly', UserId: 'AIDAEXAMPLE' });
    mockEc2Send.mockResolvedValue({ Vpcs: [] });
    const res = await call();
    expect(((await res.json()).data as { valid: boolean }).valid).toBe(true);
    const [, , status, identityJson] = mockUpdate.mock.calls[0]!;
    expect(status).toBe('active');
    expect(JSON.parse(identityJson as string)).toMatchObject({ authMethod: 'access-key', accountId: '123456789012' });
    expect(String(identityJson)).not.toContain(SECRET);
  });

  it('a root key is invalid and the reason says why, in words for a key — not the server-identity message', async () => {
    mockStsSend.mockResolvedValue({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:root', UserId: '123456789012' });
    const body = (await (await call()).json()).data as { valid: boolean; reason: string; fix: string };
    expect(body.valid).toBe(false);
    expect(body.reason).toMatch(/root user/i);
    expect(body.reason).not.toMatch(/server has no AWS credentials/i);
    expect(body.fix).toMatch(/dedicated IAM user/i);
    expect(JSON.parse(String(mockUpdate.mock.calls[0]![3]))).toMatchObject({ authMethod: 'access-key', validationReason: body.reason });
  });

  it('a rejected key is explained as a wrong or deleted key', async () => {
    mockStsSend.mockRejectedValue(new Error('The security token included in the request is invalid.'));
    const body = (await (await call()).json()).data as { reason: string; fix: string };
    expect(body.reason).toMatch(/does not accept this access key/i);
    expect(body.fix).toMatch(/Secret access key/);
  });
});

describe('explanations for access-key accounts', () => {
  it('speaks about the key, not about the server or a role', () => {
    expect(explainValidationFailure('aws', 'InvalidClientTokenId', [], 'access-key').reason).toMatch(/does not accept this access key/i);
    expect(explainValidationFailure('aws', 'AccessDenied: not authorized', [], 'access-key').reason).toMatch(/IAM user is not allowed to read/i);
    expect(explainValidationFailure('aws', undefined, ['ec2:DescribeVpcs'], 'access-key').reason).toMatch(/access key works, but its IAM user cannot read/i);
  });
  it('never repeats an access key id, even one that AWS echoed back', () => {
    const e = explainValidationFailure('aws', `Something odd happened with ${KEY_ID} today`, [], 'access-key');
    expect(`${e.reason} ${e.fix}`).not.toContain(KEY_ID);
    expect(e.reason).toContain('[access key id]');
  });
  it('the role messages are unchanged for role accounts', () => {
    expect(explainValidationFailure('aws', 'InvalidClientTokenId', [], 'role').reason).toMatch(/server uses is not valid/i);
  });
});

describe('the read-only policy shown for the key', () => {
  it('covers everything discovery needs (the adapter\'s own list, sts aside), so a key made from it works', () => {
    for (const action of REQUIRED_AWS_PERMISSIONS.filter((a) => a !== 'sts:GetCallerIdentity')) expect(AWS_DISCOVERY_ACTIONS).toContain(action);
  });
  it('can only list, describe and get settings: no wildcard, nothing that reads data or changes anything', () => {
    for (const action of AWS_DISCOVERY_ACTIONS) {
      expect(action).toMatch(/^[a-z0-9-]+:(Describe|List|Get)[A-Za-z]+$/);
      expect(action).not.toMatch(/\*/);
    }
    for (const forbidden of ['s3:GetObject', 'dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:Query', 'sqs:ReceiveMessage', 'secretsmanager:GetSecretValue', 'kms:Decrypt', 'ssm:GetParameter']) {
      expect(AWS_DISCOVERY_ACTIONS).not.toContain(forbidden);
    }
    const policy = JSON.parse(buildDiscoveryPolicy());
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0]).toMatchObject({ Effect: 'Allow', Resource: '*' });
    expect(policy.Statement[0].Action).toEqual([...AWS_DISCOVERY_ACTIONS]);
  });
});
