/**
 * Deploying with the IAM user's own access key (no role): an explicit opt-in ("allowDeploy"), never the default.
 */
import { renderToStaticMarkup } from 'react-dom/server';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-sts', () => ({ STSClient: jest.fn().mockImplementation(() => ({ send: mockSend })), AssumeRoleCommand: jest.fn() }));

import { authMethodOf, isAwsDeployKeyCredentials, type CloudCredentials } from '@/lib/cloud/types';
import { assertTerraformCapable, ACCESS_KEY_NOT_FOR_TERRAFORM } from '@/lib/cloud/terraformCapability';
import { resolveExecutionCredentials } from '@/lib/cloud/credentials/resolveExecutionCredentials';
import { AwsKeyCredentialsSchema, CloudCredentialsSchema } from '@/lib/cloud/credentialSchemas';
import { checkAwsConnectInput } from '@/lib/cloud/awsConnectInput';
import { explainValidationFailure } from '@/lib/cloud/validationExplain';
import ConnectAwsAccountForm from '@/components/accounts/ConnectAwsAccountForm';

const KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const keyOnly: CloudCredentials = { accessKeyId: KEY, secretAccessKey: SECRET, region: 'eu-north-1' };
const keyDeploy: CloudCredentials = { ...keyOnly, allowDeploy: true } as CloudCredentials;
const keyRole: CloudCredentials = { ...keyOnly, roleArn: 'arn:aws:iam::123456789012:role/CloudBuilder' };

describe('a key that its owner allowed to deploy', () => {
  test('is a distinct kind of account; a key alone and key + role are unchanged', () => {
    expect(authMethodOf(keyDeploy)).toBe('access-key-deploy');
    expect(authMethodOf(keyOnly)).toBe('access-key');
    expect(authMethodOf(keyRole)).toBe('key-and-role');
    expect(isAwsDeployKeyCredentials(keyDeploy)).toBe(true);
    expect(isAwsDeployKeyCredentials(keyOnly)).toBe(false);
  });

  test('may run Terraform; a key alone still may not, and says how to fix that', () => {
    expect(() => assertTerraformCapable(keyDeploy)).not.toThrow();
    expect(() => assertTerraformCapable(keyOnly)).toThrow(/access key and an IAM role/i);
    expect(ACCESS_KEY_NOT_FOR_TERRAFORM).toMatch(/deploy with that key/);
  });

  test('Terraform runs as the IAM user: its key in the environment, no assume-role call', async () => {
    const env = await resolveExecutionCredentials(keyDeploy);
    expect(env).toEqual({ AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET, AWS_DEFAULT_REGION: 'eu-north-1' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a key alone is still refused at the credential resolver (defence in depth)', async () => {
    await expect(resolveExecutionCredentials(keyOnly)).rejects.toThrow(/access key/i);
  });
});

describe('the credential schema', () => {
  test('accepts allowDeploy only as the literal true', () => {
    expect(AwsKeyCredentialsSchema.safeParse({ ...keyOnly, allowDeploy: true }).success).toBe(true);
    for (const bad of [false, 'true', 1, 'yes', null]) expect(AwsKeyCredentialsSchema.safeParse({ ...keyOnly, allowDeploy: bad }).success).toBe(false);
    expect(CloudCredentialsSchema.safeParse({ ...keyOnly, allowDeploy: true }).success).toBe(true);
  });
  test('a key + role body with allowDeploy is not accepted (the two modes do not mix)', () => {
    expect(CloudCredentialsSchema.safeParse({ ...keyRole, allowDeploy: true }).success).toBe(false);
  });
  test('the role mode and Azure are unaffected', () => {
    expect(CloudCredentialsSchema.safeParse(keyRole).success).toBe(true);
    expect(CloudCredentialsSchema.safeParse({ ...keyOnly }).success).toBe(true);
  });
});

describe('connect form input', () => {
  test('without a role (direct mode) only the key is checked', () => {
    expect(checkAwsConnectInput({ accessKeyId: KEY, secretAccessKey: SECRET, roleArn: '' }, { needsRole: false })).toBeNull();
    expect(checkAwsConnectInput({ accessKeyId: KEY, secretAccessKey: SECRET, roleArn: '' })).toMatch(/Role ARN/);       // role mode unchanged
    expect(checkAwsConnectInput({ accessKeyId: 'ASIA123', secretAccessKey: SECRET, roleArn: '' }, { needsRole: false })).toMatch(/temporary/);
    expect(checkAwsConnectInput({ accessKeyId: KEY, secretAccessKey: 'short', roleArn: '' }, { needsRole: false })).toMatch(/40 characters/);
  });
});

describe('validation messages for a deploy key read like a key, not a role', () => {
  test('a key AWS does not know', () => {
    const e = explainValidationFailure('aws', 'InvalidClientTokenId: The security token included in the request is invalid', [], 'access-key-deploy');
    expect(e.reason).toMatch(/does not recognise this Access key ID/);
  });
});

describe('the connect form', () => {
  const html = renderToStaticMarkup(<ConnectAwsAccountForm onConnected={() => undefined} />);
  test('opens in the simple mode: three steps, AdministratorAccess, no role fields', () => {
    expect(html).toContain('direct-key-guide');
    expect(html).toContain('AdministratorAccess');
    expect(html).not.toContain('Role ARN (arn:aws');
    expect(html).not.toContain('External ID');
  });
  test('says plainly what it grants and that it is for test accounts', () => {
    expect(html).toMatch(/create and delete anything in this AWS account/);
    expect(html).toMatch(/test or sandbox account/);
    expect(html).toMatch(/never with the account(&#x27;|')s root key/);
  });
  test('the safer mode is one click away', () => {
    expect(html).toContain('Safer');
    expect(html).toContain('Access key + IAM role');
  });
});
