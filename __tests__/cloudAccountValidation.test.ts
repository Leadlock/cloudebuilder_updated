/**
 * Why a cloud account is "invalid", in plain words â€” and keeping that reason with the account so the list can show it.
 */
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
import { explainValidationFailure } from '@/lib/cloud/validationExplain';
import { POST } from '@/app/api/cloud-accounts/[id]/validate/route';

describe('explainValidationFailure â€” AWS', () => {
  it('the server has no AWS credentials of its own: says so, and that the role has not been tested yet', () => {
    const e = explainValidationFailure('aws', 'Could not load credentials from any providers');
    expect(e.reason).toMatch(/server has no AWS credentials of its own/i);
    expect(e.fix).toMatch(/AWS_ACCESS_KEY_ID/);
    expect(e.fix).toMatch(/not been tested/i);
    expect(explainValidationFailure('aws', 'CredentialsProviderError: x').reason).toBe(e.reason);
  });

  it.each([
    ['The security token included in the request is invalid.', /access key .* not valid/i],
    ['InvalidClientTokenId', /access key .* not valid/i],
    ['The request signature we calculated does not match: SignatureDoesNotMatch', /access key .* not valid/i],
    ['ExpiredToken: The provided token has expired.', /have expired/i],
    ['User: [arn] is not authorized to perform: sts:AssumeRole on resource: [arn]', /refused to let CloudCraft assume your role/i],
    ['Invalid length for parameter RoleArn, value: 3, valid min length: 20', /role ARN does not look valid/i],
    ['getaddrinfo ENOTFOUND sts.us-east-1.amazonaws.com', /could not reach AWS/i],
  ])('"%s"', (msg, expected) => {
    expect(explainValidationFailure('aws', msg).reason).toMatch(expected);
  });

  it('refusing the assume-role names the three things to check (trust policy, External ID, the server\'s own permission)', () => {
    const e = explainValidationFailure('aws', 'User: [arn] is not authorized to perform: sts:AssumeRole on resource: [arn]');
    expect(e.fix).toMatch(/trust policy/i);
    expect(e.fix).toMatch(/External ID/);
    expect(e.fix).toMatch(/sts:AssumeRole/);
  });

  it('when the role was assumed but cannot read anything, it says what is missing and what to attach', () => {
    const e = explainValidationFailure('aws', undefined, ['ec2:DescribeVpcs', 'ec2:DescribeSubnets', 'ec2:DescribeInstances', 'rds:DescribeDBInstances']);
    expect(e.reason).toMatch(/assumed the role, but the role cannot read your resources/);
    expect(e.reason).toContain('ec2:DescribeVpcs');
    expect(e.reason).not.toContain('rds:DescribeDBInstances');      // only the first few
    expect(e.fix).toMatch(/ReadOnlyAccess/);
  });

  it('an error it does not recognise is passed on (shortened) with a pointer to the log, never swallowed', () => {
    const e = explainValidationFailure('aws', 'Something unusual happened '.repeat(40));
    expect(e.reason.startsWith('The connection check failed: Something unusual')).toBe(true);
    expect(e.reason.length).toBeLessThan(260);
    expect(e.fix).toMatch(/server log/);
    expect(explainValidationFailure('aws', '').reason).toBe('The connection check failed.');
  });
});

describe('explainValidationFailure â€” Azure', () => {
  it.each([
    ['AADSTS7000215: Invalid client secret provided.', /client secret is wrong/i],
    ['AADSTS7000222: The provided client secret keys are expired.', /has expired/i],
    ['AADSTS700016: Application with identifier \'abc\' was not found in the directory', /No Azure application matches this client ID/i],
    ['AADSTS90002: Tenant \'abc\' not found.', /tenant ID was not found/i],
    ['AuthorizationFailed: The client does not have authorization to perform action', /not allowed to read this subscription/i],
    ['SubscriptionNotFound: The subscription was not found.', /subscription ID was not found/i],
    ['connect ETIMEDOUT 20.1.2.3:443', /could not reach Azure/i],
  ])('"%s"', (msg, expected) => {
    expect(explainValidationFailure('azure', msg).reason).toMatch(expected);
  });
  it('an AWS-only message is not mistaken for an Azure one, and the reverse', () => {
    expect(explainValidationFailure('azure', 'Could not load credentials from any providers').reason).toMatch(/connection check failed/i);
    expect(explainValidationFailure('aws', 'AADSTS7000215').reason).toMatch(/connection check failed/i);
  });
});

