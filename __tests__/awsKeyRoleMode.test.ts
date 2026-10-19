/**
 * Connecting an AWS account with the user's OWN access key and the user's OWN role: no AWS account or identity of CloudBuilder's is
 * involved anywhere. The key signs in and assumes the role, so discovery AND Terraform run on temporary role credentials.
 */
const mockStsSend = jest.fn();
const stsConstructed: { region?: string; credentials?: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string } }[] = [];
const assumeInputs: Record<string, unknown>[] = [];
jest.mock('@aws-sdk/client-sts', () => ({
  __esModule: true,
  STSClient: class { constructor(public config: object) { stsConstructed.push(config); } send(...a: unknown[]) { return mockStsSend(...a); } },
  AssumeRoleCommand: class { constructor(public input: Record<string, unknown>) { assumeInputs.push(input); } },
  GetCallerIdentityCommand: class { constructor(public input?: unknown) {} },
}));
const mockEc2Send = jest.fn();
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
import { authMethodOf, isAwsCredentials, isAwsKeyCredentials, isAwsKeyRoleCredentials, isAwsRoleCredentials, type CloudCredentials } from '@/lib/cloud/types';
import { AwsDiscoveryAdapter } from '@/lib/cloud/adapters/awsAdapter';
import { assertTerraformCapable } from '@/lib/cloud/terraformCapability';
import { resolveExecutionCredentials } from '@/lib/cloud/credentials/resolveExecutionCredentials';
import { explainValidationFailure } from '@/lib/cloud/validationExplain';
import { POST as createPost } from '@/app/api/cloud-accounts/route';
import { POST as validatePost } from '@/app/api/cloud-accounts/[id]/validate/route';

const KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const ROLE = 'arn:aws:iam::123456789012:role/CloudCraftRole';
const keyRole = { accessKeyId: KEY_ID, secretAccessKey: SECRET, roleArn: ROLE, externalId: 'ext-123', region: 'us-east-1' };
const keyRoleNoExt = { accessKeyId: KEY_ID, secretAccessKey: SECRET, roleArn: ROLE, region: 'us-east-1' };
const keyOnly = { accessKeyId: KEY_ID, secretAccessKey: SECRET, region: 'us-east-1' };
const roleOnly = { roleArn: ROLE, externalId: 'ext-123', region: 'us-east-1' };
const USER_ARN = 'arn:aws:iam::123456789012:user/cloudcraft';
const ASSUMED_ARN = 'arn:aws:sts::123456789012:assumed-role/CloudCraftRole/cloudcraft-discovery';

/** STS as AWS answers: AssumeRole gives temporary credentials; GetCallerIdentity says who is calling (the user, or the assumed role). */
function stsAnswers(who: { key?: string; assumed?: string } = {}) {
  mockStsSend.mockImplementation(async (cmd: { input?: { RoleArn?: string } }) => {
    if (cmd.input?.RoleArn) return { Credentials: { AccessKeyId: 'ASIATEMPORARY00000000', SecretAccessKey: 'temp-secret', SessionToken: 'TEMP-SESSION-TOKEN' } };
    return stsConstructed.at(-1)?.credentials?.sessionToken
      ? { Account: '123456789012', Arn: who.assumed ?? ASSUMED_ARN, UserId: 'AROAEXAMPLE:cloudcraft-discovery' }
      : { Account: '123456789012', Arn: who.key ?? USER_ARN, UserId: 'AIDAEXAMPLE' };
  });
}

beforeEach(() => { [mockStsSend, mockEc2Send].forEach((m) => m.mockReset()); stsConstructed.length = 0; assumeInputs.length = 0; });

