import OpenAI from 'openai';
import { awsResources } from '../resources/aws';
import { azureResources } from '../resources/azure';
import { db } from '../../src/prisma/db';
import { QuestionnaireResult, QuestionnaireAnswers, ArchitectureQuestion, IdentifiedGap } from '@/types';

// Azure AI Foundry's "v1" API is OpenAI-SDK-compatible: point the standard
// client at "<endpoint>/openai/v1" with the resource's API key and call
// client.responses.create(...) exactly as against OpenAI itself — no
// Azure-specific client class or api-version query param needed. The env var
// holds the full deployment URL as copied from the Foundry portal (ending in
// "/responses"); strip that suffix to get the SDK's base URL.
function foundryBaseURL(): string {
  const endpoint = process.env.AZURE_AI_FOUNDRY_ENDPOINT ?? '';
  return endpoint.replace(/\/responses\/?$/, '');
}

let _client: OpenAI | null = null;
function foundryClient(): OpenAI {
  if (!_client) {
    const baseURL = foundryBaseURL();
    const apiKey = process.env.AZURE_AI_FOUNDRY_API_KEY;
    if (!baseURL || !apiKey) {
      throw new Error(
        'Azure AI Foundry is not configured — set AZURE_AI_FOUNDRY_ENDPOINT and AZURE_AI_FOUNDRY_API_KEY.'
      );
    }
    _client = new OpenAI({ baseURL, apiKey });
  }
  return _client;
}

const FOUNDRY_MODEL = process.env.AZURE_AI_FOUNDRY_DEPLOYMENT || 'gpt-4o';

/** Shape of the JSON graph the LLM is prompted to emit — unverified until validateAgainstRde runs. */
interface RawAiResource {
  id: string;
  resourceType: string;
  label?: string;
  config?: Record<string, unknown>;
  parentId?: string | null;
}

interface RawAiConnection {
  sourceId: string;
  targetId: string;
  label?: string;
}

interface RawAiGraph {
  resources?: RawAiResource[];
  connections?: RawAiConnection[];
}

// Distilled from the app's own scoring engines — lib/engines/assessment/rules/{aws,azure}.ts
// (CRITICAL/HIGH security findings) and lib/engines/validation/ArchitectureValidator.ts
// (availability/SPOF/structural findings). Generating architectures that already satisfy
// these means they land on the canvas with a high security/quality score and few Auto-Fix
// findings, instead of the user having to fix AI output by hand. Keep this in sync when a
// new CRITICAL/HIGH rule is added to either rules file — re-run the extraction described in
// that file's history if this list goes stale.
const QUALITY_GUIDELINES: Record<'aws' | 'azure' | 'common', string[]> = {
  common: [
    'Never design a single point of failure: no single compute instance serving production traffic (use ≥2 instances or an auto-scaling group behind a load balancer), no single-AZ deployment (spread across ≥2 availability zones/subnets), no non-HA database tier.',
    'Front any internet-facing compute tier with a load balancer; add a WAF if the workload is public-facing.',
    'Add a caching layer (e.g. Redis/ElastiCache, Azure Cache for Redis) for typical web/API workloads, and a CDN in front of static assets.',
    'Every nested resource needs a correct parentId pointing to an existing container resource of the same cloud provider (e.g. a subnet\'s parentId is its VPC/VNet\'s id) — never nest a resource under a container from the other provider.',
    'Enable encryption at rest by default on every storage/database resource unless the user explicitly asks otherwise.',
    'Set backup/retention config to at least 7 days on databases that support it.',
  ],
  aws: [
    'S3 buckets: publicAccess=false with all four Block Public Access settings on, unless the user explicitly wants a public bucket (then front it with CloudFront + OAC instead of a public bucket).',
    'RDS: publiclyAccessible=false, storageEncrypted=true, multiAZ=true for production, backup retention ≥7 days.',
    'EC2: require IMDSv2 (metadata options httpTokens=required).',
    'Security groups: never allow inbound 22 (SSH) or 3389 (RDP) from 0.0.0.0/0 — omit the rule or scope it to a specific admin CIDR.',
    'EKS: disable/restrict the public API endpoint (private endpoint access, or restrict public access CIDRs).',
    'ECS: do not auto-assign public IPs to tasks — run them in private subnets behind a load balancer.',
    'IAM: never attach AdministratorAccess — scope roles to least privilege for what the workload actually needs.',
  ],
  azure: [
    'Storage accounts: require secure transfer, and disallow anonymous blob access (serve public content via Front Door/CDN with a private origin or SAS instead).',
    'Azure SQL: disable public network access (use a private endpoint) and enable Transparent Data Encryption.',
    'Cosmos DB: disable public network access, use private endpoints.',
    'NSGs: never allow inbound 22 (SSH) or 3389 (RDP) from any source — omit the rule or scope it to a specific admin range.',
    'AKS: enable Kubernetes RBAC with Entra integration.',
  ],
};

