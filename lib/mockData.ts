import { Project, Environment, Region, EnvironmentState, ArchitectureVersion, CanvasNode, CanvasEdge } from '@/types';

function emptyEnv(id: Environment, label: string, region: Region): EnvironmentState {
  return { id, label, nodes: [], edges: [], region };
}

const prodNodes1: CanvasNode[] = [
  { id: 'n1', type: 'containerNode', resourceType: 'aws_vpc', provider: 'aws', label: 'Production VPC', position: { x: 80, y: 310 }, width: 440, height: 720, config: { name: 'prod-vpc', cidrBlock: '10.0.0.0/16', enableDnsSupport: true, enableDnsHostnames: true } },
  { id: 'n2', type: 'containerNode', resourceType: 'aws_subnet', provider: 'aws', label: 'Public Subnet', position: { x: 115, y: 375 }, width: 370, height: 190, groupId: 'n1', config: { name: 'public-subnet', cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: true } },
  { id: 'n3', type: 'containerNode', resourceType: 'aws_subnet', provider: 'aws', label: 'Private App Subnet', position: { x: 115, y: 595 }, width: 370, height: 190, groupId: 'n1', config: { name: 'private-app-subnet', cidrBlock: '10.0.2.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: false } },
  { id: 'n9', type: 'containerNode', resourceType: 'aws_subnet', provider: 'aws', label: 'Private DB Subnet', position: { x: 115, y: 815 }, width: 370, height: 190, groupId: 'n1', config: { name: 'private-db-subnet', cidrBlock: '10.0.3.0/24', availabilityZone: 'us-east-1c', mapPublicIpOnLaunch: false } },
  { id: 'n0', type: 'cloudNode', resourceType: 'aws_internet', provider: 'aws', label: 'Internet', position: { x: 210, y: 30 }, config: { name: 'Internet' } },
  { id: 'n10', type: 'cloudNode', resourceType: 'aws_cloudfront', provider: 'aws', label: 'CloudFront', position: { x: 210, y: 160 }, config: { name: 'my-cdn' } },
  { id: 'n6', type: 'cloudNode', resourceType: 'aws_alb', provider: 'aws', label: 'App Load Balancer', position: { x: 210, y: 430 }, groupId: 'n2', config: { name: 'prod-alb', lbType: 'application', scheme: 'internet-facing' } },
  { id: 'n4', type: 'cloudNode', resourceType: 'aws_ec2', provider: 'aws', label: 'App Web Server', position: { x: 210, y: 650 }, groupId: 'n3', config: { name: 'app-web-server', instanceType: 'm5.large', ami: 'ami-0c55b159cbfafe1f0', keyName: 'prod-key' } },
  { id: 'n5', type: 'cloudNode', resourceType: 'aws_rds', provider: 'aws', label: 'Production DB Server', position: { x: 210, y: 870 }, groupId: 'n9', config: { name: 'prod-db', engine: 'mysql', instanceClass: 'db.t3.medium', multiAz: true, encrypted: true } },
  { id: 'n7', type: 'cloudNode', resourceType: 'aws_s3', provider: 'aws', label: 'Assets Bucket', position: { x: 580, y: 430 }, config: { name: 'assets-s3', bucketName: 'prod-assets-bucket', versioning: true, encryption: true, publicAccess: false } },
  { id: 'n8', type: 'cloudNode', resourceType: 'aws_sg', provider: 'aws', label: 'Web Security Group', position: { x: 580, y: 650 }, config: { name: 'web-sg', allowSsh: false, allowHttp: true, allowHttps: true } },
];
const prodEdges1: CanvasEdge[] = [
  { id: 'e0', source: 'n0', target: 'n10', label: 'HTTPS / 443', edgeType: 'NETWORK_FLOW', relationshipType: 'NETWORK_FLOW', protocol: 'HTTPS', port: 443, networkScope: 'public' },
  { id: 'e1', source: 'n10', target: 'n6', label: 'Origin HTTP/S', edgeType: 'ROUTES_TO', relationshipType: 'ROUTES_TO', protocol: 'HTTPS', port: 443, networkScope: 'public' },
  { id: 'e2', source: 'n6', target: 'n4', label: 'HTTP / 80', edgeType: 'LOAD_BALANCES', relationshipType: 'LOAD_BALANCES', protocol: 'HTTP', port: 80, networkScope: 'private' },
  { id: 'e3', source: 'n4', target: 'n5', label: 'Port 5432', edgeType: 'CONNECTS_TO', relationshipType: 'CONNECTS_TO', protocol: 'PostgreSQL', port: 5432, networkScope: 'private' },
  { id: 'e4', source: 'n4', target: 'n7', label: 'S3 API / IAM', edgeType: 'STORES_IN', relationshipType: 'STORES_IN', protocol: 'HTTPS', port: 443, networkScope: 'private' },
];

const v1: ArchitectureVersion = {
  id: 'v1', version: 1, label: 'Initial architecture', timestamp: '2024-11-01T10:00:00Z',
  author: 'Alice Chen', summary: 'Initial VPC, EC2, and RDS setup',
  nodes: prodNodes1.slice(0, 4), edges: prodEdges1.slice(0, 2),
};
const v2: ArchitectureVersion = {
  id: 'v2', version: 2, label: 'Added S3 and Security Group', timestamp: '2024-11-15T14:00:00Z',
  author: 'Alice Chen', summary: 'Added Assets Bucket and Web Security Group',
  nodes: prodNodes1.slice(0, 6), edges: prodEdges1.slice(0, 4),
};
const v3: ArchitectureVersion = {
  id: 'v3', version: 3, label: 'Production-ready', timestamp: '2024-12-15T14:32:00Z',
  author: 'Bob Smith', summary: 'Added ALB, enabled Multi-AZ RDS, encryption',
  nodes: prodNodes1, edges: prodEdges1,
};

const azureNodes: CanvasNode[] = [
  { id: 'a1', type: 'containerNode', resourceType: 'azure_resource_group', provider: 'azure', label: 'Main Resource Group', position: { x: 50, y: 50 }, width: 840, height: 540, config: { name: 'microservices-rg', location: 'eastus' } },
  { id: 'a2', type: 'containerNode', resourceType: 'azure_vnet', provider: 'azure', label: 'App VNet', position: { x: 80, y: 110 }, width: 780, height: 440, groupId: 'a1', config: { name: 'app-vnet', addressSpace: '10.0.0.0/16' } },
  { id: 'a3', type: 'containerNode', resourceType: 'azure_subnet', provider: 'azure', label: 'Services Subnet', position: { x: 110, y: 170 }, width: 340, height: 240, groupId: 'a2', config: { name: 'services-subnet', addressPrefix: '10.0.1.0/24' } },
  { id: 'a7', type: 'cloudNode', resourceType: 'azure_lb', provider: 'azure', label: 'App Load Balancer', position: { x: 480, y: 180 }, groupId: 'a2', config: { name: 'app-lb', sku: 'Standard' } },
  { id: 'a4', type: 'cloudNode', resourceType: 'azure_vm', provider: 'azure', label: 'API Server', position: { x: 180, y: 240 }, groupId: 'a3', config: { name: 'api-vm', size: 'Standard_D2s_v3', osType: 'Linux', adminUsername: 'azureuser' } },
  { id: 'a5', type: 'cloudNode', resourceType: 'azure_storage', provider: 'azure', label: 'Blob Storage', position: { x: 520, y: 320 }, groupId: 'a1', config: { name: 'mystorageacct', sku: 'Standard_ZRS', kind: 'StorageV2', httpsOnly: true } },
  { id: 'a6', type: 'cloudNode', resourceType: 'azure_nsg', provider: 'azure', label: 'App NSG', position: { x: 680, y: 180 }, groupId: 'a1', config: { name: 'app-nsg', allowSsh: false, allowRdp: false } },
];
const azureEdges: CanvasEdge[] = [
  { id: 'ae1', source: 'a7', target: 'a4', label: 'Balance HTTP / 80', edgeType: 'LOAD_BALANCES', relationshipType: 'LOAD_BALANCES', protocol: 'HTTP', port: 80, networkScope: 'private' },
  { id: 'ae2', source: 'a4', target: 'a5', label: 'Blob HTTPS / 443', edgeType: 'STORES_IN', relationshipType: 'STORES_IN', protocol: 'HTTPS', port: 443, networkScope: 'private' },
];

export const mockProjects: Project[] = [
  {
    id: 'proj-1',
    name: 'Production Web App',
    provider: 'aws',
    description: 'Multi-tier web application with ALB, EC2 Auto Scaling, and RDS',
    createdAt: '2024-11-01T10:00:00Z',
    updatedAt: '2024-12-15T14:32:00Z',
    resourceCount: 8,
    securityScore: 74,
    architectureScore: 81,
    estimatedMonthlyCost: 312.45,
    environment: 'production',
    region: 'us-east-1',
    tags: ['production', 'web', 'rds'],
    versions: [v1, v2, v3],
    environments: {
      production: { id: 'production', label: 'Production', nodes: prodNodes1, edges: prodEdges1, region: 'us-east-1' },
      staging: { id: 'staging', label: 'Staging', nodes: prodNodes1.slice(0, 5), edges: prodEdges1.slice(0, 3), region: 'us-east-2' },
      development: { id: 'development', label: 'Development', nodes: prodNodes1.slice(0, 3), edges: prodEdges1.slice(0, 2), region: 'us-east-2' },
    },
    nodes: prodNodes1,
    edges: prodEdges1,
  },
  {
    id: 'proj-2',
    name: 'Azure Microservices',
    provider: 'azure',
    description: 'Containerized microservices on Azure with VNet and NSG',
    createdAt: '2024-10-10T09:00:00Z',
    updatedAt: '2024-12-10T16:20:00Z',
    resourceCount: 6,
    securityScore: 88,
    architectureScore: 79,
    estimatedMonthlyCost: 189.75,
    environment: 'production',
    region: 'eastus',
    tags: ['azure', 'microservices'],
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
