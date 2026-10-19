/**
 * AWS blueprints. Each returns a spec that follows the AWS Well-Architected security,
 * reliability and operational-excellence guidance as implemented by CloudBuilder's rules:
 * workloads in private subnets, data in isolated data subnets, two AZs, WAF on every
 * internet-facing entry point, TLS everywhere, monitoring wired to the workload.
 *
 * Account-specific values (TLS certificate, container image) are written as
 * REPLACE-WITH-YOUR-* placeholders and surfaced by collectDeploymentInputs().
 */
import type { ArchitectureSpec } from '@/lib/ai/architectureSpec';
import { AWS_REGIONS, SpecBuilder, awsCore, type AwsCore, type Cfg } from './builder';
import type { Requirements, Scale } from './requirements';

const CERT = 'arn:aws:acm:REGION:123456789012:certificate/REPLACE-WITH-YOUR-CERTIFICATE-ID';
export const IMAGE = 'REPLACE-WITH-YOUR-CONTAINER-IMAGE';

export const awsRegionOf = (id: string) => AWS_REGIONS.find((r) => r.id === id) ?? AWS_REGIONS[0];

interface AwsSizing {
  asg: { instanceType: string; minSize: number; maxSize: number; desiredCapacity: number };
  rds: { instanceClass: string; allocatedStorage: number; readReplicas?: number; maxAllocatedStorage?: number };
  cache: { nodeType: string };
  ecs: { cpu: number; memory: number; desiredCount: number; minCapacity: number; maxCapacity: number };
  eks: { nodeInstanceType: string; nodeCount: number };
  lambda: { memorySize: number; timeout: number };
}

export const AWS_SIZING: Record<Scale, AwsSizing> = {
  small: {
    asg: { instanceType: 't3.small', minSize: 1, maxSize: 4, desiredCapacity: 1 },
    rds: { instanceClass: 'db.t3.small', allocatedStorage: 50 },
    cache: { nodeType: 'cache.t3.small' },
    ecs: { cpu: 256, memory: 512, desiredCount: 1, minCapacity: 1, maxCapacity: 4 },
    eks: { nodeInstanceType: 't3.medium', nodeCount: 2 },
    lambda: { memorySize: 256, timeout: 10 },
  },
  medium: {
    asg: { instanceType: 't3.large', minSize: 2, maxSize: 8, desiredCapacity: 2 },
    rds: { instanceClass: 'db.m5.large', allocatedStorage: 200, maxAllocatedStorage: 500 },
    cache: { nodeType: 'cache.t3.medium' },
    ecs: { cpu: 1024, memory: 2048, desiredCount: 2, minCapacity: 2, maxCapacity: 10 },
    eks: { nodeInstanceType: 'm5.large', nodeCount: 4 },
    lambda: { memorySize: 512, timeout: 15 },
  },
  large: {
    asg: { instanceType: 'c5.large', minSize: 3, maxSize: 20, desiredCapacity: 4 },
    rds: { instanceClass: 'db.r6g.xlarge', allocatedStorage: 500, readReplicas: 1, maxAllocatedStorage: 2000 },
    cache: { nodeType: 'cache.r6g.large' },
    ecs: { cpu: 2048, memory: 4096, desiredCount: 4, minCapacity: 4, maxCapacity: 30 },
    eks: { nodeInstanceType: 'm5.xlarge', nodeCount: 6 },
    lambda: { memorySize: 1024, timeout: 29 },
  },
};

export const certFor = (region: string) => CERT.replace('REGION', region);

function rdsConfig(r: Requirements): Cfg {
  const s = AWS_SIZING[r.scale].rds;
  const c: NonNullable<Cfg> = { instanceClass: s.instanceClass, allocatedStorage: s.allocatedStorage };
  if (s.maxAllocatedStorage) c.maxAllocatedStorage = s.maxAllocatedStorage;
  if (s.readReplicas) c.readReplicas = s.readReplicas;
  if (r.db === 'mysql') { c.engine = 'mysql'; c.engineVersion = '8.0.39'; c.port = 3306; }
  if (r.regulated) { c.backupRetentionPeriod = 35; c.enablePerformanceInsights = true; }
  return c;
}

