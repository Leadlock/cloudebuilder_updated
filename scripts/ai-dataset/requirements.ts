/**
 * The requirement dimensions a user can express, and the natural-language prompts
 * generated from them. Every dataset example is one point in this lattice.
 */
export type Provider = 'aws' | 'azure' | 'multi';
export type Scale = 'small' | 'medium' | 'large';
export type Database = 'postgres' | 'mysql' | 'nosql' | 'none';

export interface Requirements {
  provider: Provider;
  /** Pattern id (see patterns.ts). */
  pattern: string;
  /** Primary region id (AWS region or Azure location). */
  region: string;
  /** Secondary region/location (multi-cloud: the Azure side). */
  regionB?: string;
  scale: Scale;
  db: Database;
  cache: boolean;
  /** Global CDN / edge (CloudFront or Front Door) in front of the app. */
  cdn: boolean;
  /** Regulated workload: stricter WAF, longer backups, extra monitoring, private-only management. */
  regulated: boolean;
  /** Asynchronous processing through a queue. */
  queue: boolean;
  /** Short workload name used in labels and the summary, e.g. "storefront". */
  app: string;
}

export const SCALE_USERS: Record<Scale, string[]> = {
  small: ['about 1,000 users', 'around 2,000 daily active users', 'a few thousand users', '~1k concurrent users at peak'],
  medium: ['about 25,000 users', 'around 50,000 daily active users', 'tens of thousands of users', '~5k concurrent users at peak'],
  large: ['about 250,000 users', 'several hundred thousand daily active users', '~50k concurrent users at peak', 'over 500,000 users'],
};

export const APP_NAMES = [
  'storefront', 'orders', 'booking', 'patient-portal', 'ledger', 'catalog', 'analytics', 'support-desk', 'inventory', 'media',
  'payments', 'crm', 'learning', 'fleet', 'telemetry', 'marketplace', 'billing', 'reports', 'identity', 'scheduler',
];

/** Human descriptions of each pattern, used to phrase prompts. */
export const PATTERN_TEXT: Record<string, { title: string; phrases: string[] }> = {
  'aws-three-tier': { title: 'three-tier web application on EC2 Auto Scaling', phrases: ['a classic three-tier web application on virtual machines', 'a load-balanced web app on EC2 with a relational database', 'an auto-scaling VM-based web tier with a managed database'] },
  'aws-ecs': { title: 'containerised web application on ECS Fargate', phrases: ['a containerised web application on ECS Fargate', 'a Docker-based service on ECS behind a load balancer', 'containers on Fargate with a managed database'] },
  'aws-eks': { title: 'Kubernetes platform on EKS', phrases: ['a Kubernetes platform on EKS', 'a microservices platform running on EKS', 'a private EKS cluster for our services'] },
  'aws-serverless': { title: 'serverless web application and API', phrases: ['a serverless web application with an API', 'a Lambda-based API with a static front end', 'a fully serverless backend with DynamoDB'] },
  'aws-queue-worker': { title: 'web application with asynchronous queue workers', phrases: ['a web app that hands long-running jobs to background workers through a queue', 'a web tier plus queue-driven worker fleet', 'an order-processing style app with async workers'] },
  'azure-three-tier': { title: 'three-tier web application on Virtual Machine Scale Sets', phrases: ['a classic three-tier web application on virtual machines', 'a load-balanced web app on VM scale sets with Azure SQL', 'an auto-scaling VM-based web tier with a managed database'] },
  'azure-app-service': { title: 'web application on Azure App Service', phrases: ['a web application on Azure App Service', 'a PaaS web app with a managed database', 'an App Service based website with SQL'] },
  'azure-serverless': { title: 'serverless API on Azure Functions', phrases: ['a serverless API on Azure Functions', 'an event-driven backend using Functions and Cosmos DB', 'a Functions-based API with a static site'] },
  'azure-aks': { title: 'Kubernetes platform on AKS', phrases: ['a Kubernetes platform on AKS', 'a microservices platform running on AKS', 'a private AKS cluster for our services'] },
  'aws-static-site': { title: 'static website on S3 and CloudFront', phrases: ['a static website on S3 and CloudFront', 'a marketing site or SPA served from S3 behind a CDN', 'a serverless static front end with a WAF'] },
  'aws-event-driven': { title: 'event-driven processing with SQS and Lambda', phrases: ['an event-driven pipeline that processes uploaded files with a queue and Lambda workers', 'asynchronous processing using S3, SQS and Lambda', 'a queue-buffered serverless worker pipeline'] },
  'aws-lambda-private-api': { title: 'private Lambda API behind a load balancer', phrases: ['a Lambda API that runs inside the VPC and reaches a private database', 'Lambda functions behind an ALB with a PostgreSQL database', 'a private serverless API with no public database endpoint'] },
  'azure-static-site': { title: 'static website on Blob storage and Front Door', phrases: ['a static website on Azure Blob storage with Front Door', 'a marketing site or SPA served from Azure behind a CDN', 'a static front end with a WAF on Azure'] },
  'azure-functions-private-api': { title: 'private Functions API behind Application Gateway', phrases: ['an Azure Functions API inside the VNet with an Azure SQL database', 'Functions behind an Application Gateway WAF with private data services', 'a private serverless API on Azure'] },
  'multi-aws-azure-dr': { title: 'AWS primary with Azure disaster recovery', phrases: ['an AWS primary site with a warm disaster-recovery site on Azure', 'a multi-cloud DR setup: run on AWS, fail over to Azure', 'AWS production with an Azure standby for resilience'] },
  'multi-active-active': { title: 'active-active web application across AWS and Azure', phrases: ['an active-active web application spread across AWS and Azure', 'a multi-cloud web app with one global entry point', 'a vendor-diverse deployment serving traffic from both AWS and Azure'] },
};

