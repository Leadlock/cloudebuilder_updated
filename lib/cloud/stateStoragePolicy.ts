/**
 * The AWS permissions a role needs for CloudCraft's "Create state storage for me" button and for Terraform to use that storage
 * afterwards. Plain data (no AWS SDK), so the connect screen can show it, and kept in step with
 * lib/terraform/execution/stateBackendProvisioner.ts (which calls exactly these actions).
 *
 * Scoped to resources named with the CloudCraft prefixes, not "*": the role can create and use its state bucket and lock table, and
 * cannot touch any other bucket or table in the account. (Delete is only for the state object itself, which Terraform replaces on
 * each run; there is no permission to delete the bucket or the table.)
 */
export const STATE_BUCKET_PREFIX = 'cloudcraft-tfstate-';
export const STATE_LOCK_TABLE_PREFIX = 'cloudcraft-tf-lock';

export function buildStateStoragePolicy(): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'CloudCraftStateBucketCreateAndSecure',
        Effect: 'Allow',
        Action: ['s3:CreateBucket', 's3:PutBucketVersioning', 's3:PutEncryptionConfiguration', 's3:PutBucketPublicAccessBlock', 's3:PutBucketPolicy', 's3:PutBucketTagging', 's3:ListBucket', 's3:GetBucketLocation'],
        Resource: `arn:aws:s3:::${STATE_BUCKET_PREFIX}*`,
      },
      {
        Sid: 'CloudCraftStateObjects',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        Resource: `arn:aws:s3:::${STATE_BUCKET_PREFIX}*/*`,
      },
      {
        Sid: 'CloudCraftStateLockTable',
        Effect: 'Allow',
        Action: ['dynamodb:CreateTable', 'dynamodb:DescribeTable', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
        Resource: `arn:aws:dynamodb:*:*:table/${STATE_LOCK_TABLE_PREFIX}*`,
      },
      {
        // Used to pick a unique bucket name when the name field is left empty.
        Sid: 'CloudCraftWhoAmI',
        Effect: 'Allow',
        Action: 'sts:GetCallerIdentity',
        Resource: '*',
      },
    ],
  }, null, 2);
}
