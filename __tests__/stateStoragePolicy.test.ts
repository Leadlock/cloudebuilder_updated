import { buildStateStoragePolicy, STATE_BUCKET_PREFIX, STATE_LOCK_TABLE_PREFIX } from '@/lib/cloud/stateStoragePolicy';
import { defaultBucketName } from '@/lib/terraform/execution/stateBackendProvisioner';

type Statement = { Effect: string; Action: string | string[]; Resource: string | string[] };
const statements = (JSON.parse(buildStateStoragePolicy()) as { Statement: Statement[] }).Statement;
const allActions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));

describe('state storage policy', () => {
  test('covers every call the state-storage button makes', () => {
    // IAM action for each SDK call in stateBackendProvisioner.ts (note: PutBucketEncryption needs s3:PutEncryptionConfiguration).
    for (const action of [
      's3:CreateBucket', 's3:PutBucketVersioning', 's3:PutEncryptionConfiguration', 's3:PutBucketPublicAccessBlock', 's3:PutBucketPolicy',
      's3:ListBucket', // HeadBucket
      'dynamodb:CreateTable', 'dynamodb:DescribeTable', 'sts:GetCallerIdentity',
    ]) expect(allActions).toContain(action);
  });

  test('covers what Terraform needs to use the state afterwards', () => {
    for (const action of ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem']) expect(allActions).toContain(action);
  });

  test('is scoped to CloudBuilder-named resources and can never delete a bucket or table', () => {
    expect(allActions.filter((a) => /^(s3:DeleteBucket|dynamodb:DeleteTable)/.test(a))).toEqual([]);
    for (const s of statements.filter((x) => !String(x.Action).includes('sts:'))) {
      for (const r of Array.isArray(s.Resource) ? s.Resource : [s.Resource]) {
        expect(r).not.toBe('*');
        expect(r).toMatch(new RegExp(`${STATE_BUCKET_PREFIX}|${STATE_LOCK_TABLE_PREFIX}`));
      }
    }
  });

  test('the automatic bucket name matches the policy, so the button works with the policy as shown', () => {
    expect(defaultBucketName('123456789012', 'eu-north-1').startsWith(STATE_BUCKET_PREFIX)).toBe(true);
  });
});

test('the policy allows tagging the state bucket', () => {
  expect(allActions).toContain('s3:PutBucketTagging');
});