function buildQualityGuidelines(provider: 'aws' | 'azure'): string {
  const bullets = [...QUALITY_GUIDELINES.common, ...QUALITY_GUIDELINES[provider]];
  return bullets.map((b) => `- ${b}`).join('\n');
}

/**
 * Validates and filters AI-generated graph output against the RDE catalog.
 * Rejects any resource whose type is not in the supported catalog.
 * Returns { validated: graph, rejected: string[] } where rejected lists unsupported types.
 */
function validateAgainstRde(
  graph: RawAiGraph,
  validTypes: Set<string>
): { resources: RawAiResource[]; connections: RawAiConnection[]; rejected: string[] } {
  const rejected: string[] = [];
  const validResources = (graph.resources ?? []).filter((r) => {
    if (!validTypes.has(r.resourceType)) {
      rejected.push(r.resourceType);
      return false;
    }
    return true;
  });

  const validIds = new Set(validResources.map((r) => r.id));
  const validConnections = (graph.connections ?? []).filter(
    (c) => validIds.has(c.sourceId) && validIds.has(c.targetId)
  );

  return { resources: validResources, connections: validConnections, rejected };
}

/**
 * Robust fallback heuristic generator that generates smart, contextual questions
 * and flags architectural gaps even if Azure AI Foundry is unreachable or offline.
 */
