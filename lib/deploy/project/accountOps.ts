/**
 * AzureOps for a connected account: the service principal's credentials are read when they are needed (in the request or the worker), turned into
 * short-lived tokens, and never stored in a release, a log or a queue payload.
 */
import { ClientSecretCredential } from '@azure/identity';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { resolveExecutionCredentials } from '@/lib/cloud/credentials/resolveExecutionCredentials';
import { assertEnoughTimeLeft } from '@/lib/cloud/credentialLifetime';
import { isAzureCredentials, isAwsCredentials, type CloudCredentials } from '@/lib/cloud/types';
import { createAzureOps, type AcaOps, type AzureOps } from './azureOps';
import { createAwsClients, createAwsOps, type AwsOps } from './awsOps';
import { azureDriver, type ReleaseDriver } from './driver';
import { awsDriver } from './awsDriver';
import { ecsDriver } from './ecsDriver';
import { acaDriver } from './acaDriver';
import { createEcsClient, createEcsOps } from './ecsOps';
import type { Release } from './types';

export class AccountError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = 'AccountError'; }
}

/** Operations in the Azure subscription of a connected account. Throws AccountError when the account is missing or is not an Azure one. */
export async function azureOpsForAccount(orgId: string, cloudAccountId: string): Promise<AzureOps & AcaOps> {
  const json = await cloudAccountRepository.getCredentials(cloudAccountId, orgId);
  if (!json) throw new AccountError('The cloud account was not found.', 404);
  const creds = JSON.parse(json) as CloudCredentials;
  if (!isAzureCredentials(creds)) throw new AccountError('A deployment to an Azure VM needs an Azure account.');
  assertEnoughTimeLeft((creds as { expiresAt?: string }).expiresAt);
  // The same credentials Terraform gets (the provider's own variables); this also refuses an account that is for discovery only.
  await resolveExecutionCredentials(creds);
  const credential = new ClientSecretCredential(creds.tenantId, creds.clientId, creds.clientSecret);
  return createAzureOps({
    subscriptionId: creds.subscriptionId,
    getToken: async (scope) => {
      const t = await credential.getToken(scope);
      if (!t?.token) throw new AccountError('Azure did not give a token for this account. Check its credentials.', 502);
      return t.token;
    },
  });
}

/** Credentials for a connected AWS account: the role is assumed again whenever the credentials are about to run out. */
async function awsCredentialProvider(orgId: string, cloudAccountId: string, what: string) {
  const json = await cloudAccountRepository.getCredentials(cloudAccountId, orgId);
  if (!json) throw new AccountError('The cloud account was not found.', 404);
  const creds = JSON.parse(json) as CloudCredentials;
  if (!isAwsCredentials(creds)) throw new AccountError(`A deployment to ${what} needs an AWS account.`);
  assertEnoughTimeLeft((creds as { expiresAt?: string }).expiresAt);
  // The first look also refuses an account that is for discovery only.
  let cached = { at: Date.now(), env: await resolveExecutionCredentials(creds) };
  return async () => {
    if (Date.now() - cached.at > 10 * 60_000) cached = { at: Date.now(), env: await resolveExecutionCredentials(creds) };
    const e = cached.env;
    if (!e['AWS_ACCESS_KEY_ID'] || !e['AWS_SECRET_ACCESS_KEY']) throw new AccountError('AWS did not give credentials for this account. Check its role.', 502);
    return { accessKeyId: e['AWS_ACCESS_KEY_ID'], secretAccessKey: e['AWS_SECRET_ACCESS_KEY'], ...(e['AWS_SESSION_TOKEN'] ? { sessionToken: e['AWS_SESSION_TOKEN'] } : {}) };
  };
}

/** Operations in the AWS account of a connected account, in a region. */
export async function awsOpsForAccount(orgId: string, cloudAccountId: string, region: string): Promise<AwsOps> {
  return createAwsOps({ clients: createAwsClients(region, await awsCredentialProvider(orgId, cloudAccountId, 'AWS EC2')) });
}

/** The driver for a release: the cloud it runs in, with the connected account's credentials. */
export async function releaseDriverFor(release: Pick<Release, 'orgId' | 'cloudAccountId' | 'target' | 'outputs' | 'settings'>): Promise<ReleaseDriver> {
  if (release.target === 'ec2') {
    const region = release.outputs && release.outputs.kind === 'ec2' ? release.outputs.region : ((release.settings as { deploy?: { ec2?: { region?: string } } }).deploy?.ec2?.region ?? '');
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new AccountError('The AWS region of this release is not known.');
    return awsDriver(await awsOpsForAccount(release.orgId, release.cloudAccountId, region));
  }
  if (release.target === 'ecs') {
    const region = release.outputs && release.outputs.kind === 'ecs' ? release.outputs.region : ((release.settings as { deploy?: { ecs?: { region?: string } } }).deploy?.ecs?.region ?? '');
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new AccountError('The AWS region of this release is not known.');
    const credentials = await awsCredentialProvider(release.orgId, release.cloudAccountId, 'AWS ECS');
    return ecsDriver(createAwsOps({ clients: createAwsClients(region, credentials) }), createEcsOps({ ecs: createEcsClient(region, credentials) }));
  }
  if (release.target === 'container-apps') return acaDriver(await azureOpsForAccount(release.orgId, release.cloudAccountId));
  return azureDriver(await azureOpsForAccount(release.orgId, release.cloudAccountId));
}
