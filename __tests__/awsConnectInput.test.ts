/**
 * Telling a person what is wrong with what they typed — instead of "Validation failed" — both in the form (before anything is sent)
 * and in the server's answer.
 */
const mockIdentity = jest.fn();
const mockOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({
  extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockOrgRole(...a), resolveOrgIds: async () => ['org-1'],
}));
jest.mock('@/lib/repositories/orgRepository', () => ({ orgRepository: {} }));
const mockCreate = jest.fn();
jest.mock('@/lib/repositories/cloudAccountRepository', () => ({ cloudAccountRepository: { create: (...a: unknown[]) => mockCreate(...a) } }));

import { NextRequest } from 'next/server';
import { checkAwsConnectInput, describeArn } from '@/lib/cloud/awsConnectInput';
import { POST as createPost } from '@/app/api/cloud-accounts/route';

const good = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', roleArn: 'arn:aws:iam::123456789012:role/CloudCraftRole', externalId: '' };

describe('checkAwsConnectInput', () => {
  it('accepts correct input, with or without an External ID', () => {
    expect(checkAwsConnectInput(good)).toBeNull();
    expect(checkAwsConnectInput({ ...good, externalId: 'abc123' })).toBeNull();
    expect(checkAwsConnectInput({ ...good, accessKeyId: `  ${good.accessKeyId}  ` })).toBeNull();     // stray spaces from copy-paste
  });

  it('the mistake in the screenshot: an IAM USER\'s ARN pasted where the ROLE\'s is needed — says exactly that, and what to do', () => {
    const msg = checkAwsConnectInput({ ...good, roleArn: 'arn:aws:iam::460195068628:user/Test' });
    expect(msg).toMatch(/ARN of an IAM user, not of a role/);
    expect(msg).toMatch(/IAM → Roles/);
    expect(msg).toMatch(/steps 1 and 2/);
  });

  it.each([
    [{ accessKeyId: '' }, /Enter the Access key ID/],
    [{ accessKeyId: 'ASIAIOSFODNN7EXAMPLE' }, /temporary access key/],
    [{ accessKeyId: 'AKIA123' }, /20 characters and start with AKIA/],
    [{ secretAccessKey: '' }, /Enter the Secret access key/],
    [{ secretAccessKey: 'too-short' }, /40 characters/],
    [{ roleArn: '' }, /Enter the Role ARN/],
    [{ roleArn: 'arn:aws:iam::123456789012:root' }, /ARN of an account, not of a role/],
    [{ roleArn: 'CloudCraftRole' }, /should look like arn:aws:iam::123456789012:role\/CloudCraftRole/],
    [{ externalId: 'x' }, /External ID must be 2 to 1224 characters/],
  ])('%j → a sentence about that one field', (patch, expected) => {
    expect(checkAwsConnectInput({ ...good, ...patch })).toMatch(expected);
  });

  it('reports the first problem in the order the fields are filled in (key, secret, role, External ID)', () => {
    expect(checkAwsConnectInput({ accessKeyId: '', secretAccessKey: '', roleArn: '', externalId: '' })).toMatch(/Access key ID/);
    expect(checkAwsConnectInput({ ...good, secretAccessKey: '', roleArn: '' })).toMatch(/Secret access key/);
  });

  it('describeArn tells users, roles and accounts apart', () => {
    expect(describeArn('arn:aws:iam::123456789012:user/bob')).toBe('user');
    expect(describeArn('arn:aws:iam::123456789012:role/r')).toBe('role');
    expect(describeArn('arn:aws:iam::123456789012:root')).toBe('root');
    expect(describeArn('nonsense')).toBe('other');
  });
});

describe('POST /api/cloud-accounts says which field is wrong', () => {
  const call = (credentials: unknown, provider = 'aws') => createPost(new NextRequest('http://localhost/api/cloud-accounts', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, name: 'x', credentials }),
  }));
  const message = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;
  beforeEach(() => {
    [mockIdentity, mockOrgRole, mockCreate].forEach((m) => m.mockReset());
    mockIdentity.mockReturnValue({ userId: 'u1', role: 'admin', orgIds: ['org-1'] });
    mockOrgRole.mockResolvedValue('owner');
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  const keyRole = { accessKeyId: good.accessKeyId, secretAccessKey: good.secretAccessKey, roleArn: good.roleArn, region: 'us-east-1' };

  it('a user\'s ARN in the role field gets the plain explanation, not "Validation failed"', async () => {
    const res = await call({ ...keyRole, roleArn: 'arn:aws:iam::460195068628:user/Test' });
    expect(res.status).toBe(400);
    expect(await message(res)).toMatch(/roleArn is the ARN of an IAM user, not of a role/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['a bad access key id', { ...keyRole, accessKeyId: 'AKIA1' }, /accessKeyId: accessKeyId must be a long-term IAM access key ID/],
    ['a short secret', { ...keyRole, secretAccessKey: 'short' }, /secretAccessKey: secretAccessKey must be the 40-character secret access key/],
    ['a bad region', { ...keyRole, region: 'nowhere' }, /region: region must be a valid AWS region/],
    ['an unknown field', { ...keyRole, sessionToken: 'x' }, /Unrecognized key/],
  ])('%s is named', async (_n, credentials, expected) => {
    const res = await call(credentials);
    expect(res.status).toBe(400);
    expect(await message(res)).toMatch(expected);
  });

  it('Azure mistakes are named too', async () => {
    const res = await call({ tenantId: 'not-a-uuid', clientId: 'x', clientSecret: 's', subscriptionId: 'y' }, 'azure');
    expect(res.status).toBe(400);
    expect(await message(res)).toMatch(/tenantId: tenantId must be a valid UUID/);
  });

  it('an unrecognisable body still gets the plain "Validation failed", and bad JSON a clear message', async () => {
    expect(await message(await call({ nonsense: true }))).toBe('Validation failed');
    const bad = await createPost(new NextRequest('http://localhost/api/cloud-accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' }));
    expect(bad.status).toBe(400);
    expect(await message(bad)).toBe('Invalid JSON body');
  });

  it('the error never echoes the secret back', async () => {
    const res = await call({ ...keyRole, roleArn: 'arn:aws:iam::460195068628:user/Test' });
    expect(JSON.stringify(await res.json())).not.toContain(good.secretAccessKey);
  });
});
