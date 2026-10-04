/**
 * Resolves a connected CloudAccount's CloudCredentials into environment
 * variables Terraform's native AWS/azurerm providers read directly — used
 * ONLY by the Terraform execution path (lib/terraform/execution), never by
 * discovery (which authenticates its own SDK clients directly and never
 * needs a flat env-var shape).
 *
 * AWS: CloudCraft only ever stores a cross-account role ARN + external ID
 * (AwsRoleCredentials), the same shape used for read-only discovery — there
 * is no static access key on file. Terraform can't assume a role itself
 * without first having *some* credential, so this performs the identical
 * STS AssumeRole call lib/cloud/adapters/awsAdapter.ts's discovery adapter
 * already does (using the app server's own ambient AWS identity — instance
 * role / env vars / etc. — to call sts:AssumeRole), and returns the
 * resulting temporary session credentials as AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN.
 *
 * IMPORTANT: the connected IAM role must be granted write permissions for
 * whatever Terraform will create/modify — REQUIRED_AWS_PERMISSIONS in
 * awsAdapter.ts is a read-only discovery permission set and is NOT
 * sufficient for apply. This is a deliberate scope boundary: CloudCraft
 * does not provision or widen that role's permissions itself.
 *
 * Azure: AzureSpCredentials maps directly onto Terraform's azurerm
 * provider's own ARM_* environment variable convention — no assume-role
 * equivalent needed.
 *
 * The returned env vars are never logged, and are only ever passed as the
 * `env` of a child_process — never written to a file, never included in
 * any API response.
 */
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { isAwsKeyRoleCredentials, isAwsRoleCredentials } from '@/lib/cloud/types';
import { assertTerraformCapable } from '@/lib/cloud/terraformCapability';
import type { CloudCredentials } from '@/lib/cloud/types';

export async function resolveExecutionCredentials(
  credentials: CloudCredentials,
): Promise<Record<string, string>> {
  assertTerraformCapable(credentials);     // defence in depth: an access key never becomes Terraform's environment
  if (isAwsRoleCredentials(credentials) || isAwsKeyRoleCredentials(credentials)) {
    // The user's own key signs in (a legacy role-only connection uses the server's ambient identity); the role is assumed either way,
    // so Terraform only ever runs on short-lived credentials.
    const signIn = isAwsKeyRoleCredentials(credentials) ? { credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey } } : {};
    const stsClient = new STSClient({ region: credentials.region, ...signIn });
    const assumed = await stsClient.send(
      new AssumeRoleCommand({
        RoleArn: credentials.roleArn,
        RoleSessionName: 'cloudcraft-terraform-execution',
        ExternalId: credentials.externalId || undefined,
        DurationSeconds: 3600,
      }),
    );

    if (
      !assumed.Credentials?.AccessKeyId ||
      !assumed.Credentials?.SecretAccessKey ||
      !assumed.Credentials?.SessionToken
    ) {
      throw new Error('STS AssumeRole did not return valid credentials for Terraform execution');
    }

    return {
      AWS_ACCESS_KEY_ID: assumed.Credentials.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: assumed.Credentials.SecretAccessKey,
      AWS_SESSION_TOKEN: assumed.Credentials.SessionToken,
      AWS_DEFAULT_REGION: credentials.region,
    };
  }

  return {
    ARM_CLIENT_ID: credentials.clientId,
    ARM_CLIENT_SECRET: credentials.clientSecret,
    ARM_TENANT_ID: credentials.tenantId,
    ARM_SUBSCRIPTION_ID: credentials.subscriptionId,
  };
}
