/**
 * AzureOps for a connected account: the service principal's credentials are read when they are needed (in the request or the worker), turned into
 * short-lived tokens, and never stored in a release, a log or a queue payload.
 */
import { ClientSecretCredential } from '@azure/identity';
import { cloudAccountRepository } from '@/lib/repositories/cloudAccountRepository';
import { resolveExecutionCredentials } from '@/lib/cloud/credentials/resolveExecutionCredentials';
import { assertEnoughTimeLeft } from '@/lib/cloud/credentialLifetime';
import { isAzureCredentials, type CloudCredentials } from '@/lib/cloud/types';
import { createAzureOps, type AzureOps } from './azureOps';

export class AccountError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = 'AccountError'; }
}

/** Operations in the Azure subscription of a connected account. Throws AccountError when the account is missing or is not an Azure one. */
export async function azureOpsForAccount(orgId: string, cloudAccountId: string): Promise<AzureOps> {
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