describe('POST /api/cloud-accounts/[id]/validate keeps the reason with the account', () => {
  const call = () => POST(new NextRequest('http://localhost/api/cloud-accounts/acct-1/validate', { method: 'POST' }), { params: Promise.resolve({ id: 'acct-1' }) });
  beforeEach(() => {
    [mockIdentity, mockOrgRole, mockResolveOrg, mockFind, mockCreds, mockUpdate, mockValidate].forEach((m) => m.mockReset());
    mockIdentity.mockReturnValue({ userId: 'u1', role: 'admin', orgIds: ['org-1'] });
    mockResolveOrg.mockResolvedValue('org-1'); mockOrgRole.mockResolvedValue('owner');
    mockFind.mockResolvedValue({ id: 'acct-1', provider: 'aws' });
    mockCreds.mockResolvedValue(JSON.stringify({ roleArn: 'arn:aws:iam::123456789012:role/x', externalId: 'e', region: 'us-east-1' }));
    mockUpdate.mockResolvedValue({});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('a failed check is saved as invalid, with the plain-words reason and fix inside the account\'s identity, and returned', async () => {
    mockValidate.mockResolvedValue({ valid: false, permissionsOk: false, missingPermissions: ['ec2:DescribeVpcs'], error: 'Could not load credentials from any providers' });
    const res = await call();
    const body = (await res.json()).data as { valid: boolean; reason: string; fix: string; error: string };
    expect(body.valid).toBe(false);
    expect(body.reason).toMatch(/server has no AWS credentials/i);
    expect(body.fix).toMatch(/AWS_ACCESS_KEY_ID/);
    const [id, org, status, identityJson] = mockUpdate.mock.calls[0]!;
    expect([id, org, status]).toEqual(['acct-1', 'org-1', 'invalid']);
    expect(JSON.parse(identityJson as string)).toMatchObject({ validationReason: body.reason, validationFix: body.fix });
  });

  it('a successful check is active, replaces any earlier failure reason, and returns no reason', async () => {
    mockValidate.mockResolvedValue({ valid: true, permissionsOk: true, missingPermissions: [], identity: { provider: 'aws', accountId: '123456789012', arn: 'arn:aws:sts::123456789012:assumed-role/x/y', userId: 'U', region: 'us-east-1' } });
    const res = await call();
    expect(((await res.json()).data as { reason: unknown }).reason).toBeNull();
    const [, , status, identityJson] = mockUpdate.mock.calls[0]!;
    expect(status).toBe('active');
    const saved = JSON.parse(identityJson as string);
    expect(saved.accountId).toBe('123456789012');
    expect(saved).not.toHaveProperty('validationReason');
  });

  it('never saves or returns the stored credentials (their values), only the explanation', async () => {
    mockCreds.mockResolvedValue(JSON.stringify({ roleArn: 'arn:aws:iam::999988887777:role/MyPrivateRole', externalId: 'EXT-ID-VALUE-8f3a1c', region: 'us-east-1' }));
    mockValidate.mockResolvedValue({ valid: false, permissionsOk: false, missingPermissions: [], error: 'Could not load credentials from any providers' });
    const res = await call();
    const text = JSON.stringify(await res.json()) + String(mockUpdate.mock.calls[0]![3]);
    expect(text).not.toContain('EXT-ID-VALUE-8f3a1c');
    expect(text).not.toContain('999988887777');
    expect(text).not.toContain('MyPrivateRole');
  });

  it('still needs a signed-in member of the account\'s organisation', async () => {
    mockIdentity.mockReturnValue(null);
    expect((await call()).status).toBe(401);
    mockIdentity.mockReturnValue({ userId: 'u1', role: 'admin', orgIds: [] }); mockOrgRole.mockResolvedValue(null);
    expect((await call()).status).toBe(403);
    mockOrgRole.mockResolvedValue('member'); mockFind.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(mockValidate).not.toHaveBeenCalled();
  });
});
