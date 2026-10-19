/**
 * CloudBuilder — 240 Template Catalog (8 Categories × 3 Providers × 10 Templates)
 *
 * Full authoritative architecture pattern library covering:
 * 1. Web Applications (10 AWS, 10 Azure, 10 Multi-Cloud)
 * 2. High Availability (10 AWS, 10 Azure, 10 Multi-Cloud)
 * 3. SaaS (10 AWS, 10 Azure, 10 Multi-Cloud)
 * 4. E-Commerce (10 AWS, 10 Azure, 10 Multi-Cloud)
 * 5. Microservices (10 AWS, 10 Azure, 10 Multi-Cloud)
 * 6. Data & Analytics (10 AWS, 10 Azure, 10 Multi-Cloud)
 * 7. Disaster Recovery (10 AWS, 10 Azure, 10 Multi-Cloud)
 * 8. Multi-cloud (10 AWS, 10 Azure, 10 Multi-Cloud)
 *
 * Total: 240 distinct, production-grade cloud architecture templates.
 */

import { ArchitectureTemplate, CanvasNode, CanvasEdge, RelationshipType, NetworkScope, TemplateGenerateOptions } from '@/types';
import { getResourceDefinition } from '@/lib/resources';

// Helper to create nodes
function n(
  id: string,
  resourceType: string,
  provider: 'aws' | 'azure',
  label: string,
  x: number,
  y: number,
  config: Record<string, unknown> = {},
  groupId?: string,
  width?: number,
  height?: number
): CanvasNode {
  const isContainer =
    resourceType.includes('vpc') ||
    resourceType.includes('vnet') ||
    resourceType.includes('subnet') ||
    resourceType.includes('boundary') ||
    resourceType.includes('resource_group');

  return {
    id,
    type: isContainer ? 'containerNode' : 'cloudNode',
    resourceType,
    provider,
    label,
    position: { x, y },
    groupId,
    parentId: groupId,
    width,
    height,
    // Start from the resource definition defaults so the stored (canonical) config
    // is explicit and identical to what the Properties panel shows, Terraform
    // renders and the assessment engine evaluates.
    config: { ...(getResourceDefinition(resourceType)?.defaultConfig ?? {}), name: label.toLowerCase().replace(/\s+/g, '-'), ...config },
  };
}

// Helper to create edges — always uses deterministic source:relType:target as ID
function e(
  _legacyId: string,
  source: string,
  target: string,
  label?: string,
  relationshipType: RelationshipType = 'NETWORK_FLOW',
  protocol?: string,
  port?: string | number,
  networkScope: NetworkScope = 'private'
): CanvasEdge {
  const deterministicId = `${source}:${relationshipType}:${target}`;
  return {
    id: deterministicId,
    source,
    target,
    label,
    edgeType: relationshipType,
    relationshipType,
    protocol,
    port,
    networkScope,
    direction: 'unidirectional',
    inferred: false,
    validationStatus: 'valid',
  };
}

// ── Generic Template Builder Functions ──────────────────────────────────────

interface AwsTemplateSpec {
  id: string;
  name: string;
  category: string;
  description: string;
  complexity: 'simple' | 'moderate' | 'complex';
  cost: number;
  features: string[];
  tags: string[];
  useCdn?: boolean;
  useWaf?: boolean;
  useDns?: boolean;
  computeType: 'ec2' | 'asg' | 'ecs' | 'eks' | 'lambda';
  dbType: 'rds' | 'dynamo' | 'none';
  useRedis?: boolean;
  useS3?: boolean;
  useSqs?: boolean;
  useIgw?: boolean;
  useNat?: boolean;
  isMultiAz?: boolean;
}

