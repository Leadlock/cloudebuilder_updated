/**
 * Which connected accounts may run Terraform.
 *
 * An account connected with an AWS access key is for DISCOVERY ONLY. A stored key that could create and delete infrastructure
 * would be a permanent standing risk (unlike a role, which hands out temporary credentials), so running Terraform requires an
 * account connected with an IAM role (AWS) or a service principal (Azure). Kept in its own small module so every Terraform path
 * — plan, apply, teardown, lock release — can check it the same way.
 */
import { isAwsKeyCredentials } from '@/lib/cloud/types';
import type { AwsKeyCredentials, CloudCredentials } from '@/lib/cloud/types';

export const ACCESS_KEY_NOT_FOR_TERRAFORM =
  'This account was connected with an access key, which CloudCraft uses only to read (discover) your resources. To run Terraform, connect the account with an IAM role instead.';

/** Throws (HTTP 400) if the account cannot be used to run Terraform. */
export function assertTerraformCapable(credentials: CloudCredentials): asserts credentials is Exclude<CloudCredentials, AwsKeyCredentials> {
  if (isAwsKeyCredentials(credentials)) {
    throw Object.assign(new Error(ACCESS_KEY_NOT_FOR_TERRAFORM), { statusCode: 400 });
  }
}
