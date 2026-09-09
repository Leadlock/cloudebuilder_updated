import { ArchitectureTemplate, TemplateGenerateOptions, CanvasNode, CanvasEdge, CloudProvider } from '@/types';

function n(id: string, resourceType: string, provider: 'aws' | 'azure', label: string, x: number, y: number, config: Record<string, unknown> = {}): CanvasNode {
  return { id, type: 'cloudNode', resourceType, provider, label, position: { x, y }, config: { name: label.toLowerCase().replace(/\s+/g, '-'), ...config } };
}
function e(id: string, source: string, target: string, label?: string): CanvasEdge {
  return { id, source, target, label };
}

export const architectureTemplates: ArchitectureTemplate[] = [
  // ─── 3-Tier Web Application ────────────────────────────────────────────────
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
    features: ['Load balanced', 'Auto Scaling', 'Managed database', 'Security groups'],
    generate(opts: TemplateGenerateOptions) {
      const ha = opts.highAvailability;
      const nodes: CanvasNode[] = [
        n('vpc', 'aws_vpc', 'aws', 'Production VPC', 50, 40, { cidrBlock: '10.0.0.0/16', enableDnsHostnames: true, enableDnsSupport: true }),
        n('igw', 'aws_igw', 'aws', 'Internet Gateway', 320, 40),
        n('pub1', 'aws_subnet', 'aws', 'Public Subnet 1a', 80, 160, { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: true }),
        n('alb', 'aws_alb', 'aws', 'App Load Balancer', 310, 160, { lbType: 'application', scheme: 'internet-facing' }),
        n('priv1', 'aws_subnet', 'aws', 'Private Subnet 1a', 80, 300, { cidrBlock: '10.0.2.0/24', availabilityZone: 'us-east-1a' }),
        n('ec2a', 'aws_ec2', 'aws', 'App Server 1', 220, 300, { instanceType: 't3.medium', keyName: 'prod-key' }),
        n('sg', 'aws_sg', 'aws', 'App Security Group', 440, 300, { allowHttp: true, allowHttps: true, allowSsh: false }),
        n('db', 'aws_rds', 'aws', 'MySQL Database', 310, 450, { engine: 'mysql', instanceClass: 'db.t3.medium', multiAz: ha || false, encrypted: true }),
      ];
      if (ha) {
        nodes.push(n('pub2', 'aws_subnet', 'aws', 'Public Subnet 1b', 580, 160, { cidrBlock: '10.0.3.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: true }));
        nodes.push(n('priv2', 'aws_subnet', 'aws', 'Private Subnet 1b', 580, 300, { cidrBlock: '10.0.4.0/24', availabilityZone: 'us-east-1b' }));
        nodes.push(n('ec2b', 'aws_ec2', 'aws', 'App Server 2', 580, 300, { instanceType: 't3.medium', keyName: 'prod-key' }));
      }
      const edges: CanvasEdge[] = [
        e('e1', 'igw', 'alb'),
        e('e2', 'alb', 'ec2a'),
        e('e3', 'ec2a', 'db'),
        e('e4', 'vpc', 'pub1'),
        e('e5', 'vpc', 'priv1'),
      ];
      if (ha) {
        edges.push(e('e6', 'alb', 'ec2b'), e('e7', 'ec2b', 'db'));
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
    estimatedCost: 420,
    resourceCount: 12,
    features: ['Multi-AZ', 'Auto Scaling', 'S3 static assets', 'WAF ready', 'Encrypted storage'],
    generate(opts) {
      const nodes: CanvasNode[] = [
        n('vpc', 'aws_vpc', 'aws', 'HA VPC', 50, 40, { cidrBlock: '10.0.0.0/16', enableDnsHostnames: true, enableDnsSupport: true }),
        n('igw', 'aws_igw', 'aws', 'Internet Gateway', 700, 40),
        n('pub1', 'aws_subnet', 'aws', 'Public Subnet AZ-A', 80, 160, { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: true }),
        n('pub2', 'aws_subnet', 'aws', 'Public Subnet AZ-B', 380, 160, { cidrBlock: '10.0.2.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: true }),
        n('alb', 'aws_alb', 'aws', 'App Load Balancer', 660, 160, { lbType: 'application', scheme: 'internet-facing' }),
        n('nat', 'aws_nat', 'aws', 'NAT Gateway', 700, 300, { connectivityType: 'public' }),
        n('priv1', 'aws_subnet', 'aws', 'Private Subnet AZ-A', 80, 320, { cidrBlock: '10.0.3.0/24', availabilityZone: 'us-east-1a' }),
        n('priv2', 'aws_subnet', 'aws', 'Private Subnet AZ-B', 380, 320, { cidrBlock: '10.0.4.0/24', availabilityZone: 'us-east-1b' }),
        n('ec2a', 'aws_ec2', 'aws', 'App Server AZ-A', 80, 450, { instanceType: 'm5.large', keyName: 'prod-key' }),
        n('ec2b', 'aws_ec2', 'aws', 'App Server AZ-B', 380, 450, { instanceType: 'm5.large', keyName: 'prod-key' }),
        n('rds', 'aws_rds', 'aws', 'RDS Multi-AZ', 480, 600, { engine: 'postgres', instanceClass: 'db.m5.large', multiAz: true, encrypted: true }),
        n('s3', 'aws_s3', 'aws', 'Assets Bucket', 150, 600, { versioning: true, encryption: true, publicAccess: false }),
        n('sg', 'aws_sg', 'aws', 'Web Security Group', 230, 600, { allowHttp: true, allowHttps: true, allowSsh: false }),
      ];
      const edges: CanvasEdge[] = [
        e('e1', 'igw', 'alb'), e('e2', 'alb', 'ec2a'), e('e3', 'alb', 'ec2b'),
        e('e4', 'ec2a', 'rds'), e('e5', 'ec2b', 'rds'), e('e6', 'ec2a', 's3'),
        e('e7', 'nat', 'priv1'), e('e8', 'nat', 'priv2'),
      ];
      return { nodes, edges };
    },
  },

  // ─── SaaS Platform ──────────────────────────────────────────────────────────
  {
    id: 'saas',
    name: 'SaaS Platform',
    description: 'Multi-tenant SaaS with API gateway, managed services, caching and object storage.',
    provider: 'aws',
    category: 'SaaS',
    tags: ['aws', 'saas', 'multi-tenant', 'api'],
    complexity: 'complex',
    estimatedCost: 650,
    resourceCount: 11,
    features: ['API Gateway', 'Caching layer', 'CDN', 'RDS Multi-AZ', 'S3 storage'],
    generate() {
      const nodes: CanvasNode[] = [
        n('vpc', 'aws_vpc', 'aws', 'SaaS VPC', 50, 50, { cidrBlock: '10.0.0.0/16', enableDnsHostnames: true, enableDnsSupport: true }),
        n('igw', 'aws_igw', 'aws', 'Internet Gateway', 700, 50),
        n('alb', 'aws_alb', 'aws', 'Application LB', 700, 180, { lbType: 'application', scheme: 'internet-facing' }),
        n('pub1', 'aws_subnet', 'aws', 'Public Subnet', 100, 180, { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a' }),
        n('api', 'aws_ec2', 'aws', 'API Servers', 350, 320, { instanceType: 'm5.xlarge', keyName: 'saas-key' }),
        n('sg-api', 'aws_sg', 'aws', 'API Security Group', 560, 320, { allowHttps: true, allowHttp: false, allowSsh: false }),
        n('priv1', 'aws_subnet', 'aws', 'Private Subnet', 100, 320, { cidrBlock: '10.0.2.0/24', availabilityZone: 'us-east-1a' }),
        n('nat', 'aws_nat', 'aws', 'NAT Gateway', 700, 320, { connectivityType: 'public' }),
        n('rds', 'aws_rds', 'aws', 'Postgres DB', 200, 480, { engine: 'postgres', instanceClass: 'db.r5.large', multiAz: true, encrypted: true }),
        n('s3-app', 'aws_s3', 'aws', 'App Storage', 480, 480, { versioning: true, encryption: true, publicAccess: false }),
        n('s3-media', 'aws_s3', 'aws', 'Media Bucket', 660, 480, { versioning: false, encryption: true, publicAccess: true }),
      ];
      const edges: CanvasEdge[] = [
        e('e1', 'igw', 'alb'), e('e2', 'alb', 'api'), e('e3', 'api', 'rds'),
        e('e4', 'api', 's3-app'), e('e5', 'api', 's3-media'), e('e6', 'nat', 'api'),
      ];
      return { nodes, edges };
    },
  },

  // ─── E-Commerce ─────────────────────────────────────────────────────────────
  {
    id: 'ecommerce',
    name: 'E-Commerce Platform',
    description: 'High-performance e-commerce stack with CDN, caching, and managed database.',
    provider: 'aws',
    category: 'E-Commerce',
    tags: ['aws', 'ecommerce', 'rds', 's3', 'cdn'],
    complexity: 'complex',
    estimatedCost: 580,
    resourceCount: 10,
    features: ['CDN', 'HA database', 'S3 media', 'Security groups', 'NAT Gateway'],
    generate(opts) {
      const nodes: CanvasNode[] = [
        n('vpc', 'aws_vpc', 'aws', 'Commerce VPC', 50, 50, { cidrBlock: '10.0.0.0/16', enableDnsHostnames: true, enableDnsSupport: true }),
        n('igw', 'aws_igw', 'aws', 'Internet Gateway', 720, 50),
        n('alb', 'aws_alb', 'aws', 'Commerce LB', 720, 200, { lbType: 'application', scheme: 'internet-facing' }),
        n('pub1', 'aws_subnet', 'aws', 'Public Subnet', 100, 200, { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a' }),
        n('web', 'aws_ec2', 'aws', 'Web Servers', 200, 350, { instanceType: 'm5.large' }),
        n('api', 'aws_ec2', 'aws', 'API Servers', 450, 350, { instanceType: 'm5.large' }),
        n('nat', 'aws_nat', 'aws', 'NAT Gateway', 720, 350, { connectivityType: 'public' }),
        n('rds', 'aws_rds', 'aws', 'MySQL DB', 300, 500, { engine: 'mysql', instanceClass: 'db.r5.large', multiAz: opts.highAvailability || true, encrypted: true }),
        n('s3', 'aws_s3', 'aws', 'Product Images', 560, 500, { versioning: true, encryption: true, publicAccess: true }),
        n('sg', 'aws_sg', 'aws', 'Commerce SG', 730, 500, { allowHttp: true, allowHttps: true, allowSsh: false }),
      ];
      const edges: CanvasEdge[] = [
        e('e1', 'igw', 'alb'), e('e2', 'alb', 'web'), e('e3', 'web', 'api'),
        e('e4', 'api', 'rds'), e('e5', 'api', 's3'), e('e6', 'nat', 'api'),
      ];
      return { nodes, edges };
    },
  },

  // ─── Microservices ──────────────────────────────────────────────────────────
  {
    id: 'microservices',
    name: 'Microservices Architecture',
    description: 'Container-based microservices with an ALB, multiple service subnets and shared RDS.',
    provider: 'aws',
    category: 'Microservices',
    tags: ['aws', 'microservices', 'containers', 'alb'],
    complexity: 'complex',
    estimatedCost: 520,
    resourceCount: 12,
    features: ['Service isolation', 'Multi-subnet', 'Shared DB', 'ALB routing'],
    generate() {
      const nodes: CanvasNode[] = [
        n('vpc', 'aws_vpc', 'aws', 'Microservices VPC', 50, 50, { cidrBlock: '10.0.0.0/16', enableDnsHostnames: true, enableDnsSupport: true }),
        n('igw', 'aws_igw', 'aws', 'Internet Gateway', 740, 50),
        n('alb', 'aws_alb', 'aws', 'Ingress LB', 740, 200, { lbType: 'application', scheme: 'internet-facing' }),
        n('nat', 'aws_nat', 'aws', 'NAT Gateway', 740, 370),
        n('pub1', 'aws_subnet', 'aws', 'Public Subnet', 80, 200, { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a' }),
        n('svc1', 'aws_ec2', 'aws', 'Auth Service', 80, 370, { instanceType: 't3.medium' }),
        n('svc2', 'aws_ec2', 'aws', 'User Service', 260, 370, { instanceType: 't3.medium' }),
        n('svc3', 'aws_ec2', 'aws', 'Order Service', 440, 370, { instanceType: 't3.medium' }),
        n('svc4', 'aws_ec2', 'aws', 'Payment Service', 620, 370, { instanceType: 't3.medium' }),
        n('sg1', 'aws_sg', 'aws', 'Service SG', 80, 510, { allowHttps: true, allowHttp: false, allowSsh: false }),
        n('rds', 'aws_rds', 'aws', 'Shared Postgres', 260, 510, { engine: 'postgres', instanceClass: 'db.m5.large', multiAz: true, encrypted: true }),
        n('s3', 'aws_s3', 'aws', 'Assets Bucket', 440, 510, { versioning: true, encryption: true, publicAccess: false }),
      ];
      const edges: CanvasEdge[] = [
        e('e1', 'igw', 'alb'), e('e2', 'alb', 'svc1'), e('e3', 'alb', 'svc2'),
        e('e4', 'alb', 'svc3'), e('e5', 'alb', 'svc4'), e('e6', 'svc1', 'rds'),
        e('e7', 'svc2', 'rds'), e('e8', 'svc3', 'rds'), e('e9', 'svc3', 's3'),
      ];
      return { nodes, edges };
    },
  },

  // ─── Data Lake ──────────────────────────────────────────────────────────────
  {
    id: 'data-lake',
    name: 'Data Lake',
    description: 'S3-based data lake with VPC isolation, NAT gateway, and analytics-ready EC2.',
    provider: 'aws',
    category: 'Data & Analytics',
    tags: ['aws', 'data', 'analytics', 's3', 'lake'],
    complexity: 'moderate',
    estimatedCost: 280,
    resourceCount: 9,
    features: ['S3 tiered storage', 'VPC isolation', 'Analytics compute', 'NAT Gateway'],
    generate() {
      const nodes: CanvasNode[] = [
        n('vpc', 'aws_vpc', 'aws', 'Data VPC', 50, 50, { cidrBlock: '10.0.0.0/16', enableDnsHostnames: true, enableDnsSupport: true }),
        n('igw', 'aws_igw', 'aws', 'Internet Gateway', 700, 50),
        n('nat', 'aws_nat', 'aws', 'NAT Gateway', 700, 200),
        n('pub', 'aws_subnet', 'aws', 'Public Subnet', 80, 200, { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a' }),
        n('priv', 'aws_subnet', 'aws', 'Analytics Subnet', 80, 350, { cidrBlock: '10.0.2.0/24', availabilityZone: 'us-east-1a' }),
        n('proc', 'aws_ec2', 'aws', 'ETL Processor', 300, 350, { instanceType: 'm5.xlarge' }),
        n('raw', 'aws_s3', 'aws', 'Raw Data Lake', 500, 220, { versioning: true, encryption: true, publicAccess: false }),
        n('proc-s3', 'aws_s3', 'aws', 'Processed Data', 500, 380, { versioning: true, encryption: true, publicAccess: false }),
        n('sg', 'aws_sg', 'aws', 'Analytics SG', 700, 380, { allowSsh: false, allowHttp: false, allowHttps: false }),
      ];
      const edges: CanvasEdge[] = [
        e('e1', 'igw', 'nat'), e('e2', 'nat', 'proc'), e('e3', 'proc', 'raw'),
        e('e4', 'proc', 'proc-s3'),
      ];
      return { nodes, edges };
    },
  },

  // ─── Azure Microservices ─────────────────────────────────────────────────────
  {
    id: 'azure-microservices',
    name: 'Azure Microservices Platform',
    description: 'Container-based microservices on Azure with VNet, NSG, and managed services.',
    provider: 'azure',
    category: 'Microservices',
    tags: ['azure', 'microservices', 'vnet', 'nsg'],
    complexity: 'complex',
    estimatedCost: 390,
    resourceCount: 10,
    features: ['VNet isolation', 'NSG', 'Azure SQL', 'Blob Storage', 'Load Balancer'],
    generate() {
      const nodes: CanvasNode[] = [
        n('rg', 'azure_resource_group', 'azure', 'Microservices RG', 50, 50, { location: 'eastus' }),
        n('vnet', 'azure_vnet', 'azure', 'Services VNet', 250, 50, { addressSpace: '10.0.0.0/16' }),
        n('sub1', 'azure_subnet', 'azure', 'Services Subnet', 100, 200, { addressPrefix: '10.0.1.0/24' }),
        n('sub2', 'azure_subnet', 'azure', 'Data Subnet', 330, 200, { addressPrefix: '10.0.2.0/24' }),
        n('lb', 'azure_lb', 'azure', 'Service LB', 580, 200, { sku: 'Standard' }),
        n('vm1', 'azure_vm', 'azure', 'API Server 1', 80, 360, { size: 'Standard_D2s_v3', osType: 'Linux', adminUsername: 'azureuser' }),
        n('vm2', 'azure_vm', 'azure', 'API Server 2', 260, 360, { size: 'Standard_D2s_v3', osType: 'Linux', adminUsername: 'azureuser' }),
        n('sql', 'azure_sql', 'azure', 'Azure SQL', 440, 360, { tier: 'Standard', maxSizeGb: 250 }),
        n('storage', 'azure_storage', 'azure', 'Blob Storage', 620, 360, { sku: 'Standard_ZRS', kind: 'StorageV2', httpsOnly: true }),
        n('nsg', 'azure_nsg', 'azure', 'Services NSG', 80, 500, { allowSsh: false, allowRdp: false }),
      ];
      const edges: CanvasEdge[] = [
        e('e1', 'lb', 'vm1'), e('e2', 'lb', 'vm2'), e('e3', 'vm1', 'sql'),
        e('e4', 'vm2', 'sql'), e('e5', 'vm1', 'storage'), e('e6', 'vnet', 'sub1'), e('e7', 'vnet', 'sub2'),
      ];
      return { nodes, edges };
    },
  },

  // ─── Multi-cloud ─────────────────────────────────────────────────────────────
  {
    id: 'multicloud',
    name: 'AWS + Azure Multi-cloud',
    description: 'Workloads spanning AWS and Azure with cross-cloud connectivity.',
    provider: 'multi',
    category: 'Multi-cloud',
    tags: ['multi-cloud', 'aws', 'azure', 'hybrid'],
    complexity: 'complex',
    estimatedCost: 820,
    resourceCount: 14,
    features: ['Cross-cloud', 'VPN-like connections', 'AWS primary', 'Azure secondary'],
    generate() {
      const nodes: CanvasNode[] = [
        // AWS side
        n('aws-vpc', 'aws_vpc', 'aws', 'AWS VPC', 50, 50, { cidrBlock: '10.1.0.0/16', enableDnsHostnames: true, enableDnsSupport: true }),
        n('aws-igw', 'aws_igw', 'aws', 'AWS IGW', 50, 180),
        n('aws-pub', 'aws_subnet', 'aws', 'AWS Public Subnet', 50, 310, { cidrBlock: '10.1.1.0/24', availabilityZone: 'us-east-1a' }),
        n('aws-alb', 'aws_alb', 'aws', 'AWS ALB', 220, 180, { lbType: 'application', scheme: 'internet-facing' }),
        n('aws-ec2', 'aws_ec2', 'aws', 'AWS App Server', 220, 310, { instanceType: 'm5.large' }),
        n('aws-rds', 'aws_rds', 'aws', 'AWS RDS', 220, 450, { engine: 'mysql', instanceClass: 'db.t3.medium', multiAz: true, encrypted: true }),
        n('aws-s3', 'aws_s3', 'aws', 'AWS S3', 400, 180, { versioning: true, encryption: true, publicAccess: false }),
        // Azure side
        n('az-rg', 'azure_resource_group', 'azure', 'Azure Resource Group', 600, 50, { location: 'eastus' }),
        n('az-vnet', 'azure_vnet', 'azure', 'Azure VNet', 600, 180, { addressSpace: '10.2.0.0/16' }),
        n('az-sub', 'azure_subnet', 'azure', 'Azure Subnet', 600, 310, { addressPrefix: '10.2.1.0/24' }),
        n('az-vm', 'azure_vm', 'azure', 'Azure VM', 780, 310, { size: 'Standard_D2s_v3', osType: 'Linux', adminUsername: 'azureuser' }),
        n('az-sql', 'azure_sql', 'azure', 'Azure SQL', 780, 450, { tier: 'Standard', maxSizeGb: 250 }),
        n('az-stor', 'azure_storage', 'azure', 'Azure Storage', 600, 450, { sku: 'Standard_ZRS', kind: 'StorageV2', httpsOnly: true }),
        n('az-nsg', 'azure_nsg', 'azure', 'Azure NSG', 960, 310, { allowSsh: false, allowRdp: false }),
      ];
      const edges: CanvasEdge[] = [
        e('e1', 'aws-igw', 'aws-alb'), e('e2', 'aws-alb', 'aws-ec2'), e('e3', 'aws-ec2', 'aws-rds'),
        e('e4', 'az-vnet', 'az-sub'), e('e5', 'az-vm', 'az-sql'), e('e6', 'az-vm', 'az-stor'),
        // Cross-cloud connection
        e('e7', 'aws-ec2', 'az-vm', 'Cross-cloud'),
        e('e8', 'aws-s3', 'az-stor', 'Data Sync'),
      ];
      return { nodes, edges };
    },
  },

  // ─── Disaster Recovery ───────────────────────────────────────────────────────
  {
    id: 'disaster-recovery',
    name: 'Disaster Recovery',
    description: 'Multi-region DR architecture with primary AWS and standby on Azure.',
    provider: 'multi',
    category: 'Disaster Recovery',
    tags: ['dr', 'multi-region', 'ha', 'backup'],
    complexity: 'complex',
    estimatedCost: 960,
    resourceCount: 12,
    features: ['Multi-region', 'RTO < 1hr', 'RPO < 15min', 'Cross-cloud standby'],
    generate() {
      const nodes: CanvasNode[] = [
        n('p-vpc', 'aws_vpc', 'aws', 'Primary VPC', 50, 50, { cidrBlock: '10.0.0.0/16', enableDnsHostnames: true, enableDnsSupport: true }),
        n('p-alb', 'aws_alb', 'aws', 'Primary ALB', 50, 200, { lbType: 'application', scheme: 'internet-facing' }),
        n('p-ec2', 'aws_ec2', 'aws', 'Primary App', 50, 350, { instanceType: 'm5.large' }),
        n('p-rds', 'aws_rds', 'aws', 'Primary RDS', 50, 480, { engine: 'postgres', instanceClass: 'db.m5.large', multiAz: true, encrypted: true }),
        n('p-s3', 'aws_s3', 'aws', 'Primary Storage', 250, 480, { versioning: true, encryption: true, publicAccess: false }),
        n('p-igw', 'aws_igw', 'aws', 'Primary IGW', 250, 200),
        // DR side
        n('dr-rg', 'azure_resource_group', 'azure', 'DR Resource Group', 550, 50, { location: 'eastus2' }),
        n('dr-vnet', 'azure_vnet', 'azure', 'DR VNet', 550, 200, { addressSpace: '10.10.0.0/16' }),
        n('dr-vm', 'azure_vm', 'azure', 'Standby VM', 550, 350, { size: 'Standard_B2s', osType: 'Linux', adminUsername: 'azureuser' }),
        n('dr-sql', 'azure_sql', 'azure', 'DR Database', 730, 350, { tier: 'Standard', maxSizeGb: 250 }),
        n('dr-stor', 'azure_storage', 'azure', 'DR Storage', 730, 480, { sku: 'Standard_GRS', kind: 'StorageV2', httpsOnly: true }),
        n('dr-nsg', 'azure_nsg', 'azure', 'DR NSG', 550, 480, { allowSsh: false, allowRdp: false }),
      ];
      const edges: CanvasEdge[] = [
        e('e1', 'p-igw', 'p-alb'), e('e2', 'p-alb', 'p-ec2'), e('e3', 'p-ec2', 'p-rds'),
        e('e4', 'p-rds', 'dr-sql', 'DB Replication'), e('e5', 'p-s3', 'dr-stor', 'Geo-Replication'),
        e('e6', 'dr-vm', 'dr-sql'), e('e7', 'dr-vnet', 'dr-vm'),
      ];
      return { nodes, edges };
    },
  },
];

export function getTemplate(id: string): ArchitectureTemplate | undefined {
  return architectureTemplates.find((t) => t.id === id);
}

export function getTemplatesByProvider(provider: CloudProvider): ArchitectureTemplate[] {
  if (provider === 'multi') return architectureTemplates.filter((t) => t.provider === 'multi');
  return architectureTemplates.filter((t) => t.provider === provider || t.provider === 'multi');
}
