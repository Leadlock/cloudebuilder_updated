/**
 * Which connected accounts may run Terraform.
 *
 * An account connected with an AWS access key alone is for DISCOVERY ONLY by default. A stored key that could create and delete
 * infrastructure is a standing risk (unlike a role, which hands out temporary credentials), so running Terraform normally requires an
 * account connected with an IAM role (AWS) or a service principal (Azure). The owner can explicitly opt in to deploying with the key
 * itself ("allowDeploy", chosen when connecting): simpler, for test accounts, and never the default. Kept in its own small module so
 * every Terraform path — plan, apply, teardown, lock release — can check it the same way.
 */
import { isAwsKeyCredentials, isAwsDeployKeyCredentials } from '@/lib/cloud/types';
import type { AwsKeyCredentials, CloudCredentials, DeployKeyCredentials } from '@/lib/cloud/types';

export const ACCESS_KEY_NOT_FOR_TERRAFORM =
  'This account was connected with an access key alone, which CloudBuilder uses only to read (discover) your resources. To run Terraform, connect the account again with an access key and an IAM role (the role does the work, on temporary credentials), or connect it with the access key and choose to deploy with that key.';

/** Throws (HTTP 400) if the account cannot be used to run Terraform. */
export function assertTerraformCapable(credentials: CloudCredentials): asserts credentials is Exclude<CloudCredentials, AwsKeyCredentials> | DeployKeyCredentials {
  if (isAwsKeyCredentials(credentials) && !isAwsDeployKeyCredentials(credentials)) {
    throw Object.assign(new Error(ACCESS_KEY_NOT_FOR_TERRAFORM), { statusCode: 400 });
  }
}