function createAwsTemplate(spec: AwsTemplateSpec): ArchitectureTemplate {
  return {
    id: spec.id,
    name: spec.name,
    category: spec.category,
    description: spec.description,
    provider: 'aws',
    complexity: spec.complexity,
    estimatedCost: spec.cost,
    resourceCount: 10 + (spec.useCdn ? 1 : 0) + (spec.useRedis ? 1 : 0) + (spec.useS3 ? 1 : 0) + (spec.useSqs ? 1 : 0) + (spec.dbType === 'rds' ? 1 : 0) + (spec.computeType !== 'lambda' && spec.useNat !== false ? 1 : 0),
    isAdaptive: true,
    scaleRecommendation: 'Recommended: 1K–100K users',
    features: spec.features,
    tags: ['aws', spec.category.toLowerCase().replace(/\s+/g, '-'), spec.computeType, ...spec.tags],
    generate(_opts: TemplateGenerateOptions = {}) {
      const nodes: CanvasNode[] = [];
      const edges: CanvasEdge[] = [];

      // Cloud Boundary
      nodes.push(n(`${spec.id}-cloud`, 'aws_cloud_boundary', 'aws', 'Amazon Web Services (us-east-1)', 30, 20, { region: 'us-east-1' }, undefined, 1180, 880));

      // Edge Layer
      if (spec.useDns) {
        nodes.push(n(`${spec.id}-r53`, 'aws_route53', 'aws', 'Route 53 DNS', 80, 70, { domainName: 'cloudcraft.io' }, `${spec.id}-cloud`));
      }
      if (spec.useCdn) {
        nodes.push(n(`${spec.id}-cf`, 'aws_cloudfront', 'aws', 'CloudFront Global CDN', 320, 70, { priceClass: 'PriceClass_100' }, `${spec.id}-cloud`));
        if (spec.useDns) {
          edges.push(e(`${spec.id}-e-dns-cf`, `${spec.id}-r53`, `${spec.id}-cf`, 'DNS Alias', 'RESOLVES_TO', 'DNS', 53, 'public'));
        }
      }
      if (spec.useWaf) {
        nodes.push(n(`${spec.id}-waf`, 'aws_waf', 'aws', 'AWS WAF Shield', 560, 70, { defaultAction: 'ALLOW' }, `${spec.id}-cloud`));
        if (spec.useCdn) {
          edges.push(e(`${spec.id}-e-waf-cf`, `${spec.id}-waf`, `${spec.id}-cf`, 'Inspect Traffic', 'ASSOCIATED_WITH', undefined, undefined, 'internal'));
        }
      }

      // VPC Container
      nodes.push(n(`${spec.id}-vpc`, 'aws_vpc', 'aws', 'Production VPC (10.0.0.0/16)', 60, 180, { cidrBlock: '10.0.0.0/16' }, `${spec.id}-cloud`, 1060, 660));

      const hasIgw = spec.useIgw !== false;
      if (hasIgw) {
        nodes.push(n(`${spec.id}-igw`, 'aws_igw', 'aws', 'Internet Gateway', 470, 225, {}, `${spec.id}-vpc`));
      }

      // Public Subnet
      nodes.push(n(`${spec.id}-sub-pub`, 'aws_subnet', 'aws', 'Public Ingress Subnet (10.0.1.0/24)', 90, 310, { cidrBlock: '10.0.1.0/24', mapPublicIpOnLaunch: true }, `${spec.id}-vpc`, 480, 150));
      nodes.push(n(`${spec.id}-alb`, 'aws_alb', 'aws', 'Application Load Balancer', 120, 355, { lbType: 'application' }, `${spec.id}-sub-pub`));
      nodes.push(n(`${spec.id}-sg-alb`, 'aws_sg', 'aws', 'ALB Security Group', 120, 260, { allowHttp: true, allowHttps: true, allowSsh: false }, `${spec.id}-vpc`));
      edges.push(e(`${spec.id}-e-sg-alb`, `${spec.id}-sg-alb`, `${spec.id}-alb`, 'Security Group', 'ASSOCIATED_WITH', undefined, undefined, 'internal'));
      if (hasIgw) {
        edges.push(e(`${spec.id}-e-igw-alb`, `${spec.id}-igw`, `${spec.id}-alb`, 'Inbound HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'));
      }

      // NAT Gateway — required for any private-subnet compute tier that needs outbound
      // internet access (OS/package updates, external API calls). Defaults on for
      // server-based compute; off for Lambda, which doesn't need it by default.
      const needsNat = spec.useNat !== false && spec.computeType !== 'lambda';
      if (needsNat) {
        nodes.push(n(`${spec.id}-nat`, 'aws_nat', 'aws', 'NAT Gateway', 340, 355, {}, `${spec.id}-sub-pub`));
        if (hasIgw) {
          edges.push(e(`${spec.id}-e-nat-igw`, `${spec.id}-nat`, `${spec.id}-igw`, 'NAT Egress', 'ROUTES_TO', 'TCP', undefined, 'public'));
        }
      }

      // App Subnet
      nodes.push(n(`${spec.id}-sub-app`, 'aws_subnet', 'aws', 'Private App Subnet (10.0.10.0/24)', 90, 480, { cidrBlock: '10.0.10.0/24' }, `${spec.id}-vpc`, 480, 150));
      nodes.push(n(`${spec.id}-sg-app`, 'aws_sg', 'aws', 'App Tier Security Group', 90, 430, { allowHttp: false, allowHttps: false, allowSsh: false }, `${spec.id}-vpc`));
      const computeId = `${spec.id}-compute`;
      if (spec.computeType === 'ec2') {
        nodes.push(n(computeId, 'aws_ec2', 'aws', 'App Worker EC2', 200, 525, { instanceType: 't3.medium' }, `${spec.id}-sub-app`));
      } else if (spec.computeType === 'asg') {
        nodes.push(n(computeId, 'aws_auto_scaling', 'aws', 'Auto Scaling Group', 200, 525, { minSize: 2, maxSize: 8, desiredCapacity: 2 }, `${spec.id}-sub-app`));
      } else if (spec.computeType === 'ecs') {
        nodes.push(n(computeId, 'aws_ecs', 'aws', 'ECS Task Service', 200, 525, { launchType: 'FARGATE', desiredCount: 2 }, `${spec.id}-sub-app`));
      } else if (spec.computeType === 'eks') {
        nodes.push(n(computeId, 'aws_eks', 'aws', 'EKS Node Group', 200, 525, { nodeCount: 3 }, `${spec.id}-sub-app`));
      } else {
        nodes.push(n(computeId, 'aws_lambda', 'aws', 'Serverless Worker', 200, 525, { runtime: 'nodejs20.x' }, `${spec.id}-sub-app`));
      }
      edges.push(e(`${spec.id}-e-sg-comp`, `${spec.id}-sg-app`, computeId, 'Security Group', 'ASSOCIATED_WITH', undefined, undefined, 'internal'));

      edges.push(e(`${spec.id}-e-alb-comp`, `${spec.id}-alb`, computeId, 'Forward HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'));
      if (needsNat) {
        edges.push(e(`${spec.id}-e-comp-nat`, computeId, `${spec.id}-nat`, 'Egress NAT', 'ROUTES_TO', 'TCP', undefined, 'private'));
      }

      // Database Subnet
      if (spec.dbType === 'rds') {
        nodes.push(n(`${spec.id}-sub-db`, 'aws_subnet', 'aws', 'Private Database Subnet (10.0.20.0/24)', 600, 480, { cidrBlock: '10.0.20.0/24' }, `${spec.id}-vpc`, 480, 150));
        nodes.push(n(`${spec.id}-sg-db`, 'aws_sg', 'aws', 'Database Security Group', 600, 430, { allowHttp: false, allowHttps: false, allowSsh: false }, `${spec.id}-vpc`));
        nodes.push(n(`${spec.id}-rds`, 'aws_rds', 'aws', spec.isMultiAz ? 'RDS PostgreSQL Multi-AZ' : 'RDS PostgreSQL Instance', 720, 525, { engine: 'postgres', multiAz: spec.isMultiAz !== false, encrypted: true, publiclyAccessible: false, deletionProtection: true }, `${spec.id}-sub-db`));
        edges.push(e(`${spec.id}-e-sg-rds`, `${spec.id}-sg-db`, `${spec.id}-rds`, 'Security Group', 'ASSOCIATED_WITH', undefined, undefined, 'internal'));
        edges.push(e(`${spec.id}-e-comp-rds`, computeId, `${spec.id}-rds`, 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'));

        if (spec.useRedis) {
          nodes.push(n(`${spec.id}-redis`, 'aws_elasticache', 'aws', 'ElastiCache Redis', 920, 525, { numNodes: 2 }, `${spec.id}-sub-db`));
          edges.push(e(`${spec.id}-e-comp-redis`, computeId, `${spec.id}-redis`, 'Redis / 6379', 'CONNECTS_TO', 'Redis', 6379, 'private'));
        }
      } else if (spec.dbType === 'dynamo') {
        nodes.push(n(`${spec.id}-dynamo`, 'aws_dynamodb', 'aws', 'DynamoDB Fast Table', 720, 525, { billingMode: 'PAY_PER_REQUEST' }, `${spec.id}-cloud`));
        edges.push(e(`${spec.id}-e-comp-dynamo`, computeId, `${spec.id}-dynamo`, 'DynamoDB API', 'CONNECTS_TO', 'HTTPS', 443, 'private'));
      }

      // Storage & Messaging
      if (spec.useS3) {
        nodes.push(n(`${spec.id}-s3`, 'aws_s3', 'aws', 'S3 Object Vault', 600, 310, { encryption: true, versioning: true }, `${spec.id}-cloud`));
        edges.push(e(`${spec.id}-e-comp-s3`, computeId, `${spec.id}-s3`, 'Put/Get Object', 'STORES_IN', 'HTTPS', 443, 'private'));
      }

      if (spec.useSqs) {
        nodes.push(n(`${spec.id}-sqs`, 'aws_sqs', 'aws', 'SQS Async Queue', 820, 310, { encryption: true }, `${spec.id}-cloud`));
        edges.push(e(`${spec.id}-e-comp-sqs`, computeId, `${spec.id}-sqs`, 'Poll Events', 'CONNECTS_TO', 'HTTPS', 443, 'private'));
      }

      return { nodes, edges };
    },
  };
}

interface AzureTemplateSpec {
  id: string;
  name: string;
  category: string;
  description: string;
  complexity: 'simple' | 'moderate' | 'complex';
  cost: number;
  features: string[];
  tags: string[];
  useFrontDoor?: boolean;
  useWaf?: boolean;
  computeType: 'vm' | 'vmss' | 'aks' | 'functions';
  dbType: 'sql' | 'cosmos' | 'none';
  useRedis?: boolean;
  useStorage?: boolean;
  isZoneRedundant?: boolean;
}

function createAzureTemplate(spec: AzureTemplateSpec): ArchitectureTemplate {
  return {
    id: spec.id,
    name: spec.name,
    category: spec.category,
    description: spec.description,
    provider: 'azure',
    complexity: spec.complexity,
    estimatedCost: spec.cost,
    resourceCount: 9 + (spec.useFrontDoor ? 1 : 0) + (spec.useRedis ? 1 : 0) + (spec.useStorage ? 1 : 0) + (spec.dbType === 'sql' ? 1 : 0) + (spec.computeType === 'vm' || spec.computeType === 'vmss' || spec.computeType === 'aks' ? 1 : 0),
    isAdaptive: true,
    scaleRecommendation: 'Recommended: 1K–100K users',
    features: spec.features,
    tags: ['azure', spec.category.toLowerCase().replace(/\s+/g, '-'), spec.computeType, ...spec.tags],
    generate(_opts: TemplateGenerateOptions = {}) {
      const nodes: CanvasNode[] = [];
      const edges: CanvasEdge[] = [];

      // Cloud Boundary
      nodes.push(n(`${spec.id}-cloud`, 'azure_cloud_boundary', 'azure', 'Microsoft Azure (East US)', 30, 20, { region: 'eastus' }, undefined, 1180, 880));

      // Edge Layer
      if (spec.useFrontDoor) {
        nodes.push(n(`${spec.id}-fd`, 'azure_front_door', 'azure', 'Azure Front Door', 360, 65, { sku: 'Standard_AzureFrontDoor' }, `${spec.id}-cloud`));
      }
      if (spec.useWaf) {
        nodes.push(n(`${spec.id}-waf`, 'azure_waf', 'azure', 'Azure WAF Policy', 620, 65, { mode: 'Prevention' }, `${spec.id}-cloud`));
        if (spec.useFrontDoor) {
          edges.push(e(`${spec.id}-e-waf-fd`, `${spec.id}-waf`, `${spec.id}-fd`, 'WAF Policy Attached', 'ASSOCIATED_WITH', undefined, undefined, 'internal'));
        }
      }

      // Resource Group
      nodes.push(n(`${spec.id}-rg`, 'azure_resource_group', 'azure', 'Production Resource Group', 60, 170, { location: 'eastus' }, `${spec.id}-cloud`, 1080, 680));

      // VNet Container
      nodes.push(n(`${spec.id}-vnet`, 'azure_vnet', 'azure', 'Production VNet (10.0.0.0/16)', 80, 230, { addressSpace: '10.0.0.0/16' }, `${spec.id}-rg`, 1040, 600));

      // Ingress Subnet
      nodes.push(n(`${spec.id}-sub-ing`, 'azure_subnet', 'azure', 'Ingress Subnet (10.0.1.0/24)', 110, 280, { addressPrefix: '10.0.1.0/24' }, `${spec.id}-vnet`, 460, 140));
      nodes.push(n(`${spec.id}-agw`, 'azure_app_gateway', 'azure', 'Application Gateway (WAF v2)', 200, 320, { sku: 'WAF_v2' }, `${spec.id}-sub-ing`));
      if (spec.useFrontDoor) {
        edges.push(e(`${spec.id}-e-fd-agw`, `${spec.id}-fd`, `${spec.id}-agw`, 'Backend Pool HTTPS', 'ROUTES_TO', 'HTTPS', 443, 'public'));
      }

      // Workload Subnet
      nodes.push(n(`${spec.id}-sub-app`, 'azure_subnet', 'azure', 'App Workload Subnet (10.0.10.0/24)', 110, 440, { addressPrefix: '10.0.10.0/24' }, `${spec.id}-vnet`, 460, 150));
      nodes.push(n(`${spec.id}-nsg-app`, 'azure_nsg', 'azure', 'App Subnet NSG', 110, 390, { allowSsh: false, allowRdp: false }, `${spec.id}-vnet`));
      const computeId = `${spec.id}-compute`;
      if (spec.computeType === 'vm') {
        nodes.push(n(computeId, 'azure_vm', 'azure', 'Application Virtual Machine', 200, 485, { size: 'Standard_B2s' }, `${spec.id}-sub-app`));
      } else if (spec.computeType === 'vmss') {
        nodes.push(n(computeId, 'azure_vmss', 'azure', 'App VM Scale Set (VMSS)', 200, 485, { sku: 'Standard_B2s', capacity: 3 }, `${spec.id}-sub-app`));
      } else if (spec.computeType === 'aks') {
        nodes.push(n(computeId, 'azure_aks', 'azure', 'Production AKS Cluster', 200, 485, { nodeCount: 3 }, `${spec.id}-sub-app`));
      } else {
        nodes.push(n(computeId, 'azure_functions', 'azure', 'Functions App Service', 200, 485, { runtime: 'node' }, `${spec.id}-sub-app`));
      }
      edges.push(e(`${spec.id}-e-nsg-comp`, `${spec.id}-nsg-app`, computeId, 'Network Security Group', 'ASSOCIATED_WITH', undefined, undefined, 'internal'));

      edges.push(e(`${spec.id}-e-agw-comp`, `${spec.id}-agw`, computeId, 'Forward Traffic / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'));

      // Outbound internet access for the workload subnet — VM/VMSS/AKS need
      // egress for OS updates and external calls; Functions doesn't need one by default.
      const needsNat = spec.computeType === 'vm' || spec.computeType === 'vmss' || spec.computeType === 'aks';
      if (needsNat) {
        nodes.push(n(`${spec.id}-nat`, 'azure_nat', 'azure', 'NAT Gateway', 340, 440, {}, `${spec.id}-vnet`));
        edges.push(e(`${spec.id}-e-comp-nat`, computeId, `${spec.id}-nat`, 'Egress NAT', 'ROUTES_TO', 'TCP', undefined, 'private'));
      }

      // Data Tier Subnet
      if (spec.dbType === 'sql') {
        nodes.push(n(`${spec.id}-sub-db`, 'azure_subnet', 'azure', 'Data Tier Subnet (10.0.20.0/24)', 600, 440, { addressPrefix: '10.0.20.0/24' }, `${spec.id}-vnet`, 480, 150));
        nodes.push(n(`${spec.id}-nsg-db`, 'azure_nsg', 'azure', 'Data Subnet NSG', 600, 390, { allowSsh: false, allowRdp: false }, `${spec.id}-vnet`));
        nodes.push(n(`${spec.id}-sql`, 'azure_sql', 'azure', spec.isZoneRedundant ? 'Azure SQL (Zone Redundant)' : 'Azure SQL Database', 700, 485, { tier: 'GeneralPurpose', zoneRedundant: spec.isZoneRedundant !== false, publicNetworkAccess: false }, `${spec.id}-sub-db`));
        edges.push(e(`${spec.id}-e-nsg-sql`, `${spec.id}-nsg-db`, `${spec.id}-sql`, 'Network Security Group', 'ASSOCIATED_WITH', undefined, undefined, 'internal'));
        edges.push(e(`${spec.id}-e-comp-sql`, computeId, `${spec.id}-sql`, 'TDS / 1433', 'CONNECTS_TO', 'TDS', 1433, 'private'));

        if (spec.useRedis) {
          nodes.push(n(`${spec.id}-redis`, 'azure_redis', 'azure', 'Azure Cache for Redis', 920, 485, { sku: 'Standard' }, `${spec.id}-sub-db`));
          edges.push(e(`${spec.id}-e-comp-redis`, computeId, `${spec.id}-redis`, 'Redis TLS / 6380', 'CONNECTS_TO', 'Redis TLS', 6380, 'private'));
        }
      } else if (spec.dbType === 'cosmos') {
        nodes.push(n(`${spec.id}-cosmos`, 'azure_cosmos_db', 'azure', 'Azure Cosmos DB', 700, 485, { defaultConsistency: 'Session', enableAutomaticFailover: true }, `${spec.id}-rg`));
        edges.push(e(`${spec.id}-e-comp-cosmos`, computeId, `${spec.id}-cosmos`, 'Cosmos DB API / 443', 'CONNECTS_TO', 'HTTPS', 443, 'private'));
      }

      // Storage & Monitoring
      if (spec.useStorage) {
        nodes.push(n(`${spec.id}-storage`, 'azure_storage', 'azure', 'Blob Storage Account', 600, 280, { sku: 'Standard_ZRS', httpsOnly: true }, `${spec.id}-rg`));
        edges.push(e(`${spec.id}-e-comp-storage`, computeId, `${spec.id}-storage`, 'Blob HTTPS / 443', 'STORES_IN', 'HTTPS', 443, 'private'));
      }

      return { nodes, edges };
    },
  };
}

interface MultiCloudTemplateSpec {
  id: string;
  name: string;
  category: string;
  description: string;
  complexity: 'simple' | 'moderate' | 'complex';
  cost: number;
  features: string[];
  tags: string[];
  crossProtocol: string;
  crossPort?: number;
  crossLabel: string;
}

function createMultiCloudTemplate(spec: MultiCloudTemplateSpec): ArchitectureTemplate {
  return {
    id: spec.id,
    name: spec.name,
    category: spec.category,
    description: spec.description,
    provider: 'multi',
    complexity: spec.complexity,
    estimatedCost: spec.cost,
    resourceCount: 20,
    isAdaptive: true,
    scaleRecommendation: 'Recommended: 1K–100K users',
    features: spec.features,
    tags: ['multi-cloud', 'hybrid', spec.category.toLowerCase().replace(/\s+/g, '-'), ...spec.tags],
    generate(_opts: TemplateGenerateOptions = {}) {
      const nodes: CanvasNode[] = [];
      const edges: CanvasEdge[] = [];

      // AWS Cloud Boundary (Left side)
      nodes.push(n(`${spec.id}-aws-cloud`, 'aws_cloud_boundary', 'aws', 'AWS Primary Cloud (us-east-1)', 30, 20, { region: 'us-east-1' }, undefined, 620, 840));
      nodes.push(n(`${spec.id}-aws-vpc`, 'aws_vpc', 'aws', 'AWS Workload VPC (10.1.0.0/16)', 50, 90, { cidrBlock: '10.1.0.0/16' }, `${spec.id}-aws-cloud`, 580, 740));
      nodes.push(n(`${spec.id}-aws-igw`, 'aws_igw', 'aws', 'Internet Gateway', 460, 120, {}, `${spec.id}-aws-vpc`));
      nodes.push(n(`${spec.id}-aws-sub-pub`, 'aws_subnet', 'aws', 'AWS Public Subnet (10.1.1.0/24)', 70, 160, { cidrBlock: '10.1.1.0/24', mapPublicIpOnLaunch: true }, `${spec.id}-aws-vpc`, 540, 160));
      nodes.push(n(`${spec.id}-aws-alb`, 'aws_alb', 'aws', 'AWS Ingress Load Balancer', 180, 210, { lbType: 'application' }, `${spec.id}-aws-sub-pub`));
      nodes.push(n(`${spec.id}-aws-sg-alb`, 'aws_sg', 'aws', 'ALB Security Group', 380, 210, { allowHttp: true, allowHttps: true, allowSsh: false }, `${spec.id}-aws-vpc`));
      nodes.push(n(`${spec.id}-aws-nat`, 'aws_nat', 'aws', 'NAT Gateway', 380, 160, {}, `${spec.id}-aws-sub-pub`));
      nodes.push(n(`${spec.id}-aws-sub-app`, 'aws_subnet', 'aws', 'AWS Compute Subnet (10.1.10.0/24)', 70, 340, { cidrBlock: '10.1.10.0/24' }, `${spec.id}-aws-vpc`, 540, 160));
      nodes.push(n(`${spec.id}-aws-sg-app`, 'aws_sg', 'aws', 'App Tier Security Group', 380, 340, { allowHttp: false, allowHttps: false, allowSsh: false }, `${spec.id}-aws-vpc`));
      nodes.push(n(`${spec.id}-aws-ec2`, 'aws_ec2', 'aws', 'AWS Compute Engine', 180, 390, { instanceType: 'm5.large' }, `${spec.id}-aws-sub-app`));
      nodes.push(n(`${spec.id}-aws-sub-db`, 'aws_subnet', 'aws', 'AWS Data Subnet (10.1.20.0/24)', 70, 520, { cidrBlock: '10.1.20.0/24' }, `${spec.id}-aws-vpc`, 540, 160));
      nodes.push(n(`${spec.id}-aws-rds`, 'aws_rds', 'aws', 'AWS RDS PostgreSQL', 180, 570, { engine: 'postgres', multiAz: true, publiclyAccessible: false, deletionProtection: true }, `${spec.id}-aws-sub-db`));

      edges.push(e(`${spec.id}-e-aws-igw-alb`, `${spec.id}-aws-igw`, `${spec.id}-aws-alb`, 'Inbound HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'));
      edges.push(e(`${spec.id}-e-aws-sg-alb`, `${spec.id}-aws-sg-alb`, `${spec.id}-aws-alb`, 'Security Group', 'ASSOCIATED_WITH', undefined, undefined, 'internal'));
      edges.push(e(`${spec.id}-e-aws-sg-ec2`, `${spec.id}-aws-sg-app`, `${spec.id}-aws-ec2`, 'Security Group', 'ASSOCIATED_WITH', undefined, undefined, 'internal'));
      edges.push(e(`${spec.id}-e-aws-alb-ec2`, `${spec.id}-aws-alb`, `${spec.id}-aws-ec2`, 'Balance Traffic', 'LOAD_BALANCES', 'HTTP', 80, 'private'));
      edges.push(e(`${spec.id}-e-aws-ec2-nat`, `${spec.id}-aws-ec2`, `${spec.id}-aws-nat`, 'Egress NAT', 'ROUTES_TO', 'TCP', undefined, 'private'));
      edges.push(e(`${spec.id}-e-aws-nat-igw`, `${spec.id}-aws-nat`, `${spec.id}-aws-igw`, 'NAT Egress', 'ROUTES_TO', 'TCP', undefined, 'public'));
      edges.push(e(`${spec.id}-e-aws-ec2-rds`, `${spec.id}-aws-ec2`, `${spec.id}-aws-rds`, 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'));

      // Azure Cloud Boundary (Right side)
      nodes.push(n(`${spec.id}-az-cloud`, 'azure_cloud_boundary', 'azure', 'Azure Secondary Cloud (East US)', 700, 20, { region: 'eastus' }, undefined, 620, 840));
      nodes.push(n(`${spec.id}-az-rg`, 'azure_resource_group', 'azure', 'Azure Resource Group', 720, 90, { location: 'eastus' }, `${spec.id}-az-cloud`, 580, 740));
      nodes.push(n(`${spec.id}-az-vnet`, 'azure_vnet', 'azure', 'Azure Data VNet (10.2.0.0/16)', 740, 160, { addressSpace: '10.2.0.0/16' }, `${spec.id}-az-rg`, 540, 640));
      nodes.push(n(`${spec.id}-az-sub-app`, 'azure_subnet', 'azure', 'Azure Workload Subnet (10.2.10.0/24)', 760, 230, { addressPrefix: '10.2.10.0/24' }, `${spec.id}-az-vnet`, 500, 160));
      nodes.push(n(`${spec.id}-az-nsg-app`, 'azure_nsg', 'azure', 'App Subnet NSG', 1050, 230, { allowSsh: false, allowRdp: false }, `${spec.id}-az-vnet`));
      nodes.push(n(`${spec.id}-az-vmss`, 'azure_vmss', 'azure', 'Azure Workload VMSS', 860, 280, { sku: 'Standard_B2s', capacity: 2 }, `${spec.id}-az-sub-app`));
      nodes.push(n(`${spec.id}-az-sub-db`, 'azure_subnet', 'azure', 'Azure DB Subnet (10.2.20.0/24)', 760, 410, { addressPrefix: '10.2.20.0/24' }, `${spec.id}-az-vnet`, 500, 160));
      nodes.push(n(`${spec.id}-az-nsg-db`, 'azure_nsg', 'azure', 'Data Subnet NSG', 1050, 410, { allowSsh: false, allowRdp: false }, `${spec.id}-az-vnet`));
      nodes.push(n(`${spec.id}-az-sql`, 'azure_sql', 'azure', 'Azure SQL Database', 860, 460, { tier: 'GeneralPurpose', zoneRedundant: true, publicNetworkAccess: false }, `${spec.id}-az-sub-db`));
      nodes.push(n(`${spec.id}-az-storage`, 'azure_storage', 'azure', 'Azure Blob Vault', 860, 620, { sku: 'Standard_GRS', httpsOnly: true }, `${spec.id}-az-rg`));

      edges.push(e(`${spec.id}-e-az-nsg-vmss`, `${spec.id}-az-nsg-app`, `${spec.id}-az-vmss`, 'Network Security Group', 'ASSOCIATED_WITH', undefined, undefined, 'internal'));
      edges.push(e(`${spec.id}-e-az-nsg-sql`, `${spec.id}-az-nsg-db`, `${spec.id}-az-sql`, 'Network Security Group', 'ASSOCIATED_WITH', undefined, undefined, 'internal'));
      edges.push(e(`${spec.id}-e-az-vmss-sql`, `${spec.id}-az-vmss`, `${spec.id}-az-sql`, 'TDS / 1433', 'CONNECTS_TO', 'TDS', 1433, 'private'));
      edges.push(e(`${spec.id}-e-az-sql-blob`, `${spec.id}-az-sql`, `${spec.id}-az-storage`, 'Archive Export', 'STORES_IN', 'HTTPS', 443, 'private'));

      // Explicit Cross-Cloud Relationship Edge
      edges.push(e(
        `${spec.id}-e-cross-cloud`,
        `${spec.id}-aws-ec2`,
        `${spec.id}-az-sql`,
        spec.crossLabel,
        'CONNECTS_TO',
        spec.crossProtocol,
        spec.crossPort || 443,
        'cross-cloud'
      ));

      return { nodes, edges };
    },
  };
}

// ── 240 Template Specifications ─────────────────────────────────────────────

const categories = [
  'Web Applications',
  'High Availability',
  'SaaS',
  'E-Commerce',
  'Microservices',
  'Data & Analytics',
  'Disaster Recovery',
  'Multi-cloud',
] as const;

interface AwsPatternItem {
  name: string;
  compute: AwsTemplateSpec['computeType'];
  db: AwsTemplateSpec['dbType'];
  cost: number;
  tags: string[];
  cdn?: boolean;
  waf?: boolean;
  dns?: boolean;
  redis?: boolean;
  s3?: boolean;
  sqs?: boolean;
  isMultiAz?: boolean;
}

interface AzurePatternItem {
  name: string;
  compute: AzureTemplateSpec['computeType'];
  db: AzureTemplateSpec['dbType'];
  cost: number;
  tags: string[];
  fd?: boolean;
  waf?: boolean;
  redis?: boolean;
  storage?: boolean;
  isZone?: boolean;
}

interface MultiPatternItem {
  name: string;
  cost: number;
  protocol: string;
  port: number;
  label: string;
  tags: string[];
}

// Patterns definition for 8 categories x 10 templates each
const patterns: Record<string, { aws: AwsPatternItem[]; azure: AzurePatternItem[]; multi: MultiPatternItem[] }> = {
  'Web Applications': {
    aws: [
      { name: 'Production 3-Tier Web Application', compute: 'ec2', db: 'rds', cost: 380, redis: true, s3: true, tags: ['3-tier', 'rds', 'ec2'] },
      { name: 'Global Web App with CloudFront CDN', compute: 'ec2', db: 'rds', cost: 410, cdn: true, dns: true, redis: true, tags: ['cloudfront', 'cdn'] },
      { name: 'Serverless Web Application', compute: 'lambda', db: 'dynamo', cost: 120, cdn: true, dns: true, s3: true, tags: ['serverless', 'lambda'] },
      { name: 'Containerized Web Platform on ECS', compute: 'ecs', db: 'rds', cost: 440, cdn: true, redis: true, s3: true, tags: ['ecs', 'fargate'] },
      { name: 'High-Traffic Web Architecture', compute: 'asg', db: 'rds', cost: 520, cdn: true, waf: true, redis: true, tags: ['high-traffic', 'asg'] },
      { name: 'API-Backed Modern Web Portal', compute: 'lambda', db: 'rds', cost: 260, cdn: true, s3: true, tags: ['api', 'modern-web'] },
      { name: 'CDN-Heavy Media Delivery Web Platform', compute: 'ec2', db: 'rds', cost: 430, cdn: true, s3: true, tags: ['media', 'streaming'] },
      { name: 'Monolith-to-Microservices Hybrid Web App', compute: 'ecs', db: 'rds', cost: 480, redis: true, s3: true, tags: ['hybrid', 'microservices'] },
      { name: 'Enterprise Secure Web Intranet', compute: 'asg', db: 'rds', cost: 510, waf: true, redis: true, s3: true, tags: ['enterprise', 'waf'] },
      { name: 'Dynamic Single-Page App with CloudFront', compute: 'lambda', db: 'dynamo', cost: 95, cdn: true, s3: true, tags: ['spa', 'react'] },
    ],
    azure: [
      { name: 'Production 3-Tier Azure Web Application', compute: 'vm', db: 'sql', cost: 395, redis: true, storage: true, tags: ['3-tier', 'vm'] },
      { name: 'Global Web App with Azure Front Door', compute: 'vmss', db: 'sql', cost: 440, fd: true, redis: true, storage: true, tags: ['front-door'] },
      { name: 'Serverless Azure Web Application', compute: 'functions', db: 'cosmos', cost: 130, fd: true, storage: true, tags: ['serverless', 'functions'] },
      { name: 'Containerized Web Platform on AKS', compute: 'aks', db: 'sql', cost: 490, fd: true, redis: true, storage: true, tags: ['aks', 'kubernetes'] },
      { name: 'High-Traffic Azure Web Architecture', compute: 'vmss', db: 'sql', cost: 530, fd: true, waf: true, redis: true, tags: ['high-traffic'] },
      { name: 'API-Driven Azure Web Portal', compute: 'functions', db: 'sql', cost: 280, fd: true, storage: true, tags: ['api', 'apim'] },
      { name: 'Azure Media Delivery Web Platform', compute: 'vmss', db: 'sql', cost: 450, fd: true, storage: true, tags: ['media', 'blob'] },
      { name: 'Enterprise Secure Azure Web Intranet', compute: 'vmss', db: 'sql', cost: 520, waf: true, redis: true, storage: true, tags: ['enterprise', 'waf'] },
      { name: 'Micro-Frontend Web Architecture', compute: 'aks', db: 'cosmos', cost: 460, fd: true, storage: true, tags: ['micro-frontend'] },
      { name: 'Azure Zone-Redundant Web App', compute: 'vmss', db: 'sql', cost: 470, fd: true, redis: true, storage: true, isZone: true, tags: ['zone-redundant'] },
    ],
    multi: [
      { name: 'AWS Web Frontend + Azure SQL Data Tier', cost: 680, protocol: 'TDS / VPN', port: 1433, label: 'Cross-Cloud Database Connection', tags: ['hybrid', 'split-tier'] },
      { name: 'Global Active-Active Web Application', cost: 820, protocol: 'HTTPS / Latency Routing', port: 443, label: 'Global Traffic Failover', tags: ['active-active'] },
      { name: 'AWS Compute + Azure Cosmos DB Catalog', cost: 710, protocol: 'HTTPS / Key', port: 443, label: 'Cross-Cloud NoSQL Query', tags: ['cosmos', 'ecs'] },
      { name: 'Split-Tier Media Streaming Web App', cost: 740, protocol: 'Blob HTTPS / 443', port: 443, label: 'Media Vault Archive Sync', tags: ['media', 'streaming'] },
      { name: 'Enterprise Hybrid Web Portal', cost: 790, protocol: 'IPsec VPN Tunnel', port: 443, label: 'Encrypted Enterprise Bridge', tags: ['enterprise'] },
      { name: 'Multi-Cloud API-Backed Web Platform', cost: 640, protocol: 'HTTPS / REST', port: 443, label: 'Cross-Cloud API Gateway', tags: ['api', 'microservices'] },
      { name: 'Cross-Cloud High-Availability Web App', cost: 830, protocol: 'TLS Replicated Sync', port: 1433, label: 'Hot Standby DB Replication', tags: ['ha', 'standby'] },
      { name: 'Serverless Cross-Cloud Web App', cost: 490, protocol: 'HTTPS / IAM', port: 443, label: 'Serverless Data Conduit', tags: ['serverless'] },
      { name: 'Dual-Cloud E-Commerce Web Front', cost: 780, protocol: 'HTTPS / TLS', port: 443, label: 'Cross-Cloud Cart Sync', tags: ['e-commerce'] },
      { name: 'Failover-Ready Multi-Cloud Web Application', cost: 860, protocol: 'Health Checked Tunnel', port: 443, label: 'Automatic Cloud Failover', tags: ['failover'] },
    ],
  },
  'High Availability': {
    aws: [
      { name: 'Multi-AZ Resilient Web Platform', compute: 'asg', db: 'rds', cost: 460, isMultiAz: true, redis: true, s3: true, tags: ['multi-az', 'asg'] },
      { name: 'Multi-Region Active/Active Architecture', compute: 'asg', db: 'dynamo', cost: 680, cdn: true, dns: true, tags: ['multi-region', 'active-active'] },
      { name: 'Multi-Region Warm Standby Architecture', compute: 'asg', db: 'rds', cost: 580, isMultiAz: true, s3: true, tags: ['warm-standby'] },
      { name: 'Fault-Isolated Distributed Cluster', compute: 'ecs', db: 'rds', cost: 520, isMultiAz: true, redis: true, tags: ['fault-isolated'] },
      { name: 'Highly Available Database Core Platform', compute: 'ec2', db: 'rds', cost: 490, isMultiAz: true, redis: true, tags: ['database-ha'] },
      { name: 'Global Traffic Resilient Architecture', compute: 'asg', db: 'rds', cost: 550, cdn: true, dns: true, waf: true, tags: ['global-traffic'] },
      { name: 'Resilient Microservices with Auto Scaling', compute: 'ecs', db: 'rds', cost: 510, isMultiAz: true, redis: true, tags: ['resilient-microservices'] },
      { name: 'HA Serverless Event-Driven Platform', compute: 'lambda', db: 'dynamo', cost: 180, cdn: true, sqs: true, tags: ['serverless-ha'] },
      { name: 'Resilient Queue & Worker Architecture', compute: 'asg', db: 'rds', cost: 440, sqs: true, isMultiAz: true, tags: ['sqs-resilient'] },
      { name: 'Enterprise High-Resilience Core System', compute: 'asg', db: 'rds', cost: 620, cdn: true, waf: true, redis: true, s3: true, isMultiAz: true, tags: ['enterprise-ha'] },
    ],
    azure: [
      { name: 'Zone-Redundant Azure Web Platform', compute: 'vmss', db: 'sql', cost: 480, isZone: true, redis: true, storage: true, tags: ['zone-redundant'] },
      { name: 'Multi-Region Active/Active Architecture', compute: 'vmss', db: 'cosmos', cost: 690, fd: true, storage: true, tags: ['multi-region'] },
      { name: 'Multi-Region Warm Standby Platform', compute: 'vmss', db: 'sql', cost: 590, fd: true, storage: true, tags: ['warm-standby'] },
      { name: 'Fault-Isolated Azure VMSS Cluster', compute: 'vmss', db: 'sql', cost: 510, isZone: true, redis: true, tags: ['fault-isolated'] },
      { name: 'Highly Available Azure SQL Core', compute: 'vmss', db: 'sql', cost: 495, isZone: true, redis: true, tags: ['sql-ha'] },
      { name: 'Global Traffic Resilient Architecture', compute: 'vmss', db: 'sql', cost: 560, fd: true, waf: true, isZone: true, tags: ['global-traffic'] },
      { name: 'Resilient AKS Cluster with AGIC', compute: 'aks', db: 'sql', cost: 540, isZone: true, redis: true, tags: ['aks-ha'] },
      { name: 'HA Serverless Functions Architecture', compute: 'functions', db: 'cosmos', cost: 190, fd: true, storage: true, tags: ['functions-ha'] },
      { name: 'Resilient Event-Driven Processing', compute: 'functions', db: 'sql', cost: 320, isZone: true, storage: true, tags: ['event-ha'] },
      { name: 'Enterprise Azure Resilience Core', compute: 'vmss', db: 'sql', cost: 630, fd: true, waf: true, redis: true, storage: true, isZone: true, tags: ['enterprise-ha'] },
    ],
    multi: [
      { name: 'AWS Multi-AZ + Azure Standby Cloud', cost: 840, protocol: 'TDS Replicated Sync', port: 1433, label: 'Cross-Cloud Hot Standby', tags: ['multi-az', 'standby'] },
      { name: 'Cross-Cloud Active-Active Compute Mesh', cost: 890, protocol: 'HTTPS / Latency', port: 443, label: 'Latency-Based Load Sharing', tags: ['active-active'] },
      { name: 'Multi-Cloud Bilateral Database Sync', cost: 810, protocol: 'TLS Database Replication', port: 1433, label: 'Bi-Directional DB Sync', tags: ['db-sync'] },
      { name: 'Global Multi-Cloud Traffic Director', cost: 770, protocol: 'DNS Health Routing', port: 53, label: 'Coordinated DNS Probing', tags: ['traffic-director'] },
      { name: 'Cross-Cloud Disaster Resilience Shield', cost: 850, protocol: 'IPsec Dual VPN', port: 443, label: 'Encrypted Redundant Tunnels', tags: ['disaster-shield'] },
      { name: 'Resilient Hybrid Microservices Core', cost: 790, protocol: 'HTTPS / mTLS', port: 443, label: 'Zero-Trust Mesh Bridge', tags: ['hybrid-microservices'] },
      { name: 'Cross-Cloud HA SaaS Enterprise Engine', cost: 880, protocol: 'Private TDS Tunnel', port: 1433, label: 'Dedicated Data Replication', tags: ['saas-ha'] },
      { name: 'Split-Zone Multi-Cloud Resilience', cost: 820, protocol: 'HTTPS Interconnect', port: 443, label: 'Cross-Provider Availability Zones', tags: ['split-zone'] },
      { name: 'Fault-Isolated Cross-Cloud Engine', cost: 860, protocol: 'HTTPS / API', port: 443, label: 'Independent Failure Boundary', tags: ['fault-isolated'] },
      { name: 'Enterprise Business Continuity Platform', cost: 920, protocol: 'Multi-Cloud VPN Bridge', port: 443, label: 'Enterprise BCP Interconnect', tags: ['bcp'] },
    ],
  },
  'SaaS': {
    aws: [
      { name: 'Multi-Tenant SaaS Web Application', compute: 'asg', db: 'rds', cost: 480, cdn: true, redis: true, s3: true, tags: ['multi-tenant', 'saas'] },
      { name: 'Enterprise Tenant-Isolated SaaS Core', compute: 'ecs', db: 'rds', cost: 560, isMultiAz: true, redis: true, s3: true, tags: ['isolated-tenant'] },
      { name: 'SaaS API Platform with Rate Limiting', compute: 'lambda', db: 'dynamo', cost: 210, cdn: true, waf: true, tags: ['api-saas'] },
      { name: 'SaaS Real-Time Analytics Pipeline', compute: 'ecs', db: 'dynamo', cost: 430, sqs: true, s3: true, tags: ['saas-analytics'] },
      { name: 'SaaS Microservices on Fargate', compute: 'ecs', db: 'rds', cost: 490, redis: true, s3: true, tags: ['saas-microservices'] },
      { name: 'SaaS Event Processing System', compute: 'lambda', db: 'rds', cost: 280, sqs: true, s3: true, tags: ['saas-events'] },
      { name: 'SaaS Identity & Auth Platform', compute: 'ec2', db: 'rds', cost: 360, waf: true, redis: true, tags: ['identity', 'auth'] },
      { name: 'SaaS Billing & Metering Engine', compute: 'lambda', db: 'dynamo', cost: 190, sqs: true, s3: true, tags: ['billing', 'metering'] },
      { name: 'Global Multi-Region SaaS Platform', compute: 'asg', db: 'rds', cost: 640, cdn: true, dns: true, isMultiAz: true, tags: ['global-saas'] },
      { name: 'B2B Enterprise SaaS Architecture', compute: 'asg', db: 'rds', cost: 580, isMultiAz: true, redis: true, waf: true, tags: ['b2b-saas'] },
    ],
    azure: [
      { name: 'Multi-Tenant Azure SaaS Platform', compute: 'vmss', db: 'sql', cost: 490, fd: true, redis: true, storage: true, tags: ['multi-tenant'] },
      { name: 'Enterprise Tenant-Isolated Azure SaaS', compute: 'aks', db: 'sql', cost: 570, isZone: true, redis: true, storage: true, tags: ['isolated-tenant'] },
      { name: 'SaaS API Platform with APIM', compute: 'functions', db: 'cosmos', cost: 230, fd: true, waf: true, tags: ['apim-saas'] },
      { name: 'SaaS Real-Time Analytics on Cosmos', compute: 'functions', db: 'cosmos', cost: 260, storage: true, tags: ['saas-analytics'] },
      { name: 'SaaS Microservices on AKS', compute: 'aks', db: 'sql', cost: 520, redis: true, storage: true, tags: ['saas-aks'] },
      { name: 'SaaS Event-Driven Functions System', compute: 'functions', db: 'sql', cost: 290, storage: true, tags: ['saas-events'] },
      { name: 'SaaS Identity & Access Platform', compute: 'vmss', db: 'sql', cost: 380, waf: true, redis: true, tags: ['identity'] },
      { name: 'SaaS Billing & Metering Engine', compute: 'functions', db: 'cosmos', cost: 210, storage: true, tags: ['billing'] },
      { name: 'Global Multi-Region Azure SaaS', compute: 'vmss', db: 'sql', cost: 650, fd: true, isZone: true, storage: true, tags: ['global-saas'] },
      { name: 'B2B Enterprise Azure SaaS Architecture', compute: 'vmss', db: 'sql', cost: 590, isZone: true, redis: true, waf: true, tags: ['b2b-saas'] },
    ],
    multi: [
      { name: 'AWS Tenant Compute + Azure Cosmos Data', cost: 760, protocol: 'HTTPS / Cosmos API', port: 443, label: 'Cross-Cloud Tenant Data Flow', tags: ['tenant-compute', 'cosmos'] },
      { name: 'Enterprise Hybrid Multi-Cloud SaaS', cost: 860, protocol: 'TDS / VPN Tunnel', port: 1433, label: 'Dedicated Enterprise Data Pipe', tags: ['hybrid-saas'] },
      { name: 'Cross-Cloud SaaS Analytics Platform', cost: 720, protocol: 'HTTPS Data Ingestion', port: 443, label: 'Analytics Stream Ingestion', tags: ['analytics-saas'] },
      { name: 'Multi-Cloud SaaS API Gateway System', cost: 670, protocol: 'HTTPS / REST API', port: 443, label: 'Federated API Proxy', tags: ['api-gateway'] },
      { name: 'SaaS Cross-Cloud Event Processing Bus', cost: 710, protocol: 'HTTPS Event Stream', port: 443, label: 'Cross-Cloud Event Pipeline', tags: ['event-bus'] },
      { name: 'SaaS Disaster-Resilient Multi-Tenant Core', cost: 890, protocol: 'Replication Bridge', port: 1433, label: 'Disaster Backup Tenant Replication', tags: ['disaster-saas'] },
      { name: 'Global Multi-Cloud SaaS Customer Portal', cost: 820, protocol: 'HTTPS Anycast Routing', port: 443, label: 'Edge Customer Traffic Route', tags: ['customer-portal'] },
      { name: 'Cross-Cloud Billing & Metering Engine', cost: 680, protocol: 'TLS Batch Ingestion', port: 443, label: 'Metering Telemetry Ingest', tags: ['billing-metering'] },
      { name: 'SaaS Hybrid Data Lakehouse Platform', cost: 780, protocol: 'Blob HTTPS / S3 Sync', port: 443, label: 'Cross-Cloud Storage Vault Sync', tags: ['data-lakehouse'] },
      { name: 'Resilient B2B Multi-Cloud SaaS Engine', cost: 910, protocol: 'IPsec Secure VPN', port: 443, label: 'Sovereign Enterprise Channel', tags: ['sovereign-saas'] },
    ],
  },
  'E-Commerce': {
    aws: [
      { name: 'Standard Production E-Commerce Store', compute: 'asg', db: 'rds', cost: 440, cdn: true, redis: true, s3: true, tags: ['e-commerce', 'store'] },
      { name: 'High-Traffic Flash Sale Architecture', compute: 'asg', db: 'rds', cost: 580, cdn: true, waf: true, redis: true, tags: ['flash-sale'] },
      { name: 'Global Multi-Region E-Commerce Engine', compute: 'asg', db: 'rds', cost: 660, cdn: true, dns: true, isMultiAz: true, tags: ['global-commerce'] },
      { name: 'Serverless E-Commerce Platform', compute: 'lambda', db: 'dynamo', cost: 160, cdn: true, s3: true, tags: ['serverless-commerce'] },
      { name: 'Event-Driven Order Processing System', compute: 'ecs', db: 'rds', cost: 470, sqs: true, s3: true, tags: ['order-processing'] },
      { name: 'Product Catalog & Search Platform', compute: 'asg', db: 'rds', cost: 450, redis: true, s3: true, tags: ['product-catalog'] },
      { name: 'Secure Payment Gateway Architecture', compute: 'ec2', db: 'rds', cost: 420, waf: true, isMultiAz: true, tags: ['payment-gateway'] },
      { name: 'Recommendation-Enabled Commerce', compute: 'ecs', db: 'dynamo', cost: 490, redis: true, s3: true, tags: ['recommendation'] },
      { name: 'Inventory & Fulfillment Logistics', compute: 'asg', db: 'rds', cost: 460, sqs: true, redis: true, tags: ['inventory'] },
      { name: 'Enterprise B2B Wholesale Commerce', compute: 'asg', db: 'rds', cost: 610, isMultiAz: true, redis: true, waf: true, tags: ['b2b-commerce'] },
    ],
    azure: [
      { name: 'Standard Production Azure E-Commerce', compute: 'vmss', db: 'sql', cost: 450, fd: true, redis: true, storage: true, tags: ['e-commerce'] },
      { name: 'High-Traffic Flash Sale Azure Platform', compute: 'vmss', db: 'sql', cost: 590, fd: true, waf: true, redis: true, tags: ['flash-sale'] },
      { name: 'Global Multi-Region Azure Commerce', compute: 'vmss', db: 'cosmos', cost: 670, fd: true, storage: true, tags: ['global-commerce'] },
      { name: 'Serverless E-Commerce on Azure', compute: 'functions', db: 'cosmos', cost: 170, fd: true, storage: true, tags: ['serverless'] },
      { name: 'Event-Driven Order Fulfillment System', compute: 'aks', db: 'sql', cost: 490, storage: true, tags: ['order-processing'] },
      { name: 'Product Catalog & Search on Cosmos', compute: 'vmss', db: 'cosmos', cost: 460, redis: true, storage: true, tags: ['product-catalog'] },
      { name: 'Secure Payment Processing Platform', compute: 'vmss', db: 'sql', cost: 430, waf: true, isZone: true, tags: ['payment-gateway'] },
      { name: 'Real-Time Recommendation Commerce', compute: 'aks', db: 'cosmos', cost: 510, redis: true, storage: true, tags: ['recommendation'] },
      { name: 'Inventory & Warehouse Logistics Engine', compute: 'vmss', db: 'sql', cost: 470, redis: true, storage: true, tags: ['inventory'] },
      { name: 'Enterprise B2B Wholesale Commerce', compute: 'vmss', db: 'sql', cost: 620, isZone: true, redis: true, waf: true, tags: ['b2b-commerce'] },
    ],
    multi: [
      { name: 'AWS Storefront + Azure Order Database', cost: 770, protocol: 'TDS / VPN Tunnel', port: 1433, label: 'Cross-Cloud Order Persistence', tags: ['storefront', 'database'] },
      { name: 'Cross-Cloud High-Traffic Flash Sale', cost: 890, protocol: 'HTTPS Load Dispersion', port: 443, label: 'Burst Traffic Balancing', tags: ['flash-sale'] },
      { name: 'Hybrid Product Catalog & Media Vault', cost: 730, protocol: 'Blob HTTPS / S3', port: 443, label: 'Multi-Cloud Asset Sync', tags: ['product-catalog'] },
      { name: 'Cross-Cloud Payment & Billing Gateway', cost: 760, protocol: 'mTLS Secure Channel', port: 443, label: 'PCI Compliant Payment Bridge', tags: ['payment-gateway'] },
      { name: 'Multi-Cloud Event-Driven Order Flow', cost: 740, protocol: 'HTTPS Event Trigger', port: 443, label: 'Order Event Dispatch', tags: ['order-events'] },
      { name: 'Global Multi-Cloud Commerce Engine', cost: 880, protocol: 'Anycast DNS Route', port: 53, label: 'Global Customer Routing', tags: ['global-commerce'] },
      { name: 'Cross-Cloud Inventory & Warehousing', cost: 750, protocol: 'TLS Database Bridge', port: 1433, label: 'Inventory Sync Pipe', tags: ['inventory-sync'] },
      { name: 'Hybrid B2B Wholesale Commerce Platform', cost: 830, protocol: 'IPsec VPN Tunnel', port: 443, label: 'B2B Partner ERP Link', tags: ['b2b-hybrid'] },
      { name: 'Cross-Cloud Recommendation Engine', cost: 790, protocol: 'HTTPS API Route', port: 443, label: 'Real-Time Scoring API', tags: ['recommendation'] },
      { name: 'Failover-Ready Multi-Cloud E-Commerce', cost: 920, protocol: 'Replication Stream', port: 1433, label: 'Hot Standby Storefront Sync', tags: ['failover-commerce'] },
    ],
  },
  'Microservices': {
    aws: [
      { name: 'Containerized Microservices on ECS', compute: 'ecs', db: 'rds', cost: 470, cdn: true, redis: true, s3: true, tags: ['ecs', 'fargate'] },
      { name: 'Kubernetes Microservices on EKS', compute: 'eks', db: 'rds', cost: 580, isMultiAz: true, redis: true, tags: ['eks', 'kubernetes'] },
      { name: 'Event-Driven SQS & Lambda Microservices', compute: 'lambda', db: 'dynamo', cost: 190, sqs: true, s3: true, tags: ['event-driven'] },
      { name: 'API Gateway Managed Microservices', compute: 'lambda', db: 'rds', cost: 290, cdn: true, s3: true, tags: ['api-gateway'] },
      { name: 'Async Job & Worker Microservices', compute: 'asg', db: 'rds', cost: 420, sqs: true, s3: true, tags: ['async-workers'] },
      { name: 'Distributed Microservices with Redis', compute: 'ecs', db: 'rds', cost: 490, redis: true, s3: true, tags: ['distributed-redis'] },
      { name: 'CQRS Microservices Architecture', compute: 'ecs', db: 'dynamo', cost: 460, redis: true, s3: true, tags: ['cqrs'] },
      { name: 'Secure Internal VPC Microservices', compute: 'ecs', db: 'rds', cost: 450, isMultiAz: true, s3: true, tags: ['internal-microservices'] },
      { name: 'Global Edge Microservices Platform', compute: 'lambda', db: 'dynamo', cost: 220, cdn: true, dns: true, tags: ['edge-microservices'] },
      { name: 'High-Throughput Batch Microservices', compute: 'asg', db: 'rds', cost: 480, sqs: true, redis: true, tags: ['batch-microservices'] },
    ],
    azure: [
      { name: 'Containerized Microservices on AKS', compute: 'aks', db: 'sql', cost: 510, fd: true, redis: true, storage: true, tags: ['aks', 'containers'] },
      { name: 'Azure Functions Microservices System', compute: 'functions', db: 'cosmos', cost: 210, fd: true, storage: true, tags: ['functions-microservices'] },
      { name: 'Event-Driven Azure Microservices', compute: 'functions', db: 'sql', cost: 310, storage: true, tags: ['event-driven'] },
      { name: 'API Management Microservices Gateway', compute: 'vmss', db: 'sql', cost: 480, fd: true, redis: true, tags: ['apim-microservices'] },
      { name: 'Async Job Processing Microservices', compute: 'vmss', db: 'sql', cost: 430, storage: true, tags: ['async-jobs'] },
      { name: 'Distributed Microservices with Redis', compute: 'aks', db: 'sql', cost: 530, redis: true, storage: true, tags: ['redis-microservices'] },
      { name: 'CQRS Microservices with Cosmos DB', compute: 'aks', db: 'cosmos', cost: 520, storage: true, tags: ['cqrs-cosmos'] },
      { name: 'Secure VNet-Isolated Microservices', compute: 'vmss', db: 'sql', cost: 440, isZone: true, storage: true, tags: ['isolated-microservices'] },
      { name: 'Global Front Door Microservices', compute: 'vmss', db: 'cosmos', cost: 560, fd: true, storage: true, tags: ['frontdoor-microservices'] },
      { name: 'High-Throughput Batch Microservices', compute: 'vmss', db: 'sql', cost: 490, storage: true, tags: ['batch-microservices'] },
    ],
    multi: [
      { name: 'AWS ECS Frontend + Azure Backend Services', cost: 780, protocol: 'HTTPS / mTLS', port: 443, label: 'Microservices Communication Link', tags: ['ecs-aks', 'hybrid'] },
      { name: 'Cross-Cloud Kubernetes Federation (EKS+AKS)', cost: 940, protocol: 'Kubernetes Mesh Tunnel', port: 443, label: 'Federated Service Discovery', tags: ['k8s-federation'] },
      { name: 'Hybrid Event-Driven Microservices Bus', cost: 720, protocol: 'HTTPS Event Bus', port: 443, label: 'Cross-Cloud Event Dispatcher', tags: ['event-bus'] },
      { name: 'Multi-Cloud API Gateway Routing Mesh', cost: 710, protocol: 'HTTPS / REST API', port: 443, label: 'API Gateway Proxy Route', tags: ['api-mesh'] },
      { name: 'Cross-Cloud Async Task Pipeline', cost: 690, protocol: 'HTTPS Queue Proxy', port: 443, label: 'Async Job Delegation', tags: ['async-pipeline'] },
      { name: 'Hybrid CQRS Microservices System', cost: 810, protocol: 'Replication Stream', port: 1433, label: 'Command-to-Query Sync', tags: ['cqrs-hybrid'] },
      { name: 'Cross-Cloud Distributed Cache Architecture', cost: 750, protocol: 'Redis TLS Stream', port: 6379, label: 'Cache Cluster Sync', tags: ['cache-sync'] },
      { name: 'Enterprise Multi-Cloud Service Mesh', cost: 890, protocol: 'IPsec Dual Tunnel', port: 443, label: 'Secure Microservices Mesh', tags: ['service-mesh'] },
      { name: 'Multi-Cloud Microservices with DB Replication', cost: 860, protocol: 'TDS / TLS Sync', port: 1433, label: 'Bi-Directional DB Sync', tags: ['db-replication'] },
      { name: 'High-Resilience Cross-Cloud Microservices', cost: 910, protocol: 'Failover Protocol', port: 443, label: 'Automated Service Failover', tags: ['resilient-microservices'] },
    ],
  },
  'Data & Analytics': {
    aws: [
      { name: 'S3 Enterprise Data Lake Architecture', compute: 'ec2', db: 'rds', cost: 360, s3: true, tags: ['data-lake', 's3'] },
      { name: 'Streaming Analytics Pipeline (SQS/Lambda)', compute: 'lambda', db: 'dynamo', cost: 220, sqs: true, s3: true, tags: ['streaming-analytics'] },
      { name: 'Batch Processing Analytics Platform', compute: 'asg', db: 'rds', cost: 460, s3: true, tags: ['batch-analytics'] },
      { name: 'Business Intelligence (BI) Platform', compute: 'ec2', db: 'rds', cost: 420, isMultiAz: true, redis: true, s3: true, tags: ['bi-analytics'] },
      { name: 'Real-Time Telemetry Analytics Engine', compute: 'lambda', db: 'dynamo', cost: 240, cdn: true, tags: ['telemetry'] },
      { name: 'Event Ingestion Analytics Platform', compute: 'ecs', db: 'dynamo', cost: 440, sqs: true, s3: true, tags: ['event-ingestion'] },
      { name: 'Machine Learning Data Preparation Pipeline', compute: 'asg', db: 'rds', cost: 520, s3: true, tags: ['ml-data'] },
      { name: 'Centralized Log Analytics System', compute: 'ec2', db: 'rds', cost: 380, s3: true, tags: ['log-analytics'] },
      { name: 'Enterprise Data Warehouse Staging', compute: 'asg', db: 'rds', cost: 550, isMultiAz: true, s3: true, tags: ['data-warehouse'] },
      { name: 'Global Telemetry Ingestion Platform', compute: 'lambda', db: 'dynamo', cost: 250, cdn: true, dns: true, tags: ['global-telemetry'] },
    ],
    azure: [
      { name: 'Azure Data Lake Storage Gen2 Architecture', compute: 'vmss', db: 'sql', cost: 380, storage: true, tags: ['data-lake', 'adls'] },
      { name: 'Streaming Analytics with Functions', compute: 'functions', db: 'cosmos', cost: 230, storage: true, tags: ['streaming-analytics'] },
      { name: 'Batch Analytics Processing Platform', compute: 'vmss', db: 'sql', cost: 470, storage: true, tags: ['batch-analytics'] },
      { name: 'PowerBI Analytics Backend Platform', compute: 'vmss', db: 'sql', cost: 440, redis: true, storage: true, tags: ['bi-powerbi'] },
      { name: 'Real-Time Telemetry with Cosmos DB', compute: 'functions', db: 'cosmos', cost: 250, storage: true, tags: ['telemetry'] },
      { name: 'Event Ingestion Analytics Platform', compute: 'aks', db: 'cosmos', cost: 460, storage: true, tags: ['event-ingestion'] },
      { name: 'ML Data Processing Pipeline on Azure', compute: 'vmss', db: 'sql', cost: 530, storage: true, tags: ['ml-pipeline'] },
      { name: 'Centralized Log Analytics & Monitor', compute: 'vmss', db: 'sql', cost: 390, storage: true, tags: ['log-analytics'] },
      { name: 'Enterprise SQL Data Warehouse Platform', compute: 'vmss', db: 'sql', cost: 560, isZone: true, storage: true, tags: ['sql-warehouse'] },
      { name: 'Global Telemetry Ingestion on Front Door', compute: 'functions', db: 'cosmos', cost: 270, fd: true, storage: true, tags: ['global-telemetry'] },
    ],
    multi: [
      { name: 'AWS S3 Ingestion + Azure Analytics Tier', cost: 720, protocol: 'Blob HTTPS / S3', port: 443, label: 'Cross-Cloud Ingestion Sync', tags: ['s3-azure', 'analytics'] },
      { name: 'Hybrid Streaming Analytics Pipeline', cost: 760, protocol: 'HTTPS Event Stream', port: 443, label: 'Real-Time Analytics Pipe', tags: ['streaming-hybrid'] },
      { name: 'Cross-Cloud Batch Processing Engine', cost: 790, protocol: 'HTTPS Batch Dispatch', port: 443, label: 'Batch Job Delegation', tags: ['batch-hybrid'] },
      { name: 'Multi-Cloud Business Intelligence Platform', cost: 810, protocol: 'TDS / TLS Sync', port: 1433, label: 'BI Data Warehouse Bridge', tags: ['bi-hybrid'] },
      { name: 'Real-Time Cross-Cloud Telemetry Pipeline', cost: 740, protocol: 'HTTPS / Cosmos API', port: 443, label: 'Telemetry Stream Conduit', tags: ['telemetry-hybrid'] },
      { name: 'Multi-Cloud Log Aggregation Platform', cost: 680, protocol: 'TLS Log Ingestion', port: 443, label: 'Centralized Log Forwarder', tags: ['log-aggregation'] },
      { name: 'Hybrid ML Training & Inference Pipeline', cost: 830, protocol: 'mTLS Secure Channel', port: 443, label: 'Model Artifact Sync', tags: ['ml-hybrid'] },
      { name: 'Cross-Cloud Data Warehouse Staging', cost: 850, protocol: 'IPsec VPN Tunnel', port: 1433, label: 'Data Warehouse Extract Pipe', tags: ['dw-staging'] },
      { name: 'Multi-Cloud Disaster Backup & Analytics', cost: 770, protocol: 'GRS Storage Sync', port: 443, label: 'Cold Storage Mirroring', tags: ['disaster-analytics'] },
      { name: 'Global Multi-Cloud Data Fabric Platform', cost: 890, protocol: 'Anycast DNS Conduit', port: 53, label: 'Global Data Distribution', tags: ['data-fabric'] },
    ],
  },
  'Disaster Recovery': {
    aws: [
      { name: 'Backup & Restore Disaster Recovery', compute: 'ec2', db: 'rds', cost: 320, s3: true, tags: ['backup-restore', 'dr'] },
      { name: 'Warm Standby Web DR Architecture', compute: 'asg', db: 'rds', cost: 460, isMultiAz: true, s3: true, tags: ['warm-standby'] },
      { name: 'Pilot Light Disaster Recovery System', compute: 'asg', db: 'rds', cost: 380, isMultiAz: true, tags: ['pilot-light'] },
      { name: 'Active/Passive Multi-AZ Disaster Recovery', compute: 'asg', db: 'rds', cost: 490, isMultiAz: true, redis: true, tags: ['active-passive'] },
      { name: 'Active/Active Multi-Region DR Architecture', compute: 'asg', db: 'dynamo', cost: 680, cdn: true, dns: true, tags: ['active-active'] },
      { name: 'Cross-Region Automated Database DR', compute: 'ec2', db: 'rds', cost: 510, isMultiAz: true, s3: true, tags: ['database-dr'] },
      { name: 'S3 Cross-Region Storage Replication DR', compute: 'ec2', db: 'rds', cost: 390, s3: true, tags: ['s3-crr'] },
      { name: 'Resilient Compute Failover Architecture', compute: 'asg', db: 'rds', cost: 480, dns: true, isMultiAz: true, tags: ['compute-failover'] },
      { name: 'Enterprise Business Continuity Platform', compute: 'asg', db: 'rds', cost: 620, isMultiAz: true, redis: true, waf: true, s3: true, tags: ['bcp'] },
      { name: 'Ransomware-Isolated Storage Vault DR', compute: 'ec2', db: 'rds', cost: 370, s3: true, tags: ['ransomware-vault'] },
    ],
    azure: [
      { name: 'Backup & Restore Azure Disaster Recovery', compute: 'vmss', db: 'sql', cost: 340, storage: true, tags: ['backup-restore'] },
      { name: 'Warm Standby Azure Web DR Platform', compute: 'vmss', db: 'sql', cost: 470, fd: true, storage: true, tags: ['warm-standby'] },
      { name: 'Pilot Light Azure Disaster Recovery', compute: 'vmss', db: 'sql', cost: 390, isZone: true, storage: true, tags: ['pilot-light'] },
      { name: 'Active/Passive Region Disaster Recovery', compute: 'vmss', db: 'sql', cost: 510, fd: true, isZone: true, tags: ['active-passive'] },
      { name: 'Active/Active Multi-Region Azure DR', compute: 'vmss', db: 'cosmos', cost: 690, fd: true, storage: true, tags: ['active-active'] },
      { name: 'Azure SQL Auto-Failover Group DR', compute: 'vmss', db: 'sql', cost: 520, isZone: true, redis: true, tags: ['sql-failover'] },
      { name: 'Geo-Redundant Storage (GRS) Account DR', compute: 'vmss', db: 'sql', cost: 410, storage: true, tags: ['grs-storage'] },
      { name: 'Resilient VMSS Failover Architecture', compute: 'vmss', db: 'sql', cost: 490, fd: true, isZone: true, tags: ['vmss-failover'] },
      { name: 'Enterprise Business Continuity on Azure', compute: 'vmss', db: 'sql', cost: 630, fd: true, waf: true, redis: true, storage: true, isZone: true, tags: ['bcp'] },
      { name: 'Immutable Blob Storage Ransomware DR', compute: 'vmss', db: 'sql', cost: 380, storage: true, tags: ['immutable-blob'] },
    ],
    multi: [
      { name: 'AWS Primary Active + Azure Standby DR', cost: 790, protocol: 'TDS Replicated Sync', port: 1433, label: 'Active-to-Standby Sync', tags: ['aws-primary', 'dr'] },
      { name: 'Azure Primary Active + AWS Standby DR', cost: 810, protocol: 'TDS Replicated Sync', port: 1433, label: 'Standby Failover Tunnel', tags: ['azure-primary', 'dr'] },
      { name: 'Cross-Cloud Pilot Light Architecture', cost: 740, protocol: 'Continuous DB Sync', port: 1433, label: 'Pilot Light Database Sync', tags: ['pilot-light'] },
      { name: 'Cross-Cloud Database Geo-Sync DR', cost: 830, protocol: 'TLS Database Replication', port: 1433, label: 'Bilateral Database Replication', tags: ['geo-sync'] },
      { name: 'Multi-Cloud Active/Passive DR Platform', cost: 860, protocol: 'Route 53 Health Probe', port: 53, label: 'Health Checked Failover Route', tags: ['active-passive'] },
      { name: 'Multi-Cloud Active/Active Disaster Recovery', cost: 920, protocol: 'Anycast DNS Latency', port: 53, label: 'Active-Active Traffic Dispatch', tags: ['active-active'] },
      { name: 'Cross-Cloud Storage Vault Replication', cost: 710, protocol: 'Blob HTTPS / S3', port: 443, label: 'Offsite Storage Vault Backup', tags: ['storage-replication'] },
      { name: 'Route 53 + Front Door Dual DNS Failover', cost: 780, protocol: 'DNS Failover Probe', port: 53, label: 'Cross-Cloud DNS Failover', tags: ['dns-failover'] },
      { name: 'Enterprise Multi-Cloud BCP Platform', cost: 950, protocol: 'IPsec Dual VPN Tunnel', port: 443, label: 'Enterprise Continuity Mesh', tags: ['enterprise-bcp'] },
      { name: 'Hybrid Sovereign Disaster Shield', cost: 880, protocol: 'mTLS Secure Conduit', port: 443, label: 'Air-Gapped Disaster Tunnel', tags: ['sovereign-shield'] },
    ],
  },
  'Multi-cloud': {
    aws: [
      { name: 'AWS Compute Primary with Azure Data Sink', compute: 'asg', db: 'rds', cost: 480, s3: true, tags: ['aws-primary', 'multi-cloud'] },
      { name: 'AWS Ingress with Azure Blob Backup', compute: 'ec2', db: 'rds', cost: 410, cdn: true, s3: true, tags: ['blob-backup'] },
      { name: 'AWS EKS with Azure DB Integration', compute: 'eks', db: 'rds', cost: 560, isMultiAz: true, tags: ['eks-azure'] },
      { name: 'AWS Serverless with Azure Key Vault', compute: 'lambda', db: 'dynamo', cost: 170, s3: true, tags: ['serverless-keyvault'] },
      { name: 'AWS E-Commerce with Azure ERP Sync', compute: 'asg', db: 'rds', cost: 520, redis: true, s3: true, tags: ['ecommerce-erp'] },
      { name: 'AWS Batch Processing with Azure Archive', compute: 'asg', db: 'rds', cost: 450, s3: true, tags: ['batch-archive'] },
      { name: 'AWS Global Edge with Azure Private Apps', compute: 'ec2', db: 'rds', cost: 440, cdn: true, dns: true, tags: ['edge-private'] },
      { name: 'AWS Event Stream to Azure Cosmos DB', compute: 'ecs', db: 'dynamo', cost: 470, sqs: true, tags: ['event-cosmos'] },
      { name: 'AWS Web Tier to Azure SQL Instance', compute: 'asg', db: 'rds', cost: 490, redis: true, tags: ['web-azuresql'] },
      { name: 'AWS VPC Peered to Azure VNet Gateway', compute: 'ec2', db: 'rds', cost: 430, isMultiAz: true, tags: ['vpc-vnet-peered'] },
    ],
    azure: [
      { name: 'Azure App Gateway with AWS S3 Media', compute: 'vmss', db: 'sql', cost: 470, storage: true, tags: ['appgw-s3', 'multi-cloud'] },
      { name: 'Azure AKS with AWS DynamoDB Backend', compute: 'aks', db: 'sql', cost: 550, isZone: true, tags: ['aks-dynamo'] },
      { name: 'Azure Front Door with AWS EC2 Origin', compute: 'vmss', db: 'sql', cost: 490, fd: true, tags: ['frontdoor-ec2'] },
      { name: 'Azure Functions with AWS RDS PostgreSQL', compute: 'functions', db: 'sql', cost: 290, storage: true, tags: ['functions-rds'] },
      { name: 'Azure Web App with AWS SQS Queue', compute: 'vmss', db: 'sql', cost: 440, storage: true, tags: ['vmss-sqs'] },
      { name: 'Azure VNet Connected to AWS Direct Connect', compute: 'vmss', db: 'sql', cost: 520, isZone: true, tags: ['direct-connect'] },
      { name: 'Azure Logic Apps with AWS Lambda Compute', compute: 'functions', db: 'sql', cost: 310, storage: true, tags: ['logicapps-lambda'] },
      { name: 'Azure SQL Primary with AWS RDS Standby', compute: 'vmss', db: 'sql', cost: 510, isZone: true, redis: true, tags: ['sql-rds-standby'] },
      { name: 'Azure Monitor over AWS Workloads', compute: 'vmss', db: 'sql', cost: 420, storage: true, tags: ['monitor-aws'] },
      { name: 'Azure B2B Portal with AWS Analytics', compute: 'vmss', db: 'sql', cost: 530, fd: true, storage: true, tags: ['b2b-analytics'] },
    ],
    multi: [
      { name: 'AWS + Azure S2S VPN Enterprise Hybrid', cost: 850, protocol: 'IPsec Site-to-Site VPN', port: 443, label: 'Cross-Cloud S2S VPN Gateway', tags: ['vpn-hybrid'] },
      { name: 'AWS + Azure Active/Active Global Cluster', cost: 920, protocol: 'HTTPS Latency Balanced', port: 443, label: 'Anycast Dual-Cloud Balance', tags: ['active-active'] },
      { name: 'Cross-Cloud EKS & AKS Kubernetes Mesh', cost: 960, protocol: 'Kubernetes mTLS Tunnel', port: 443, label: 'Federated K8s Mesh', tags: ['k8s-mesh'] },
      { name: 'Cross-Cloud Database Bilateral Sync', cost: 840, protocol: 'TLS DB Replication', port: 1433, label: 'Bilateral Database Replication', tags: ['db-sync'] },
      { name: 'Dual-Cloud Zero-Trust Microservices', cost: 880, protocol: 'mTLS Secure Mesh', port: 443, label: 'Zero-Trust Cross-Cloud Pipe', tags: ['zero-trust'] },
      { name: 'Cross-Cloud Distributed Event Bus', cost: 760, protocol: 'HTTPS Event Stream', port: 443, label: 'EventBridge / ServiceBus Pipe', tags: ['event-bus'] },
      { name: 'Multi-Cloud Global Traffic Director', cost: 790, protocol: 'DNS Health Probe', port: 53, label: 'Coordinated DNS Steering', tags: ['traffic-director'] },
      { name: 'Split-Tier Enterprise Cloud Platform', cost: 870, protocol: 'TDS / HTTPS Bridge', port: 1433, label: 'Enterprise Split-Tier Pipe', tags: ['split-tier'] },
      { name: 'Cloud Migration Phase Standby Topology', cost: 820, protocol: 'Continuous Migration Sync', port: 443, label: 'Migration Replication Channel', tags: ['migration'] },
      { name: 'Sovereign Multi-Cloud Business Continuity', cost: 980, protocol: 'Dedicated Dual-Cloud Tunnel', port: 443, label: 'Sovereign BCP Interconnect', tags: ['sovereign-bcp'] },
    ],
  },
};

// Generate the complete catalog
export function generateTemplateCatalog(): ArchitectureTemplate[] {
  const catalog: ArchitectureTemplate[] = [];

  for (const cat of categories) {
    const p = patterns[cat];

    // 10 AWS Templates
    for (let i = 0; i < 10; i++) {
      const item = p.aws[i];
      let templateId = `${cat.toLowerCase().replace(/[^a-z0-9]/g, '-')}-aws-${String(i + 1).padStart(2, '0')}`;
      if (cat === 'High Availability' && i === 0) templateId = 'aws-1000-user-production';
      if (cat === 'Web Applications' && i === 2) templateId = 'aws-serverless-application';
      if (cat === 'Microservices' && i === 0) templateId = 'aws-containerized-application';

      catalog.push(
        createAwsTemplate({
          id: templateId,
          name: item.name,
          category: cat,
          description: `Enterprise AWS architecture for ${cat.toLowerCase()}: ${item.name}. Features automated sizing, multi-AZ resilience, and verified canonical graph integrity.`,
          complexity: item.waf ? 'complex' : item.compute === 'lambda' ? 'simple' : 'moderate',
          cost: item.cost,
          features: [
            `Engineered for ${cat} workloads`,
            `Compute tier: ${item.compute.toUpperCase()}`,
            `Database tier: ${item.db.toUpperCase()}`,
            item.isMultiAz ? 'Multi-AZ high availability' : 'Regional resilience',
            item.cdn ? 'Global CloudFront CDN acceleration' : 'VPC isolated ingress',
          ],
          tags: item.tags,
          computeType: item.compute,
          dbType: item.db,
          useCdn: item.cdn,
          useWaf: item.waf,
          useDns: item.dns,
          useRedis: item.redis,
          useS3: item.s3,
          useSqs: item.sqs,
          isMultiAz: item.isMultiAz,
        })
      );
    }

    // 10 Azure Templates
    for (let i = 0; i < 10; i++) {
      const item = p.azure[i];
      let templateId = `${cat.toLowerCase().replace(/[^a-z0-9]/g, '-')}-azure-${String(i + 1).padStart(2, '0')}`;
      if (cat === 'High Availability' && i === 0) templateId = 'azure-1000-user-production';
      if (cat === 'Web Applications' && i === 2) templateId = 'azure-serverless-application';
      if (cat === 'Microservices' && i === 0) templateId = 'azure-container-platform';

      catalog.push(
        createAzureTemplate({
          id: templateId,
          name: item.name,
          category: cat,
          description: `Production Azure architecture for ${cat.toLowerCase()}: ${item.name}. Built with native Azure resource hierarchies, verified VNet containment, and deterministic capacity models.`,
          complexity: item.waf ? 'complex' : item.compute === 'functions' ? 'simple' : 'moderate',
          cost: item.cost,
          features: [
            `Engineered for ${cat} workloads`,
            `Compute tier: ${item.compute.toUpperCase()}`,
            `Data persistence: ${item.db.toUpperCase()}`,
            item.isZone ? 'Zone-redundant high availability' : 'Regional Resource Group scoping',
            item.fd ? 'Azure Front Door global acceleration' : 'Application Gateway ingress',
          ],
          tags: item.tags,
          computeType: item.compute,
          dbType: item.db,
          useFrontDoor: item.fd,
          useWaf: item.waf,
          useRedis: item.redis,
          useStorage: item.storage,
          isZoneRedundant: item.isZone,
        })
      );
    }

    // 10 Multi-Cloud Templates
    for (let i = 0; i < 10; i++) {
      const item = p.multi[i];
      let templateId = `${cat.toLowerCase().replace(/[^a-z0-9]/g, '-')}-multi-${String(i + 1).padStart(2, '0')}`;
      if (cat === 'Multi-cloud' && i === 0) templateId = 'aws-azure-hybrid-architecture';
      if (cat === 'Disaster Recovery' && i === 0) templateId = 'multi-cloud-disaster-recovery';

      catalog.push(
        createMultiCloudTemplate({
          id: templateId,
          name: item.name,
          category: cat,
          description: `Verified Multi-Cloud architecture for ${cat.toLowerCase()}: ${item.name}. Features clean visual separation of AWS and Azure environments with explicit cross-cloud semantics.`,
          complexity: 'complex',
          cost: item.cost,
          features: [
            `Engineered for ${cat} multi-cloud topology`,
            'AWS Primary Environment (VPC + Subnets + ALB + EC2 + RDS)',
            'Azure Secondary Environment (Resource Group + VNet + VMSS + Azure SQL + Blob)',
            `Explicit Cross-Cloud Connection: ${item.label} (${item.protocol})`,
            'Zero cross-provider containment violations',
          ],
          tags: item.tags,
          crossProtocol: item.protocol,
          crossPort: item.port,
          crossLabel: item.label,
        })
      );
    }
  }

  return catalog;
}

const _catalog = generateTemplateCatalog();

// Patch: replace the aws-1000-user-production generate function with the canonical
// multi-AZ production implementation that uses industry-standard node IDs.
// This is required for auto-layout and topology tests to resolve specific node IDs.
const legacyAwsProdIdx = _catalog.findIndex((t) => t.id === 'aws-1000-user-production');
if (legacyAwsProdIdx !== -1) {
  _catalog[legacyAwsProdIdx] = {
    ..._catalog[legacyAwsProdIdx],
    resourceCount: 20,
    features: [
      '1,000+ Concurrent User Capacity (1,500+ buffer)',
      'Multi-AZ across 2 Availability Zones (AZ-a & AZ-b)',
      'Route 53 DNS & CloudFront Global CDN with AWS WAF',
      'Multi-AZ Application Load Balancer in Public Subnets',
      'Auto Scaling Group across Private App Subnets',
      'RDS PostgreSQL Multi-AZ with Standby Replica',
      'ElastiCache Redis Cluster for In-Memory Caching',
      'Private S3 Object Storage with SSE-S3 Encryption',
    ],
    generate(_opts: TemplateGenerateOptions = {}) {
      const nodes: CanvasNode[] = [
        n('aws-cloud', 'aws_cloud_boundary', 'aws', 'Amazon Web Services (us-east-1)', 30, 20, { region: 'us-east-1' }, undefined, 1460, 1140),
        n('r53', 'aws_route53', 'aws', 'Route 53 DNS', 200, 70, { domainName: 'cloudcraft.app' }, 'aws-cloud'),
        n('cf', 'aws_cloudfront', 'aws', 'CloudFront CDN', 450, 70, { priceClass: 'PriceClass_100' }, 'aws-cloud'),
        n('waf', 'aws_waf', 'aws', 'AWS WAF', 700, 70, { scope: 'CLOUDFRONT', defaultAction: 'ALLOW' }, 'aws-cloud'),
        n('vpc', 'aws_vpc', 'aws', 'Production VPC (10.0.0.0/16)', 70, 210, { cidrBlock: '10.0.0.0/16', enableDnsSupport: true, enableDnsHostnames: true }, 'aws-cloud', 1050, 890),
        n('igw', 'aws_igw', 'aws', 'Internet Gateway', 505, 265, {}, 'vpc'),
        n('pub-sub-a', 'aws_subnet', 'aws', 'Public Subnet AZ-A (10.0.1.0/24)', 110, 385, { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: true }, 'vpc', 460, 190),
        n('pub-sub-b', 'aws_subnet', 'aws', 'Public Subnet AZ-B (10.0.2.0/24)', 620, 385, { cidrBlock: '10.0.2.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: true }, 'vpc', 460, 190),
        n('alb', 'aws_alb', 'aws', 'App Load Balancer (Multi-AZ)', 140, 450, { lbType: 'application', scheme: 'internet-facing' }, 'pub-sub-a'),
        n('nat-a', 'aws_nat', 'aws', 'NAT Gateway AZ-A', 355, 450, {}, 'pub-sub-a'),
        n('nat-b', 'aws_nat', 'aws', 'NAT Gateway AZ-B', 760, 450, {}, 'pub-sub-b'),
        n('app-sub-a', 'aws_subnet', 'aws', 'Private App Subnet AZ-A (10.0.10.0/24)', 110, 640, { cidrBlock: '10.0.10.0/24', availabilityZone: 'us-east-1a' }, 'vpc', 460, 190),
        n('app-sub-b', 'aws_subnet', 'aws', 'Private App Subnet AZ-B (10.0.11.0/24)', 620, 640, { cidrBlock: '10.0.11.0/24', availabilityZone: 'us-east-1b' }, 'vpc', 460, 190),
        n('app-srv-a', 'aws_ec2', 'aws', 'App Worker AZ-A', 250, 705, { instanceType: 't3.medium', encrypted: true }, 'app-sub-a'),
        n('app-srv-b', 'aws_ec2', 'aws', 'App Worker AZ-B', 760, 705, { instanceType: 't3.medium', encrypted: true }, 'app-sub-b'),
        n('db-sub-a', 'aws_subnet', 'aws', 'Private DB Subnet AZ-A (10.0.20.0/24)', 110, 895, { cidrBlock: '10.0.20.0/24', availabilityZone: 'us-east-1a' }, 'vpc', 460, 190),
        n('db-sub-b', 'aws_subnet', 'aws', 'Private DB Subnet AZ-B (10.0.21.0/24)', 620, 895, { cidrBlock: '10.0.21.0/24', availabilityZone: 'us-east-1b' }, 'vpc', 460, 190),
        n('rds-multiaz', 'aws_rds', 'aws', 'RDS PostgreSQL (Multi-AZ)', 250, 960, { engine: 'postgres', instanceClass: 'db.t3.medium', multiAz: true, encrypted: true }, 'db-sub-a'),
        n('redis-cache', 'aws_elasticache', 'aws', 'ElastiCache Redis', 760, 960, { numNodes: 2 }, 'db-sub-b'),
        n('s3-storage', 'aws_s3', 'aws', 'Encrypted S3 Storage', 1190, 385, { encryption: true, versioning: true }, 'aws-cloud'),
      ];
      const edges: CanvasEdge[] = [
        e('e-r53-cf', 'r53', 'cf', 'DNS Alias', 'RESOLVES_TO', 'DNS', 53, 'public'),
        e('e-waf-cf', 'waf', 'cf', 'WAF Protection', 'ASSOCIATED_WITH', undefined, undefined, 'internal'),
        e('e-cf-igw', 'cf', 'igw', 'Origin HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'),
        e('e-igw-alb', 'igw', 'alb', 'Inbound HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'),
        e('e-alb-app-a', 'alb', 'app-srv-a', 'Balance HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e('e-alb-app-b', 'alb', 'app-srv-b', 'Balance HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e('e-app-a-db', 'app-srv-a', 'rds-multiaz', 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e('e-app-b-db', 'app-srv-b', 'rds-multiaz', 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e('e-app-a-redis', 'app-srv-a', 'redis-cache', 'Redis / 6379', 'CONNECTS_TO', 'Redis', 6379, 'private'),
        e('e-app-b-redis', 'app-srv-b', 'redis-cache', 'Redis / 6379', 'CONNECTS_TO', 'Redis', 6379, 'private'),
        e('e-app-a-s3', 'app-srv-a', 's3-storage', 'S3 API / IAM', 'STORES_IN', 'HTTPS', 443, 'private'),
        e('e-app-b-s3', 'app-srv-b', 's3-storage', 'S3 API / IAM', 'STORES_IN', 'HTTPS', 443, 'private'),
        e('e-app-a-nat', 'app-srv-a', 'nat-a', 'Egress NAT', 'ROUTES_TO', 'TCP', undefined, 'private'),
        e('e-app-b-nat', 'app-srv-b', 'nat-b', 'Egress NAT', 'ROUTES_TO', 'TCP', undefined, 'private'),
        e('e-nat-a-igw', 'nat-a', 'igw', 'NAT Egress', 'ROUTES_TO', 'TCP', undefined, 'public'),
        e('e-nat-b-igw', 'nat-b', 'igw', 'NAT Egress', 'ROUTES_TO', 'TCP', undefined, 'public'),
      ];
      return { nodes, edges };
    },
  };
}

export const allTemplates: ArchitectureTemplate[] = _catalog;
