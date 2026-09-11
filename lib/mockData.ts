import { Project, Environment, Region, EnvironmentState, ArchitectureVersion, CanvasNode, CanvasEdge } from '@/types';

function emptyEnv(id: Environment, label: string, region: Region): EnvironmentState {
  return { id, label, nodes: [], edges: [], region };
}

// ── AWS 1,000-User Production Reference Architecture (Multi-AZ) ──────────────
const prodNodes1: CanvasNode[] = [
  // ── 1. Cloud Provider Boundary
  {
    id: 'aws-cloud',
    type: 'cloudProviderNode',
    resourceType: 'aws_cloud_boundary',
    provider: 'aws',
    label: 'Amazon Web Services (us-east-1)',
    position: { x: 40, y: 20 },
    width: 1460,
    height: 1120,
    config: { region: 'us-east-1' },
  },

  // ── 2. Global / Regional Ingress Pipeline
  {
    id: 'n0',
    type: 'cloudNode',
    resourceType: 'aws_internet',
    provider: 'aws',
    label: 'Public Internet',
    position: { x: 120, y: 80 },
    groupId: 'aws-cloud',
    config: { name: 'Internet' },
  },
  {
    id: 'r53',
    type: 'cloudNode',
    resourceType: 'aws_route53',
    provider: 'aws',
    label: 'Route 53 DNS',
    position: { x: 340, y: 80 },
    groupId: 'aws-cloud',
    config: { domainName: 'cloudcraft.app' },
  },
  {
    id: 'n10',
    type: 'cloudNode',
    resourceType: 'aws_cloudfront',
    provider: 'aws',
    label: 'CloudFront CDN',
    position: { x: 560, y: 80 },
    groupId: 'aws-cloud',
    config: { priceClass: 'PriceClass_100', defaultRootObject: 'index.html' },
  },
  {
    id: 'waf',
    type: 'cloudNode',
    resourceType: 'aws_waf',
    provider: 'aws',
    label: 'AWS WAF WebACL',
    position: { x: 780, y: 80 },
    groupId: 'aws-cloud',
    config: { scope: 'CLOUDFRONT', defaultAction: 'ALLOW' },
  },

  // ── 3. Regional Storage & Security (Flank, Outside VPC)
  {
    id: 'n7',
    type: 'cloudNode',
    resourceType: 'aws_s3',
    provider: 'aws',
    label: 'Assets S3 Vault',
    position: { x: 1190, y: 380 },
    groupId: 'aws-cloud',
    config: { name: 'prod-assets-vault', bucketName: 'cloudcraft-prod-assets-vault', versioning: true, encryption: true, publicAccess: false },
  },

  // ── 4. Production VPC
  {
    id: 'n1',
    type: 'containerNode',
    resourceType: 'aws_vpc',
    provider: 'aws',
    label: 'Production VPC (10.0.0.0/16)',
    position: { x: 80, y: 200 },
    width: 1060,
    height: 760,
    groupId: 'aws-cloud',
    config: { name: 'prod-vpc', cidrBlock: '10.0.0.0/16', enableDnsSupport: true, enableDnsHostnames: true },
  },

  // ── 5. Public Subnets Tier (AZ-A & AZ-B)
  {
    id: 'n2',
    type: 'containerNode',
    resourceType: 'aws_subnet',
    provider: 'aws',
    label: 'Public Subnet AZ-A (10.0.1.0/24)',
    position: { x: 120, y: 270 },
    width: 470,
    height: 190,
    groupId: 'n1',
    config: { name: 'public-subnet-a', cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: true },
  },
  {
    id: 'pub2',
    type: 'containerNode',
    resourceType: 'aws_subnet',
    provider: 'aws',
    label: 'Public Subnet AZ-B (10.0.2.0/24)',
    position: { x: 630, y: 270 },
    width: 470,
    height: 190,
    groupId: 'n1',
    config: { name: 'public-subnet-b', cidrBlock: '10.0.2.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: true },
  },
  {
    id: 'n6',
    type: 'cloudNode',
    resourceType: 'aws_alb',
    provider: 'aws',
    label: 'App Load Balancer (Multi-AZ)',
    position: { x: 150, y: 330 },
    groupId: 'n2',
    config: { name: 'prod-alb', lbType: 'application', scheme: 'internet-facing' },
  },
  {
    id: 'nat-a',
    type: 'cloudNode',
    resourceType: 'aws_nat',
    provider: 'aws',
    label: 'NAT Gateway AZ-A',
    position: { x: 370, y: 330 },
    groupId: 'n2',
    config: { connectivityType: 'public' },
  },
  {
    id: 'nat-b',
    type: 'cloudNode',
    resourceType: 'aws_nat',
    provider: 'aws',
    label: 'NAT Gateway AZ-B',
    position: { x: 880, y: 330 },
    groupId: 'pub2',
    config: { connectivityType: 'public' },
  },

  // ── 6. Private Application Subnets Tier (AZ-A & AZ-B)
  {
    id: 'n3',
    type: 'containerNode',
    resourceType: 'aws_subnet',
    provider: 'aws',
    label: 'Private App Subnet AZ-A (10.0.10.0/24)',
    position: { x: 120, y: 490 },
    width: 470,
    height: 190,
    groupId: 'n1',
    config: { name: 'private-app-subnet-a', cidrBlock: '10.0.10.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: false },
  },
  {
    id: 'app-sub-b',
    type: 'containerNode',
    resourceType: 'aws_subnet',
    provider: 'aws',
    label: 'Private App Subnet AZ-B (10.0.11.0/24)',
    position: { x: 630, y: 490 },
    width: 470,
    height: 190,
    groupId: 'n1',
    config: { name: 'private-app-subnet-b', cidrBlock: '10.0.11.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: false },
  },
  {
    id: 'n4',
    type: 'cloudNode',
    resourceType: 'aws_ec2',
    provider: 'aws',
    label: 'App Server AZ-A',
    position: { x: 260, y: 550 },
    groupId: 'n3',
    config: { name: 'app-srv-a', instanceType: 't3.medium', keyName: 'prod-key', encrypted: true },
  },
  {
    id: 'app-srv-b',
    type: 'cloudNode',
    resourceType: 'aws_ec2',
    provider: 'aws',
    label: 'App Server AZ-B',
    position: { x: 770, y: 550 },
    groupId: 'app-sub-b',
    config: { name: 'app-srv-b', instanceType: 't3.medium', keyName: 'prod-key', encrypted: true },
  },

  // ── 7. Private Database Subnets Tier (AZ-A & AZ-B)
  {
    id: 'n9',
    type: 'containerNode',
    resourceType: 'aws_subnet',
    provider: 'aws',
    label: 'Private DB Subnet AZ-A (10.0.20.0/24)',
    position: { x: 120, y: 710 },
    width: 470,
    height: 190,
    groupId: 'n1',
    config: { name: 'private-db-subnet-a', cidrBlock: '10.0.20.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: false },
  },
  {
    id: 'db-sub-b',
    type: 'containerNode',
    resourceType: 'aws_subnet',
    provider: 'aws',
    label: 'Private DB Subnet AZ-B (10.0.21.0/24)',
    position: { x: 630, y: 710 },
    width: 470,
    height: 190,
    groupId: 'n1',
    config: { name: 'private-db-subnet-b', cidrBlock: '10.0.21.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: false },
  },
  {
    id: 'n5',
    type: 'cloudNode',
    resourceType: 'aws_rds',
    provider: 'aws',
    label: 'RDS PostgreSQL (Multi-AZ)',
    position: { x: 260, y: 770 },
    groupId: 'n9',
    config: { name: 'prod-db', engine: 'postgres', instanceClass: 'db.t3.medium', multiAz: true, encrypted: true },
  },
  {
    id: 'redis',
    type: 'cloudNode',
    resourceType: 'aws_elasticache',
    provider: 'aws',
    label: 'ElastiCache Redis HA',
    position: { x: 770, y: 770 },
    groupId: 'db-sub-b',
    config: { name: 'prod-redis', numNodes: 2 },
  },
];

const prodEdges1: CanvasEdge[] = [
  // Ingress Flow
  { id: 'n0:NETWORK_FLOW:r53', source: 'n0', target: 'r53', label: 'DNS Query', edgeType: 'NETWORK_FLOW', relationshipType: 'NETWORK_FLOW', protocol: 'DNS', port: 53, networkScope: 'public' },
  { id: 'r53:RESOLVES_TO:n10', source: 'r53', target: 'n10', label: 'DNS Alias', edgeType: 'RESOLVES_TO', relationshipType: 'RESOLVES_TO', protocol: 'HTTPS', port: 443, networkScope: 'public' },
  { id: 'waf:ASSOCIATED_WITH:n10', source: 'waf', target: 'n10', label: 'WAF Protection', edgeType: 'ASSOCIATED_WITH', relationshipType: 'ASSOCIATED_WITH', networkScope: 'internal' },
  { id: 'n10:ROUTES_TO:n6', source: 'n10', target: 'n6', label: 'Origin HTTPS / 443', edgeType: 'ROUTES_TO', relationshipType: 'ROUTES_TO', protocol: 'HTTPS', port: 443, networkScope: 'public' },

  // Multi-AZ Load Balancing
  { id: 'n6:LOAD_BALANCES:n4', source: 'n6', target: 'n4', label: 'Balance HTTP / 80', edgeType: 'LOAD_BALANCES', relationshipType: 'LOAD_BALANCES', protocol: 'HTTP', port: 80, networkScope: 'private' },
  { id: 'n6:LOAD_BALANCES:app-srv-b', source: 'n6', target: 'app-srv-b', label: 'Balance HTTP / 80', edgeType: 'LOAD_BALANCES', relationshipType: 'LOAD_BALANCES', protocol: 'HTTP', port: 80, networkScope: 'private' },

  // Compute to Database (PostgreSQL :5432)
  { id: 'n4:CONNECTS_TO:n5', source: 'n4', target: 'n5', label: 'PostgreSQL / 5432', edgeType: 'CONNECTS_TO', relationshipType: 'CONNECTS_TO', protocol: 'PostgreSQL', port: 5432, networkScope: 'private' },
  { id: 'app-srv-b:CONNECTS_TO:n5', source: 'app-srv-b', target: 'n5', label: 'PostgreSQL / 5432', edgeType: 'CONNECTS_TO', relationshipType: 'CONNECTS_TO', protocol: 'PostgreSQL', port: 5432, networkScope: 'private' },

  // Compute to Redis (:6379)
  { id: 'n4:CONNECTS_TO:redis', source: 'n4', target: 'redis', label: 'Redis / 6379', edgeType: 'CONNECTS_TO', relationshipType: 'CONNECTS_TO', protocol: 'Redis', port: 6379, networkScope: 'private' },
  { id: 'app-srv-b:CONNECTS_TO:redis', source: 'app-srv-b', target: 'redis', label: 'Redis / 6379', edgeType: 'CONNECTS_TO', relationshipType: 'CONNECTS_TO', protocol: 'Redis', port: 6379, networkScope: 'private' },

  // Compute to S3 Vault
  { id: 'n4:STORES_IN:n7', source: 'n4', target: 'n7', label: 'S3 API / HTTPS', edgeType: 'STORES_IN', relationshipType: 'STORES_IN', protocol: 'HTTPS', port: 443, networkScope: 'private' },
  { id: 'app-srv-b:STORES_IN:n7', source: 'app-srv-b', target: 'n7', label: 'S3 API / HTTPS', edgeType: 'STORES_IN', relationshipType: 'STORES_IN', protocol: 'HTTPS', port: 443, networkScope: 'private' },
];

const v1: ArchitectureVersion = {
  id: 'v1', version: 1, label: 'Initial architecture', timestamp: '2024-11-01T10:00:00Z',
  author: 'Alice Chen', summary: 'Initial VPC, EC2, and RDS setup',
  nodes: prodNodes1.slice(0, 6), edges: prodEdges1.slice(0, 4),
};
const v2: ArchitectureVersion = {
  id: 'v2', version: 2, label: 'Added S3 and Cache', timestamp: '2024-11-15T14:00:00Z',
  author: 'Alice Chen', summary: 'Added Assets S3 Vault and ElastiCache Redis',
  nodes: prodNodes1.slice(0, 10), edges: prodEdges1.slice(0, 8),
};
const v3: ArchitectureVersion = {
  id: 'v3', version: 3, label: 'Production-ready 1,000-User Multi-AZ', timestamp: '2024-12-15T14:32:00Z',
  author: 'Bob Smith', summary: 'Added Multi-AZ subnets, ALB, RDS Multi-AZ, and Route 53',
  nodes: prodNodes1, edges: prodEdges1,
};

// ── Azure Production 1,000-User Reference Architecture ────────────────────────
const azureNodes: CanvasNode[] = [
  { id: 'az-cloud', type: 'cloudProviderNode', resourceType: 'azure_cloud_boundary', provider: 'azure', label: 'Microsoft Azure (East US)', position: { x: 40, y: 20 }, width: 1100, height: 880, config: { region: 'eastus' } },
  { id: 'az-fd', type: 'cloudNode', resourceType: 'azure_front_door', provider: 'azure', label: 'Azure Front Door', position: { x: 360, y: 70 }, groupId: 'az-cloud', config: { sku: 'Standard_AzureFrontDoor' } },
  { id: 'az-waf', type: 'cloudNode', resourceType: 'azure_waf', provider: 'azure', label: 'Azure WAF Policy', position: { x: 620, y: 70 }, groupId: 'az-cloud', config: { mode: 'Prevention' } },
  { id: 'az-rg', type: 'containerNode', resourceType: 'azure_resource_group', provider: 'azure', label: 'Production Resource Group', position: { x: 80, y: 170 }, width: 1020, height: 690, groupId: 'az-cloud', config: { location: 'eastus' } },
  { id: 'az-vnet', type: 'containerNode', resourceType: 'azure_vnet', provider: 'azure', label: 'Production VNet (10.0.0.0/16)', position: { x: 100, y: 230 }, width: 980, height: 610, groupId: 'az-rg', config: { addressSpace: '10.0.0.0/16' } },
  { id: 'az-sub-ingress', type: 'containerNode', resourceType: 'azure_subnet', provider: 'azure', label: 'Ingress Subnet (10.0.1.0/24)', position: { x: 130, y: 280 }, width: 920, height: 150, groupId: 'az-vnet', config: { addressPrefix: '10.0.1.0/24' } },
  { id: 'az-agw', type: 'cloudNode', resourceType: 'azure_app_gateway', provider: 'azure', label: 'Application Gateway (WAF v2)', position: { x: 460, y: 330 }, groupId: 'az-sub-ingress', config: { sku: 'WAF_v2' } },
  { id: 'az-sub-app', type: 'containerNode', resourceType: 'azure_subnet', provider: 'azure', label: 'App Workload Subnet (10.0.10.0/24)', position: { x: 130, y: 460 }, width: 920, height: 170, groupId: 'az-vnet', config: { addressPrefix: '10.0.10.0/24' } },
  { id: 'az-vmss', type: 'cloudNode', resourceType: 'azure_vmss', provider: 'azure', label: 'App VM Scale Set (VMSS)', position: { x: 460, y: 520 }, groupId: 'az-sub-app', config: { sku: 'Standard_B2s', capacity: 3 } },
  { id: 'az-sub-data', type: 'containerNode', resourceType: 'azure_subnet', provider: 'azure', label: 'Data Tier Subnet (10.0.20.0/24)', position: { x: 130, y: 650 }, width: 920, height: 170, groupId: 'az-vnet', config: { addressPrefix: '10.0.20.0/24' } },
  { id: 'az-sql-ha', type: 'cloudNode', resourceType: 'azure_sql', provider: 'azure', label: 'Azure SQL (Zone Redundant)', position: { x: 280, y: 710 }, groupId: 'az-sub-data', config: { tier: 'GeneralPurpose', zoneRedundant: true } },
  { id: 'az-redis', type: 'cloudNode', resourceType: 'azure_redis', provider: 'azure', label: 'Azure Cache for Redis', position: { x: 680, y: 710 }, groupId: 'az-sub-data', config: { sku: 'Standard' } },
  { id: 'az-blob', type: 'cloudNode', resourceType: 'azure_storage', provider: 'azure', label: 'Blob Storage Account', position: { x: 860, y: 70 }, groupId: 'az-cloud', config: { sku: 'Standard_ZRS', httpsOnly: true } },
];

const azureEdges: CanvasEdge[] = [
  { id: 'az-waf:ASSOCIATED_WITH:az-fd', source: 'az-waf', target: 'az-fd', label: 'WAF Policy Attached', edgeType: 'ASSOCIATED_WITH', relationshipType: 'ASSOCIATED_WITH', networkScope: 'internal' },
  { id: 'az-fd:ROUTES_TO:az-agw', source: 'az-fd', target: 'az-agw', label: 'Backend Pool HTTPS / 443', edgeType: 'ROUTES_TO', relationshipType: 'ROUTES_TO', protocol: 'HTTPS', port: 443, networkScope: 'public' },
  { id: 'az-agw:LOAD_BALANCES:az-vmss', source: 'az-agw', target: 'az-vmss', label: 'Balance HTTP / 80', edgeType: 'LOAD_BALANCES', relationshipType: 'LOAD_BALANCES', protocol: 'HTTP', port: 80, networkScope: 'private' },
  { id: 'az-vmss:CONNECTS_TO:az-sql-ha', source: 'az-vmss', target: 'az-sql-ha', label: 'TDS / 1433', edgeType: 'CONNECTS_TO', relationshipType: 'CONNECTS_TO', protocol: 'TDS', port: 1433, networkScope: 'private' },
  { id: 'az-vmss:CONNECTS_TO:az-redis', source: 'az-vmss', target: 'az-redis', label: 'Redis TLS / 6380', edgeType: 'CONNECTS_TO', relationshipType: 'CONNECTS_TO', protocol: 'Redis TLS', port: 6380, networkScope: 'private' },
  { id: 'az-vmss:STORES_IN:az-blob', source: 'az-vmss', target: 'az-blob', label: 'Blob HTTPS / 443', edgeType: 'STORES_IN', relationshipType: 'STORES_IN', protocol: 'HTTPS', port: 443, networkScope: 'private' },
];

export const mockProjects: Project[] = [
  {
    id: 'proj-1',
    name: 'Production Web App (1,000-User HA)',
    provider: 'aws',
    description: 'Multi-tier AWS production architecture with Route 53, CloudFront CDN, WAF, ALB, Multi-AZ EC2, and RDS Multi-AZ',
    createdAt: '2024-11-01T10:00:00Z',
    updatedAt: '2024-12-15T14:32:00Z',
    resourceCount: prodNodes1.length,
    securityScore: 92,
    architectureScore: 95,
    estimatedMonthlyCost: 385.50,
    environment: 'production',
    region: 'us-east-1',
    tags: ['production', 'web', 'multi-az', '1000-users'],
    versions: [v1, v2, v3],
    environments: {
      production: { id: 'production', label: 'Production', nodes: prodNodes1, edges: prodEdges1, region: 'us-east-1' },
      staging: { id: 'staging', label: 'Staging', nodes: prodNodes1.slice(0, 10), edges: prodEdges1.slice(0, 6), region: 'us-east-2' },
      development: { id: 'development', label: 'Development', nodes: prodNodes1.slice(0, 6), edges: prodEdges1.slice(0, 3), region: 'us-east-2' },
    },
    nodes: prodNodes1,
    edges: prodEdges1,
  },
  {
    id: 'proj-2',
    name: 'Azure Microservices (1,000-User HA)',
    provider: 'azure',
    description: 'Production-ready Azure architecture with Front Door, WAF, App Gateway, VMSS, and Zone Redundant Azure SQL',
    createdAt: '2024-10-10T09:00:00Z',
    updatedAt: '2024-12-10T16:20:00Z',
    resourceCount: azureNodes.length,
    securityScore: 90,
    architectureScore: 92,
    estimatedMonthlyCost: 410.25,
    environment: 'production',
    region: 'eastus',
    tags: ['azure', 'microservices', '1000-users', 'zone-redundant'],
    versions: [],
    environments: {
      production: { id: 'production', label: 'Production', nodes: azureNodes, edges: azureEdges, region: 'eastus' },
      staging: emptyEnv('staging', 'Staging', 'eastus2'),
      development: emptyEnv('development', 'Development', 'eastus2'),
    },
    nodes: azureNodes,
    edges: azureEdges,
  },
  {
    id: 'proj-3',
    name: 'Data Lake Architecture',
    provider: 'aws',
    description: 'S3-based data lake with VPC isolation and NAT gateway',
    createdAt: '2024-09-15T08:00:00Z',
    updatedAt: '2024-11-30T11:45:00Z',
    resourceCount: 0,
    securityScore: 100,
    architectureScore: 0,
    estimatedMonthlyCost: 0,
    environment: 'staging',
    region: 'us-west-2',
    tags: ['data', 'analytics', 'aws'],
    versions: [],
    environments: {
      production: emptyEnv('production', 'Production', 'us-west-2'),
      staging: emptyEnv('staging', 'Staging', 'us-west-2'),
      development: emptyEnv('development', 'Development', 'us-west-2'),
    },
    nodes: [],
    edges: [],
  },
];

export function getProject(id: string): Project | undefined {
  return mockProjects.find((p) => p.id === id);
}

export function saveProject(project: Project): void {
  const idx = mockProjects.findIndex((p) => p.id === project.id);
  if (idx >= 0) mockProjects[idx] = project;
  else mockProjects.push(project);
}
