/**
 * Provider-independent semantic types for discovered cloud resources.
 *
 * Security rules:
 * - These types NEVER carry credential fields.
 * - Credential resolution is done once in the adapter and discarded.
 * - Only sanitized, functional metadata flows through the system.
 */

// ─── Provider constants ───────────────────────────────────────────────────────

export type CloudProviderKey = 'aws' | 'azure';

// ─── Credentials (server-side only, never serialised to client) ────────────────

/**
 * AWS cross-account role assumption credentials.
 * The external ID is a shared secret CloudCraft uses to prevent confused-deputy attacks.
 */
export interface AwsRoleCredentials {
  roleArn: string;
  externalId: string;
  region: string;
  /** Optional: additional regions to discover in */
  additionalRegions?: string[];
}

/**
 * The user's OWN access key plus the user's OWN role: the key belongs to an IAM user in their account whose only permission is to
 * assume that role, and the role carries the real permissions (read-only for discovery, more for Terraform). CloudCraft signs in with
 * the key and assumes the role, so everything it does runs on short-lived role credentials — and no AWS account of CloudCraft's own
 * is involved anywhere. This is how accounts are connected.
 */
export interface AwsKeyRoleCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  roleArn: string;
  /** Optional: if the role's trust policy requires one. */
  externalId?: string;
  region: string;
  /** Optional: additional regions to discover in */
  additionalRegions?: string[];
}

/**
 * AWS access-key credentials with NO role: a long-lived key of an IAM user, used directly. For DISCOVERY ONLY unless the owner opted
 * in to deploying with the key (allowDeploy): a stored key that can change infrastructure is a standing risk, so it is never the default;
 * Terraform normally runs on a role's temporary credentials.
 */
export interface AwsKeyCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Optional: additional regions to discover in */
  additionalRegions?: string[];
  /**
   * Set only when the owner explicitly chose "deploy with this key": Terraform may then run directly on this key (which needs write
   * permission, for example AdministratorAccess on the IAM user). Without it a key alone is for discovery only.
   */
  allowDeploy?: true;
}

/**
 * Azure service principal credentials.
 */
export interface AzureSpCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
}

export type AwsCredentials = AwsRoleCredentials | AwsKeyRoleCredentials | AwsKeyCredentials;
export type CloudCredentials = AwsCredentials | AzureSpCredentials;

/** Legacy: a role assumed with the CloudCraft server's own AWS identity (no key in the credentials). */
export const isAwsRoleCredentials = (c: CloudCredentials): c is AwsRoleCredentials => 'roleArn' in c && !('accessKeyId' in c);
/** The user's own key + the user's own role (how accounts are connected now). */
export const isAwsKeyRoleCredentials = (c: CloudCredentials): c is AwsKeyRoleCredentials => 'accessKeyId' in c && 'roleArn' in c;
/** A key with no role (older connections): discovery only. */
export const isAwsKeyCredentials = (c: CloudCredentials): c is AwsKeyCredentials => 'accessKeyId' in c && !('roleArn' in c);
export const isAwsCredentials = (c: CloudCredentials): c is AwsCredentials => 'roleArn' in c || 'accessKeyId' in c;
export const isAzureCredentials = (c: CloudCredentials): c is AzureSpCredentials => 'tenantId' in c;

/** How an account signs in. Stored (as a plain label) with the account so the UI can say what it may be used for. */
export type AuthMethod = 'key-and-role' | 'role' | 'access-key' | 'access-key-deploy' | 'service-principal';
/** A key with no role that its owner allowed to deploy: Terraform runs directly on the key. */
export type DeployKeyCredentials = AwsKeyCredentials & { allowDeploy: true };
export const isAwsDeployKeyCredentials = (c: CloudCredentials): c is DeployKeyCredentials => isAwsKeyCredentials(c) && (c as AwsKeyCredentials).allowDeploy === true;

