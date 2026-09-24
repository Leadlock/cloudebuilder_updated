/**
 * CloudCraft — Hand-Built Reference Architectures
 *
 * Unlike lib/templates/catalogData.ts (a parameterized factory that produces
 * many labeled variations of one shallow "ALB + compute + optional DB" shape),
 * every template in this file is a distinct, hand-modeled architecture pattern
 * with its own topology, containment, and relationships. Each is built only
 * from resource types that already exist in the RDE (lib/resources/aws.ts,
 * lib/resources/azure.ts) — no invented services, ports, or protocols.
 *
 * Provenance: these patterns are informed by publicly documented AWS/Azure
 * architecture guidance (AWS Architecture Center, AWS Well-Architected
 * Framework whitepapers, Azure Architecture Center, Azure Well-Architected
 * Framework). They are CloudCraft-authored implementations inspired by that
 * guidance, not reproductions of a specific AWS/Microsoft-published diagram —
 * see each template's `sourceReferences` for what informed it. Do not present
 * these as official AWS/Microsoft-endorsed architectures.
 *
 * Known limitation (see final report): the current RDE has no resource types
 * for API Gateway, EventBridge/SNS, Glue/Athena/Redshift, Kinesis, Cosmos DB,
 * Service Bus, Azure API Management, or Azure App Service (PaaS web apps).
 * That makes a handful of requested categories — a "real" managed Data &
 * Analytics pipeline, a dedicated pub/sub Event-Driven pattern, and an Azure
 * PaaS web-app pattern distinct from VM/VMSS — impossible to model accurately
 * without first extending the RDE (and, in turn, cost/security/Terraform
 * coverage for those types). Rather than fake those categories with
 * resources that don't represent the real service, they are intentionally
 * left out of this file. AWS Serverless and Azure Functions patterns ARE
 * included because Lambda/Functions, DynamoDB/Storage, and Lambda Function
 * URLs (a real, officially documented CloudFront-compatible HTTPS origin
 * since 2022) are all already representable with existing types.
 */
import { ArchitectureTemplate, CanvasNode, CanvasEdge, RelationshipType, NetworkScope, TemplateGenerateOptions } from '@/types';
import { getResourceDefinition } from '@/lib/resources';

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