/** Data-store attachment shared by the VPC-based patterns. Returns the ids workloads must connect to. */
export function awsData(b: SpecBuilder, r: Requirements, core: AwsCore): { db: string | null; cache: string | null; nosql: string | null } {
  let db: string | null = null; let cache: string | null = null; let nosql: string | null = null;
  if (r.db === 'postgres' || r.db === 'mysql') {
    db = b.add('rds', 'aws_rds', r.db === 'mysql' ? 'MySQL Multi-AZ Database' : 'PostgreSQL Multi-AZ Database', core.data[0], rdsConfig(r));
  }
  if (r.db === 'nosql') {
    nosql = b.add('ddb', 'aws_dynamodb', 'Application Table', undefined, { name: `${r.app}-table`, billingMode: 'PAY_PER_REQUEST' });
  }
  if (r.cache) {
    cache = b.add('cache', 'aws_elasticache', 'Redis Cache', core.data[1], { nodeType: AWS_SIZING[r.scale].cache.nodeType });
  }
  return { db, cache, nosql };
}

export function regionalWaf(b: SpecBuilder, r: Requirements, target: string): string {
  const waf = b.add('waf-alb', 'aws_waf', 'Regional WAF', 'aws-cloud', {
    scope: 'REGIONAL', defaultAction: 'ALLOW',
    managedRuleGroups: r.regulated
      ? ['AWSManagedRulesCommonRuleSet', 'AWSManagedRulesKnownBadInputsRuleSet', 'AWSManagedRulesSQLiRuleSet', 'AWSManagedRulesAmazonIpReputationList']
      : ['AWSManagedRulesCommonRuleSet', 'AWSManagedRulesKnownBadInputsRuleSet'],
    rateLimitEnabled: true,
  });
  b.connect(waf, target);
  return waf;
}

export function securityGroups(b: SpecBuilder, core: AwsCore, ids: { alb?: string; app: string[]; db?: string | null; cache?: string | null }) {
  const sg = (id: string, label: string, target: string, cfg?: Cfg) => { b.add(id, 'aws_sg', label, core.vpc, cfg); b.connect(id, target); };
  if (ids.alb) sg('sg-alb', 'Load Balancer Security Group', ids.alb, { allowHttp: false, allowHttps: true });
  ids.app.forEach((a, i) => sg(`sg-app-${i === 0 ? 'a' : 'b'}`, `App Security Group ${i === 0 ? 'A' : 'B'}`, a, { allowHttp: true, allowHttps: false, sourceCidr: '10.0.0.0/8' }));
  if (ids.db) sg('sg-db', 'Database Security Group', ids.db, { allowHttp: false, allowHttps: false, sourceCidr: '10.0.0.0/8' });
  if (ids.cache) sg('sg-cache', 'Cache Security Group', ids.cache, { allowHttp: false, allowHttps: false, sourceCidr: '10.0.0.0/8' });
}

export function monitoring(b: SpecBuilder, core: AwsCore, targets: string[], namespace: string, metric: string): void {
  const cw = b.add('cloudwatch', 'aws_cloudwatch', 'CloudWatch Alarms', undefined, { namespace, metricName: metric });
  for (const t of targets) b.connect(cw, t);
}