export function authMethodOf(c: CloudCredentials): AuthMethod {
  return isAwsKeyRoleCredentials(c) ? 'key-and-role' : isAwsRoleCredentials(c) ? 'role' : isAwsDeployKeyCredentials(c) ? 'access-key-deploy' : isAwsKeyCredentials(c) ? 'access-key' : 'service-principal';
}

// ─── Discovered resource (semantic model) ────────────────────────────────────

export type DiscoveredResourceType =
  // Networking
  | 'vpc' | 'vnet' | 'subnet' | 'internet-gateway' | 'nat-gateway' | 'route-table' | 'peering'
  // Compute
  | 'ec2-instance' | 'virtual-machine' | 'auto-scaling-group' | 'aks' | 'functions' | 'lambda' | 'ecs' | 'eks' | 'vm-scale-set' | 'web-app'
  // Storage
  | 's3-bucket' | 'storage-account' | 'blob-container' | 'ebs-volume'
  // Database
  | 'rds-instance' | 'sql-database' | 'sql-server' | 'dynamodb-table' | 'elasticache' | 'cosmos-db' | 'redis-cache'
  // Load balancing
  | 'alb' | 'nlb' | 'load-balancer' | 'application-gateway' | 'target-group'
  // CDN
  | 'cloudfront' | 'front-door'
  // Identity / security
  | 'iam-role' | 'security-group' | 'network-security-group' | 'key-vault' | 'network-acl' | 'kms-key' | 'waf-web-acl' | 'waf-policy' | 'bastion-host'
  // Messaging
  | 'sqs-queue'
  // DNS / monitoring
  | 'hosted-zone' | 'cloudwatch-alarm'
  // Other
  | 'resource-group' | 'public-ip' | 'network-interface' | 'unknown';

export interface DiscoveredResource {
  /** Provider-assigned resource ID (e.g. ARN, Azure resource ID) */
  providerResourceId: string;
  /** CloudCraft semantic type */
  resourceType: DiscoveredResourceType;
  /** Cloud provider */
  provider: CloudProviderKey;
  /** Human-readable name */
  name: string;
  /** Provider region / location */
  region: string;
  /** Runtime status (running, stopped, available, …) */
  status: string;
  /** Provider-specific structured configuration (NO secrets) */
  configuration: Record<string, unknown>;
  /** Additional metadata that does not fit configuration */
  metadata: Record<string, unknown>;
}

// ─── Discovery result ─────────────────────────────────────────────────────────

export type DiscoveryStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface DiscoveryResult {
  accountId: string;
  provider: CloudProviderKey;
  status: DiscoveryStatus;
  startedAt: string;
  completedAt?: string;
  resources: DiscoveredResource[];
  /**
   * Topological relationships (containment/network/traffic/security/storage
   * edges) reconstructed by the adapter from live API responses — e.g. real
   * ALB→TargetGroup→EC2 traffic paths from DescribeTargetHealth, not just
   * "same VPC" heuristics. sourceResourceId/targetResourceId reference the
   * same IDs as DiscoveredResource.providerResourceId.
   */
  relationships: import('./discovery/types').CloudRelationship[];
  error?: string;
  /** Summary counts by resource type */
  summary: Record<string, number>;
}

// ─── Account identity (safe to return to client) ─────────────────────────────

export interface AwsAccountIdentity {
  provider: 'aws';
  accountId: string;
  accountAlias?: string;
  arn: string;
  userId: string;
  region: string;
}

export interface AzureAccountIdentity {
  provider: 'azure';
  tenantId: string;
  subscriptionId: string;
  subscriptionName: string;
  clientId: string;
}

export type CloudAccountIdentity = AwsAccountIdentity | AzureAccountIdentity;

// ─── Validation result ────────────────────────────────────────────────────────

export interface AccountValidationResult {
  valid: boolean;
  identity?: CloudAccountIdentity;
  permissionsOk: boolean;
  missingPermissions: string[];
  error?: string;
}
