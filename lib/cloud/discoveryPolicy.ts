/**
 * The read-only AWS permissions CloudBuilder's discovery uses, and the IAM policy built from them. Plain data (no AWS SDK), so the
 * connect screen can show it. Derived from the calls lib/cloud/adapters/awsAdapter.ts makes: list/describe/get-settings only —
 * nothing here can read S3 objects, DynamoDB items, SQS messages or secrets, or change anything.
 *
 * Note a few S3 actions are not named like their SDK calls (GetBucketEncryption needs s3:GetEncryptionConfiguration, and
 * GetPublicAccessBlock needs s3:GetBucketPublicAccessBlock).
 */
export const AWS_DISCOVERY_ACTIONS: readonly string[] = [
  // network and compute
  'ec2:DescribeRegions', 'ec2:DescribeVpcs', 'ec2:DescribeSubnets', 'ec2:DescribeSecurityGroups', 'ec2:DescribeRouteTables',
  'ec2:DescribeNetworkAcls', 'ec2:DescribeNatGateways', 'ec2:DescribeInternetGateways', 'ec2:DescribeInstances', 'ec2:DescribeVolumes',
  'ec2:DescribeLaunchTemplateVersions',
  'elasticloadbalancing:DescribeLoadBalancers', 'elasticloadbalancing:DescribeTargetGroups', 'elasticloadbalancing:DescribeTargetHealth',
  'autoscaling:DescribeAutoScalingGroups', 'autoscaling:DescribePolicies',
  'lambda:ListFunctions',
  'ecs:ListClusters', 'ecs:ListServices', 'ecs:DescribeServices', 'ecs:DescribeTaskDefinition',
  'eks:ListClusters', 'eks:DescribeCluster', 'eks:ListNodegroups', 'eks:DescribeNodegroup',
  // data services (settings only)
  'rds:DescribeDBInstances', 'elasticache:DescribeCacheClusters', 'elasticache:DescribeReplicationGroups',
  'dynamodb:ListTables', 'dynamodb:DescribeTable', 'sqs:ListQueues', 'sqs:GetQueueAttributes',
  's3:ListAllMyBuckets', 's3:GetBucketLocation', 's3:GetBucketVersioning', 's3:GetEncryptionConfiguration',
  's3:GetBucketPublicAccessBlock', 's3:GetBucketOwnershipControls',
  // security and edge
  'iam:ListRoles', 'iam:ListAttachedRolePolicies', 'kms:ListKeys', 'kms:ListAliases', 'kms:DescribeKey', 'kms:GetKeyRotationStatus',
  'wafv2:ListWebACLs', 'wafv2:GetWebACL', 'cloudfront:ListDistributions', 'route53:ListHostedZones', 'route53:ListResourceRecordSets',
  'cloudwatch:DescribeAlarms',
  // optional features
  'cloudwatch:GetMetricStatistics', 'wellarchitected:ListWorkloads', 'wellarchitected:GetWorkload',
  // account-level checks for the Well-Architected review (CloudTrail, GuardDuty, root MFA, AWS Config): status reads only
  'cloudtrail:DescribeTrails', 'cloudtrail:GetTrailStatus', 'guardduty:ListDetectors', 'guardduty:GetDetector',
  'iam:GetAccountSummary', 'config:DescribeConfigurationRecorders', 'config:DescribeConfigurationRecorderStatus',
];

/** The inline policy to attach to the read-only IAM user (or role) CloudBuilder connects with. */
export function buildDiscoveryPolicy(): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Sid: 'CloudCraftDiscoveryReadOnly', Effect: 'Allow', Action: AWS_DISCOVERY_ACTIONS, Resource: '*' }],
  }, null, 2);
}
