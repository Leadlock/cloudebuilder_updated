import { ArchitectureTemplate, TemplateGenerateOptions, CanvasNode, CanvasEdge, CloudProvider, RelationshipType, NetworkScope } from '@/types';

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
    config: { name: label.toLowerCase().replace(/\s+/g, '-'), ...config },
  };
}

function e(
  id: string,
  source: string,
  target: string,
  label?: string,
  relationshipType: RelationshipType = 'NETWORK_FLOW',
  protocol?: string,
  port?: string | number,
  networkScope: NetworkScope = 'private'
): CanvasEdge {
  return {
    id,
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

export const architectureTemplates: ArchitectureTemplate[] = [
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
        n('aws-cloud', 'aws_cloud_boundary', 'aws', 'Amazon Web Services (us-east-1)', 40, 20, { region: 'us-east-1' }, undefined, 1100, 920),

        // ── Edge & Ingress Layer (Regional/Global)
        n('r53', 'aws_route53', 'aws', 'Route 53 DNS', 220, 60, { domainName: 'cloudcraft.app' }, 'aws-cloud'),
        n('cf', 'aws_cloudfront', 'aws', 'CloudFront CDN', 460, 60, { priceClass: 'PriceClass_100', defaultRootObject: 'index.html' }, 'aws-cloud'),
        n('waf', 'aws_waf', 'aws', 'AWS WAF', 700, 60, { scope: 'CLOUDFRONT', defaultAction: 'ALLOW' }, 'aws-cloud'),

        // ── VPC Container
        n('vpc', 'aws_vpc', 'aws', 'Production VPC (10.0.0.0/16)', 80, 160, { cidrBlock: '10.0.0.0/16', enableDnsSupport: true, enableDnsHostnames: true }, 'aws-cloud', 1020, 740),
        n('igw', 'aws_igw', 'aws', 'Internet Gateway', 460, 210, {}, 'vpc'),

        // ── Public Subnets Tier (AZ-a & AZ-b)
        n('pub-sub-a', 'aws_subnet', 'aws', 'Public Subnet AZ-A (10.0.1.0/24)', 120, 290, { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: true }, 'vpc', 450, 170),
        n('pub-sub-b', 'aws_subnet', 'aws', 'Public Subnet AZ-B (10.0.2.0/24)', 610, 290, { cidrBlock: '10.0.2.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: true }, 'vpc', 450, 170),
        n('alb', 'aws_alb', 'aws', 'App Load Balancer (Multi-AZ)', 160, 350, { lbType: 'application', scheme: 'internet-facing' }, 'pub-sub-a'),
        n('nat-a', 'aws_nat', 'aws', 'NAT Gateway AZ-A', 380, 350, { connectivityType: 'public' }, 'pub-sub-a'),
        n('nat-b', 'aws_nat', 'aws', 'NAT Gateway AZ-B', 870, 350, { connectivityType: 'public' }, 'pub-sub-b'),

        // ── Private Application Subnets Tier (AZ-a & AZ-b)
        n('app-sub-a', 'aws_subnet', 'aws', 'Private App Subnet AZ-A (10.0.10.0/24)', 120, 490, { cidrBlock: '10.0.10.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: false }, 'vpc', 450, 170),
        n('app-sub-b', 'aws_subnet', 'aws', 'Private App Subnet AZ-B (10.0.11.0/24)', 610, 490, { cidrBlock: '10.0.11.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: false }, 'vpc', 450, 170),
        n('app-srv-a', 'aws_ec2', 'aws', 'App Worker AZ-A', 260, 550, { instanceType: 't3.medium', keyName: 'prod-key', encrypted: true }, 'app-sub-a'),
        n('app-srv-b', 'aws_ec2', 'aws', 'App Worker AZ-B', 750, 550, { instanceType: 't3.medium', keyName: 'prod-key', encrypted: true }, 'app-sub-b'),

        // ── Private Database Subnets Tier (AZ-a & AZ-b)
        n('db-sub-a', 'aws_subnet', 'aws', 'Private DB Subnet AZ-A (10.0.20.0/24)', 120, 690, { cidrBlock: '10.0.20.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: false }, 'vpc', 450, 170),
        n('db-sub-b', 'aws_subnet', 'aws', 'Private DB Subnet AZ-B (10.0.21.0/24)', 610, 690, { cidrBlock: '10.0.21.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: false }, 'vpc', 450, 170),
        n('rds-multiaz', 'aws_rds', 'aws', 'RDS PostgreSQL (Multi-AZ)', 260, 750, { engine: 'postgres', instanceClass: 'db.t3.medium', multiAz: true, encrypted: true }, 'db-sub-a'),
        n('redis-cache', 'aws_elasticache', 'aws', 'ElastiCache Redis', 750, 750, { numNodes: 2 }, 'db-sub-b'),

        // ── Regional Storage (Outside Subnets)
        n('s3-storage', 'aws_s3', 'aws', 'Encrypted S3 Storage', 880, 210, { bucketName: 'prod-assets-vault', encryption: true, versioning: true, publicAccess: false }, 'aws-cloud'),
      ];

      const edges: CanvasEdge[] = [
        // Ingress Flow
        e('e-r53-cf', 'r53', 'cf', 'DNS Alias', 'RESOLVES_TO', 'DNS', 53, 'public'),
        e('e-waf-cf', 'waf', 'cf', 'WAF Protection', 'ASSOCIATED_WITH', undefined, undefined, 'internal'),
        e('e-cf-alb', 'cf', 'alb', 'Origin HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'),
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
        n('vpc', 'aws_vpc', 'aws', 'Production VPC', 50, 40, { cidrBlock: '10.0.0.0/16' }, undefined, 820, 580),
        n('igw', 'aws_igw', 'aws', 'Internet Gateway', 380, 90, {}, 'vpc'),

        n('pub1', 'aws_subnet', 'aws', 'Public Subnet', 80, 160, { cidrBlock: '10.0.1.0/24', mapPublicIpOnLaunch: true }, 'vpc', 340, 160),
        n('alb', 'aws_alb', 'aws', 'App Load Balancer', 150, 210, { lbType: 'application', scheme: 'internet-facing' }, 'pub1'),

        n('priv1', 'aws_subnet', 'aws', 'Private App Subnet', 80, 350, { cidrBlock: '10.0.2.0/24', availabilityZone: 'us-east-1a' }, 'vpc', 340, 160),
        n('ec2a', 'aws_ec2', 'aws', 'App Server 1', 150, 400, { instanceType: 't3.medium', keyName: 'prod-key' }, 'priv1'),

        n('db-sub', 'aws_subnet', 'aws', 'Private DB Subnet', 450, 350, { cidrBlock: '10.0.3.0/24', availabilityZone: 'us-east-1a' }, 'vpc', 340, 160),
        n('db', 'aws_rds', 'aws', 'PostgreSQL Database', 520, 400, { engine: 'postgres', instanceClass: 'db.t3.medium', multiAz: ha, encrypted: true }, 'db-sub'),
      ];

      if (ha) {
        nodes.push(n('priv2', 'aws_subnet', 'aws', 'Private App Subnet 1b', 450, 160, { cidrBlock: '10.0.4.0/24', availabilityZone: 'us-east-1b' }, 'vpc', 340, 160));
        nodes.push(n('ec2b', 'aws_ec2', 'aws', 'App Server 2', 520, 210, { instanceType: 't3.medium', keyName: 'prod-key' }, 'priv2'));
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
    resourceCount: 11,
    features: ['Multi-AZ', 'Auto Scaling', 'S3 static assets', 'Encrypted storage'],
    generate(_opts) {
      const nodes: CanvasNode[] = [
        n('vpc', 'aws_vpc', 'aws', 'HA Production VPC', 50, 40, { cidrBlock: '10.0.0.0/16' }, undefined, 900, 680),
        n('igw', 'aws_igw', 'aws', 'Internet Gateway', 420, 90, {}, 'vpc'),

        n('pub1', 'aws_subnet', 'aws', 'Public Subnet AZ-A', 80, 160, { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: true }, 'vpc', 380, 160),
        n('alb', 'aws_alb', 'aws', 'App Load Balancer', 120, 220, { lbType: 'application', scheme: 'internet-facing' }, 'pub1'),
        n('nat', 'aws_nat', 'aws', 'NAT Gateway AZ-A', 300, 220, { connectivityType: 'public' }, 'pub1'),

        n('priv1', 'aws_subnet', 'aws', 'Private Subnet AZ-A', 80, 350, { cidrBlock: '10.0.3.0/24', availabilityZone: 'us-east-1a' }, 'vpc', 380, 160),
        n('ec2a', 'aws_ec2', 'aws', 'App Server AZ-A', 180, 400, { instanceType: 'm5.large', keyName: 'prod-key' }, 'priv1'),

        n('priv2', 'aws_subnet', 'aws', 'Private Subnet AZ-B', 500, 350, { cidrBlock: '10.0.4.0/24', availabilityZone: 'us-east-1b' }, 'vpc', 380, 160),
        n('ec2b', 'aws_ec2', 'aws', 'App Server AZ-B', 600, 400, { instanceType: 'm5.large', keyName: 'prod-key' }, 'priv2'),

        n('db-sub', 'aws_subnet', 'aws', 'Private DB Subnet', 80, 530, { cidrBlock: '10.0.5.0/24' }, 'vpc', 800, 160),
        n('rds', 'aws_rds', 'aws', 'RDS Multi-AZ Postgres', 200, 580, { engine: 'postgres', instanceClass: 'db.m5.large', multiAz: true, encrypted: true }, 'db-sub'),

        n('s3', 'aws_s3', 'aws', 'Assets Bucket', 600, 580, { versioning: true, encryption: true, publicAccess: false }),
      ];

      const edges: CanvasEdge[] = [
        e('e1', 'igw', 'alb', 'Inbound HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'),
        e('e2', 'alb', 'ec2a', 'HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e('e3', 'alb', 'ec2b', 'HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e('e4', 'ec2a', 'rds', 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e('e5', 'ec2b', 'rds', 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e('e6', 'ec2a', 's3', 'S3 API / IAM', 'STORES_IN', 'HTTPS', 443, 'private'),
        e('e7', 'ec2b', 's3', 'S3 API / IAM', 'STORES_IN', 'HTTPS', 443, 'private'),
        e('e8', 'ec2a', 'nat', 'Egress NAT', 'ROUTES_TO', 'TCP', undefined, 'private'),
        e('e9', 'nat', 'igw', 'Internet Egress', 'ROUTES_TO', 'TCP', undefined, 'public'),
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
        n('vpc', 'aws_vpc', 'aws', 'SaaS VPC', 50, 50, { cidrBlock: '10.0.0.0/16' }, undefined, 880, 640),
        n('igw', 'aws_igw', 'aws', 'Internet Gateway', 420, 90, {}, 'vpc'),

        n('pub1', 'aws_subnet', 'aws', 'Public Subnet', 80, 170, { cidrBlock: '10.0.1.0/24', mapPublicIpOnLaunch: true }, 'vpc', 400, 160),
        n('alb', 'aws_alb', 'aws', 'API Load Balancer', 120, 220, { lbType: 'application', scheme: 'internet-facing' }, 'pub1'),
        n('nat', 'aws_nat', 'aws', 'NAT Gateway', 320, 220, { connectivityType: 'public' }, 'pub1'),

        n('priv1', 'aws_subnet', 'aws', 'Private App Subnet', 80, 350, { cidrBlock: '10.0.2.0/24' }, 'vpc', 400, 160),
        n('api', 'aws_ec2', 'aws', 'API Cluster Workers', 200, 400, { instanceType: 'm5.xlarge', keyName: 'saas-key' }, 'priv1'),

        n('db-sub', 'aws_subnet', 'aws', 'Private Data Subnet', 80, 530, { cidrBlock: '10.0.3.0/24' }, 'vpc', 800, 150),
        n('rds', 'aws_rds', 'aws', 'Multi-AZ Postgres DB', 200, 580, { engine: 'postgres', instanceClass: 'db.m5.large', multiAz: true, encrypted: true }, 'db-sub'),
        n('redis', 'aws_elasticache', 'aws', 'ElastiCache Session Store', 560, 580, { numNodes: 2 }, 'db-sub'),

        n('s3-app', 'aws_s3', 'aws', 'Private App Storage', 560, 220, { versioning: true, encryption: true, publicAccess: false }),
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
        n('aws-cloud', 'aws_cloud_boundary', 'aws', 'AWS Primary Cloud', 40, 40, { region: 'us-east-1' }, undefined, 480, 580),
        n('aws-vpc', 'aws_vpc', 'aws', 'AWS VPC', 60, 100, { cidrBlock: '10.1.0.0/16' }, 'aws-cloud', 440, 500),
        n('aws-sub', 'aws_subnet', 'aws', 'AWS App Subnet', 80, 180, { cidrBlock: '10.1.1.0/24' }, 'aws-vpc', 400, 180),
        n('aws-ec2', 'aws_ec2', 'aws', 'AWS App Server', 180, 230, { instanceType: 'm5.large' }, 'aws-sub'),
        n('aws-rds', 'aws_rds', 'aws', 'AWS RDS Postgres', 180, 420, { engine: 'postgres', multiAz: true, encrypted: true }, 'aws-vpc'),

        // Azure Side
        n('az-cloud', 'azure_cloud_boundary', 'azure', 'Azure Secondary Cloud', 560, 40, { region: 'eastus' }, undefined, 480, 580),
        n('az-rg', 'azure_resource_group', 'azure', 'Azure RG', 580, 100, { location: 'eastus' }, 'az-cloud', 440, 500),
        n('az-vnet', 'azure_vnet', 'azure', 'Azure VNet', 600, 160, { addressSpace: '10.2.0.0/16' }, 'az-rg', 400, 420),
        n('az-sub', 'azure_subnet', 'azure', 'Azure Data Subnet', 620, 220, { addressPrefix: '10.2.1.0/24' }, 'az-vnet', 360, 160),
        n('az-sql', 'azure_sql', 'azure', 'Azure SQL Standby', 700, 270, { tier: 'GeneralPurpose' }, 'az-sub'),
        n('az-storage', 'azure_storage', 'azure', 'Azure Blob Backup', 700, 440, { sku: 'Standard_GRS', httpsOnly: true }, 'az-rg'),
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

export const TEMPLATES = architectureTemplates;

export function getTemplate(id: string): ArchitectureTemplate | undefined {
  return architectureTemplates.find((t) => t.id === id);
}

export function getTemplatesByProvider(provider: CloudProvider): ArchitectureTemplate[] {
  if (provider === 'multi') return architectureTemplates.filter((t) => t.provider === 'multi');
  return architectureTemplates.filter((t) => t.provider === provider || t.provider === 'multi');
}