function getHeuristicQuestionnaire(prompt: string, provider: 'aws' | 'azure'): QuestionnaireResult {
  const lower = prompt.toLowerCase();
  const isAws = provider === 'aws';

  const gaps: IdentifiedGap[] = [];
  const questions: ArchitectureQuestion[] = [];

  // Gap 1: Traffic Scale & Auto-scaling
  gaps.push({
    id: 'gap-scale',
    title: 'Workload Traffic & Scaling Strategy Unspecified',
    description: 'The initial request does not specify expected concurrency or whether auto-scaling groups/container autoscaling should be provisioned.',
    severity: 'important',
    addressedByQuestionId: 'q-scale',
  });

  questions.push({
    id: 'q-scale',
    category: 'scale',
    categoryLabel: 'Traffic & Scale',
    question: 'What is the expected traffic scale and scaling strategy?',
    rationale: 'Determines whether to provision elastic load balancers, auto-scaling groups, or serverless auto-concurrency.',
    options: [
      {
        id: 'opt-high-scale',
        label: 'Production High-Traffic (Auto-Scaling + ALB)',
        description: 'Automatic horizontal scaling across instances/containers with health checks.',
        isRecommended: true,
        technicalImpact: isAws ? 'ALB + Auto Scaling Group / ECS Fargate autoscaling' : 'Azure Application Gateway + VMSS / AKS autoscaling',
      },
      {
        id: 'opt-med-scale',
        label: 'Steady Moderate Workload (Multi-Instance)',
        description: 'Fixed 2-instance redundant pool behind load balancer.',
        isRecommended: false,
        technicalImpact: '2 worker instances balanced across availability zones',
      },
      {
        id: 'opt-low-scale',
        label: 'Cost-Optimized / Staging (Single Instance)',
        description: 'Minimal footprint for non-critical dev/testing environments.',
        isRecommended: false,
        technicalImpact: 'Single node, non-HA, lowest monthly cost',
      },
    ],
    defaultOptionId: 'opt-high-scale',
  });

  // Gap 2: High Availability & Multi-AZ
  gaps.push({
    id: 'gap-ha',
    title: 'High Availability & Zone Redundancy Not Defined',
    description: 'Production architectures must span at least 2 Availability Zones to prevent single points of failure (SPOF).',
    severity: 'critical',
    addressedByQuestionId: 'q-ha',
  });

  questions.push({
    id: 'q-ha',
    category: 'availability',
    categoryLabel: 'High Availability (Multi-AZ)',
    question: 'How resilient should the deployment be against data center outages?',
    rationale: 'Required to meet SLA uptime targets and eliminate single points of failure.',
    options: [
      {
        id: 'opt-multi-az',
        label: 'Multi-AZ Active-Active (Recommended for 99.99% SLA)',
        description: 'Spans Subnet AZ-A & Subnet AZ-B with standby database replication.',
        isRecommended: true,
        technicalImpact: isAws ? '2 Availability Zones (us-east-1a, 1b) + RDS Multi-AZ' : '2 Availability Zones + Azure SQL Zone Redundancy',
      },
      {
        id: 'opt-single-az',
        label: 'Single-AZ (Cost Sensitive)',
        description: 'All compute and storage in a single zone.',
        isRecommended: false,
        technicalImpact: 'SPOF risk during cloud provider zone incidents',
      },
    ],
    defaultOptionId: 'opt-multi-az',
  });

  // Gap 3: Security, WAF & Network Isolation
  gaps.push({
    id: 'gap-security',
    title: 'WAF & Subnet Security Perimeter Missing',
    description: 'Workloads handling user traffic should be shielded behind a Web Application Firewall with strict private subnet isolation.',
    severity: 'critical',
    addressedByQuestionId: 'q-security',
  });

  questions.push({
    id: 'q-security',
    category: 'security',
    categoryLabel: 'Security & Network Isolation',
    question: 'What level of security perimeter and network isolation is required?',
    rationale: 'Protects user data, prevents SQL injection/DDoS, and satisfies security review gates.',
    options: [
      {
        id: 'opt-sec-enterprise',
        label: 'Enterprise Hardened (WAF + Private Subnets + KMS)',
        description: 'Web Application Firewall (OWASP top 10), private app/data subnets, KMS customer encryption.',
        isRecommended: true,
        technicalImpact: isAws ? 'AWS WAF + Private VPC Subnets + KMS Keys + Strict Security Groups' : 'Azure WAF + Private VNet Subnets + Azure Key Vault + NSGs',
      },
      {
        id: 'opt-sec-standard',
        label: 'Standard (Private Subnets & Firewalls)',
        description: 'VPC/VNet segmentation with security groups/NSGs, no WAF.',
        isRecommended: false,
        technicalImpact: 'Isolated subnets with default cloud encryption',
      },
      {
        id: 'opt-sec-basic',
        label: 'Basic / Direct Public Access',
        description: 'Minimal networking restrictions (suitable only for sandbox prototypes).',
        isRecommended: false,
        technicalImpact: 'Publicly reachable instances (triggers security findings)',
      },
    ],
    defaultOptionId: 'opt-sec-enterprise',
  });

  // Gap 4: Compute Runtime
  const isServerlessRequested = lower.includes('lambda') || lower.includes('serverless') || lower.includes('function');
  const isK8sRequested = lower.includes('kubernetes') || lower.includes('k8s') || lower.includes('eks') || lower.includes('aks') || lower.includes('container') || lower.includes('docker') || lower.includes('ecs');

  questions.push({
    id: 'q-compute',
    category: 'compute',
    categoryLabel: 'Compute Platform',
    question: 'Which compute runtime best matches your deployment model?',
    rationale: 'Defines how application code is hosted, updated, and scaled.',
    options: [
      {
        id: 'opt-comp-containers',
        label: isAws ? 'Managed Containers (AWS ECS Fargate)' : 'Managed Containers (Azure Container Apps / AKS)',
        description: 'Serverless container orchestration without managing underlying VMs.',
        isRecommended: !isServerlessRequested,
        technicalImpact: isAws ? 'ECS Service + Task Definitions in Private Subnets' : 'AKS / Container Apps with autoscaling',
      },
      {
        id: 'opt-comp-serverless',
        label: isAws ? 'Serverless (AWS Lambda + API Gateway)' : 'Serverless (Azure Functions + API Mgmt)',
        description: 'Event-driven, zero idle cost, instant scale per request.',
        isRecommended: isServerlessRequested,
        technicalImpact: isAws ? 'API Gateway + Lambda Functions' : 'API Management + Azure Functions',
      },
      {
        id: 'opt-comp-vms',
        label: isAws ? 'Virtual Machines (EC2 Instances)' : 'Virtual Machines (Azure VMs)',
        description: 'Dedicated virtual servers with full OS control.',
        isRecommended: false,
        technicalImpact: isAws ? 'EC2 Auto Scaling Group' : 'Azure VM Scale Set',
      },
    ],
    defaultOptionId: isServerlessRequested ? 'opt-comp-serverless' : 'opt-comp-containers',
  });

  // Gap 5: Database & Caching
  const hasRedis = lower.includes('redis') || lower.includes('cache');
  questions.push({
    id: 'q-database',
    category: 'database',
    categoryLabel: 'Database & In-Memory Caching',
    question: 'How should the persistence and caching tier be configured?',
    rationale: 'Ensures data durability, fast query response times, and automated backups.',
    options: [
      {
        id: 'opt-db-cache-ha',
        label: isAws ? 'Multi-AZ Managed Database + Redis Cluster' : 'Zone-Redundant PostgreSQL/SQL + Redis Cache',
        description: 'Primary/standby database with automated 7-day backup retention and in-memory caching.',
        isRecommended: true,
        technicalImpact: isAws ? 'AWS RDS Multi-AZ + ElastiCache Redis' : 'Azure Database for PostgreSQL + Azure Cache for Redis',
      },
      {
        id: 'opt-db-only',
        label: 'Managed Database Only (No In-Memory Cache)',
        description: 'Direct queries to database without caching layer.',
        isRecommended: false,
        technicalImpact: 'Standard RDS / Azure SQL without Redis node',
      },
    ],
    defaultOptionId: 'opt-db-cache-ha',
  });

  // Gap 6: CDN & Static Storage
  questions.push({
    id: 'q-storage',
    category: 'storage',
    categoryLabel: 'CDN & Content Delivery',
    question: 'How should frontend assets and user uploaded media be delivered?',
    rationale: 'Accelerates global page loads and protects origin object buckets.',
    options: [
      {
        id: 'opt-cdn-storage',
        label: isAws ? 'CloudFront CDN + S3 (Block Public Access + OAC)' : 'Azure Front Door / CDN + Storage Account (Private Origin)',
        description: 'Global edge caching with strict Origin Access Control so bucket remains 100% private.',
        isRecommended: true,
        technicalImpact: isAws ? 'CloudFront Distribution + S3 Bucket (all BPA enabled)' : 'Azure Front Door + Azure Storage Account',
      },
      {
        id: 'opt-storage-only',
        label: 'Object Storage Only',
        description: 'Direct bucket access without edge CDN caching.',
        isRecommended: false,
        technicalImpact: 'S3 / Blob Storage only',
      },
    ],
    defaultOptionId: 'opt-cdn-storage',
  });

  return {
    summary: `Based on your request ("${prompt.slice(0, 70)}${prompt.length > 70 ? '…' : ''}"), we identified ${gaps.length} architectural dimensions requiring clarification before generating a production-grade topology.`,
    identifiedGaps: gaps,
    questions,
    suggestedProjectName: prompt.slice(0, 35).trim(),
  };
}