const DB_TEXT: Record<Database, string[]> = {
  postgres: ['PostgreSQL', 'a PostgreSQL database', 'Postgres as the relational store'],
  mysql: ['MySQL', 'a MySQL database', 'MySQL as the relational store'],
  nosql: ['a NoSQL document/key-value store', 'a NoSQL database', 'a serverless NoSQL data store'],
  none: [],
};

export type PromptStyle = 'terse' | 'detailed' | 'business' | 'constraints' | 'casual' | 'minimal' | 'technical' | 'question' | 'vague';
export const PROMPT_STYLES: PromptStyle[] = ['terse', 'detailed', 'business', 'constraints', 'casual', 'minimal', 'technical', 'question', 'vague'];

const SHORT_NAME: Record<string, string> = {
  'aws-three-tier': 'three-tier web app on EC2', 'aws-ecs': 'ECS Fargate app', 'aws-eks': 'EKS platform', 'aws-serverless': 'serverless API on Lambda',
  'azure-three-tier': 'three-tier web app on VM scale sets', 'azure-app-service': 'App Service web app', 'azure-serverless': 'Azure Functions API', 'azure-aks': 'AKS platform',
  'multi-aws-azure-dr': 'AWS primary with Azure DR', 'multi-active-active': 'active-active app across AWS and Azure',
};

/**
 * A "vague" prompt names only the cloud, the kind of app and the scale. Everything it does not say must come
 * out as the sensible default — default region, a relational database (NoSQL for serverless), no cache/CDN/queue,
 * not regulated — so the model learns to fill gaps predictably instead of guessing. `fixed` keeps the
 * pattern's own constants (e.g. serverless is always NoSQL with a CDN).
 */
export function vagueRequirements(r: Requirements, fixed: Partial<Requirements> = {}): Requirements {
  return {
    ...r,
    region: r.provider === 'azure' ? 'eastus' : 'us-east-1',
    ...(r.provider === 'multi' ? { regionB: 'eastus' } : {}),
    db: fixed.db ?? 'postgres', cache: fixed.cache ?? false, cdn: fixed.cdn ?? false, queue: fixed.queue ?? false, regulated: false,
  };
}

function cloudName(r: Requirements): string {
  return r.provider === 'aws' ? 'AWS' : r.provider === 'azure' ? 'Azure' : 'AWS and Azure';
}

/** Deterministically choose from a list using a numeric seed. */
const choose = <T>(arr: T[], seed: number): T => arr[Math.abs(seed) % arr.length];