describe('credential kinds', () => {
  it('a key + role is its own kind: not mistaken for a key alone or for a role alone', () => {
    expect(authMethodOf(keyRole)).toBe('key-and-role');
    expect(authMethodOf(keyRoleNoExt)).toBe('key-and-role');
    expect(authMethodOf(keyOnly)).toBe('access-key');
    expect(authMethodOf(roleOnly)).toBe('role');
    expect(isAwsKeyRoleCredentials(keyRole)).toBe(true);
    expect(isAwsKeyCredentials(keyRole)).toBe(false);
    expect(isAwsRoleCredentials(keyRole)).toBe(false);
    expect([keyRole, keyOnly, roleOnly].every((c) => isAwsCredentials(c))).toBe(true);
  });
});

describe('POST /api/cloud-accounts — connecting with a key and a role', () => {
  const call = (body: unknown) => createPost(new NextRequest('http://localhost/api/cloud-accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  beforeEach(() => {
    [mockIdentity, mockOrgRole, mockCreate].forEach((m) => m.mockReset());
    mockIdentity.mockReturnValue({ userId: 'u1', role: 'admin', orgIds: ['org-1'] });
    mockOrgRole.mockResolvedValue('owner');
    mockCreate.mockResolvedValue({ id: 'acct-1', provider: 'aws', name: 'Mine', identity: { authMethod: 'key-and-role' }, status: 'pending' });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  const saved = () => mockCreate.mock.calls[0]![0] as { credentialsJson: string; identityJson: string };

  it('stores the key AND the role (nothing is dropped), records how the account signs in, and never returns the secret', async () => {
    const res = await call({ provider: 'aws', name: 'Mine', credentials: keyRole });
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain(SECRET);
    expect(JSON.parse(saved().credentialsJson)).toEqual(keyRole);
    // how it signs in and what it points at: no secret, no full key id, no External ID value
    expect(JSON.parse(saved().identityJson)).toEqual({ authMethod: 'key-and-role', connection: { region: 'us-east-1', roleArn: ROLE, hasExternalId: true, accessKeyHint: 'AKIA…MPLE' } });
    for (const secret of [SECRET, KEY_ID, 'ext-123']) expect(saved().identityJson).not.toContain(secret);
  });

  it('the External ID is optional', async () => {
    expect((await call({ provider: 'aws', name: 'Mine', credentials: keyRoleNoExt })).status).toBe(201);
    expect(JSON.parse(saved().credentialsJson)).toEqual(keyRoleNoExt);
  });

  it('a key alone and a role alone are still accepted, and recorded as what they are', async () => {
    expect((await call({ provider: 'aws', name: 'k', credentials: keyOnly })).status).toBe(201);
    expect(JSON.parse(saved().identityJson)).toMatchObject({ authMethod: 'access-key' });
    mockCreate.mockClear();
    expect((await call({ provider: 'aws', name: 'r', credentials: roleOnly })).status).toBe(201);
    expect(JSON.parse(saved().identityJson)).toMatchObject({ authMethod: 'role' });
  });

  it.each([
    ['a role ARN that is not one', { ...keyRole, roleArn: 'arn:aws:iam::123:role/x' }],
    ['a role ARN for a user', { ...keyRole, roleArn: 'arn:aws:iam::123456789012:user/bob' }],
    ['an External ID with spaces around it', { ...keyRole, externalId: ' ext ' }],
    ['a temporary key (ASIA…)', { ...keyRole, accessKeyId: 'ASIAIOSFODNN7EXAMPLE' }],
    ['a short secret', { ...keyRole, secretAccessKey: 'short' }],
    ['a field nobody asked for (nothing is silently dropped)', { ...keyRole, sessionToken: 'x' }],
  ])('refuses %s', async (_n, credentials) => {
    expect((await call({ provider: 'aws', name: 'x', credentials })).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('the AWS adapter with a key and a role', () => {
  it('signs in with the user\'s own key, assumes the user\'s own role, and reads on the role\'s temporary credentials', async () => {
    stsAnswers();
    mockEc2Send.mockResolvedValue({ Vpcs: [] });
    const result = await new AwsDiscoveryAdapter(keyRole).validateAccount();
    expect(result).toMatchObject({ valid: true, permissionsOk: true, identity: { accountId: '123456789012', arn: ASSUMED_ARN } });
    // the role was assumed, with the user's External ID…
    expect(assumeInputs).toEqual([expect.objectContaining({ RoleArn: ROLE, ExternalId: 'ext-123' })]);
    // …by an STS client signed in with the user's key (never the server's ambient identity)…
    const signer = stsConstructed.find((c) => c.credentials?.accessKeyId === KEY_ID && !c.credentials.sessionToken);
    expect(signer).toBeDefined();
    // …and afterwards the identity was read with the role's temporary credentials
    expect(stsConstructed.some((c) => c.credentials?.sessionToken === 'TEMP-SESSION-TOKEN')).toBe(true);
  });

  it('without an External ID none is sent', async () => {
    stsAnswers();
    mockEc2Send.mockResolvedValue({ Vpcs: [] });
    await new AwsDiscoveryAdapter(keyRoleNoExt).validateAccount();
    expect(assumeInputs[0]).toMatchObject({ RoleArn: ROLE });
    expect(assumeInputs[0]!['ExternalId']).toBeUndefined();
  });

  it('refuses a root-user key before it is used for anything — the role is never assumed with it', async () => {
    stsAnswers({ key: 'arn:aws:iam::123456789012:root' });
    const result = await new AwsDiscoveryAdapter(keyRole).validateAccount();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/ROOT_ACCESS_KEY/);
    expect(assumeInputs).toHaveLength(0);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('a role that AWS will not let the key assume is invalid, with the cause in the message', async () => {
    mockStsSend.mockImplementation(async (cmd: { input?: { RoleArn?: string } }) => {
      if (cmd.input?.RoleArn) throw new Error('User: [arn] is not authorized to perform: sts:AssumeRole on resource: [arn]');
      return { Account: '123456789012', Arn: USER_ARN, UserId: 'AIDAEXAMPLE' };
    });
    const result = await new AwsDiscoveryAdapter(keyRole).validateAccount();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not authorized to perform: sts:AssumeRole/);
  });

  it('a role that cannot read anything is reported as missing permissions', async () => {
    stsAnswers();
    mockEc2Send.mockRejectedValue(new Error('UnauthorizedOperation'));
    const result = await new AwsDiscoveryAdapter(keyRole).validateAccount();
    expect(result).toMatchObject({ valid: false, permissionsOk: false });
    expect(result.missingPermissions).toContain('ec2:DescribeVpcs');
  });
});

describe('Terraform with a key and a role', () => {
  it('is allowed: a key + role may run it, a key alone may not', () => {
    expect(() => assertTerraformCapable(keyRole)).not.toThrow();
    expect(() => assertTerraformCapable(keyRoleNoExt)).not.toThrow();
    expect(() => assertTerraformCapable(roleOnly)).not.toThrow();
    expect(() => assertTerraformCapable(keyOnly)).toThrow(/access key and an IAM role/i);
  });

  it('runs on the role\'s TEMPORARY credentials: the key signs in only to assume the role, and is never given to Terraform', async () => {
    stsAnswers();
    const env = await resolveExecutionCredentials(keyRole as CloudCredentials);
    expect(env).toEqual({
      AWS_ACCESS_KEY_ID: 'ASIATEMPORARY00000000', AWS_SECRET_ACCESS_KEY: 'temp-secret', AWS_SESSION_TOKEN: 'TEMP-SESSION-TOKEN', AWS_DEFAULT_REGION: 'us-east-1',
    });
    expect(JSON.stringify(env)).not.toContain(KEY_ID);
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(stsConstructed[0]!.credentials).toMatchObject({ accessKeyId: KEY_ID, secretAccessKey: SECRET });
    expect(assumeInputs[0]).toMatchObject({ RoleArn: ROLE, ExternalId: 'ext-123', RoleSessionName: 'cloudcraft-terraform-execution' });
  });

  it('a key alone never becomes Terraform\'s environment; a legacy role-only account still assumes with the server\'s own identity', async () => {
    await expect(resolveExecutionCredentials(keyOnly as CloudCredentials)).rejects.toThrow(/access key alone/i);
    expect(mockStsSend).not.toHaveBeenCalled();
    stsAnswers();
    await resolveExecutionCredentials(roleOnly as CloudCredentials);
    expect(stsConstructed[0]!.credentials).toBeUndefined();        // ambient identity, as before
  });
});

describe('POST /api/cloud-accounts/[id]/validate for a key + role account', () => {
  const call = () => validatePost(new NextRequest('http://localhost/api/cloud-accounts/acct-1/validate', { method: 'POST' }), { params: Promise.resolve({ id: 'acct-1' }) });
  beforeEach(() => {
    [mockIdentity, mockOrgRole, mockResolveOrg, mockFind, mockCreds, mockUpdate].forEach((m) => m.mockReset());
    mockIdentity.mockReturnValue({ userId: 'u1', role: 'admin', orgIds: ['org-1'] });
    mockResolveOrg.mockResolvedValue('org-1'); mockOrgRole.mockResolvedValue('owner');
    mockFind.mockResolvedValue({ id: 'acct-1', provider: 'aws' });
    mockCreds.mockResolvedValue(JSON.stringify(keyRole));
    mockUpdate.mockResolvedValue({});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('a working connection is active and remembers that it is a key + role (so Terraform is allowed for it)', async () => {
    stsAnswers(); mockEc2Send.mockResolvedValue({ Vpcs: [] });
    expect(((await (await call()).json()).data as { valid: boolean }).valid).toBe(true);
    const [, , status, identityJson] = mockUpdate.mock.calls[0]!;
    expect(status).toBe('active');
    expect(JSON.parse(identityJson as string)).toMatchObject({ authMethod: 'key-and-role', accountId: '123456789012' });
    expect(String(identityJson)).not.toContain(SECRET);
  });

  it('a role the key cannot assume is explained in terms of the key, the role\'s trust and the External ID — never "the server"', async () => {
    mockStsSend.mockImplementation(async (cmd: { input?: { RoleArn?: string } }) => {
      if (cmd.input?.RoleArn) throw new Error('User: [arn] is not authorized to perform: sts:AssumeRole on resource: [arn]');
      return { Account: '123456789012', Arn: USER_ARN, UserId: 'AIDAEXAMPLE' };
    });
    const body = (await (await call()).json()).data as { valid: boolean; reason: string; fix: string };
    expect(body.valid).toBe(false);
    expect(body.reason).toMatch(/refused to let your access key assume the role/i);
    expect(body.fix).toMatch(/sts:AssumeRole/);
    expect(body.fix).toMatch(/trust policy/i);
    expect(body.fix).toMatch(/External ID/);
    expect(`${body.reason} ${body.fix}`).not.toMatch(/server/i);
  });
});

describe('explanations for a key + role', () => {
  it.each([
    ['ROOT_ACCESS_KEY: the access key belongs to the account root user', /root user/i],
    ['InvalidClientTokenId', /does not recognise this Access key ID/i],
    ['SignatureDoesNotMatch', /Secret access key does not match/i],
    ['User: [arn] is not authorized to perform: sts:AssumeRole on resource: [arn]', /refused to let your access key assume the role/i],
    ['Invalid length for parameter RoleArn', /role ARN does not look valid/i],
    ['getaddrinfo ENOTFOUND sts.amazonaws.com', /could not reach AWS/i],
  ])('"%s"', (msg, expected) => {
    expect(explainValidationFailure('aws', msg, [], 'key-and-role').reason).toMatch(expected);
  });
  it('when the role was assumed but cannot read, it says so', () => {
    expect(explainValidationFailure('aws', undefined, ['ec2:DescribeVpcs'], 'key-and-role').reason).toMatch(/assumed the role, but the role cannot read/i);
  });
  it('never repeats an access key id', () => {
    const e = explainValidationFailure('aws', `odd failure for ${KEY_ID}`, [], 'key-and-role');
    expect(`${e.reason} ${e.fix}`).not.toContain(KEY_ID);
  });
});

describe('a refused assume-role says exactly who may not assume which role', () => {
  const USER = 'arn:aws:iam::460195068628:user/Test';
  const ROLE_SAME = 'arn:aws:iam::460195068628:role/CloudCraft';
  const refusal = (user: string, role: string) => `User: ${user} is not authorized to perform: sts:AssumeRole on resource: ${role}`;
  const failAssume = (user: string, role: string) => mockStsSend.mockImplementation(async (cmd: { input?: { RoleArn?: string } }) => {
    if (cmd.input?.RoleArn) throw new Error(refusal(user, role));
    return { Account: '460195068628', Arn: user, UserId: 'AIDAEXAMPLE' };
  });

  it('the adapter keeps who and which role (ARNs are not secrets) before the text is sanitised', async () => {
    failAssume(USER, ROLE_SAME);
    const result = await new AwsDiscoveryAdapter({ ...keyRole, roleArn: ROLE_SAME }).validateAccount();
    expect(result.valid).toBe(false);
    expect(result.error).toContain(`ASSUME_DENIED|${USER}|${ROLE_SAME}|`);
  });

  it('same account: names the user and the role and gives the likeliest causes in order — role missing/misnamed, trust policy, External ID', () => {
    const e = explainValidationFailure('aws', `ASSUME_DENIED|${USER}|${ROLE_SAME}| ${refusal('[arn]', '[arn]')}`, [], 'key-and-role');
    expect(e.reason).toBe(`AWS refused to let ${USER} assume ${ROLE_SAME}.`);
    expect(e.fix).toMatch(/\(1\) the role exists with exactly this name/);
    expect(e.fix).toContain(`the role's trust policy allows ${USER}`);
    expect(e.fix).toMatch(/enough by itself in the same account/);
    expect(e.fix).toMatch(/sts:ExternalId condition/);
  });

  it('different accounts: says so, and also asks about the user\'s own permission to assume', () => {
    const e = explainValidationFailure('aws', `ASSUME_DENIED|${USER}|arn:aws:iam::111122223333:role/Other| x`, [], 'key-and-role');
    expect(e.fix).toContain('the role (in account 111122223333)');
    expect(e.fix).toContain('the account 460195068628');
    expect(e.fix).toMatch(/the user has an inline policy allowing sts:AssumeRole/);
  });

  it('the account row ends up saying it in plain words', async () => {
    failAssume(USER, ROLE_SAME);
    mockIdentity.mockReturnValue({ userId: 'u1', role: 'admin', orgIds: ['org-1'] });
    mockResolveOrg.mockResolvedValue('org-1'); mockOrgRole.mockResolvedValue('owner');
    mockFind.mockResolvedValue({ id: 'acct-1', provider: 'aws' });
    mockCreds.mockResolvedValue(JSON.stringify({ ...keyRole, roleArn: ROLE_SAME }));
    mockUpdate.mockReset();
    mockUpdate.mockResolvedValue({});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await validatePost(new NextRequest('http://localhost/api/cloud-accounts/acct-1/validate', { method: 'POST' }), { params: Promise.resolve({ id: 'acct-1' }) });
    const body = (await res.json()).data as { reason: string };
    expect(body.reason).toBe(`AWS refused to let ${USER} assume ${ROLE_SAME}.`);
    expect(JSON.parse(String(mockUpdate.mock.calls[0]![3]))).toMatchObject({ validationReason: body.reason });
  });

  it('other kinds of account keep the existing wording, and a marker never leaks into the text shown', () => {
    const legacy = explainValidationFailure('aws', `ASSUME_DENIED|${USER}|${ROLE_SAME}| x`, [], 'role');
    expect(legacy.reason).not.toContain('ASSUME_DENIED');
    const keyRoleGeneric = explainValidationFailure('aws', 'User: [arn] is not authorized to perform: sts:AssumeRole on resource: [arn]', [], 'key-and-role');
    expect(keyRoleGeneric.reason).toMatch(/refused to let your access key assume the role/i);
  });
});
