import { ArchitectureTemplate, TemplateGenerateOptions, CanvasNode, CanvasEdge, CloudProvider, RelationshipType, NetworkScope } from '@/types';
import { getResourceDefinition } from '@/lib/resources';
import { allTemplates as catalogTemplates } from '@/lib/templates/catalogData';
import { allReferenceArchitectures } from '@/lib/templates/referenceArchitectures';

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
    width,
    height,
    // Start from the resource definition defaults so the stored (canonical) config
    // is explicit and identical to what the Properties panel shows, Terraform
    // renders and the assessment engine evaluates.
    config: { ...(getResourceDefinition(resourceType)?.defaultConfig ?? {}), name: label.toLowerCase().replace(/\s+/g, '-'), ...config },
  };
}

function e(
  _id: string,
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

export const architectureTemplatesLegacy: ArchitectureTemplate[] = [
  // ─── AWS Production 1,000-User Reference Architecture ────────────────────────
  {
    id: 'aws-1000-user-production',
    name: 'AWS 1,000-User Production Reference Architecture',
    description: 'Production-ready, highly available architecture supporting 1,000+ concurrent users with zero single points of failure.',
    provider: 'aws',
    category: 'High Availability',
    tags: ['aws', '1000-users', 'production', 'multi-az', 'route53', 'cloudfront', 'waf', 'alb', 'rds-multiaz', 'elasticache', 's3'],
    complexity: 'complex',
    estimatedCost: 385,
    resourceCount: 16,
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
    generate(_opts: TemplateGenerateOptions) {
      const nodes: CanvasNode[] = [
        // ── Cloud Provider Boundary
        n('aws-cloud', 'aws_cloud_boundary', 'aws', 'Amazon Web Services (us-east-1)', 30, 20, { region: 'us-east-1' }, undefined, 1460, 1140),

        // ── Edge & Ingress Layer (Regional/Global, Outside VPC)
        n('r53', 'aws_route53', 'aws', 'Route 53 DNS', 200, 70, { domainName: 'cloudbuilder.app' }, 'aws-cloud'),
        n('cf', 'aws_cloudfront', 'aws', 'CloudFront CDN', 450, 70, { priceClass: 'PriceClass_100', defaultRootObject: 'index.html' }, 'aws-cloud'),
        n('waf', 'aws_waf', 'aws', 'AWS WAF', 700, 70, { scope: 'CLOUDFRONT', defaultAction: 'ALLOW' }, 'aws-cloud'),

        // ── VPC Container
        n('vpc', 'aws_vpc', 'aws', 'Production VPC (10.0.0.0/16)', 70, 210, { cidrBlock: '10.0.0.0/16', enableDnsSupport: true, enableDnsHostnames: true }, 'aws-cloud', 1050, 890),
        n('igw', 'aws_igw', 'aws', 'Internet Gateway', 505, 265, {}, 'vpc'),

        // ── Public Subnets Tier (AZ-a & AZ-b)
        n('pub-sub-a', 'aws_subnet', 'aws', 'Public Subnet AZ-A (10.0.1.0/24)', 110, 385, { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: true }, 'vpc', 460, 190),
        n('pub-sub-b', 'aws_subnet', 'aws', 'Public Subnet AZ-B (10.0.2.0/24)', 620, 385, { cidrBlock: '10.0.2.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: true }, 'vpc', 460, 190),
        n('alb', 'aws_alb', 'aws', 'App Load Balancer (Multi-AZ)', 140, 450, { lbType: 'application', scheme: 'internet-facing' }, 'pub-sub-a'),
        n('nat-a', 'aws_nat', 'aws', 'NAT Gateway AZ-A', 355, 450, { connectivityType: 'public' }, 'pub-sub-a'),
        n('nat-b', 'aws_nat', 'aws', 'NAT Gateway AZ-B', 760, 450, { connectivityType: 'public' }, 'pub-sub-b'),

        // ── Private Application Subnets Tier (AZ-a & AZ-b)
        n('app-sub-a', 'aws_subnet', 'aws', 'Private App Subnet AZ-A (10.0.10.0/24)', 110, 640, { cidrBlock: '10.0.10.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: false }, 'vpc', 460, 190),
        n('app-sub-b', 'aws_subnet', 'aws', 'Private App Subnet AZ-B (10.0.11.0/24)', 620, 640, { cidrBlock: '10.0.11.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: false }, 'vpc', 460, 190),
        n('app-srv-a', 'aws_ec2', 'aws', 'App Worker AZ-A', 250, 705, { instanceType: 't3.medium', keyName: 'prod-key', encrypted: true }, 'app-sub-a'),
        n('app-srv-b', 'aws_ec2', 'aws', 'App Worker AZ-B', 760, 705, { instanceType: 't3.medium', keyName: 'prod-key', encrypted: true }, 'app-sub-b'),

        // ── Private Database Subnets Tier (AZ-a & AZ-b)
        n('db-sub-a', 'aws_subnet', 'aws', 'Private DB Subnet AZ-A (10.0.20.0/24)', 110, 895, { cidrBlock: '10.0.20.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: false }, 'vpc', 460, 190),
        n('db-sub-b', 'aws_subnet', 'aws', 'Private DB Subnet AZ-B (10.0.21.0/24)', 620, 895, { cidrBlock: '10.0.21.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: false }, 'vpc', 460, 190),
        n('rds-multiaz', 'aws_rds', 'aws', 'RDS PostgreSQL (Multi-AZ)', 250, 960, { engine: 'postgres', instanceClass: 'db.t3.medium', multiAz: true, encrypted: true }, 'db-sub-a'),
        n('redis-cache', 'aws_elasticache', 'aws', 'ElastiCache Redis', 760, 960, { numNodes: 2 }, 'db-sub-b'),

        // ── Regional Storage (Outside VPC, inside AWS Cloud Boundary)
        n('s3-storage', 'aws_s3', 'aws', 'Encrypted S3 Storage', 1190, 385, { bucketName: 'prod-assets-vault', encryption: true, versioning: true, publicAccess: false }, 'aws-cloud'),
      ];

      const edges: CanvasEdge[] = [
        // Ingress Flow
        e('e-r53-cf', 'r53', 'cf', 'DNS Alias', 'RESOLVES_TO', 'DNS', 53, 'public'),
        e('e-waf-cf', 'waf', 'cf', 'WAF Protection', 'ASSOCIATED_WITH', undefined, undefined, 'internal'),
        e('e-cf-igw', 'cf', 'igw', 'Origin HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'),
        e('e-igw-alb', 'igw', 'alb', 'Inbound HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'),

        // Load Balancing across Multi-AZ Application Workers
        e('e-alb-app-a', 'alb', 'app-srv-a', 'Balance HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e('e-alb-app-b', 'alb', 'app-srv-b', 'Balance HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),

        // Application to Database Connectivity (PostgreSQL :5432)
        e('e-app-a-db', 'app-srv-a', 'rds-multiaz', 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e('e-app-b-db', 'app-srv-b', 'rds-multiaz', 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),

        // Application to In-Memory Caching (Redis :6379)
        e('e-app-a-redis', 'app-srv-a', 'redis-cache', 'Redis / 6379', 'CONNECTS_TO', 'Redis', 6379, 'private'),
        e('e-app-b-redis', 'app-srv-b', 'redis-cache', 'Redis / 6379', 'CONNECTS_TO', 'Redis', 6379, 'private'),

        // Application Tier to S3 (API storage access)
        e('e-app-a-s3', 'app-srv-a', 's3-storage', 'S3 API / IAM', 'STORES_IN', 'HTTPS', 443, 'private'),
        e('e-app-b-s3', 'app-srv-b', 's3-storage', 'S3 API / IAM', 'STORES_IN', 'HTTPS', 443, 'private'),

        // Outbound Egress through NAT Gateways
        e('e-app-a-nat', 'app-srv-a', 'nat-a', 'Egress NAT', 'ROUTES_TO', 'TCP', undefined, 'private'),
        e('e-app-b-nat', 'app-srv-b', 'nat-b', 'Egress NAT', 'ROUTES_TO', 'TCP', undefined, 'private'),
        e('e-nat-a-igw', 'nat-a', 'igw', 'NAT Egress', 'ROUTES_TO', 'TCP', undefined, 'public'),
        e('e-nat-b-igw', 'nat-b', 'igw', 'NAT Egress', 'ROUTES_TO', 'TCP', undefined, 'public'),
      ];

      return { nodes, edges };
    },
  },

  // ─── Azure Production 1,000-User Reference Architecture ──────────────────────
  {
    id: 'azure-1000-user-production',
    name: 'Azure 1,000-User Production Reference Architecture',
    description: 'Production-ready Azure architecture supporting 1,000+ concurrent users with native Azure services and zone redundancy.',
    provider: 'azure',
    category: 'High Availability',
    tags: ['azure', '1000-users', 'production', 'front-door', 'waf', 'app-gateway', 'vmss', 'azure-sql', 'redis', 'storage'],
    complexity: 'complex',
    estimatedCost: 410,
    resourceCount: 12,
    features: [
      '1,000+ Concurrent User Capacity (1,500+ buffer)',
      'Azure Front Door with Edge WAF Policy',
      'Layer-7 Application Gateway in Ingress Subnet',
      'Virtual Machine Scale Set (VMSS) with Auto-Scaling',
      'Azure SQL Database with Zone Redundant HA',
      'Azure Cache for Redis for Query & Session Offloading',
      'Storage Account (Blob) with HTTPS Enforced',
    ],
    generate(_opts: TemplateGenerateOptions) {
      const nodes: CanvasNode[] = [
        // ── Azure Cloud Boundary
        n('az-cloud', 'azure_cloud_boundary', 'azure', 'Microsoft Azure (East US)', 40, 20, { region: 'eastus' }, undefined, 1100, 880),

        // ── Global Ingress Layer
        n('az-fd', 'azure_front_door', 'azure', 'Azure Front Door', 360, 60, { sku: 'Standard_AzureFrontDoor' }, 'az-cloud'),
        n('az-waf', 'azure_waf', 'azure', 'Azure WAF Policy', 620, 60, { mode: 'Prevention' }, 'az-cloud'),

        // ── Resource Group & VNet Container
        n('az-rg', 'azure_resource_group', 'azure', 'Production Resource Group', 80, 160, { location: 'eastus' }, 'az-cloud', 1020, 700),
        n('az-vnet', 'azure_vnet', 'azure', 'Production VNet (10.0.0.0/16)', 100, 220, { addressSpace: '10.0.0.0/16' }, 'az-rg', 980, 620),

        // ── Ingress Subnet
        n('az-sub-ingress', 'azure_subnet', 'azure', 'Ingress Subnet (10.0.1.0/24)', 130, 270, { addressPrefix: '10.0.1.0/24' }, 'az-vnet', 920, 150),
        n('az-agw', 'azure_app_gateway', 'azure', 'Application Gateway (WAF v2)', 460, 320, { sku: 'WAF_v2' }, 'az-sub-ingress'),

        // ── Application Workload Subnet
        n('az-sub-app', 'azure_subnet', 'azure', 'App Workload Subnet (10.0.10.0/24)', 130, 450, { addressPrefix: '10.0.10.0/24' }, 'az-vnet', 920, 170),
        n('az-vmss', 'azure_vmss', 'azure', 'App VM Scale Set (VMSS)', 460, 510, { sku: 'Standard_B2s', capacity: 3 }, 'az-sub-app'),

        // ── Data Tier Subnet
        n('az-sub-data', 'azure_subnet', 'azure', 'Data Tier Subnet (10.0.20.0/24)', 130, 640, { addressPrefix: '10.0.20.0/24' }, 'az-vnet', 920, 170),
        n('az-sql-ha', 'azure_sql', 'azure', 'Azure SQL (Zone Redundant)', 280, 700, { tier: 'GeneralPurpose', zoneRedundant: true }, 'az-sub-data'),
        n('az-redis', 'azure_redis', 'azure', 'Azure Cache for Redis', 680, 700, { sku: 'Standard' }, 'az-sub-data'),

        // ── Storage Account (Outside Subnets)
        n('az-blob', 'azure_storage', 'azure', 'Blob Storage Account', 860, 270, { sku: 'Standard_ZRS', httpsOnly: true }, 'az-rg'),
      ];

      const edges: CanvasEdge[] = [
        // Front Door & WAF Ingress
        e('e-az-waf', 'az-waf', 'az-fd', 'WAF Policy Attached', 'ASSOCIATED_WITH', undefined, undefined, 'internal'),
        e('e-az-fd-agw', 'az-fd', 'az-agw', 'Backend Pool HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'),

        // App Gateway to VMSS Load Balancing
        e('e-az-agw-vmss', 'az-agw', 'az-vmss', 'Balance HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),

        // VMSS to Azure SQL (TDS :1433)
        e('e-az-vmss-sql', 'az-vmss', 'az-sql-ha', 'TDS / 1433', 'CONNECTS_TO', 'TDS', 1433, 'private'),

        // VMSS to Azure Redis (:6380)
        e('e-az-vmss-redis', 'az-vmss', 'az-redis', 'Redis TLS / 6380', 'CONNECTS_TO', 'Redis TLS', 6380, 'private'),

        // VMSS to Blob Storage (:443)
        e('e-az-vmss-blob', 'az-vmss', 'az-blob', 'Blob HTTPS / 443', 'STORES_IN', 'HTTPS', 443, 'private'),
      ];

      return { nodes, edges };
    },
  },

  // ─── 3-Tier Web Application (Fixed Hierarchy) ──────────────────────────────
  {
    id: '3tier-web',
    name: '3-Tier Web Application',
    description: 'Classic presentation, application, and database tiers with an ALB and RDS.',
    provider: 'aws',
    category: 'Web Applications',
    tags: ['aws', 'web', 'rds', 'ec2', 'alb'],
    complexity: 'moderate',
    estimatedCost: 180,
    resourceCount: 8,
    features: ['Load balanced', 'Managed database', 'Security groups', 'Subnet segregation'],
    generate(opts: TemplateGenerateOptions) {
      const ha = opts.highAvailability || false;
      const nodes: CanvasNode[] = [
        // ── Outer Cloud Provider Boundary
        n('aws-cloud', 'aws_cloud_boundary', 'aws', 'Amazon Web Services (us-east-1)', 30, 20, { region: 'us-east-1' }, undefined, 1150, 920),

        // ── VPC Container
        n('vpc', 'aws_vpc', 'aws', 'Production VPC (10.0.0.0/16)', 60, 110, { cidrBlock: '10.0.0.0/16' }, 'aws-cloud', 1040, 760),
        n('igw', 'aws_igw', 'aws', 'Internet Gateway', 460, 160, {}, 'vpc'),

        // ── Public Subnet Tier
        n('pub1', 'aws_subnet', 'aws', 'Public Subnet (10.0.1.0/24)', 100, 240, { cidrBlock: '10.0.1.0/24', mapPublicIpOnLaunch: true }, 'vpc', 460, 180),
        n('alb', 'aws_alb', 'aws', 'App Load Balancer', 220, 310, { lbType: 'application', scheme: 'internet-facing' }, 'pub1'),

        // ── Private App Subnet Tier
        n('priv1', 'aws_subnet', 'aws', 'Private App Subnet AZ-A (10.0.2.0/24)', 100, 460, { cidrBlock: '10.0.2.0/24', availabilityZone: 'us-east-1a' }, 'vpc', 460, 180),
        n('ec2a', 'aws_ec2', 'aws', 'App Server 1', 220, 530, { instanceType: 't3.medium', keyName: 'prod-key' }, 'priv1'),

        // ── Private DB Subnet Tier
        n('db-sub', 'aws_subnet', 'aws', 'Private DB Subnet (10.0.3.0/24)', 100, 670, { cidrBlock: '10.0.3.0/24', availabilityZone: 'us-east-1a' }, 'vpc', ha ? 960 : 460, 180),
        n('db', 'aws_rds', 'aws', 'PostgreSQL Database', 220, 740, { engine: 'postgres', instanceClass: 'db.t3.medium', multiAz: ha, encrypted: true }, 'db-sub'),
      ];

      if (ha) {
        nodes.push(n('priv2', 'aws_subnet', 'aws', 'Private App Subnet AZ-B (10.0.4.0/24)', 600, 460, { cidrBlock: '10.0.4.0/24', availabilityZone: 'us-east-1b' }, 'vpc', 460, 180));
        nodes.push(n('ec2b', 'aws_ec2', 'aws', 'App Server 2', 720, 530, { instanceType: 't3.medium', keyName: 'prod-key' }, 'priv2'));
      }

      const edges: CanvasEdge[] = [
        e('e1', 'igw', 'alb', 'Inbound HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'),
        e('e2', 'alb', 'ec2a', 'Forward HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e('e3', 'ec2a', 'db', 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
      ];

      if (ha) {
        edges.push(
          e('e4', 'alb', 'ec2b', 'Forward HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
          e('e5', 'ec2b', 'db', 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private')
        );
      }

      return { nodes, edges };
    },
  },

  // ─── Highly Available Web App ───────────────────────────────────────────────
  {
    id: 'ha-web',
    name: 'Highly Available Web App',
    description: 'Multi-AZ web application with auto-scaling, ALB, RDS Multi-AZ and S3.',
    provider: 'aws',
    category: 'High Availability',
    tags: ['aws', 'ha', 'multi-az', 'auto-scaling'],
    complexity: 'complex',
    estimatedCost: 320,
    resourceCount: 12,
    features: ['Multi-AZ across AZ-A & AZ-B', 'Auto Scaling', 'S3 static assets outside VPC', 'Encrypted storage'],
    generate(_opts) {
      const nodes: CanvasNode[] = [
        // ── Outer Cloud Provider Boundary
        n('aws-cloud', 'aws_cloud_boundary', 'aws', 'Amazon Web Services (us-east-1)', 30, 20, { region: 'us-east-1' }, undefined, 1460, 1040),

        // ── VPC Container
        n('vpc', 'aws_vpc', 'aws', 'HA Production VPC (10.0.0.0/16)', 70, 80, { cidrBlock: '10.0.0.0/16' }, 'aws-cloud', 1050, 900),
        n('igw', 'aws_igw', 'aws', 'Internet Gateway', 505, 135, {}, 'vpc'),

        // ── Multi-AZ Public Subnets (Tier 1)
        n('pub1', 'aws_subnet', 'aws', 'Public Subnet AZ-A (10.0.1.0/24)', 110, 255, { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: true }, 'vpc', 460, 190),
        n('alb', 'aws_alb', 'aws', 'App Load Balancer', 140, 320, { lbType: 'application', scheme: 'internet-facing' }, 'pub1'),
        n('nat', 'aws_nat', 'aws', 'NAT Gateway AZ-A', 355, 320, { connectivityType: 'public' }, 'pub1'),

        n('pub2', 'aws_subnet', 'aws', 'Public Subnet AZ-B (10.0.2.0/24)', 620, 255, { cidrBlock: '10.0.2.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: true }, 'vpc', 460, 190),
        n('nat-b', 'aws_nat', 'aws', 'NAT Gateway AZ-B', 760, 320, { connectivityType: 'public' }, 'pub2'),

        // ── Multi-AZ Private App Subnets (Tier 2)
        n('priv1', 'aws_subnet', 'aws', 'Private App Subnet AZ-A (10.0.3.0/24)', 110, 510, { cidrBlock: '10.0.3.0/24', availabilityZone: 'us-east-1a' }, 'vpc', 460, 190),
        n('ec2a', 'aws_ec2', 'aws', 'App Server AZ-A', 250, 575, { instanceType: 'm5.large', keyName: 'prod-key' }, 'priv1'),

        n('priv2', 'aws_subnet', 'aws', 'Private App Subnet AZ-B (10.0.4.0/24)', 620, 510, { cidrBlock: '10.0.4.0/24', availabilityZone: 'us-east-1b' }, 'vpc', 460, 190),
        n('ec2b', 'aws_ec2', 'aws', 'App Server AZ-B', 760, 575, { instanceType: 'm5.large', keyName: 'prod-key' }, 'priv2'),

        // ── Private DB Subnet (Tier 3)
        n('db-sub', 'aws_subnet', 'aws', 'Private DB Subnet (10.0.5.0/24)', 110, 765, { cidrBlock: '10.0.5.0/24' }, 'vpc', 970, 190),
        n('rds', 'aws_rds', 'aws', 'RDS Multi-AZ Postgres', 250, 830, { engine: 'postgres', instanceClass: 'db.m5.large', multiAz: true, encrypted: true }, 'db-sub'),
        n('redis', 'aws_elasticache', 'aws', 'ElastiCache Redis', 760, 830, { numNodes: 2 }, 'db-sub'),

        // ── Regional Object Storage (Outside VPC, inside AWS Cloud Boundary)
        n('s3', 'aws_s3', 'aws', 'Assets Bucket (S3)', 1180, 255, { versioning: true, encryption: true, publicAccess: false }, 'aws-cloud'),
      ];

      const edges: CanvasEdge[] = [
        e('e1', 'igw', 'alb', 'Inbound HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'),
        e('e2', 'alb', 'ec2a', 'HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e('e3', 'alb', 'ec2b', 'HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e('e4', 'ec2a', 'rds', 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e('e5', 'ec2b', 'rds', 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e('e6', 'ec2a', 'redis', 'Redis / 6379', 'CONNECTS_TO', 'Redis', 6379, 'private'),
        e('e7', 'ec2b', 'redis', 'Redis / 6379', 'CONNECTS_TO', 'Redis', 6379, 'private'),
        e('e8', 'ec2a', 's3', 'S3 API / IAM', 'STORES_IN', 'HTTPS', 443, 'private'),
        e('e9', 'ec2b', 's3', 'S3 API / IAM', 'STORES_IN', 'HTTPS', 443, 'private'),
        e('e10', 'ec2a', 'nat', 'Egress NAT', 'ROUTES_TO', 'TCP', undefined, 'private'),
        e('e11', 'ec2b', 'nat-b', 'Egress NAT', 'ROUTES_TO', 'TCP', undefined, 'private'),
        e('e12', 'nat', 'igw', 'Internet Egress', 'ROUTES_TO', 'TCP', undefined, 'public'),
      ];

      return { nodes, edges };
    },
  },

  // ─── SaaS Platform ──────────────────────────────────────────────────────────
  {
    id: 'saas',
    name: 'SaaS Platform',
    description: 'Multi-tenant SaaS with API gateway, managed caching, and object storage.',
    provider: 'aws',
    category: 'SaaS',
    tags: ['aws', 'saas', 'multi-tenant', 'api'],
    complexity: 'complex',
    estimatedCost: 520,
    resourceCount: 10,
    features: ['Load Balancer', 'RDS Multi-AZ', 'S3 storage', 'ElastiCache Redis'],
    generate() {
      const nodes: CanvasNode[] = [
        // ── Outer Cloud Provider Boundary
        n('aws-cloud', 'aws_cloud_boundary', 'aws', 'Amazon Web Services (us-east-1)', 30, 20, { region: 'us-east-1' }, undefined, 1300, 940),

        // ── VPC Container
        n('vpc', 'aws_vpc', 'aws', 'SaaS Production VPC (10.0.0.0/16)', 60, 110, { cidrBlock: '10.0.0.0/16' }, 'aws-cloud', 940, 780),
        n('igw', 'aws_igw', 'aws', 'Internet Gateway', 420, 160, {}, 'vpc'),

        // ── Public Subnet Tier
        n('pub1', 'aws_subnet', 'aws', 'Public Subnet (10.0.1.0/24)', 100, 240, { cidrBlock: '10.0.1.0/24', mapPublicIpOnLaunch: true }, 'vpc', 440, 180),
        n('alb', 'aws_alb', 'aws', 'API Load Balancer', 140, 310, { lbType: 'application', scheme: 'internet-facing' }, 'pub1'),
        n('nat', 'aws_nat', 'aws', 'NAT Gateway', 330, 310, { connectivityType: 'public' }, 'pub1'),

        // ── Private App Subnet Tier
        n('priv1', 'aws_subnet', 'aws', 'Private App Subnet (10.0.2.0/24)', 100, 460, { cidrBlock: '10.0.2.0/24' }, 'vpc', 440, 180),
        n('api', 'aws_ec2', 'aws', 'API Cluster Workers', 230, 530, { instanceType: 'm5.xlarge', keyName: 'saas-key' }, 'priv1'),

        // ── Private Data Subnet Tier
        n('db-sub', 'aws_subnet', 'aws', 'Private Data Subnet (10.0.3.0/24)', 100, 670, { cidrBlock: '10.0.3.0/24' }, 'vpc', 860, 180),
        n('rds', 'aws_rds', 'aws', 'Multi-AZ Postgres DB', 230, 740, { engine: 'postgres', instanceClass: 'db.m5.large', multiAz: true, encrypted: true }, 'db-sub'),
        n('redis', 'aws_elasticache', 'aws', 'ElastiCache Session Store', 630, 740, { numNodes: 2 }, 'db-sub'),

        // ── Regional Storage Tier (Outside VPC, inside AWS Cloud Boundary)
        n('s3-app', 'aws_s3', 'aws', 'Private App Storage (S3)', 1040, 240, { versioning: true, encryption: true, publicAccess: false }, 'aws-cloud'),
      ];

      const edges: CanvasEdge[] = [
        e('e1', 'igw', 'alb', 'Inbound HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'),
        e('e2', 'alb', 'api', 'Balance HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e('e3', 'api', 'rds', 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e('e4', 'api', 'redis', 'Redis / 6379', 'CONNECTS_TO', 'Redis', 6379, 'private'),
        e('e5', 'api', 's3-app', 'S3 API / IAM', 'STORES_IN', 'HTTPS', 443, 'private'),
        e('e6', 'api', 'nat', 'Egress NAT', 'ROUTES_TO', 'TCP', undefined, 'private'),
        e('e7', 'nat', 'igw', 'Internet Egress', 'ROUTES_TO', 'TCP', undefined, 'public'),
      ];

      return { nodes, edges };
    },
  },

  // ─── Multi-Cloud Architecture (AWS + Azure) ──────────────────────────────────
  {
    id: 'multicloud',
    name: 'AWS + Azure Multi-Cloud Architecture',
    description: 'Workloads spanning AWS and Azure with verified cross-cloud connectivity.',
    provider: 'multi',
    category: 'Multi-cloud',
    tags: ['multi-cloud', 'aws', 'azure', 'hybrid'],
    complexity: 'complex',
    estimatedCost: 740,
    resourceCount: 12,
    features: ['Cross-cloud VPN tunnel', 'AWS primary compute', 'Azure secondary data store', 'Strict cloud isolation'],
    generate() {
      const nodes: CanvasNode[] = [
        // AWS Side
        n('aws-cloud', 'aws_cloud_boundary', 'aws', 'AWS Primary Cloud', 30, 30, { region: 'us-east-1' }, undefined, 580, 680),
        n('aws-vpc', 'aws_vpc', 'aws', 'AWS VPC (10.1.0.0/16)', 60, 100, { cidrBlock: '10.1.0.0/16' }, 'aws-cloud', 520, 570),
        n('aws-sub', 'aws_subnet', 'aws', 'AWS App Subnet (10.1.1.0/24)', 90, 180, { cidrBlock: '10.1.1.0/24' }, 'aws-vpc', 460, 180),
        n('aws-ec2', 'aws_ec2', 'aws', 'AWS App Server', 210, 250, { instanceType: 'm5.large' }, 'aws-sub'),
        n('aws-rds', 'aws_rds', 'aws', 'AWS RDS Postgres', 210, 440, { engine: 'postgres', multiAz: true, encrypted: true }, 'aws-vpc'),

        // Azure Side
        n('az-cloud', 'azure_cloud_boundary', 'azure', 'Azure Secondary Cloud', 660, 30, { region: 'eastus' }, undefined, 580, 680),
        n('az-rg', 'azure_resource_group', 'azure', 'Azure Resource Group', 690, 100, { location: 'eastus' }, 'az-cloud', 520, 570),
        n('az-vnet', 'azure_vnet', 'azure', 'Azure VNet (10.2.0.0/16)', 710, 160, { addressSpace: '10.2.0.0/16' }, 'az-rg', 480, 480),
        n('az-sub', 'azure_subnet', 'azure', 'Azure Data Subnet (10.2.1.0/24)', 730, 240, { addressPrefix: '10.2.1.0/24' }, 'az-vnet', 440, 180),
        n('az-sql', 'azure_sql', 'azure', 'Azure SQL Standby', 830, 310, { tier: 'GeneralPurpose' }, 'az-sub'),
        n('az-storage', 'azure_storage', 'azure', 'Azure Blob Backup', 830, 460, { sku: 'Standard_GRS', httpsOnly: true }, 'az-rg'),
      ];

      const edges: CanvasEdge[] = [
        e('e1', 'aws-ec2', 'aws-rds', 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e('e2', 'az-sql', 'az-storage', 'Backup Archive', 'STORES_IN', 'HTTPS', 443, 'private'),
        // Cross-cloud connection
        e('e-cross', 'aws-ec2', 'az-sql', 'Cross-Cloud VPN Replicate', 'CONNECTS_TO', 'TDS / VPN', 1433, 'cross-cloud'),
      ];

      return { nodes, edges };
    },
  },
];

// architectureTemplates = hand-built reference architectures (distinct topologies,
// see lib/templates/referenceArchitectures.ts) first, followed by the parameterized
// quick-start catalog (lib/templates/catalogData.ts) for broader labeled variety.
export const architectureTemplates: ArchitectureTemplate[] = [
  ...allReferenceArchitectures,
  ...catalogTemplates,
];

export const legacyArchitectureTemplates = architectureTemplatesLegacy;

export const TEMPLATES = architectureTemplates;

export function getTemplate(id: string): ArchitectureTemplate | undefined {
  return architectureTemplates.find((t) => t.id === id);
}

export function getTemplatesByProvider(provider: CloudProvider): ArchitectureTemplate[] {
  if (provider === 'multi') return architectureTemplates.filter((t) => t.provider === 'multi');
  return architectureTemplates.filter((t) => t.provider === provider || t.provider === 'multi');
}
