/**
 * Setting up the AWS connection without guessing: the server's own AWS identity is checked and shown, the trust policy is written
 * for the user, and a refused assume-role says which identity the server really is.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({ send: (...a: unknown[]) => mockSend(...a) })),
  GetCallerIdentityCommand: jest.fn().mockImplementation((i: unknown) => ({ input: i })),
}));
const mockIdentity = jest.fn();
const mockOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockOrgRole(...a) }));
const mockResolveOrg = jest.fn();
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockResolveOrg(...a) }));
const mockFind = jest.fn();
const mockCreds = jest.fn();
const mockUpdate = jest.fn();
jest.mock('@/lib/repositories/cloudAccountRepository', () => ({
  cloudAccountRepository: { findById: (...a: unknown[]) => mockFind(...a), getCredentials: (...a: unknown[]) => mockCreds(...a), updateStatus: (...a: unknown[]) => mockUpdate(...a) },
}));
const mockValidate = jest.fn();
jest.mock('@/lib/cloud/provider', () => ({ createDiscoveryProvider: async () => ({ validateAccount: (...a: unknown[]) => mockValidate(...a), dispose: async () => undefined }) }));

import { NextRequest } from 'next/server';
import { generateExternalId, trustPrincipalFromArn, buildTrustPolicy, buildAssumeRolePolicy } from '@/lib/cloud/trustPolicy';
import { getServerAwsIdentity, _clearServerIdentityCacheForTests } from '@/lib/cloud/serverIdentity';
import { POST as validatePost } from '@/app/api/cloud-accounts/[id]/validate/route';

describe('trust policy helpers', () => {
  it('generates a different 128-bit hex External ID each time', () => {
    const a = generateExternalId(); const b = generateExternalId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[\x21-\x7E]{2,1224}$/);               // and it is a value the connect API accepts
  });

  it.each([
    ['arn:aws:iam::123456789012:user/cloudcraft-server', 'arn:aws:iam::123456789012:user/cloudcraft-server'],
    ['arn:aws:iam::123456789012:root', 'arn:aws:iam::123456789012:root'],
    ['arn:aws:sts::123456789012:assumed-role/CloudCraftEc2Role/i-0abc123', 'arn:aws:iam::123456789012:role/CloudCraftEc2Role'],
    ['arn:aws:sts::123456789012:federated-user/bob', 'arn:aws:iam::123456789012:root'],
    ['arn:aws-us-gov:iam::123456789012:user/x', 'arn:aws-us-gov:iam::123456789012:user/x'],
  ])('the principal for %s is %s (a session ARN can never be a principal)', (arn, expected) => {
    expect(trustPrincipalFromArn(arn)).toBe(expected);
  });

  it('writes a trust policy that names that principal and requires the External ID', () => {
    const policy = JSON.parse(buildTrustPolicy('arn:aws:iam::123456789012:user/cloudcraft-server', 'abc123'));
    expect(policy.Statement[0]).toEqual({
      Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::123456789012:user/cloudcraft-server' }, Action: 'sts:AssumeRole',
      Condition: { StringEquals: { 'sts:ExternalId': 'abc123' } },
    });
  });

  it('without an External ID the trust policy trusts the principal alone (no condition); with one it requires it', () => {
    const plain = JSON.parse(buildTrustPolicy('arn:aws:iam::123456789012:root'));
    expect(plain.Statement[0]).toEqual({ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::123456789012:root' }, Action: 'sts:AssumeRole' });
    expect(JSON.parse(buildTrustPolicy('arn:aws:iam::123456789012:root', '')).Statement[0]).not.toHaveProperty('Condition');
  });

  it('writes the policy the IAM user needs: assume exactly that one role', () => {
    const policy = JSON.parse(buildAssumeRolePolicy('arn:aws:iam::111122223333:role/CloudCraftReadOnly'));
    expect(policy.Statement).toEqual([{ Effect: 'Allow', Action: 'sts:AssumeRole', Resource: 'arn:aws:iam::111122223333:role/CloudCraftReadOnly' }]);
  });
});

describe('getServerAwsIdentity', () => {
  beforeEach(() => { _clearServerIdentityCacheForTests(); mockSend.mockReset(); });
  afterEach(() => jest.useRealTimers());

  it('reports the account and ARN AWS says the server is — and nothing else', async () => {
    mockSend.mockResolvedValue({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/cloudcraft-server', UserId: 'AIDAXXXX' });
    const r = await getServerAwsIdentity();
    expect(r).toEqual({ configured: true, accountId: '123456789012', arn: 'arn:aws:iam::123456789012:user/cloudcraft-server' });
  });

  it('says in plain words that the server has no AWS identity (the "invalid account" cause), with what to do', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' }));
    const r = await getServerAwsIdentity();
    expect(r.configured).toBe(false);
    if (!r.configured) {
      expect(r.reason).toMatch(/no AWS credentials of its own/i);
      expect(r.fix).toMatch(/AWS_ACCESS_KEY_ID/);
    }
  });

  it('an invalid or expired key is explained as such', async () => {
    mockSend.mockRejectedValue(new Error('The security token included in the request is invalid.'));
    const r = await getServerAwsIdentity();
    expect(!r.configured && r.reason).toMatch(/access key .* not valid/i);
  });

  it('answers from memory for a minute, and "fresh" asks again', async () => {
    mockSend.mockResolvedValue({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/a' });
    await getServerAwsIdentity(); await getServerAwsIdentity();
    expect(mockSend).toHaveBeenCalledTimes(1);
    mockSend.mockResolvedValue({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/b' });
    expect((await getServerAwsIdentity({ fresh: true }))).toMatchObject({ arn: 'arn:aws:iam::123456789012:user/b' });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('gives up after 8 seconds instead of hanging the screen (for example waiting on an unreachable metadata service)', async () => {
    jest.useFakeTimers();
    mockSend.mockReturnValue(new Promise(() => undefined));
    const p = getServerAwsIdentity();
    await jest.advanceTimersByTimeAsync(8_100);
    const r = await p;
    expect(r.configured).toBe(false);
    expect(!r.configured && r.reason).toMatch(/could not reach AWS/i);
  });

  it('an incomplete answer is not mistaken for a working identity', async () => {
    mockSend.mockResolvedValue({ Account: '123456789012' });
    expect((await getServerAwsIdentity()).configured).toBe(false);
  });
});

describe('a refused assume-role names the identity the server really is', () => {
  const call = () => validatePost(new NextRequest('http://localhost/api/cloud-accounts/acct-1/validate', { method: 'POST' }), { params: Promise.resolve({ id: 'acct-1' }) });
  beforeEach(() => {
    _clearServerIdentityCacheForTests();
    [mockSend, mockIdentity, mockOrgRole, mockResolveOrg, mockFind, mockCreds, mockUpdate, mockValidate].forEach((m) => m.mockReset());
    mockIdentity.mockReturnValue({ userId: 'u1', role: 'admin', orgIds: ['org-1'] });
    mockResolveOrg.mockResolvedValue('org-1'); mockOrgRole.mockResolvedValue('owner');
    mockFind.mockResolvedValue({ id: 'acct-1', provider: 'aws' });
    mockCreds.mockResolvedValue(JSON.stringify({ roleArn: 'arn:aws:iam::123456789012:role/x', externalId: 'e', region: 'us-east-1' }));
    mockUpdate.mockResolvedValue({});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('adds "the server is signed in as <arn> — the role must trust that identity"', async () => {
    mockValidate.mockResolvedValue({ valid: false, permissionsOk: false, missingPermissions: [], error: 'User: [arn] is not authorized to perform: sts:AssumeRole on resource: [arn]' });
    mockSend.mockResolvedValue({ Account: '999900001111', Arn: 'arn:aws:iam::999900001111:user/cloudcraft-server' });
    const body = (await (await call()).json()).data as { fix: string };
    expect(body.fix).toContain('The CloudBuilder server is signed in as arn:aws:iam::999900001111:user/cloudcraft-server');
    expect(String(mockUpdate.mock.calls[0]![3])).toContain('arn:aws:iam::999900001111:user/cloudcraft-server');
  });

  it('adds nothing when the server has no identity (that is a different message), and for other kinds of failure', async () => {
    mockValidate.mockResolvedValue({ valid: false, permissionsOk: false, missingPermissions: [], error: 'User: [arn] is not authorized to perform: sts:AssumeRole on resource: [arn]' });
    mockSend.mockRejectedValue(new Error('Could not load credentials from any providers'));
    expect(((await (await call()).json()).data as { fix: string }).fix).not.toMatch(/signed in as/);

    mockSend.mockResolvedValue({ Account: '999900001111', Arn: 'arn:aws:iam::999900001111:user/x' });
    mockValidate.mockResolvedValue({ valid: false, permissionsOk: false, missingPermissions: [], error: 'ExpiredToken' });
    expect(((await (await call()).json()).data as { fix: string }).fix).not.toMatch(/signed in as/);
  });
});
