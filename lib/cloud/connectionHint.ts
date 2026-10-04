/**
 * The NON-secret facts about how an account is connected (which role, which region, which key it starts and ends with), saved with the
 * account so the Edit screen can show them. Never includes a secret, a full access key id, or the External ID's value.
 */
import { isAwsCredentials, isAwsKeyCredentials, isAwsKeyRoleCredentials, isAwsRoleCredentials, isAzureCredentials, type CloudCredentials } from './types';

export interface ConnectionHint {
  region?: string;
  roleArn?: string;
  /** For example "AKIA…MPLE": enough to recognise the key, not enough to use it. */
  accessKeyHint?: string;
  hasExternalId?: boolean;
  tenantId?: string;
  clientId?: string;
  subscriptionId?: string;
  clientSecretSet?: boolean;
}

export function maskAccessKeyId(id: string): string {
  return id.length >= 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : '…';
}

export function connectionHintOf(c: CloudCredentials): ConnectionHint {
  if (isAzureCredentials(c)) return { tenantId: c.tenantId, clientId: c.clientId, subscriptionId: c.subscriptionId, clientSecretSet: true };
  if (!isAwsCredentials(c)) return {};
  const hint: ConnectionHint = { region: c.region };
  if (isAwsKeyRoleCredentials(c) || isAwsRoleCredentials(c)) {
    hint.roleArn = c.roleArn;
    hint.hasExternalId = !!c.externalId;
  }
  if (isAwsKeyRoleCredentials(c) || isAwsKeyCredentials(c)) hint.accessKeyHint = maskAccessKeyId(c.accessKeyId);
  return hint;
}