function e(
  source: string,
  target: string,
  label: string,
  relationshipType: RelationshipType,
  protocol?: string,
  port?: string | number,
  networkScope: NetworkScope = 'private'
): CanvasEdge {
  return {
    id: `${source}:${relationshipType}:${target}`,
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

const AWS_ARCH_CENTER = { label: 'AWS Architecture Center', url: 'https://aws.amazon.com/architecture/' };
const AWS_WAF_FRAMEWORK = { label: 'AWS Well-Architected Framework', url: 'https://aws.amazon.com/architecture/well-architected/' };
const AZURE_ARCH_CENTER = { label: 'Azure Architecture Center', url: 'https://learn.microsoft.com/azure/architecture/' };
const AZURE_WAF_FRAMEWORK = { label: 'Azure Well-Architected Framework', url: 'https://learn.microsoft.com/azure/well-architected/' };

// ════════════════════════════════════════════════════════════════════════════
// AWS — Serverless REST API (API-first, no VPC required)
// ════════════════════════════════════════════════════════════════════════════
function awsServerlessApi(): ArchitectureTemplate {
  const id = 'ref-aws-serverless-api';
  return {
    id,
    name: 'Serverless REST API',
    category: 'Serverless',
    description: 'A fully serverless API backend: CloudFront serves the static frontend from S3 and proxies API calls to a Lambda function via its HTTPS Function URL, with DynamoDB as the data store. No VPC, NAT Gateway, or always-on compute — you pay per request and scale to zero.',
    provider: 'aws',
    complexity: 'simple',
    estimatedCost: 35,
    resourceCount: 7,
    isAdaptive: false,
    scaleRecommendation: 'Scales automatically from zero to thousands of req/s; costs track usage, not fixed capacity.',
    isReferenceArchitecture: true,
    architecturePattern: 'Serverless REST API',
    useCases: ['Public APIs with spiky or unpredictable traffic', 'MVPs and low-ops backends', 'Mobile/SPA backends'],
    availabilityTarget: 'Regional managed-service availability (Lambda/DynamoDB SLAs) — no Multi-AZ configuration needed since both services are inherently multi-AZ',
    supportedScale: 'Near-zero to high-throughput — scales per-request, not per-server',
    dataFlowSummary: 'Browser → CloudFront (static assets from S3, API requests proxied to Lambda) → Lambda → DynamoDB',
    sourceReferences: [AWS_ARCH_CENTER, { label: 'AWS Lambda Function URLs documentation', url: 'https://docs.aws.amazon.com/lambda/latest/dg/lambda-urls.html' }],
    features: [
      'Pay-per-request compute (Lambda) and storage (DynamoDB on-demand)',
      'No servers, no VPC, no NAT Gateway to manage or pay for',
      'CloudFront edge caching for static assets, direct HTTPS proxy to API',
      'Scales to zero when idle',
    ],
    tags: ['aws', 'serverless', 'lambda', 'dynamodb', 'api'],
    generate(_opts: TemplateGenerateOptions = {}) {
      const nodes: CanvasNode[] = [
        n(`${id}-cloud`, 'aws_cloud_boundary', 'aws', 'Amazon Web Services (us-east-1)', 30, 20, { region: 'us-east-1' }, undefined, 980, 460),
        n(`${id}-r53`, 'aws_route53', 'aws', 'Route 53 DNS', 80, 80, { domainName: 'api.cloudcraft.example' }, `${id}-cloud`),
        n(`${id}-cf`, 'aws_cloudfront', 'aws', 'CloudFront Distribution', 340, 80, { priceClass: 'PriceClass_100' }, `${id}-cloud`),
        n(`${id}-s3-web`, 'aws_s3', 'aws', 'Static Frontend (S3)', 600, 80, { versioning: true, encryption: true, publicAccess: false }, `${id}-cloud`),
        n(`${id}-lambda`, 'aws_lambda', 'aws', 'API Handler (Lambda)', 340, 250, { runtime: 'nodejs20.x', memorySize: 512 }, `${id}-cloud`),
        n(`${id}-iam`, 'aws_iam', 'aws', 'Lambda Execution Role', 80, 250, { trustedService: 'lambda.amazonaws.com' }, `${id}-cloud`),
        n(`${id}-ddb`, 'aws_dynamodb', 'aws', 'DynamoDB Table', 600, 250, { billingMode: 'PAY_PER_REQUEST' }, `${id}-cloud`),
      ];
      const edges: CanvasEdge[] = [
        e(`${id}-r53`, `${id}-cf`, 'DNS Alias', 'RESOLVES_TO', 'DNS', 53, 'public'),
        e(`${id}-cf`, `${id}-s3-web`, 'Static Asset Origin', 'SERVES', 'HTTPS', 443, 'private'),
        e(`${id}-cf`, `${id}-lambda`, 'API Origin (Lambda Function URL)', 'ROUTES_TO', 'HTTPS', 443, 'public'),
        e(`${id}-iam`, `${id}-lambda`, 'Execution Role', 'AUTHENTICATES_WITH', undefined, undefined, 'internal'),
        e(`${id}-lambda`, `${id}-ddb`, 'DynamoDB API', 'CONNECTS_TO', 'HTTPS', 443, 'private'),
      ];
      return { nodes, edges };
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// AWS — Microservices on ECS Fargate (database-per-service, async messaging)
// ════════════════════════════════════════════════════════════════════════════
function awsMicroservicesEcs(): ArchitectureTemplate {
  const id = 'ref-aws-microservices-ecs';
  return {
    id,
    name: 'Microservices on ECS Fargate',
    category: 'Microservices',
    description: 'Three independently deployable services (Orders, Inventory, Payments) behind a single Application Load Balancer using path-based routing, each running on its own ECS Fargate service with its own database (database-per-service), decoupled by an SQS queue for asynchronous order-to-inventory events.',
    provider: 'aws',
    complexity: 'complex',
    estimatedCost: 95,
    resourceCount: 15,
    isAdaptive: true,
    scaleRecommendation: 'Each service scales its own Fargate task count independently based on its own load.',
    isReferenceArchitecture: true,
    architecturePattern: 'Microservices (database-per-service + async messaging)',
    useCases: ['Independently-scaled product domains', 'Teams owning separate services/deploy cadences', 'Decoupled order-processing workflows'],
    availabilityTarget: 'Multi-task Fargate services behind a Load Balancer within a single region (add a second AZ\'s subnets for Multi-AZ)',
    supportedScale: 'Startup to mid-scale multi-team systems — each service scales independently',
    dataFlowSummary: 'ALB routes /orders, /inventory, /payments by path → each Fargate service owns its data in its own database; Orders publishes to SQS, Inventory consumes asynchronously',
    sourceReferences: [AWS_ARCH_CENTER, { label: 'Amazon ECS documentation', url: 'https://docs.aws.amazon.com/ecs/' }],
    features: [
      'Path-based ALB routing to independently deployable Fargate services',
      'Database-per-service — no shared schema/coupling between services',
      'Asynchronous decoupling via SQS between Orders and Inventory',
      'Private subnets for all compute and data; only the ALB is internet-facing',
    ],
    tags: ['aws', 'microservices', 'ecs', 'fargate', 'sqs'],
    generate(_opts: TemplateGenerateOptions = {}) {
      const nodes: CanvasNode[] = [
        n(`${id}-cloud`, 'aws_cloud_boundary', 'aws', 'Amazon Web Services (us-east-1)', 30, 20, { region: 'us-east-1' }, undefined, 1400, 900),
        n(`${id}-vpc`, 'aws_vpc', 'aws', 'Production VPC (10.0.0.0/16)', 60, 80, { cidrBlock: '10.0.0.0/16' }, `${id}-cloud`, 1320, 800),
        n(`${id}-igw`, 'aws_igw', 'aws', 'Internet Gateway', 620, 120, {}, `${id}-vpc`),
        n(`${id}-sub-pub`, 'aws_subnet', 'aws', 'Public Subnet (10.0.1.0/24)', 90, 200, { cidrBlock: '10.0.1.0/24', mapPublicIpOnLaunch: true }, `${id}-vpc`, 1240, 150),
        n(`${id}-alb`, 'aws_alb', 'aws', 'Application Load Balancer (path routing)', 130, 250, { lbType: 'application', scheme: 'internet-facing' }, `${id}-sub-pub`),
        n(`${id}-sub-svc`, 'aws_subnet', 'aws', 'Private Services Subnet (10.0.10.0/24)', 90, 400, { cidrBlock: '10.0.10.0/24' }, `${id}-vpc`, 1240, 200),
        n(`${id}-svc-orders`, 'aws_ecs', 'aws', 'Orders Service (Fargate)', 130, 460, { launchType: 'FARGATE', desiredCount: 2 }, `${id}-sub-svc`),
        n(`${id}-svc-inventory`, 'aws_ecs', 'aws', 'Inventory Service (Fargate)', 520, 460, { launchType: 'FARGATE', desiredCount: 2 }, `${id}-sub-svc`),
        n(`${id}-svc-payments`, 'aws_ecs', 'aws', 'Payments Service (Fargate)', 910, 460, { launchType: 'FARGATE', desiredCount: 2 }, `${id}-sub-svc`),
        n(`${id}-queue`, 'aws_sqs', 'aws', 'Order Events Queue', 320, 620, { fifoQueue: false }, `${id}-cloud`),
        n(`${id}-sub-data`, 'aws_subnet', 'aws', 'Private Data Subnet (10.0.20.0/24)', 90, 700, { cidrBlock: '10.0.20.0/24' }, `${id}-vpc`, 1240, 150),
        n(`${id}-db-orders`, 'aws_rds', 'aws', 'Orders DB (PostgreSQL)', 130, 750, { engine: 'postgres', multiAz: false, encrypted: true, publiclyAccessible: false }, `${id}-sub-data`),
        n(`${id}-db-inventory`, 'aws_dynamodb', 'aws', 'Inventory Table (DynamoDB)', 520, 750, { billingMode: 'PAY_PER_REQUEST' }, `${id}-cloud`),
        n(`${id}-db-payments`, 'aws_rds', 'aws', 'Payments DB (PostgreSQL)', 910, 750, { engine: 'postgres', multiAz: true, encrypted: true, publiclyAccessible: false }, `${id}-sub-data`),
        n(`${id}-sg-svc`, 'aws_sg', 'aws', 'Services Security Group', 1150, 460, { allowHttp: false, allowHttps: false, allowSsh: false }, `${id}-vpc`),
      ];
      const edges: CanvasEdge[] = [
        e(`${id}-igw`, `${id}-alb`, 'Inbound HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'),
        e(`${id}-alb`, `${id}-svc-orders`, 'Route /orders', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e(`${id}-alb`, `${id}-svc-inventory`, 'Route /inventory', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e(`${id}-alb`, `${id}-svc-payments`, 'Route /payments', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e(`${id}-sg-svc`, `${id}-svc-orders`, 'Security Group', 'ASSOCIATED_WITH', undefined, undefined, 'internal'),
        e(`${id}-sg-svc`, `${id}-svc-inventory`, 'Security Group', 'ASSOCIATED_WITH', undefined, undefined, 'internal'),
        e(`${id}-sg-svc`, `${id}-svc-payments`, 'Security Group', 'ASSOCIATED_WITH', undefined, undefined, 'internal'),
        e(`${id}-svc-orders`, `${id}-db-orders`, 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e(`${id}-svc-inventory`, `${id}-db-inventory`, 'DynamoDB API', 'CONNECTS_TO', 'HTTPS', 443, 'private'),
        e(`${id}-svc-payments`, `${id}-db-payments`, 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e(`${id}-svc-orders`, `${id}-queue`, 'Publish Order Event', 'CONNECTS_TO', 'SQS API', 443, 'private'),
        e(`${id}-queue`, `${id}-svc-inventory`, 'Consume Order Event', 'TRIGGERS', 'EventSourceMapping', undefined, 'internal'),
      ];
      return { nodes, edges };
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// AWS — EKS Container Platform
// ════════════════════════════════════════════════════════════════════════════
function awsEksPlatform(): ArchitectureTemplate {
  const id = 'ref-aws-eks-platform';
  return {
    id,
    name: 'EKS Container Platform',
    category: 'Containers / Kubernetes',
    description: 'A Kubernetes application running on Amazon EKS: an internet-facing ALB (typically driven by the AWS Load Balancer Controller / Ingress in-cluster) fronts a managed EKS node group, with RDS for relational data and ElastiCache for session/cache state, both isolated in private subnets.',
    provider: 'aws',
    complexity: 'complex',
    estimatedCost: 140,
    resourceCount: 12,
    isAdaptive: true,
    scaleRecommendation: 'Node group scales via Cluster Autoscaler / Karpenter based on pod scheduling pressure, not manual sizing.',
    isReferenceArchitecture: true,
    architecturePattern: 'Managed Kubernetes (EKS)',
    useCases: ['Teams standardized on Kubernetes tooling/Helm charts', 'Portable workloads intended to also run on-prem/other clouds', 'Multi-tenant platform engineering'],
    availabilityTarget: 'Multi-AZ EKS control plane (AWS-managed) with worker nodes spread across AZs via subnet configuration',
    supportedScale: 'Small clusters to large multi-team platforms — bounded by node group and cluster-autoscaler limits, not this diagram',
    dataFlowSummary: 'Internet → ALB/Ingress → EKS pods → RDS (durable data) / ElastiCache (cache/session)',
    sourceReferences: [AWS_ARCH_CENTER, { label: 'Amazon EKS documentation', url: 'https://docs.aws.amazon.com/eks/' }],
    features: [
      'Managed Kubernetes control plane (EKS)',
      'ALB ingress into the cluster',
      'RDS and ElastiCache isolated in private data subnets',
      'IAM role scoped to the node group (IRSA pattern for pod-level permissions is a cluster-side configuration, not shown as a separate node)',
    ],
    tags: ['aws', 'kubernetes', 'eks', 'containers'],
    generate(_opts: TemplateGenerateOptions = {}) {
      const nodes: CanvasNode[] = [
        n(`${id}-cloud`, 'aws_cloud_boundary', 'aws', 'Amazon Web Services (us-east-1)', 30, 20, { region: 'us-east-1' }, undefined, 1120, 760),
        n(`${id}-vpc`, 'aws_vpc', 'aws', 'Production VPC (10.0.0.0/16)', 60, 80, { cidrBlock: '10.0.0.0/16' }, `${id}-cloud`, 1040, 660),
        n(`${id}-igw`, 'aws_igw', 'aws', 'Internet Gateway', 500, 120, {}, `${id}-vpc`),
        n(`${id}-sub-pub`, 'aws_subnet', 'aws', 'Public Subnet (10.0.1.0/24)', 90, 200, { cidrBlock: '10.0.1.0/24', mapPublicIpOnLaunch: true }, `${id}-vpc`, 960, 140),
        n(`${id}-alb`, 'aws_alb', 'aws', 'Ingress ALB', 130, 250, { lbType: 'application', scheme: 'internet-facing' }, `${id}-sub-pub`),
        n(`${id}-nat`, 'aws_nat', 'aws', 'NAT Gateway', 400, 250, {}, `${id}-sub-pub`),
        n(`${id}-sub-nodes`, 'aws_subnet', 'aws', 'Private Node Subnet (10.0.10.0/24)', 90, 380, { cidrBlock: '10.0.10.0/24' }, `${id}-vpc`, 960, 150),
        n(`${id}-eks`, 'aws_eks', 'aws', 'EKS Managed Node Group', 350, 430, { nodeCount: 4 }, `${id}-sub-nodes`),
        n(`${id}-iam`, 'aws_iam', 'aws', 'Node Group IAM Role', 750, 430, { trustedService: 'ec2.amazonaws.com' }, `${id}-vpc`),
        n(`${id}-sub-data`, 'aws_subnet', 'aws', 'Private Data Subnet (10.0.20.0/24)', 90, 560, { cidrBlock: '10.0.20.0/24' }, `${id}-vpc`, 960, 150),
        n(`${id}-rds`, 'aws_rds', 'aws', 'RDS PostgreSQL (Multi-AZ)', 300, 610, { engine: 'postgres', multiAz: true, encrypted: true, publiclyAccessible: false }, `${id}-sub-data`),
        n(`${id}-redis`, 'aws_elasticache', 'aws', 'ElastiCache Redis', 650, 610, { numNodes: 2 }, `${id}-sub-data`),
      ];
      const edges: CanvasEdge[] = [
        e(`${id}-igw`, `${id}-alb`, 'Inbound HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'),
        e(`${id}-alb`, `${id}-eks`, 'Ingress → Pods', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e(`${id}-eks`, `${id}-nat`, 'Egress NAT', 'ROUTES_TO', 'TCP', undefined, 'private'),
        e(`${id}-nat`, `${id}-igw`, 'NAT Egress', 'ROUTES_TO', 'TCP', undefined, 'public'),
        e(`${id}-iam`, `${id}-eks`, 'Node Instance Role', 'AUTHENTICATES_WITH', undefined, undefined, 'internal'),
        e(`${id}-eks`, `${id}-rds`, 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e(`${id}-eks`, `${id}-redis`, 'Redis / 6379', 'CONNECTS_TO', 'Redis', 6379, 'private'),
      ];
      return { nodes, edges };
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// AWS — Multi-Region Disaster Recovery (Warm Standby)
// ════════════════════════════════════════════════════════════════════════════
function awsMultiRegionDr(): ArchitectureTemplate {
  const id = 'ref-aws-dr-warm-standby';
  return {
    id,
    name: 'Multi-Region Disaster Recovery (Warm Standby)',
    category: 'Disaster Recovery',
    description: 'A "warm standby" DR strategy: the primary region (us-east-1) runs full production capacity; a secondary region (us-west-2) runs a scaled-down but live copy of the stack, kept current via an RDS read replica and S3 Cross-Region Replication. Route 53 health-check-based failover routing shifts traffic to the standby region if the primary becomes unhealthy.',
    provider: 'aws',
    complexity: 'complex',
    estimatedCost: 210,
    resourceCount: 16,
    isAdaptive: false,
    scaleRecommendation: 'Standby region capacity is deliberately smaller than primary; promote/resize it during an actual failover (this is the "warm standby" trade-off vs. more expensive active-active).',
    isReferenceArchitecture: true,
    architecturePattern: 'Multi-Region Disaster Recovery (Warm Standby)',
    useCases: ['Regulated workloads requiring a documented DR region', 'RTO/RPO requirements stricter than backup/restore but not requiring active-active cost'],
    availabilityTarget: 'Multi-Region — tolerates a full regional outage; RPO bounded by RDS replica lag and S3 CRR propagation time (both asynchronous, not instantaneous)',
    supportedScale: 'Primary region sized for production load; standby sized smaller until a failover is promoted',
    dataFlowSummary: 'Route 53 health-checks the primary ALB; on failure, DNS fails over to the standby region\'s ALB. RDS in the standby region is a read replica fed by asynchronous replication from the primary; S3 objects are asynchronously replicated cross-region.',
    sourceReferences: [AWS_WAF_FRAMEWORK, { label: 'AWS Disaster Recovery whitepaper guidance', url: 'https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html' }],
    features: [
      'Route 53 health-check failover routing between two regions',
      'Warm standby: live but downsized secondary-region capacity, not a cold backup',
      'RDS cross-region read replica for the database tier',
      'S3 Cross-Region Replication for object storage',
    ],
    tags: ['aws', 'disaster-recovery', 'multi-region', 'rds', 'warm-standby'],
    generate(_opts: TemplateGenerateOptions = {}) {
      const nodes: CanvasNode[] = [
        n(`${id}-r53`, 'aws_route53', 'aws', 'Route 53 (Failover Routing Policy)', 540, 20, { domainName: 'app.cloudcraft.example' }),

        // Primary region
        n(`${id}-cloud-primary`, 'aws_cloud_boundary', 'aws', 'Primary Region (us-east-1)', 30, 120, { region: 'us-east-1' }, undefined, 620, 560),
        n(`${id}-alb-primary`, 'aws_alb', 'aws', 'ALB (Primary)', 80, 190, { lbType: 'application', scheme: 'internet-facing' }, `${id}-cloud-primary`),
        n(`${id}-asg-primary`, 'aws_auto_scaling', 'aws', 'App Auto Scaling Group (Primary)', 80, 320, { minSize: 4, maxSize: 12, desiredCapacity: 4 }, `${id}-cloud-primary`),
        n(`${id}-rds-primary`, 'aws_rds', 'aws', 'RDS PostgreSQL (Primary, Multi-AZ)', 80, 450, { engine: 'postgres', multiAz: true, encrypted: true, publiclyAccessible: false }, `${id}-cloud-primary`),
        n(`${id}-s3-primary`, 'aws_s3', 'aws', 'S3 Bucket (Primary)', 380, 450, { versioning: true, encryption: true }, `${id}-cloud-primary`),

        // Secondary region
        n(`${id}-cloud-secondary`, 'aws_cloud_boundary', 'aws', 'Standby Region (us-west-2)', 720, 120, { region: 'us-west-2' }, undefined, 620, 560),
        n(`${id}-alb-secondary`, 'aws_alb', 'aws', 'ALB (Standby)', 770, 190, { lbType: 'application', scheme: 'internet-facing' }, `${id}-cloud-secondary`),
        n(`${id}-asg-secondary`, 'aws_auto_scaling', 'aws', 'App Auto Scaling Group (Standby, downsized)', 770, 320, { minSize: 1, maxSize: 12, desiredCapacity: 1 }, `${id}-cloud-secondary`),
        n(`${id}-rds-secondary`, 'aws_rds', 'aws', 'RDS PostgreSQL (Cross-Region Read Replica)', 770, 450, { engine: 'postgres', multiAz: false, encrypted: true, publiclyAccessible: false }, `${id}-cloud-secondary`),
        n(`${id}-s3-secondary`, 'aws_s3', 'aws', 'S3 Bucket (CRR Destination)', 1070, 450, { versioning: true, encryption: true }, `${id}-cloud-secondary`),
      ];
      const edges: CanvasEdge[] = [
        e(`${id}-r53`, `${id}-alb-primary`, 'Failover: Primary', 'RESOLVES_TO', 'DNS', 53, 'public'),
        e(`${id}-r53`, `${id}-alb-secondary`, 'Failover: Standby (on health-check failure)', 'RESOLVES_TO', 'DNS', 53, 'public'),
        e(`${id}-alb-primary`, `${id}-asg-primary`, 'Balance HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e(`${id}-asg-primary`, `${id}-rds-primary`, 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e(`${id}-asg-primary`, `${id}-s3-primary`, 'Put/Get Object', 'STORES_IN', 'HTTPS', 443, 'private'),
        e(`${id}-alb-secondary`, `${id}-asg-secondary`, 'Balance HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e(`${id}-asg-secondary`, `${id}-rds-secondary`, 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e(`${id}-rds-primary`, `${id}-rds-secondary`, 'Async Cross-Region Replication', 'REPLICATES_TO', undefined, undefined, 'cross-region'),
        e(`${id}-s3-primary`, `${id}-s3-secondary`, 'S3 Cross-Region Replication', 'REPLICATES_TO', 'HTTPS', 443, 'cross-region'),
      ];
      return { nodes, edges };
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// AWS — Production Three-Tier (Multi-AZ) — kept as the canonical AWS baseline
// ════════════════════════════════════════════════════════════════════════════
function awsThreeTierMultiAz(): ArchitectureTemplate {
  const id = 'ref-aws-three-tier-multi-az';
  return {
    id,
    name: 'Production Three-Tier Web Application (Multi-AZ)',
    category: 'Web Applications',
    description: 'The canonical highly-available three-tier web application: CloudFront + WAF in front of a Multi-AZ Application Load Balancer, an Auto Scaling Group spread across two Availability Zones, and a Multi-AZ RDS PostgreSQL database with an ElastiCache Redis layer for session/cache state.',
    provider: 'aws',
    complexity: 'moderate',
    estimatedCost: 120,
    resourceCount: 20,
    isAdaptive: true,
    scaleRecommendation: 'Auto Scaling Group grows/shrinks per AZ based on CPU/request-count target tracking; RDS scales vertically (instance class) or via read replicas for read-heavy workloads.',
    isReferenceArchitecture: true,
    architecturePattern: 'Three-Tier Web Application (Multi-AZ)',
    useCases: ['General-purpose production web applications', 'Workloads needing to tolerate a single Availability Zone failure'],
    availabilityTarget: 'Multi-AZ across 2 Availability Zones (tolerates single-AZ failure)',
    supportedScale: '1K–100K concurrent users depending on instance sizing',
    dataFlowSummary: 'Users → CloudFront (WAF-protected) → ALB (spans 2 AZs) → Auto Scaling Group → RDS Multi-AZ / ElastiCache',
    sourceReferences: [AWS_ARCH_CENTER, AWS_WAF_FRAMEWORK],
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
    tags: ['aws', 'web-applications', 'multi-az', 'rds', 'production'],
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
        e('r53', 'cf', 'DNS Alias', 'RESOLVES_TO', 'DNS', 53, 'public'),
        e('waf', 'cf', 'WAF Protection', 'ASSOCIATED_WITH', undefined, undefined, 'internal'),
        e('cf', 'igw', 'Origin HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'),
        e('igw', 'alb', 'Inbound HTTPS / 443', 'ROUTES_TO', 'HTTPS', 443, 'public'),
        e('alb', 'app-srv-a', 'Balance HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e('alb', 'app-srv-b', 'Balance HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e('app-srv-a', 'rds-multiaz', 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e('app-srv-b', 'rds-multiaz', 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e('app-srv-a', 'redis-cache', 'Redis / 6379', 'CONNECTS_TO', 'Redis', 6379, 'private'),
        e('app-srv-b', 'redis-cache', 'Redis / 6379', 'CONNECTS_TO', 'Redis', 6379, 'private'),
        e('app-srv-a', 's3-storage', 'S3 API / IAM', 'STORES_IN', 'HTTPS', 443, 'private'),
        e('app-srv-b', 's3-storage', 'S3 API / IAM', 'STORES_IN', 'HTTPS', 443, 'private'),
        e('app-srv-a', 'nat-a', 'Egress NAT', 'ROUTES_TO', 'TCP', undefined, 'private'),
        e('app-srv-b', 'nat-b', 'Egress NAT', 'ROUTES_TO', 'TCP', undefined, 'private'),
        e('nat-a', 'igw', 'NAT Egress', 'ROUTES_TO', 'TCP', undefined, 'public'),
        e('nat-b', 'igw', 'NAT Egress', 'ROUTES_TO', 'TCP', undefined, 'public'),
      ];
      return { nodes, edges };
    },
  };
}

export const awsReferenceArchitectures: ArchitectureTemplate[] = [
  awsThreeTierMultiAz(),
  awsServerlessApi(),
  awsMicroservicesEcs(),
  awsEksPlatform(),
  awsMultiRegionDr(),
];

// ════════════════════════════════════════════════════════════════════════════
// Azure — VMSS Three-Tier Web Application (Zone-Redundant)
// ════════════════════════════════════════════════════════════════════════════
function azureThreeTierVmss(): ArchitectureTemplate {
  const id = 'ref-azure-three-tier-vmss';
  return {
    id,
    name: 'Zone-Redundant Web Application (VMSS)',
    category: 'Web Applications',
    description: 'Azure Front Door and a WAF policy front a regional Application Gateway, which load-balances across a Virtual Machine Scale Set spread across Availability Zones. Azure SQL Database and Azure Cache for Redis sit behind the app tier inside the VNet.',
    provider: 'azure',
    complexity: 'moderate',
    estimatedCost: 130,
    resourceCount: 13,
    isAdaptive: true,
    scaleRecommendation: 'VMSS autoscale rules add/remove instances by CPU or request metrics; Azure SQL scales via service tier/vCore changes.',
    isReferenceArchitecture: true,
    architecturePattern: 'Three-Tier Web Application (Zone-Redundant)',
    useCases: ['General-purpose production web applications on Azure IaaS', 'Workloads needing zonal resilience without a full multi-region setup'],
    availabilityTarget: 'Zone-redundant within a region (VMSS instances spread across Availability Zones)',
    supportedScale: '1K–100K concurrent users depending on SKU and instance count',
    dataFlowSummary: 'Users → Front Door (WAF) → Application Gateway → VMSS → Azure SQL / Azure Cache for Redis',
    sourceReferences: [AZURE_ARCH_CENTER, AZURE_WAF_FRAMEWORK],
    features: [
      'Azure Front Door global entry point with WAF policy',
      'Application Gateway regional load balancing',
      'Zone-redundant Virtual Machine Scale Set',
      'Azure SQL Database with public network access disabled',
      'Azure Cache for Redis for session/cache state',
    ],
    tags: ['azure', 'web-applications', 'vmss', 'zone-redundant'],
    generate(_opts: TemplateGenerateOptions = {}) {
      const nodes: CanvasNode[] = [
        n(`${id}-cloud`, 'azure_cloud_boundary', 'azure', 'Microsoft Azure (East US)', 30, 20, { region: 'eastus' }, undefined, 1100, 820),
        n(`${id}-fd`, 'azure_front_door', 'azure', 'Azure Front Door', 120, 80, {}, `${id}-cloud`),
        n(`${id}-waf`, 'azure_waf', 'azure', 'WAF Policy', 420, 80, {}, `${id}-cloud`),
        n(`${id}-rg`, 'azure_resource_group', 'azure', 'Production Resource Group', 70, 200, {}, `${id}-cloud`, 1000, 600),
        n(`${id}-vnet`, 'azure_vnet', 'azure', 'Production VNet (10.0.0.0/16)', 100, 250, { addressSpace: '10.0.0.0/16' }, `${id}-rg`, 900, 500),
        n(`${id}-sub-app`, 'azure_subnet', 'azure', 'App Subnet (10.0.1.0/24)', 130, 320, { addressPrefix: '10.0.1.0/24' }, `${id}-vnet`, 400, 150),
        n(`${id}-appgw`, 'azure_app_gateway', 'azure', 'Application Gateway', 170, 370, {}, `${id}-sub-app`),
        n(`${id}-vmss`, 'azure_vmss', 'azure', 'Web Tier VMSS (Zone-Redundant)', 170, 470, { sku: 'Standard_D2s_v5', capacity: 4, osType: 'Linux', osDiskEncryption: true }, `${id}-sub-app`),
        n(`${id}-sub-data`, 'azure_subnet', 'azure', 'Data Subnet (10.0.10.0/24)', 570, 320, { addressPrefix: '10.0.10.0/24' }, `${id}-vnet`, 400, 150),
        n(`${id}-sql`, 'azure_sql', 'azure', 'Azure SQL Database', 610, 380, { tier: 'GeneralPurpose', publicNetworkAccess: false, threatDetectionEnabled: true }, `${id}-sub-data`),
        n(`${id}-redis`, 'azure_redis', 'azure', 'Azure Cache for Redis', 610, 470, {}, `${id}-sub-data`),
        n(`${id}-kv`, 'azure_key_vault', 'azure', 'Key Vault (App Secrets)', 170, 570, {}, `${id}-vnet`),
        n(`${id}-nsg`, 'azure_nsg', 'azure', 'App Subnet NSG', 400, 470, { allowSsh: false, allowRdp: false }, `${id}-vnet`),
      ];
      const edges: CanvasEdge[] = [
        e(`${id}-waf`, `${id}-fd`, 'WAF Policy Attached', 'ASSOCIATED_WITH', undefined, undefined, 'internal'),
        e(`${id}-fd`, `${id}-appgw`, 'Backend Pool HTTPS', 'ROUTES_TO', 'HTTPS Origin', 443, 'public'),
        e(`${id}-appgw`, `${id}-vmss`, 'Backend Pool / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e(`${id}-nsg`, `${id}-vmss`, 'NSG Association', 'ASSOCIATED_WITH', undefined, undefined, 'internal'),
        e(`${id}-vmss`, `${id}-sql`, 'SQL / 1433', 'CONNECTS_TO', 'TDS', 1433, 'private'),
        e(`${id}-vmss`, `${id}-redis`, 'Redis / 6380', 'CONNECTS_TO', 'Redis SSL', 6380, 'private'),
        e(`${id}-vmss`, `${id}-kv`, 'Managed Identity / KeyVault', 'AUTHENTICATES_WITH', 'Managed Identity', 443, 'private'),
      ];
      return { nodes, edges };
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Azure — Serverless API (Azure Functions)
// ════════════════════════════════════════════════════════════════════════════
function azureServerlessApi(): ArchitectureTemplate {
  const id = 'ref-azure-serverless-api';
  return {
    id,
    name: 'Serverless API (Azure Functions)',
    category: 'Serverless',
    description: 'Azure Front Door serves a static frontend from Blob Storage and routes API calls to an HTTP-triggered Azure Function, which reads/writes Azure SQL Database. Secrets are held in Key Vault and accessed via the Function\'s managed identity — no VNet or always-on compute required.',
    provider: 'azure',
    complexity: 'simple',
    estimatedCost: 30,
    resourceCount: 5,
    isAdaptive: false,
    scaleRecommendation: 'Consumption-plan Functions scale automatically per request; no manual capacity planning required.',
    isReferenceArchitecture: true,
    architecturePattern: 'Serverless API',
    useCases: ['Public APIs with spiky traffic', 'Low-ops backends and MVPs on Azure'],
    availabilityTarget: 'Regional managed-service availability (Functions/SQL SLAs) — no VM/VMSS to keep highly available',
    supportedScale: 'Near-zero to high-throughput — Consumption plan scales per-request',
    dataFlowSummary: 'Browser → Front Door (static assets from Blob Storage, API routed to Functions) → Azure Functions → Azure SQL',
    sourceReferences: [AZURE_ARCH_CENTER, { label: 'Azure Functions documentation', url: 'https://learn.microsoft.com/azure/azure-functions/' }],
    features: [
      'Consumption-plan Azure Functions — pay per execution',
      'No VNet or NAT Gateway required',
      'Managed identity used for Function → Key Vault access instead of stored secrets',
      'Static frontend served directly from Blob Storage via Front Door',
    ],
    tags: ['azure', 'serverless', 'functions', 'api'],
    generate(_opts: TemplateGenerateOptions = {}) {
      const nodes: CanvasNode[] = [
        n(`${id}-cloud`, 'azure_cloud_boundary', 'azure', 'Microsoft Azure (East US)', 30, 20, { region: 'eastus' }, undefined, 900, 420),
        n(`${id}-fd`, 'azure_front_door', 'azure', 'Azure Front Door', 350, 80, {}, `${id}-cloud`),
        n(`${id}-storage`, 'azure_storage', 'azure', 'Static Frontend (Blob Storage)', 600, 80, { sku: 'Standard_LRS', kind: 'StorageV2', httpsOnly: true, allowBlobPublicAccess: false }, `${id}-cloud`),
        n(`${id}-func`, 'azure_functions', 'azure', 'API Function (Consumption Plan)', 350, 230, {}, `${id}-cloud`),
        n(`${id}-kv`, 'azure_key_vault', 'azure', 'Key Vault (Connection Secrets)', 80, 230, {}, `${id}-cloud`),
        n(`${id}-sql`, 'azure_sql', 'azure', 'Azure SQL Database', 600, 230, { tier: 'GeneralPurpose', publicNetworkAccess: false, threatDetectionEnabled: true }, `${id}-cloud`),
      ];
      const edges: CanvasEdge[] = [
        e(`${id}-fd`, `${id}-storage`, 'Static Blob Origin', 'SERVES', 'Blob HTTPS', 443, 'public'),
        e(`${id}-fd`, `${id}-func`, 'API Origin', 'ROUTES_TO', 'HTTPS Origin', 443, 'public'),
        e(`${id}-func`, `${id}-kv`, 'Managed Identity / KeyVault', 'AUTHENTICATES_WITH', 'Managed Identity', 443, 'private'),
        e(`${id}-func`, `${id}-sql`, 'SQL / 1433', 'CONNECTS_TO', 'TDS', 1433, 'private'),
      ];
      return { nodes, edges };
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Azure — AKS Microservices Platform
// ════════════════════════════════════════════════════════════════════════════
function azureAksPlatform(): ArchitectureTemplate {
  const id = 'ref-azure-aks-platform';
  return {
    id,
    name: 'AKS Container Platform',
    category: 'Containers / Kubernetes',
    description: 'Application Gateway acts as the in-cluster ingress controller\'s upstream, routing into an Azure Kubernetes Service cluster. Pods connect out to Azure SQL Database for durable state and Azure Cache for Redis for session/cache state, both isolated in a dedicated data subnet.',
    provider: 'azure',
    complexity: 'complex',
    estimatedCost: 150,
    resourceCount: 10,
    isAdaptive: true,
    scaleRecommendation: 'AKS cluster autoscaler adjusts node count based on pod scheduling pressure; Azure SQL scales via vCore/tier changes.',
    isReferenceArchitecture: true,
    architecturePattern: 'Managed Kubernetes (AKS)',
    useCases: ['Teams standardized on Kubernetes/Helm on Azure', 'Portable workloads intended to also run on other clouds/on-prem'],
    availabilityTarget: 'Zone-redundant AKS node pools with the managed control plane',
    supportedScale: 'Small clusters to large multi-team platforms',
    dataFlowSummary: 'Internet → Application Gateway (ingress) → AKS pods → Azure SQL (durable data) / Azure Cache for Redis (cache/session)',
    sourceReferences: [AZURE_ARCH_CENTER, { label: 'Azure Kubernetes Service documentation', url: 'https://learn.microsoft.com/azure/aks/' }],
    features: [
      'Application Gateway as cluster ingress',
      'AKS-managed Kubernetes control plane',
      'Azure SQL and Azure Cache for Redis isolated in a dedicated data subnet',
      'Key Vault for cluster/application secrets via managed identity',
    ],
    tags: ['azure', 'kubernetes', 'aks', 'containers'],
    generate(_opts: TemplateGenerateOptions = {}) {
      const nodes: CanvasNode[] = [
        n(`${id}-cloud`, 'azure_cloud_boundary', 'azure', 'Microsoft Azure (East US)', 30, 20, { region: 'eastus' }, undefined, 1100, 720),
        n(`${id}-rg`, 'azure_resource_group', 'azure', 'Production Resource Group', 60, 80, {}, `${id}-cloud`, 1020, 620),
        n(`${id}-vnet`, 'azure_vnet', 'azure', 'Production VNet (10.0.0.0/16)', 90, 130, { addressSpace: '10.0.0.0/16' }, `${id}-rg`, 920, 520),
        n(`${id}-sub-ingress`, 'azure_subnet', 'azure', 'Ingress Subnet (10.0.1.0/24)', 120, 190, { addressPrefix: '10.0.1.0/24' }, `${id}-vnet`, 380, 140),
        n(`${id}-appgw`, 'azure_app_gateway', 'azure', 'Application Gateway (Ingress)', 160, 240, {}, `${id}-sub-ingress`),
        n(`${id}-sub-nodes`, 'azure_subnet', 'azure', 'AKS Node Subnet (10.0.10.0/24)', 120, 350, { addressPrefix: '10.0.10.0/24' }, `${id}-vnet`, 380, 150),
        n(`${id}-aks`, 'azure_aks', 'azure', 'AKS Cluster', 160, 400, { nodeCount: 4 }, `${id}-sub-nodes`),
        n(`${id}-sub-data`, 'azure_subnet', 'azure', 'Data Subnet (10.0.20.0/24)', 560, 350, { addressPrefix: '10.0.20.0/24' }, `${id}-vnet`, 380, 150),
        n(`${id}-sql`, 'azure_sql', 'azure', 'Azure SQL Database', 600, 400, { tier: 'GeneralPurpose', publicNetworkAccess: false, threatDetectionEnabled: true }, `${id}-sub-data`),
        n(`${id}-redis`, 'azure_redis', 'azure', 'Azure Cache for Redis', 600, 490, {}, `${id}-sub-data`),
      ];
      const edges: CanvasEdge[] = [
        e(`${id}-appgw`, `${id}-aks`, 'Backend Pool / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e(`${id}-aks`, `${id}-sql`, 'SQL / 1433', 'CONNECTS_TO', 'TDS', 1433, 'private'),
        e(`${id}-aks`, `${id}-redis`, 'Redis / 6380', 'CONNECTS_TO', 'Redis SSL', 6380, 'private'),
      ];
      return { nodes, edges };
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Azure — Multi-Region Disaster Recovery
// ════════════════════════════════════════════════════════════════════════════
function azureMultiRegionDr(): ArchitectureTemplate {
  const id = 'ref-azure-dr-warm-standby';
  return {
    id,
    name: 'Multi-Region Disaster Recovery (Warm Standby)',
    category: 'Disaster Recovery',
    description: 'A primary region (East US) runs full production capacity behind Azure Front Door; a secondary region (West US) runs a downsized but live standby stack. Azure SQL geo-replication keeps the standby database current, and Front Door\'s priority-based routing shifts traffic to the standby region on primary failure.',
    provider: 'azure',
    complexity: 'complex',
    estimatedCost: 220,
    resourceCount: 12,
    isAdaptive: false,
    scaleRecommendation: 'Standby region VMSS capacity is deliberately smaller than primary; scale it up as part of a failover runbook.',
    isReferenceArchitecture: true,
    architecturePattern: 'Multi-Region Disaster Recovery (Warm Standby)',
    useCases: ['Regulated workloads requiring a documented DR region on Azure', 'RTO/RPO requirements stricter than backup/restore'],
    availabilityTarget: 'Multi-Region — tolerates a full regional outage; RPO bounded by Azure SQL geo-replication lag (asynchronous)',
    supportedScale: 'Primary region sized for production load; standby sized smaller until a failover is promoted',
    dataFlowSummary: 'Azure Front Door (priority routing) directs traffic to the primary region\'s Application Gateway; on failure, it shifts to the standby region. Azure SQL in the standby region is a geo-replicated secondary fed asynchronously from the primary.',
    sourceReferences: [AZURE_WAF_FRAMEWORK, { label: 'Azure SQL Database active geo-replication documentation', url: 'https://learn.microsoft.com/azure/azure-sql/database/active-geo-replication-overview' }],
    features: [
      'Azure Front Door priority-based failover routing',
      'Warm standby: live but downsized secondary-region capacity',
      'Azure SQL active geo-replication for the database tier',
    ],
    tags: ['azure', 'disaster-recovery', 'multi-region', 'geo-replication'],
    generate(_opts: TemplateGenerateOptions = {}) {
      const nodes: CanvasNode[] = [
        n(`${id}-fd`, 'azure_front_door', 'azure', 'Azure Front Door (Priority Routing)', 480, 20, {}),

        n(`${id}-cloud-primary`, 'azure_cloud_boundary', 'azure', 'Primary Region (East US)', 30, 120, { region: 'eastus' }, undefined, 560, 460),
        n(`${id}-appgw-primary`, 'azure_app_gateway', 'azure', 'Application Gateway (Primary)', 70, 190, {}, `${id}-cloud-primary`),
        n(`${id}-vmss-primary`, 'azure_vmss', 'azure', 'VMSS (Primary)', 70, 300, { sku: 'Standard_D2s_v5', capacity: 4, osType: 'Linux' }, `${id}-cloud-primary`),
        n(`${id}-sql-primary`, 'azure_sql', 'azure', 'Azure SQL (Primary)', 70, 410, { tier: 'GeneralPurpose', publicNetworkAccess: false }, `${id}-cloud-primary`),

        n(`${id}-cloud-secondary`, 'azure_cloud_boundary', 'azure', 'Standby Region (West US)', 640, 120, { region: 'westus' }, undefined, 560, 460),
        n(`${id}-appgw-secondary`, 'azure_app_gateway', 'azure', 'Application Gateway (Standby)', 680, 190, {}, `${id}-cloud-secondary`),
        n(`${id}-vmss-secondary`, 'azure_vmss', 'azure', 'VMSS (Standby, downsized)', 680, 300, { sku: 'Standard_D2s_v5', capacity: 1, osType: 'Linux' }, `${id}-cloud-secondary`),
        n(`${id}-sql-secondary`, 'azure_sql', 'azure', 'Azure SQL (Geo-Replica)', 680, 410, { tier: 'GeneralPurpose', publicNetworkAccess: false }, `${id}-cloud-secondary`),
      ];
      const edges: CanvasEdge[] = [
        e(`${id}-fd`, `${id}-appgw-primary`, 'Backend Pool HTTPS (Priority 1)', 'ROUTES_TO', 'HTTPS Origin', 443, 'public'),
        e(`${id}-fd`, `${id}-appgw-secondary`, 'Backend Pool HTTPS (Priority 2 / Failover)', 'ROUTES_TO', 'HTTPS Origin', 443, 'public'),
        e(`${id}-appgw-primary`, `${id}-vmss-primary`, 'Backend Pool / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e(`${id}-appgw-secondary`, `${id}-vmss-secondary`, 'Backend Pool / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e(`${id}-vmss-primary`, `${id}-sql-primary`, 'SQL / 1433', 'CONNECTS_TO', 'TDS', 1433, 'private'),
        e(`${id}-vmss-secondary`, `${id}-sql-secondary`, 'SQL / 1433', 'CONNECTS_TO', 'TDS', 1433, 'private'),
        e(`${id}-sql-primary`, `${id}-sql-secondary`, 'Active Geo-Replication', 'REPLICATES_TO', undefined, undefined, 'cross-region'),
      ];
      return { nodes, edges };
    },
  };
}

export const azureReferenceArchitectures: ArchitectureTemplate[] = [
  azureThreeTierVmss(),
  azureServerlessApi(),
  azureAksPlatform(),
  azureMultiRegionDr(),
];

// ════════════════════════════════════════════════════════════════════════════
// Multi-Cloud — AWS Primary + Azure Disaster Recovery
// ════════════════════════════════════════════════════════════════════════════
function multiCloudAwsPrimaryAzureDr(): ArchitectureTemplate {
  const id = 'ref-multi-aws-primary-azure-dr';
  return {
    id,
    name: 'AWS Primary + Azure Disaster Recovery',
    category: 'Disaster Recovery',
    description: 'Production traffic is served entirely from AWS (ALB + Auto Scaling Group + RDS Multi-AZ). A minimal standby stack in Azure (Application Gateway + VMSS + Azure SQL) is kept ready to take over if the AWS region becomes unavailable. Since neither provider offers a managed cross-cloud database replication service, a dedicated small compute instance on each side runs a scheduled export/import job to keep the standby data current. DNS-level failover between the two providers is customer-managed (e.g. a third-party DNS service with health checks on both endpoints, since neither Route 53 nor Azure Front Door can health-check and fail over to the other cloud natively).',
    provider: 'multi',
    complexity: 'complex',
    estimatedCost: 260,
    resourceCount: 13,
    isAdaptive: false,
    scaleRecommendation: 'Azure standby capacity is intentionally minimal; this pattern trades a longer RTO (data pipeline lag + manual promotion) for avoiding a second cloud\'s full production cost.',
    isReferenceArchitecture: true,
    architecturePattern: 'Multi-Cloud Disaster Recovery (AWS Primary, Azure Standby)',
    useCases: ['Organizations required to prove they can operate outside a single cloud provider (regulatory or contractual)', 'Reducing single-vendor dependency for business continuity'],
    availabilityTarget: 'Tolerates a full AWS provider-level outage, not just a regional one — at the cost of asynchronous, non-real-time data currency in the standby',
    supportedScale: 'Primary sized for full production load on AWS; Azure standby sized only to serve traffic during an active failover',
    dataFlowSummary: 'Users → AWS ALB → AWS Auto Scaling Group → AWS RDS (source of truth). A dedicated EC2 sync job periodically exports from RDS and ships the data cross-cloud to an Azure VM sync receiver, which loads it into Azure SQL. On an AWS outage, DNS is manually or automatically (via a third-party multi-cloud DNS/health-check service) repointed to the Azure Application Gateway.',
    sourceReferences: [AWS_WAF_FRAMEWORK, AZURE_WAF_FRAMEWORK],
    features: [
      'Full production stack on AWS; minimal standby stack on Azure',
      'Explicit, honestly-labeled data pipeline between clouds (not a fabricated managed replication service)',
      'Avoids single cloud-provider dependency for business continuity',
    ],
    tags: ['multi-cloud', 'disaster-recovery', 'aws', 'azure'],
    generate(_opts: TemplateGenerateOptions = {}) {
      const nodes: CanvasNode[] = [
        n(`${id}-aws-cloud`, 'aws_cloud_boundary', 'aws', 'AWS — Primary (us-east-1)', 30, 20, { region: 'us-east-1' }, undefined, 560, 460),
        n(`${id}-alb`, 'aws_alb', 'aws', 'Application Load Balancer', 70, 90, { lbType: 'application', scheme: 'internet-facing' }, `${id}-aws-cloud`),
        n(`${id}-asg`, 'aws_auto_scaling', 'aws', 'Auto Scaling Group', 70, 200, { minSize: 4, maxSize: 12, desiredCapacity: 4 }, `${id}-aws-cloud`),
        n(`${id}-rds`, 'aws_rds', 'aws', 'RDS PostgreSQL (Multi-AZ, source of truth)', 70, 310, { engine: 'postgres', multiAz: true, encrypted: true, publiclyAccessible: false }, `${id}-aws-cloud`),
        n(`${id}-sync-job`, 'aws_ec2', 'aws', 'Cross-Cloud Sync Job (EC2, scheduled)', 350, 310, { instanceType: 't3.small' }, `${id}-aws-cloud`),

        n(`${id}-azure-cloud`, 'azure_cloud_boundary', 'azure', 'Azure — Standby (West US)', 640, 20, { region: 'westus' }, undefined, 560, 460),
        n(`${id}-appgw`, 'azure_app_gateway', 'azure', 'Application Gateway', 680, 90, {}, `${id}-azure-cloud`),
        n(`${id}-vmss`, 'azure_vmss', 'azure', 'VMSS (Standby, minimal)', 680, 200, { sku: 'Standard_D2s_v5', capacity: 1, osType: 'Linux' }, `${id}-azure-cloud`),
        n(`${id}-sql`, 'azure_sql', 'azure', 'Azure SQL (Standby Copy)', 680, 310, { tier: 'GeneralPurpose', publicNetworkAccess: false }, `${id}-azure-cloud`),
        n(`${id}-sync-receiver`, 'azure_vm', 'azure', 'Sync Receiver (VM, scheduled)', 960, 310, { size: 'Standard_B2s', osType: 'Linux' }, `${id}-azure-cloud`),
      ];
      const edges: CanvasEdge[] = [
        e(`${id}-alb`, `${id}-asg`, 'Balance HTTP / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e(`${id}-asg`, `${id}-rds`, 'PostgreSQL / 5432', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e(`${id}-appgw`, `${id}-vmss`, 'Backend Pool / 80', 'LOAD_BALANCES', 'HTTP', 80, 'private'),
        e(`${id}-vmss`, `${id}-sql`, 'SQL / 1433', 'CONNECTS_TO', 'TDS', 1433, 'private'),
        e(`${id}-sync-job`, `${id}-rds`, 'Scheduled Export', 'CONNECTS_TO', 'PostgreSQL', 5432, 'private'),
        e(`${id}-sync-job`, `${id}-sync-receiver`, 'Cross-Cloud Data Transfer (customer-managed pipeline)', 'REPLICATES_TO', 'HTTPS', 443, 'cross-cloud'),
        e(`${id}-sync-receiver`, `${id}-sql`, 'Scheduled Import', 'CONNECTS_TO', 'TDS', 1433, 'private'),
      ];
      return { nodes, edges };
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Multi-Cloud — Cross-Cloud Data Analytics Pipeline
// ════════════════════════════════════════════════════════════════════════════
// Note: an earlier draft of this second multi-cloud pattern modeled a "hybrid
// identity bridge" (AWS workload authenticating against Azure AD/Entra ID).
// It was dropped: the RDE has no identity-provider resource type, so the only
// way to draw it was to point a connection at a bare, otherwise-empty VNet
// standing in for Entra ID — which both misrepresents the service and fails
// canonical validation's cross-cloud edge check (VNet doesn't qualify as a
// valid cross-cloud endpoint type). Rather than fake it, this data-pipeline
// pattern replaces it — it needs only resource types the RDE already has.
function multiCloudDataPipeline(): ArchitectureTemplate {
  const id = 'ref-multi-data-pipeline';
  return {
    id,
    name: 'Cross-Cloud Data Analytics Pipeline',
    category: 'Data & Analytics',
    description: 'Operational data is generated and stored in an AWS S3 data lake (where the rest of the workload already runs), then exported by a Lambda function to Azure Blob Storage as a landing zone for an organization whose analytics/BI investment is on Azure. An Azure Function transforms the landed data into Azure SQL Database as a query-ready store.',
    provider: 'multi',
    complexity: 'moderate',
    estimatedCost: 90,
    resourceCount: 6,
    isAdaptive: false,
    scaleRecommendation: 'Both the export and transform steps are serverless (Lambda/Functions) and scale with data volume; no fixed capacity to size.',
    isReferenceArchitecture: true,
    architecturePattern: 'Cross-Cloud Data Pipeline (data gravity in AWS, analytics investment in Azure)',
    useCases: ['Organizations running operational workloads on AWS but standardized on Azure/Power BI for analytics', 'Post-acquisition environments with workloads split across two clouds'],
    availabilityTarget: 'Each stage relies on its own provider\'s managed-service availability; pipeline is asynchronous and tolerates transient failures via retry, not a live/HA data path',
    supportedScale: 'Batch/near-real-time volumes — bounded by Lambda/Functions execution limits, not modeled here',
    dataFlowSummary: 'AWS S3 (raw data) → AWS Lambda (export) → Azure Blob Storage (landing zone) → Azure Functions (transform) → Azure SQL Database (query-ready)',
    sourceReferences: [AWS_ARCH_CENTER, AZURE_ARCH_CENTER],
    features: [
      'Keeps operational data in AWS where the rest of the workload runs',
      'Feeds an Azure-based analytics/BI investment without duplicating the whole stack',
      'Fully serverless pipeline — no idle compute cost between runs',
    ],
    tags: ['multi-cloud', 'aws', 'azure', 'data-pipeline', 'analytics'],
    generate(_opts: TemplateGenerateOptions = {}) {
      const nodes: CanvasNode[] = [
        n(`${id}-aws-cloud`, 'aws_cloud_boundary', 'aws', 'AWS — Operational Data (us-east-1)', 30, 20, { region: 'us-east-1' }, undefined, 480, 300),
        n(`${id}-s3`, 'aws_s3', 'aws', 'S3 Data Lake (raw)', 80, 90, { versioning: true, encryption: true }, `${id}-aws-cloud`),
        n(`${id}-lambda`, 'aws_lambda', 'aws', 'Export Function (Lambda)', 80, 200, { runtime: 'nodejs20.x' }, `${id}-aws-cloud`),

        n(`${id}-azure-cloud`, 'azure_cloud_boundary', 'azure', 'Azure — Analytics (East US)', 560, 20, { region: 'eastus' }, undefined, 560, 300),
        n(`${id}-storage`, 'azure_storage', 'azure', 'Blob Storage (landing zone)', 610, 90, { sku: 'Standard_LRS', kind: 'StorageV2', httpsOnly: true, allowBlobPublicAccess: false }, `${id}-azure-cloud`),
        n(`${id}-func`, 'azure_functions', 'azure', 'Transform Function', 850, 90, {}, `${id}-azure-cloud`),
        n(`${id}-sql`, 'azure_sql', 'azure', 'Azure SQL Database (query-ready)', 850, 200, { tier: 'GeneralPurpose', publicNetworkAccess: false }, `${id}-azure-cloud`),
      ];
      const edges: CanvasEdge[] = [
        e(`${id}-lambda`, `${id}-s3`, 'Read Raw Objects', 'READS_FROM', 'HTTPS', 443, 'private'),
        e(`${id}-lambda`, `${id}-storage`, 'Cross-Cloud Export', 'DATA_FLOW', 'HTTPS', 443, 'cross-cloud'),
        e(`${id}-storage`, `${id}-func`, 'Blob Trigger', 'TRIGGERS', undefined, undefined, 'internal'),
        e(`${id}-func`, `${id}-sql`, 'SQL / 1433', 'CONNECTS_TO', 'TDS', 1433, 'private'),
      ];
      return { nodes, edges };
    },
  };
}

export const multiCloudReferenceArchitectures: ArchitectureTemplate[] = [
  multiCloudAwsPrimaryAzureDr(),
  multiCloudDataPipeline(),
];

export const allReferenceArchitectures: ArchitectureTemplate[] = [
  ...awsReferenceArchitectures,
  ...azureReferenceArchitectures,
  ...multiCloudReferenceArchitectures,
];