/** Generate a natural-language request for the given requirements. */
export function promptFor(r: Requirements, style: PromptStyle, seed: number): string {
  const pat = PATTERN_TEXT[r.pattern];
  const users = choose(SCALE_USERS[r.scale], seed);
  const regionText = r.provider === 'multi' ? `${r.region} (AWS) and ${r.regionB} (Azure)` : r.region;
  const extras: string[] = [];
  if (r.db !== 'none') extras.push(r.provider !== 'aws' && r.db !== 'nosql' ? choose(['a managed SQL database', 'Azure SQL as the relational store', 'a relational database'], seed + 1) : choose(DB_TEXT[r.db], seed + 1));
  if (r.cache) extras.push(choose(['a Redis cache', 'caching for hot reads', 'an in-memory cache layer'], seed + 2));
  if (r.cdn) extras.push(choose(['a CDN in front', 'global edge delivery with a CDN', 'CDN and WAF at the edge'], seed + 3));
  if (r.queue) extras.push(choose(['a queue for background jobs', 'asynchronous processing through a queue', 'queue-based decoupling'], seed + 4));
  const extraText = extras.length ? ` It needs ${extras.join(', ')}.` : '';
  const reg = r.regulated ? choose([' The data is regulated (think PCI/HIPAA-style controls), so apply the strictest sensible security posture.', ' We handle sensitive customer data and expect an audit, so lock it down.', ' Compliance matters here: encryption, private networking and full monitoring are required.'], seed + 5) : '';

  switch (style) {
    case 'terse':
      return `${cloudName(r)} architecture for ${pat.phrases[0]}, ${users}, ${regionText}.${extras.length ? ' ' + extras.join(', ') + '.' : ''}${r.regulated ? ' Regulated data.' : ''}`;
    case 'detailed':
      return `Design ${choose(pat.phrases, seed)} for a ${r.app.replace(/-/g, ' ')} workload on ${cloudName(r)}, deployed in ${regionText}. Expected load: ${users}.${extraText}${reg} It must be highly available across two availability zones, follow the ${r.provider === 'aws' ? 'AWS' : r.provider === 'azure' ? 'Azure' : 'AWS and Azure'} Well-Architected Framework and be ready to deploy without further changes.`;
    case 'business':
      return `We're launching our ${r.app.replace(/-/g, ' ')} product and expect ${users}. We want ${choose(pat.phrases, seed + 6)} on ${cloudName(r)} in ${regionText}.${extraText}${reg} Give us a production-ready architecture that won't need rework.`;
    case 'minimal':
      return `${cloudName(r)} ${SHORT_NAME[r.pattern] ?? pat.title}, ${users}, ${regionText}${extras.length ? ', ' + extras.join(', ') : ''}${r.regulated ? ', regulated' : ''}.`;
    case 'casual':
      return `hey, we need ${choose(pat.phrases, seed)} on ${cloudName(r)}, ${users}. running it in ${regionText}.${extras.length ? ' we want ' + extras.join(', ') + '.' : ''}${r.regulated ? ' it handles sensitive customer data so please keep it locked down.' : ''} thanks!`;
    case 'technical':
      return `Provision ${pat.title} on ${cloudName(r)} in ${regionText}. Target: ${users}. Data tier: ${r.db === 'none' ? 'none' : r.provider !== 'aws' && r.db !== 'nosql' ? 'managed SQL' : r.db}. ${r.cache ? 'Add a Redis cache tier. ' : ''}${r.cdn ? 'Front it with a CDN and WAF. ' : ''}${r.queue ? 'Use a queue for asynchronous work. ' : ''}Workloads in private subnets across two availability zones, encryption at rest and in transit${r.regulated ? ', audit logging and private-only management' : ''}.`;
    case 'question':
      return `What's a good ${cloudName(r)} architecture for ${choose(pat.phrases, seed)}? We expect ${users} and will run in ${regionText}.${extraText}${r.regulated ? ' It has to meet compliance requirements.' : ''}`;
    case 'vague':
      return `I need ${choose(pat.phrases, seed)} on ${cloudName(r)} for ${users}.`;
    case 'constraints':
      return `Requirements: cloud=${cloudName(r)}; region=${regionText}; workload=${r.app}; pattern=${pat.title}; scale=${users}; database=${r.provider !== 'aws' && r.db !== 'nosql' && r.db !== 'none' ? 'sql' : r.db}; cache=${r.cache ? 'yes' : 'no'}; cdn=${r.cdn ? 'yes' : 'no'}; queue=${r.queue ? 'yes' : 'no'}; regulated=${r.regulated ? 'yes' : 'no'}; availability=multi-AZ; must be deployable as-is.`;
  }
}
