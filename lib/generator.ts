import { AIGeneratorResult, CanvasNode, CanvasEdge, WizardOptions, Recommendation, CostOptimization } from '@/types';
import { architectureTemplates, getTemplate } from './templates';

// ─── AI Generator ─────────────────────────────────────────────────────────────
const promptKeywords: Record<string, string[]> = {
  prod1000_azure: ['azure 1000', 'azure production', '1000 user azure', 'azure front door'],
  prod1000_aws:   ['1000', '1,000', 'thousand user', 'production reference', 'production architecture', 'baseline'],
  saas:           ['saas', 'multi-tenant', 'platform', 'subscription'],
  ha:             ['highly available', 'high availability', 'multi-az', 'redundant', 'failover'],
  microservices:  ['microservice', 'microservices', 'container', 'service mesh'],
  datalake:       ['data lake', 'analytics', 'etl', 'big data', 'warehouse'],
  ecommerce:      ['ecommerce', 'e-commerce', 'shop', 'store', 'commerce'],
  dr:             ['disaster recovery', 'dr', 'backup', 'failover', 'rto', 'rpo'],
  multicloud:     ['multi-cloud', 'multicloud', 'azure and aws', 'hybrid cloud'],
  '3tier':        ['3-tier', 'three tier', 'web application', 'frontend', 'backend', 'database'],
};

function detectTemplateFromPrompt(prompt: string): string {
  const lower = prompt.toLowerCase();
  for (const [key, words] of Object.entries(promptKeywords)) {
    if (words.some((w) => lower.includes(w))) {
      switch (key) {
        case 'prod1000_azure': return 'azure-1000-user-production';
        case 'prod1000_aws':   return 'aws-1000-user-production';
        case 'saas':           return 'saas';
        case 'ha':             return 'ha-web';
        case 'microservices':  return 'microservices';
        case 'datalake':       return 'data-lake';
        case 'ecommerce':      return 'ecommerce';
        case 'dr':             return 'disaster-recovery';
        case 'multicloud':     return 'multicloud';
        default:               return '3tier-web';
      }
    }
  }
  return 'aws-1000-user-production';
}

function extractResources(prompt: string): string[] {
  const lower = prompt.toLowerCase();
  const found: string[] = [];
  if (lower.includes('react') || lower.includes('frontend') || lower.includes('web')) found.push('Load Balancer', 'S3 (static assets)');
  if (lower.includes('node') || lower.includes('api') || lower.includes('backend')) found.push('EC2 Instances (API layer)');
  if (lower.includes('postgres') || lower.includes('database') || lower.includes('sql')) found.push('RDS PostgreSQL');
  if (lower.includes('redis') || lower.includes('cache')) found.push('ElastiCache Redis');
  if (lower.includes('storage') || lower.includes('object')) found.push('S3 Bucket');
  if (lower.includes('queue') || lower.includes('message')) found.push('SQS Queue');
  if (lower.includes('serverless') || lower.includes('lambda')) found.push('Lambda Functions');
  if (lower.includes('container') || lower.includes('docker')) found.push('ECS/EKS Cluster');
  if (lower.includes('cdn') || lower.includes('cloudfront')) found.push('CloudFront CDN');
  if (found.length === 0) found.push('VPC', 'EC2 Instances', 'RDS Database', 'ALB');
  return [...new Set(found)];
}

function buildSummary(prompt: string, templateId: string): string {
  const template = getTemplate(templateId);
  if (template) {
    return `Generated a **${template.name}** architecture based on your requirements. The design includes ${template.features.slice(0, 3).join(', ')} and follows AWS Well-Architected Framework best practices.`;
  }
  return `Generated a cloud architecture based on your description. Resources have been placed on the canvas with appropriate networking, security groups, and connectivity.`;
}

export function generateFromPrompt(prompt: string): AIGeneratorResult {
  const templateId = detectTemplateFromPrompt(prompt);
  const template = getTemplate(templateId);
  if (!template) {
    return { nodes: [], edges: [], summary: 'Could not generate architecture.', suggestedResources: [], estimatedCost: 0, securityScore: 0 };
  }
  const { nodes, edges } = template.generate({ highAvailability: prompt.toLowerCase().includes('highly available') });
  const validation = architectureValidator.validate(nodes, edges);
  return {
    nodes,
    edges,
    summary: buildSummary(prompt, templateId),
    suggestedResources: extractResources(prompt),
    estimatedCost: template.estimatedCost,
    securityScore: validation.score.security,
  };
}

// ─── Wizard Generator ─────────────────────────────────────────────────────────
export function generateFromWizard(opts: WizardOptions): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const template = getTemplate(opts.templateId) ?? architectureTemplates[0];
  return template.generate({
    region: opts.region,
    environment: opts.environment,
    highAvailability: opts.highAvailability,
    includeMonitoring: opts.includeMonitoring,
    includeWAF: opts.includeWAF,
  });
}

// ─── Architecture Scoring ─────────────────────────────────────────────────────
import { architectureValidator } from './engines/validation/ArchitectureValidator';

export function scoreArchitecture(nodes: CanvasNode[], edges: CanvasEdge[] = []): {
  overall: number; reliability: number; security: number;
  performance: number; cost: number; scalability: number;
} {
  const report = architectureValidator.validate(nodes, edges);
  return {
    overall: report.score.overall,
    reliability: report.score.reliability,
    security: report.score.security,
    performance: report.score.performance,
    cost: report.score.cost,
    scalability: report.score.scalability,
  };
}