/**
 * Enforces production-grade 3-tier / 4-tier network topology, multi-AZ balancing,
 * and standard cloud wiring (NAT -> IGW, ALB in Public Subnet, Compute in App Subnet,
 * Database in Data Subnet).
 */
function normalizeProductionTopology(
  graph: RawAiGraph,
  provider: 'aws' | 'azure'
): RawAiGraph {
  const resources = [...(graph.resources ?? [])];
  const connections = [...(graph.connections ?? [])];
  if (resources.length === 0) {
    return { resources: [], connections: [] };
  }

  const hasWorkloads = resources.some((r) =>
    ['aws_alb', 'aws_nat', 'aws_eks', 'aws_ecs', 'aws_ec2', 'aws_auto_scaling', 'aws_lambda', 'aws_rds', 'aws_elasticache', 'aws_subnet', 'azure_app_gateway', 'azure_aks', 'azure_vmss', 'azure_app_service', 'azure_functions', 'azure_sql', 'azure_redis', 'azure_subnet'].includes(r.resourceType)
  );
  if (!hasWorkloads) {
    return { resources, connections };
  }

  const isAws = provider === 'aws';



  if (isAws) {
    // 1. Ensure VPC exists
    let vpc = resources.find((r) => r.resourceType === 'aws_vpc');
    if (!vpc) {
      vpc = { id: 'vpc-main', resourceType: 'aws_vpc', label: 'Production VPC (10.0.0.0/16)', config: { cidrBlock: '10.0.0.0/16' } };
      resources.unshift(vpc);
    }

    // 2. Ensure Internet Gateway exists
    let igw = resources.find((r) => r.resourceType === 'aws_igw');
    if (!igw) {
      igw = { id: 'igw-main', resourceType: 'aws_igw', label: 'Internet Gateway', parentId: vpc.id };
      resources.push(igw);
    } else if (!igw.parentId) {
      igw.parentId = vpc.id;
    }

    // 3. Ensure 3 Subnet Tiers (Public, App, Data) across AZ-A (us-east-1a) & AZ-B (us-east-1b)
    const subnets = resources.filter((r) => r.resourceType === 'aws_subnet');

    const isPublic = (s: RawAiResource) => {
      const name = `${s.id} ${s.label || ''}`.toLowerCase();
      return name.includes('pub') || name.includes('ingress');
    };
    const isData = (s: RawAiResource) => {
      const name = `${s.id} ${s.label || ''}`.toLowerCase();
      return name.includes('data') || name.includes('db') || name.includes('database');
    };
    const isApp = (s: RawAiResource) => {
      return !isPublic(s) && !isData(s);
    };
    const isAzB = (s: RawAiResource) => {
      const name = `${s.id} ${s.label || ''} ${(s.config?.availabilityZone as string) || ''}`.toLowerCase();
      return name.includes('1b') || name.endsWith('-b') || name.endsWith('b') || name.includes('az-b') || name.includes('az-2') || name.includes('zone b');
    };

    let pubSubnetA = subnets.find((s) => isPublic(s) && !isAzB(s));
    let pubSubnetB = subnets.find((s) => isPublic(s) && isAzB(s));
    let appSubnetA = subnets.find((s) => isApp(s) && !isAzB(s));
    let appSubnetB = subnets.find((s) => isApp(s) && isAzB(s));
    let dataSubnetA = subnets.find((s) => isData(s) && !isAzB(s));
    let dataSubnetB = subnets.find((s) => isData(s) && isAzB(s));

    // If subnets are missing, create them cleanly
    if (!pubSubnetA) {
      pubSubnetA = { id: 'public-subnet-a', resourceType: 'aws_subnet', label: 'Public Subnet A (10.0.1.0/24)', parentId: vpc.id, config: { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a' } };
      resources.push(pubSubnetA);
    }
    if (!pubSubnetB) {
      pubSubnetB = { id: 'public-subnet-b', resourceType: 'aws_subnet', label: 'Public Subnet B (10.0.2.0/24)', parentId: vpc.id, config: { cidrBlock: '10.0.2.0/24', availabilityZone: 'us-east-1b' } };
      resources.push(pubSubnetB);
    }

    if (!appSubnetA) {
      appSubnetA = { id: 'private-app-subnet-a', resourceType: 'aws_subnet', label: 'Private App Subnet A (10.0.10.0/24)', parentId: vpc.id, config: { cidrBlock: '10.0.10.0/24', availabilityZone: 'us-east-1a' } };
      resources.push(appSubnetA);
    }
    if (!appSubnetB) {
      appSubnetB = { id: 'private-app-subnet-b', resourceType: 'aws_subnet', label: 'Private App Subnet B (10.0.11.0/24)', parentId: vpc.id, config: { cidrBlock: '10.0.11.0/24', availabilityZone: 'us-east-1b' } };
      resources.push(appSubnetB);
    }

    if (!dataSubnetA) {
      dataSubnetA = { id: 'private-data-subnet-a', resourceType: 'aws_subnet', label: 'Private Data Subnet A (10.0.20.0/24)', parentId: vpc.id, config: { cidrBlock: '10.0.20.0/24', availabilityZone: 'us-east-1a' } };
      resources.push(dataSubnetA);
    }
    if (!dataSubnetB) {
      dataSubnetB = { id: 'private-data-subnet-b', resourceType: 'aws_subnet', label: 'Private Data Subnet B (10.0.21.0/24)', parentId: vpc.id, config: { cidrBlock: '10.0.21.0/24', availabilityZone: 'us-east-1b' } };
      resources.push(dataSubnetB);
    }


    // 4. Place and Wire Ingress & NAT into Public Subnets
    const alb = resources.find((r) => r.resourceType === 'aws_alb');
    if (alb) {
      alb.parentId = pubSubnetA.id;
    }

    let nat = resources.find((r) => r.resourceType === 'aws_nat');
    if (!nat) {
      nat = { id: 'nat-gateway-a', resourceType: 'aws_nat', label: 'VPC NAT Gateway A', parentId: pubSubnetA.id };
      resources.push(nat);
    } else {
      nat.parentId = pubSubnetA.id;
    }

    // Connect NAT to IGW
    if (!connections.some((c) => c.sourceId === nat!.id && c.targetId === igw!.id)) {
      connections.push({ sourceId: nat.id, targetId: igw.id, label: 'Outbound Traffic to Internet Gateway' });
    }

    // 5. Place and Wire Compute Tier into App Subnets
    const computeTypes = ['aws_eks', 'aws_ecs', 'aws_ec2', 'aws_auto_scaling', 'aws_lambda'];
    const computeNodes = resources.filter((r) => computeTypes.includes(r.resourceType));

    computeNodes.forEach((node, idx) => {
      // Alternate between App Subnet A and App Subnet B for multi-AZ
      const targetSubnet = idx % 2 === 0 ? appSubnetA! : appSubnetB!;
      node.parentId = targetSubnet.id;

      // Connect ALB -> Compute
      if (alb && !connections.some((c) => c.sourceId === alb.id && c.targetId === node.id)) {
        connections.push({ sourceId: alb.id, targetId: node.id, label: 'Load Balancer forwards to Workload' });
      }

      // Connect Compute -> NAT for outbound internet
      if (nat && !connections.some((c) => c.sourceId === node.id && c.targetId === nat!.id)) {
        connections.push({ sourceId: node.id, targetId: nat.id, label: 'Outbound Internet via NAT' });
      }
    });

    // 6. Place and Wire Data Tier (RDS / Redis) into Data Subnets
    const rds = resources.find((r) => r.resourceType === 'aws_rds');
    if (rds) {
      rds.parentId = dataSubnetA.id;
      if (!rds.config) rds.config = {};
      rds.config.multiAz = true;
      rds.config.multiAZ = true;
      rds.config.encrypted = true;
      rds.config.storageEncrypted = true;
      rds.config.publiclyAccessible = false;

      // Connect Compute -> RDS
      computeNodes.forEach((node) => {
        if (!connections.some((c) => c.sourceId === node.id && c.targetId === rds.id)) {
          connections.push({ sourceId: node.id, targetId: rds.id, label: 'PostgreSQL Connection (5432)' });
        }
      });
    }

    const redis = resources.find((r) => r.resourceType === 'aws_elasticache');
    if (redis) {
      redis.parentId = dataSubnetB.id;
      // Connect Compute -> Redis
      computeNodes.forEach((node) => {
        if (!connections.some((c) => c.sourceId === node.id && c.targetId === redis.id)) {
          connections.push({ sourceId: node.id, targetId: redis.id, label: 'Redis Cache (6379)' });
        }
      });
    }

    // 7. Perimeter & Storage Tier (WAF, CloudFront, S3)
    const cdn = resources.find((r) => r.resourceType === 'aws_cloudfront');
    const waf = resources.find((r) => r.resourceType === 'aws_waf');
    const s3 = resources.find((r) => r.resourceType === 'aws_s3');

    if (waf && cdn && !connections.some((c) => c.sourceId === waf.id && c.targetId === cdn.id)) {
      connections.push({ sourceId: waf.id, targetId: cdn.id, label: 'WAF Protection' });
    }
    if (cdn && alb && !connections.some((c) => c.sourceId === cdn.id && c.targetId === alb.id)) {
      connections.push({ sourceId: cdn.id, targetId: alb.id, label: 'CloudFront Origin to ALB' });
    }

    if (s3) {
      if (!s3.config) s3.config = {};
      s3.config.publicAccess = false;
      s3.config.blockPublicAcls = true;
      s3.config.blockPublicPolicy = true;
      s3.config.blockPublicAccess = true;
      s3.config.encryption = true;
      s3.config.encryptionType = 'AES-256';

      // Connect CDN -> S3 for static assets with Origin Access Control (OAC)
      if (cdn && !connections.some((c) => c.sourceId === cdn.id && c.targetId === s3.id)) {
        connections.push({ sourceId: cdn.id, targetId: s3.id, label: 'CloudFront OAC to S3 Origin' });
      }
      // Connect Compute -> S3 for private media & file storage
      computeNodes.forEach((node) => {
        if (!connections.some((c) => c.sourceId === node.id && c.targetId === s3.id)) {
          connections.push({ sourceId: node.id, targetId: s3.id, label: 'IAM S3 Media Access' });
        }
      });
    }
  } else {
    // Azure Normalization
    let rg = resources.find((r) => r.resourceType === 'azure_resource_group');
    if (!rg) {
      rg = { id: 'rg-main', resourceType: 'azure_resource_group', label: 'Production Resource Group', config: { location: 'eastus' } };
      resources.unshift(rg);
    }

    let vnet = resources.find((r) => r.resourceType === 'azure_vnet');
    if (!vnet) {
      vnet = { id: 'vnet-main', resourceType: 'azure_vnet', label: 'Production VNet (10.0.0.0/16)', parentId: rg.id, config: { addressSpace: '10.0.0.0/16' } };
      resources.push(vnet);
    }

    const subnets = resources.filter((r) => r.resourceType === 'azure_subnet');
    let ingressSubnet = subnets.find((s) => s.id.includes('ingress') || s.id.includes('appgw') || s.id.includes('public'));
    let appSubnet = subnets.find((s) => s.id.includes('app') || s.id.includes('aks') || s.id.includes('compute'));
    let dataSubnet = subnets.find((s) => s.id.includes('data') || s.id.includes('sql') || s.id.includes('db'));

    if (!ingressSubnet) {
      ingressSubnet = { id: 'snet-ingress', resourceType: 'azure_subnet', label: 'Ingress Subnet (10.0.1.0/24)', parentId: vnet.id, config: { addressPrefix: '10.0.1.0/24' } };
      resources.push(ingressSubnet);
    }
    if (!appSubnet) {
      appSubnet = { id: 'snet-app', resourceType: 'azure_subnet', label: 'Application Subnet (10.0.10.0/24)', parentId: vnet.id, config: { addressPrefix: '10.0.10.0/24' } };
      resources.push(appSubnet);
    }
    if (!dataSubnet) {
      dataSubnet = { id: 'snet-data', resourceType: 'azure_subnet', label: 'Data Subnet (10.0.20.0/24)', parentId: vnet.id, config: { addressPrefix: '10.0.20.0/24' } };
      resources.push(dataSubnet);
    }

    const appGw = resources.find((r) => r.resourceType === 'azure_app_gateway');
    if (appGw) appGw.parentId = ingressSubnet.id;

    const computeNodes = resources.filter((r) => ['azure_aks', 'azure_app_service', 'azure_vmss', 'azure_functions'].includes(r.resourceType));
    computeNodes.forEach((node) => {
      node.parentId = appSubnet!.id;
      if (appGw && !connections.some((c) => c.sourceId === appGw.id && c.targetId === node.id)) {
        connections.push({ sourceId: appGw.id, targetId: node.id, label: 'App Gateway to Workload' });
      }
    });

    const dbNodes = resources.filter((r) => ['azure_sql', 'azure_cosmosdb', 'azure_redis'].includes(r.resourceType));
    dbNodes.forEach((dbNode) => {
      dbNode.parentId = dataSubnet!.id;
      computeNodes.forEach((comp) => {
        if (!connections.some((c) => c.sourceId === comp.id && c.targetId === dbNode.id)) {
          connections.push({ sourceId: comp.id, targetId: dbNode.id, label: 'App to Database' });
        }
      });
    });

    const storageAccount = resources.find((r) => ['azure_storage_account', 'azure_blob_storage'].includes(r.resourceType));
    const frontDoor = resources.find((r) => ['azure_frontdoor', 'azure_cdn'].includes(r.resourceType));
    if (storageAccount) {
      if (frontDoor && !connections.some((c) => c.sourceId === frontDoor.id && c.targetId === storageAccount.id)) {
        connections.push({ sourceId: frontDoor.id, targetId: storageAccount.id, label: 'Front Door Origin to Storage' });
      }
      computeNodes.forEach((comp) => {
        if (!connections.some((c) => c.sourceId === comp.id && c.targetId === storageAccount.id)) {
          connections.push({ sourceId: comp.id, targetId: storageAccount.id, label: 'Managed Identity Blob Access' });
        }
      });
    }
  }

  return { resources, connections };
}

export class AiGeneratorService {
  /**
   * Generates dynamic discovery questions and identifies architectural gaps for a given prompt.
   * Leverages gpt-4o-mini via Azure AI Foundry with automatic heuristic fallback.
   */
  static async generateQuestionnaire(
    prompt: string,
    provider: 'aws' | 'azure' = 'aws'
  ): Promise<QuestionnaireResult> {
    try {
      const systemPrompt = `You are a Principal Cloud Architect specializing in ${provider.toUpperCase()} enterprise infrastructure.
Your task is to analyze the user's workload requirements and generate an interactive scoping questionnaire to fill any architectural gaps.

Analyze the prompt for missing production details such as:
1. Expected traffic volume, concurrency, and auto-scaling rules.
2. High Availability (HA), Multi-AZ redundancy, and fault tolerance.
3. Security, Web Application Firewall (WAF), DDoS protection, and subnet isolation.
4. Compute tier (Containers / ECS / EKS / AKS vs Serverless / Lambda vs VMs / EC2).
5. Data persistence, automated backup retention (>= 7 days), encryption at rest, and caching (Redis).
6. CDN / Edge distribution (CloudFront / Front Door) and secure object storage with blocked public access.

Output MUST be a single valid JSON object strictly matching this schema:
{
  "summary": "Brief explanation of gaps found and rationale for questions",
  "suggestedProjectName": "Concise 3-5 word name for the project",
  "identifiedGaps": [
    {
      "id": "gap-1",
      "title": "Short title of missing specification",
      "description": "Why this matters for production",
      "severity": "critical" | "important" | "suggestion",
      "addressedByQuestionId": "q-1"
    }
  ],
  "questions": [
    {
      "id": "q-1",
      "category": "scale" | "availability" | "security" | "compute" | "database" | "storage" | "network" | "observability",
      "categoryLabel": "Human-friendly category title",
      "question": "Clear, precise question",
      "rationale": "Why this question is critical for the architecture",
      "options": [
        {
          "id": "opt-1",
          "label": "Option title",
          "description": "Short explanation",
          "isRecommended": true | false,
          "technicalImpact": "Specific resources or settings this enables"
        }
      ],
      "defaultOptionId": "opt-1"
    }
  ]
}

Provide 4 to 6 questions. Ensure exactly one option per question has "isRecommended": true, and "defaultOptionId" matches that option.`;

      const response = await foundryClient().responses.create({
        model: FOUNDRY_MODEL,
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Workload description: "${prompt}"\nTarget Cloud Provider: ${provider.toUpperCase()}` },
        ],
        text: { format: { type: 'json_object' } },
      });

      const outputText = response.output_text || '{}';
      const parsed = JSON.parse(outputText) as Partial<QuestionnaireResult>;

      if (parsed.questions && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
        return {
          summary: parsed.summary || 'Please review and customize the following architectural specifications.',
          suggestedProjectName: parsed.suggestedProjectName || prompt.slice(0, 35).trim(),
          identifiedGaps: parsed.identifiedGaps || [],
          questions: parsed.questions,
        };
      }
    } catch (err) {
      console.warn('[AiGeneratorService] Failed to generate AI questionnaire via Foundry, using heuristic discovery:', (err as Error)?.message);
    }

    return getHeuristicQuestionnaire(prompt, provider);
  }

  /**
   * Generates a cloud architecture from a prompt (and optional questionnaire answers)
   * using the Azure AI Foundry deployment configured via AZURE_AI_FOUNDRY_*.
   * The AI is constrained to the RDE catalog — unsupported resource types are rejected.
   */
  static async generateArchitecture(
    prompt: string,
    projectId: string,
    environmentId: string,
    provider: 'aws' | 'azure' = 'aws',
    answers?: QuestionnaireAnswers,
    requirementsSummary?: string
  ): Promise<{ architectureJson: { resources: RawAiResource[]; connections: RawAiConnection[] }; historyId: string; rejectedTypes: string[] }> {
    // Select the correct resource catalog for the target provider
    const resources = provider === 'aws' ? awsResources : azureResources;

    // Narrow the valid-type set to just the target provider for prompt efficiency
    const providerValidTypes = new Set(resources.map(r => r.type));

    // Create a catalog summary for the LLM
    const catalog = resources.map(r => ({
      type: r.type,
      label: r.label,
      isContainer: r.isContainer ?? false,
      allowedChildren: r.allowedChildren ?? [],
      configSchema: (r.configSchema ?? []).map(c => ({
        key: c.key,
        type: c.type,
        defaultValue: c.defaultValue,
      })),
    }));

    // Formulate comprehensive prompt incorporating answers
    let userPromptContent = `Original Request: ${prompt}`;
    if (answers && Object.keys(answers).length > 0) {
      const answerList = Object.entries(answers)
        .map(([k, v]) => `• ${k}: ${v}`)
        .join('\n');
      userPromptContent += `\n\nUSER SPECIFICATIONS & ANSWERS:\n${answerList}`;
    }
    if (requirementsSummary) {
      userPromptContent += `\n\nADDITIONAL USER REQUIREMENTS:\n${requirementsSummary}`;
    }

    const systemPrompt = `You are an expert ${provider.toUpperCase()} cloud architect. Given a user prompt and detailed requirements, generate a complete, production-grade JSON representation of a cloud architecture.

IMPORTANT: Use ONLY the resource types defined in this catalog. Do NOT invent resource types.
Catalog:
${JSON.stringify(catalog, null, 2)}

Output must be valid JSON matching this exact schema:
{
  "resources": [
    { "id": "unique-id", "resourceType": "<type from catalog>", "label": "...", "config": { ... }, "parentId": null | "parent-id" }
  ],
  "connections": [
    { "sourceId": "unique-id", "targetId": "unique-id2", "label": "..." }
  ]
}

STRICT PRODUCTION ARCHITECTURE RULES:
1. VPC & Subnet Network Hierarchy (MANDATORY):
   - Create a VPC container (10.0.0.0/16) and attach an Internet Gateway (aws_igw).
   - Create 3 separate Subnet Tiers across at least TWO Availability Zones (AZ-A 'us-east-1a' and AZ-B 'us-east-1b'):
     * Tier 1 (Public Subnets): Public Subnet A (10.0.1.0/24) and Public Subnet B (10.0.2.0/24). Place Application Load Balancer (aws_alb) and NAT Gateways (aws_nat) here.
     * Tier 2 (Private App Subnets): App Subnet A (10.0.10.0/24) and App Subnet B (10.0.11.0/24). Place ALL compute workloads (aws_eks, aws_ecs, aws_ec2, aws_lambda) INSIDE these subnets. NEVER leave compute outside the VPC!
     * Tier 3 (Private Data Subnets): Data Subnet A (10.0.20.0/24) and Data Subnet B (10.0.21.0/24). Place databases (aws_rds) and caching (aws_elasticache) here.
2. Complete Wiring & Connections:
   - NAT Gateway (aws_nat) MUST connect to the Internet Gateway (aws_igw).
   - Compute nodes in private app subnets MUST connect to NAT Gateway for outbound internet access.
   - Load Balancer (aws_alb) in public subnet MUST forward traffic to compute nodes in app subnets.
   - Compute nodes MUST connect to RDS (5432) and Redis (6379) in data subnets.
   - WAF (aws_waf) MUST protect CloudFront (aws_cloudfront) and/or ALB.
3. Multi-AZ Reliability:
   - Never leave Subnet B empty. Spread compute and storage across both AZ-A and AZ-B.
   - Set multiAZ=true and storageEncrypted=true on RDS.

Architecture quality guidelines:
${buildQualityGuidelines(provider)}`;

    const response = await foundryClient().responses.create({
      model: FOUNDRY_MODEL,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPromptContent },
      ],
      text: { format: { type: 'json_object' } },
    });

    const outputText = response.output_text || '{}';
    let rawGraph: RawAiGraph;
    try {
      rawGraph = JSON.parse(outputText);
    } catch {
      rawGraph = { resources: [], connections: [] };
    }

    // Validate the AI's output against the RDE — reject unsupported types
    const { resources: validResources, connections: validConnections, rejected } =
      validateAgainstRde(rawGraph, providerValidTypes);

    if (rejected.length > 0) {
      console.warn(
        `[AiGeneratorService] Foundry produced unsupported resource types (removed): ${rejected.join(', ')}`
      );
    }

    // Normalize and auto-repair topology to guarantee 100% production-ready network tiers
    const normalizedGraph = normalizeProductionTopology(
      { resources: validResources, connections: validConnections },
      provider
    );

    const validatedJson = JSON.stringify(normalizedGraph);

    let historyId = '';
    try {
      const { architectureRepository } = await import('../repositories/architectureRepository');
      const architecture = await architectureRepository.findByEnvironment(environmentId);
      if (architecture) {
        const record = await db.orm.public.AIGenerationHistory.create({
          id: crypto.randomUUID(),
          projectId,
          architectureId: architecture.id,
          prompt,
          provider,
          model: FOUNDRY_MODEL,
          architectureJson: validatedJson,
          createdAt: new Date().toISOString(),
        });
        historyId = record.id;
      }
    } catch (err) {
      console.warn('[AiGeneratorService] Failed to record generation history:', (err as Error)?.message);
    }

    return {
      architectureJson: normalizedGraph,
      historyId,
      rejectedTypes: rejected,
    };
  }
}