export function edgeAndEntry(b: SpecBuilder, r: Requirements, core: AwsCore, alb: string): void {
  const r53 = b.add('r53', 'aws_route53', 'Route 53 DNS', core.boundary, { domainName: `${r.app}.example.com` });
  if (r.cdn) {
    const cf = b.add('cf', 'aws_cloudfront', 'CloudFront Distribution', core.boundary, { priceClass: r.scale === 'large' ? 'PriceClass_All' : 'PriceClass_100' });
    const wafEdge = b.add('waf-edge', 'aws_waf', 'CloudFront WAF', core.boundary, { scope: 'CLOUDFRONT', rateLimitEnabled: true });
    b.connect(r53, cf); b.connect(wafEdge, cf); b.connect(cf, core.igw);
  } else {
    b.connect(r53, alb);
  }
  b.connect(core.igw, alb);
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

export function awsThreeTier(r: Requirements): ArchitectureSpec {
  const region = awsRegionOf(r.region);
  const b = new SpecBuilder();
  const core = awsCore(b, { region, nat: true });
  const sz = AWS_SIZING[r.scale];
  const alb = b.add('alb', 'aws_alb', 'Application Load Balancer', core.pub[0], { certificateArn: certFor(region.id) });
  edgeAndEntry(b, r, core, alb);
  regionalWaf(b, r, alb);
  const asg = ['a', 'b'].map((z, i) => b.add(`asg-${z}`, 'aws_auto_scaling', `App Auto Scaling Group ${z.toUpperCase()}`, core.app[i], { ...sz.asg, healthCheckType: 'ELB' }));
  asg.forEach((a) => b.connect(alb, a));
  const data = awsData(b, r, core);
  const assets = b.add('assets', 'aws_s3', 'Assets Bucket', core.boundary, { bucketName: `${r.app}-assets-${region.id}` });
  for (const a of asg) {
    if (data.db) b.connect(a, data.db);
    if (data.cache) b.connect(a, data.cache);
    if (data.nosql) b.connect(a, data.nosql);
    b.connect(a, assets);
  }
  asg.forEach((a, i) => b.connect(a, core.nat![i]));
  let queue: string | null = null;
  if (r.queue) {
    queue = b.add('queue', 'aws_sqs', 'Job Queue', core.boundary, { name: `${r.app}-jobs` });
    const worker = b.add('worker', 'aws_auto_scaling', 'Worker Auto Scaling Group', core.app[1], { ...sz.asg, minSize: 1, desiredCapacity: 1, healthCheckType: 'EC2' });
    asg.forEach((a) => b.connect(a, queue!));
    b.connect(worker, queue);
    if (data.db) b.connect(worker, data.db);
    b.connect(worker, core.nat![1]);
  }
  securityGroups(b, core, { alb, app: asg, db: data.db, cache: data.cache });
  monitoring(b, core, [alb, ...asg, ...(data.db ? [data.db] : [])], 'AWS/EC2', 'CPUUtilization');
  return b.build(`${cap(r.app)} on AWS — three-tier web application`, summary(r, region.id, 'An internet-facing Application Load Balancer protected by AWS WAF distributes traffic to Auto Scaling groups in two private app subnets; data stays in isolated data subnets.'));
}

export function awsEcs(r: Requirements): ArchitectureSpec {
  const region = awsRegionOf(r.region);
  const b = new SpecBuilder();
  const core = awsCore(b, { region, nat: true });
  const sz = AWS_SIZING[r.scale];
  const alb = b.add('alb', 'aws_alb', 'Application Load Balancer', core.pub[0], { certificateArn: certFor(region.id) });
  edgeAndEntry(b, r, core, alb);
  regionalWaf(b, r, alb);
  const svc = ['a', 'b'].map((z, i) => b.add(`svc-${z}`, 'aws_ecs', `Web Service ${z.toUpperCase()}`, core.app[i], {
    launchType: 'FARGATE', containerImage: IMAGE, cpu: sz.ecs.cpu, memory: sz.ecs.memory, desiredCount: sz.ecs.desiredCount, minCapacity: sz.ecs.minCapacity, maxCapacity: sz.ecs.maxCapacity,
  }));
  svc.forEach((s) => b.connect(alb, s));
  const data = awsData(b, r, core);
  const assets = b.add('assets', 'aws_s3', 'Assets Bucket', core.boundary, { bucketName: `${r.app}-assets-${region.id}` });
  const queue = r.queue ? b.add('queue', 'aws_sqs', 'Job Queue', core.boundary, { name: `${r.app}-jobs` }) : null;
  for (const s of svc) {
    if (data.db) b.connect(s, data.db);
    if (data.cache) b.connect(s, data.cache);
    if (data.nosql) b.connect(s, data.nosql);
    if (queue) b.connect(s, queue);
    b.connect(s, assets);
  }
  svc.forEach((s, i) => b.connect(s, core.nat![i]));
  const iam = b.add('task-role', 'aws_iam', 'ECS Task Role', core.boundary, { trustedService: 'ecs-tasks.amazonaws.com' });
  svc.forEach((s) => b.connect(iam, s));
  monitoring(b, core, [alb, ...svc, ...(data.db ? [data.db] : [])], 'AWS/ECS', 'CPUUtilization');
  return b.build(`${cap(r.app)} on AWS — containers on ECS Fargate`, summary(r, region.id, 'Fargate services run in private app subnets behind a WAF-protected Application Load Balancer and reach data stores over the VPC network.'));
}

export function awsEks(r: Requirements): ArchitectureSpec {
  const region = awsRegionOf(r.region);
  const b = new SpecBuilder();
  const core = awsCore(b, { region, nat: true });
  const sz = AWS_SIZING[r.scale];
  const alb = b.add('alb', 'aws_alb', 'Ingress Application Load Balancer', core.pub[0], { certificateArn: certFor(region.id) });
  edgeAndEntry(b, r, core, alb);
  regionalWaf(b, r, alb);
  const eks = b.add('eks', 'aws_eks', 'EKS Cluster', undefined, {
    ...sz.eks, endpointPublicAccess: false, endpointPrivateAccess: true, clusterLogTypes: ['api', 'audit', 'authenticator'],
  });
  b.connect(alb, eks);
  const data = awsData(b, r, core);
  const assets = b.add('assets', 'aws_s3', 'Assets Bucket', core.boundary, { bucketName: `${r.app}-assets-${region.id}` });
  if (data.db) b.connect(eks, data.db);
  if (data.cache) b.connect(eks, data.cache);
  if (data.nosql) b.connect(eks, data.nosql);
  if (r.queue) { const q = b.add('queue', 'aws_sqs', 'Job Queue', core.boundary, { name: `${r.app}-jobs` }); b.connect(eks, q); }
  b.connect(eks, assets); b.connect(eks, core.nat![0]);
  const iam = b.add('cluster-role', 'aws_iam', 'EKS Cluster Role', core.boundary, { trustedService: 'eks.amazonaws.com' });
  b.connect(iam, eks);
  monitoring(b, core, [alb, eks, ...(data.db ? [data.db] : [])], 'AWS/EKS', 'node_cpu_utilization');
  return b.build(`${cap(r.app)} on AWS — Kubernetes on EKS`, summary(r, region.id, 'A private-endpoint EKS cluster with control-plane logging sits behind a WAF-protected load balancer; data stores live in isolated data subnets.'));
}

export function awsServerless(r: Requirements): ArchitectureSpec {
  const region = awsRegionOf(r.region);
  const b = new SpecBuilder();
  const sz = AWS_SIZING[r.scale];
  const cloud = b.add('aws-cloud', 'aws_cloud_boundary', `AWS — ${region.id}`);
  const r53 = b.add('r53', 'aws_route53', 'Route 53 DNS', cloud, { domainName: `${r.app}.example.com` });
  const cf = b.add('cf', 'aws_cloudfront', 'CloudFront Distribution', cloud, { priceClass: r.scale === 'large' ? 'PriceClass_All' : 'PriceClass_100' });
  const waf = b.add('waf-edge', 'aws_waf', 'CloudFront WAF', cloud, { scope: 'CLOUDFRONT', rateLimitEnabled: true });
  const site = b.add('site', 'aws_s3', 'Static Site Bucket', cloud, { bucketName: `${r.app}-site-${region.id}` });
  const api = b.add('api', 'aws_lambda', 'API Function', undefined, { ...sz.lambda, tracingMode: 'Active', runtime: 'nodejs22.x' });
  const iam = b.add('lambda-role', 'aws_iam', 'Lambda Execution Role', cloud, { trustedService: 'lambda.amazonaws.com' });
  b.connect(r53, cf); b.connect(waf, cf); b.connect(cf, site); b.connect(cf, api); b.connect(iam, api);
  const table = b.add('ddb', 'aws_dynamodb', 'Application Table', undefined, { name: `${r.app}-table`, billingMode: 'PAY_PER_REQUEST' });
  b.connect(api, table);
  const uploads = b.add('uploads', 'aws_s3', 'Uploads Bucket', cloud, { bucketName: `${r.app}-uploads-${region.id}` });
  b.connect(api, uploads);
  const targets = [api];
  if (r.queue) {
    const q = b.add('queue', 'aws_sqs', 'Job Queue', cloud, { name: `${r.app}-jobs` });
    const worker = b.add('worker', 'aws_lambda', 'Worker Function', undefined, { ...sz.lambda, tracingMode: 'Active', runtime: 'nodejs22.x' });
    b.connect(api, q); b.connect(q, worker); b.connect(worker, table); b.connect(iam, worker);
    targets.push(worker);
  }
  const cw = b.add('cloudwatch', 'aws_cloudwatch', 'CloudWatch Alarms', undefined, { namespace: 'AWS/Lambda', metricName: 'Errors', threshold: 1, comparisonOperator: 'GreaterThanOrEqualToThreshold' });
  for (const t of targets) b.connect(cw, t);
  return b.build(`${cap(r.app)} on AWS — serverless web application and API`, summary(r, region.id, 'CloudFront serves the static site from S3 and routes API calls to Lambda behind a WAF; state lives in DynamoDB, with an optional queue-driven worker.'));
}

export const cap = (s: string) => s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
export function summary(r: Requirements, region: string, lead: string): string {
  const bits: string[] = [lead];
  bits.push(`Sized for the ${r.scale} tier and deployed in ${region} across two availability zones where the service is zonal.`);
  if (r.regulated) bits.push('Regulated-workload posture: stricter WAF rule groups, 35-day database backups and Performance Insights.');
  return bits.join(' ');
}