// ─── Architecture Recommendations ─────────────────────────────────────────────
export function generateRecommendations(nodes: CanvasNode[]): Recommendation[] {
  const recs: Recommendation[] = [];
  const hasLB = nodes.some((n) => n.resourceType.includes('alb') || n.resourceType.includes('lb'));
  const hasMultiAZ = nodes.some((n) => n.config?.multiAz === true);
  const hasNAT = nodes.some((n) => n.resourceType.includes('nat'));
  const hasEncryption = nodes.some((n) => n.config?.encrypted === true || n.config?.encryption === true);
  const hasSG = nodes.some((n) => n.resourceType === 'aws_sg' || n.resourceType === 'azure_nsg');
  const ec2Nodes = nodes.filter((n) => n.resourceType === 'aws_ec2');
  const rdsNodes = nodes.filter((n) => n.resourceType === 'aws_rds');

  if (!hasLB && ec2Nodes.length > 0) {
    recs.push({ id: 'r1', category: 'reliability', severity: 'high', title: 'Add a Load Balancer', description: 'Your compute instances have no load balancer. Single-instance deployments are a single point of failure.', affectedResources: ec2Nodes.map((n) => n.label), action: 'Add an Application Load Balancer and distribute traffic across multiple instances.' });
  }
  if (!hasMultiAZ && rdsNodes.length > 0) {
    recs.push({ id: 'r2', category: 'reliability', severity: 'high', title: 'Enable RDS Multi-AZ', description: 'Your RDS instance is not configured for Multi-AZ, creating a single point of failure.', affectedResources: rdsNodes.map((n) => n.label), action: 'Enable Multi-AZ deployment in the RDS configuration to ensure automatic failover.' });
  }
  if (!hasEncryption && rdsNodes.length > 0) {
    recs.push({ id: 'r3', category: 'security', severity: 'high', title: 'Enable Encryption at Rest', description: 'One or more databases are not using encryption at rest, exposing sensitive data.', affectedResources: rdsNodes.map((n) => n.label), action: 'Enable storage encryption on all RDS instances.' });
  }
  if (!hasSG) {
    recs.push({ id: 'r4', category: 'security', severity: 'medium', title: 'Add Security Groups', description: 'No security groups are defined. Resources are accessible without network-level controls.', affectedResources: ['All compute resources'], action: 'Define Security Groups with least-privilege rules for each resource.' });
  }
  if (!hasNAT && nodes.some((n) => n.resourceType === 'aws_ec2')) {
    recs.push({ id: 'r5', category: 'security', severity: 'medium', title: 'Use NAT Gateway for Outbound Traffic', description: 'Compute resources in private subnets should use a NAT Gateway rather than direct internet access.', affectedResources: ec2Nodes.map((n) => n.label), action: 'Add a NAT Gateway to route outbound traffic from private subnets.' });
  }
  if (ec2Nodes.length > 3) {
    recs.push({ id: 'r6', category: 'cost', severity: 'low', title: 'Consider Auto Scaling', description: `You have ${ec2Nodes.length} EC2 instances. Auto Scaling can reduce costs during low-traffic periods.`, affectedResources: ec2Nodes.map((n) => n.label), action: 'Replace static EC2 instances with an Auto Scaling Group to automatically adjust capacity.' });
  }
  if (nodes.length > 10) {
    recs.push({ id: 'r7', category: 'scalability', severity: 'low', title: 'Consider Microservices Architecture', description: 'Large monolithic deployments become difficult to scale independently.', affectedResources: ['Architecture'], action: 'Break down monolithic services into independently deployable microservices.' });
  }
  recs.push({ id: 'r8', category: 'performance', severity: 'low', title: 'Add CloudWatch Monitoring', description: 'No monitoring resources detected. Visibility into performance is critical for production workloads.', affectedResources: ['All resources'], action: 'Enable CloudWatch metrics, dashboards, and alerts for all critical resources.' });
  return recs;
}

// ─── Cost Optimizations ────────────────────────────────────────────────────────
export function generateCostOptimizations(nodes: CanvasNode[]): CostOptimization[] {
  const opts: CostOptimization[] = [];
  for (const node of nodes) {
    if (node.resourceType === 'aws_ec2' && (node.config.instanceType as string)?.startsWith('m5.xl')) {
      opts.push({ id: `opt-${node.id}`, nodeId: node.id, nodeLabel: node.label, title: 'Right-size instance', description: `${node.label} is using ${node.config.instanceType}. Switching to m5.large could save ~$90/month based on avg utilization.`, potentialSavings: 87.6, effort: 'low' });
    }
    if (node.resourceType === 'aws_nat' && nodes.filter((n) => n.resourceType === 'aws_nat').length > 1) {
      opts.push({ id: `opt-nat-${node.id}`, nodeId: node.id, nodeLabel: node.label, title: 'Consolidate NAT Gateways', description: 'Multiple NAT Gateways detected. Consider using a single NAT Gateway to reduce costs.', potentialSavings: 45, effort: 'medium' });
    }
    if (node.resourceType === 'aws_rds' && !(node.config.multiAz) && (node.config.instanceClass as string)?.includes('r5')) {
      opts.push({ id: `opt-rds-${node.id}`, nodeId: node.id, nodeLabel: node.label, title: 'Use Reserved Instance pricing', description: `${node.label} is on-demand. Switching to a 1-year Reserved Instance saves ~40%.`, potentialSavings: 58, effort: 'low' });
    }
    if (node.resourceType === 'aws_s3') {
      opts.push({ id: `opt-s3-${node.id}`, nodeId: node.id, nodeLabel: node.label, title: 'Enable S3 Intelligent-Tiering', description: 'Use S3 Intelligent-Tiering to automatically move objects to cheaper storage classes.', potentialSavings: 12, effort: 'low' });
    }
  }
  return opts;
}
