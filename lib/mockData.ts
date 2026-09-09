import { Project, Environment, Region, EnvironmentState, ArchitectureVersion, CanvasNode, CanvasEdge } from '@/types';

function emptyEnv(id: Environment, label: string, region: Region): EnvironmentState {
  return { id, label, nodes: [], edges: [], region };
}

const prodNodes1: CanvasNode[] = [
  { id: 'n1', type: 'cloudNode', resourceType: 'aws_vpc', provider: 'aws', label: 'Production VPC', position: { x: 50, y: 50 }, config: { name: 'prod-vpc', cidrBlock: '10.0.0.0/16', enableDnsSupport: true, enableDnsHostnames: true } },
  { id: 'n2', type: 'cloudNode', resourceType: 'aws_subnet', provider: 'aws', label: 'Public Subnet', position: { x: 250, y: 100 }, config: { name: 'public-subnet', cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a', mapPublicIpOnLaunch: true } },
  { id: 'n3', type: 'cloudNode', resourceType: 'aws_subnet', provider: 'aws', label: 'Private Subnet', position: { x: 450, y: 100 }, config: { name: 'private-subnet', cidrBlock: '10.0.2.0/24', availabilityZone: 'us-east-1b', mapPublicIpOnLaunch: false } },
  { id: 'n4', type: 'cloudNode', resourceType: 'aws_ec2', provider: 'aws', label: 'Web Server', position: { x: 250, y: 250 }, config: { name: 'web-server', instanceType: 'm5.large', ami: 'ami-0c55b159cbfafe1f0', keyName: 'prod-key' } },
  { id: 'n5', type: 'cloudNode', resourceType: 'aws_rds', provider: 'aws', label: 'MySQL Database', position: { x: 500, y: 250 }, config: { name: 'prod-db', engine: 'mysql', instanceClass: 'db.t3.medium', multiAz: true, encrypted: true } },
  { id: 'n6', type: 'cloudNode', resourceType: 'aws_alb', provider: 'aws', label: 'App Load Balancer', position: { x: 100, y: 150 }, config: { name: 'prod-alb', lbType: 'application', scheme: 'internet-facing' } },
  { id: 'n7', type: 'cloudNode', resourceType: 'aws_s3', provider: 'aws', label: 'Assets Bucket', position: { x: 650, y: 100 }, config: { name: 'assets-s3', bucketName: 'prod-assets-bucket', versioning: true, encryption: true, publicAccess: false } },
  { id: 'n8', type: 'cloudNode', resourceType: 'aws_sg', provider: 'aws', label: 'Web Security Group', position: { x: 350, y: 350 }, config: { name: 'web-sg', allowSsh: false, allowHttp: true, allowHttps: true } },
];
const prodEdges1: CanvasEdge[] = [
  { id: 'e1', source: 'n6', target: 'n4' },
  { id: 'e2', source: 'n4', target: 'n5' },
  { id: 'e3', source: 'n4', target: 'n7' },
  { id: 'e4', source: 'n1', target: 'n2' },
  { id: 'e5', source: 'n1', target: 'n3' },
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
  { id: 'a1', type: 'cloudNode', resourceType: 'azure_resource_group', provider: 'azure', label: 'Main Resource Group', position: { x: 50, y: 50 }, config: { name: 'microservices-rg', location: 'eastus' } },
  { id: 'a2', type: 'cloudNode', resourceType: 'azure_vnet', provider: 'azure', label: 'App VNet', position: { x: 250, y: 100 }, config: { name: 'app-vnet', addressSpace: '10.0.0.0/16' } },
  { id: 'a3', type: 'cloudNode', resourceType: 'azure_subnet', provider: 'azure', label: 'Services Subnet', position: { x: 450, y: 100 }, config: { name: 'services-subnet', addressPrefix: '10.0.1.0/24' } },
  { id: 'a4', type: 'cloudNode', resourceType: 'azure_vm', provider: 'azure', label: 'API Server', position: { x: 300, y: 250 }, config: { name: 'api-vm', size: 'Standard_D2s_v3', osType: 'Linux', adminUsername: 'azureuser' } },
  { id: 'a5', type: 'cloudNode', resourceType: 'azure_storage', provider: 'azure', label: 'Blob Storage', position: { x: 550, y: 250 }, config: { name: 'mystorageacct', sku: 'Standard_ZRS', kind: 'StorageV2', httpsOnly: true } },
  { id: 'a6', type: 'cloudNode', resourceType: 'azure_nsg', provider: 'azure', label: 'App NSG', position: { x: 150, y: 350 }, config: { name: 'app-nsg', allowSsh: false, allowRdp: false } },
];
const azureEdges: CanvasEdge[] = [
  { id: 'ae1', source: 'a2', target: 'a3' },
  { id: 'ae2', source: 'a3', target: 'a4' },
  { id: 'ae3', source: 'a4', target: 'a5' },
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
