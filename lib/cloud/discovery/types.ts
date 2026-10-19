/**
 * Provider-independent semantic types for cloud infrastructure discovery & topology.
 *
 * Security:
 * - NEVER carry raw credentials or secrets.
 * - Credential resolution happens strictly server-side and is discarded after discovery.
 * - Only sanitized, functional infrastructure configuration is represented.
 */
import type { CloudProviderKey } from '../types';

// ─── Import State Machine ─────────────────────────────────────────────────────

export type ImportState =
  | 'imported'             // Existing infrastructure discovered in live cloud account
  | 'cloudbuilder-managed'   // CloudBuilder is the source of truth for this existing resource
  | 'new'                  // Newly added by user in CloudBuilder canvas (not yet in cloud)
  | 'modified'             // Existing imported resource with local changes planned
  | 'planned';             // Planned design resource scheduled for future deployment

// ─── Normalized Cloud Resource ────────────────────────────────────────────────

export interface CloudResource {
  /** Unique normalized ID (e.g. sanitised ARN or Azure resource ID) */
  id: string;
  /** Cloud provider */
  provider: CloudProviderKey;
  /** AWS Account ID or Azure Subscription ID */
  accountId?: string;
  subscriptionId?: string;
  /** Cloud region / location */
  region: string;
  /** Canonical resource type (e.g. 'vpc', 'subnet', 'ec2-instance', 'alb', 'virtual-machine') */
  resourceType: string;
  /** Human-readable display name */
  name: string;
  /** Provider-assigned ARN or ARM Resource ID */
  arn?: string;
  /** Native resource ID (e.g. 'i-0123456789abcdef0', 'vpc-12345678') */
  resourceId: string;
  /** User and system tags */
  tags: Record<string, string>;
  /** Runtime / provisioning status (running, available, stopped, etc.) */
  status: string;
  /** Provider-specific functional configuration (NO secrets, passwords, or tokens) */
  configuration: Record<string, unknown>;
  /** Parent resource ID for direct containment hierarchy (e.g. Subnet -> VPC) */
  parentResourceId?: string;
  /** Diagnostic and structural metadata */
  metadata: Record<string, unknown>;
  /** Hash of functional configuration for drift and change detection */
  configurationHash?: string;
  /** Timestamp when resource was discovered */
  discoveredAt?: string;
}

// ─── Normalized Topological Relationship ─────────────────────────────────────

export type CloudRelationshipType =
  | 'containment'   // Parent/child: VPC contains Subnet, Resource Group contains VNet
  | 'network'       // Network path: Subnet contains EC2/RDS, IGW attaches to VPC
  | 'traffic'       // Traffic flow: CloudFront -> ALB -> Target Group -> EC2
  | 'security'      // Security binding: Security Group / NSG bound to EC2 / Subnet
  | 'storage'       // Storage attachment: EC2 attached to EBS Volume, VM to Managed Disk
  | 'association';  // Generic association: Route Table attached to Subnet

export interface CloudRelationship {
  sourceResourceId: string;
  targetResourceId: string;
  relationshipType: CloudRelationshipType;
  label?: string;
  metadata?: Record<string, unknown>;
}

// ─── Discovered Topology ──────────────────────────────────────────────────────

export interface DiscoveredTopology {
  accountId: string;
  provider: CloudProviderKey;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'partial';
  startedAt: string;
  completedAt?: string;
  scannedRegions: string[];
  resources: CloudResource[];
  relationships: CloudRelationship[];
  summary: Record<string, number>;
  unsupportedResources: Array<{
    providerResourceId: string;
    rawType: string;
    name: string;
    region: string;
  }>;
  warnings: string[];
  error?: string;
}

// ─── Discovery Progress Reporting ─────────────────────────────────────────────

export interface DiscoveryProgress {
  stage:
    | 'connecting'
    | 'discovering_regions'
    | 'scanning_vpcs'
    | 'scanning_networking'
    | 'scanning_compute'
    | 'scanning_databases'
    | 'scanning_storage'
    | 'building_relationships'
    | 'building_architecture'
    | 'completed'
    | 'failed';
  currentRegion?: string;
  message: string;
  resourcesDiscovered: number;
  relationshipsDiscovered: number;
  unsupportedCount: number;
  percent?: number;
}

export type DiscoveryProgressCallback = (progress: DiscoveryProgress) => void;

// ─── Discovery Query Options ──────────────────────────────────────────────────

export interface DiscoveryOptions {
  /** Regions to discover. Use ['*'] for all accessible regions */
  regions?: string[];
  /** Optional resource type filter */
  includeResourceTypes?: string[];
  /** Progress reporting callback */
  onProgress?: DiscoveryProgressCallback;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}
