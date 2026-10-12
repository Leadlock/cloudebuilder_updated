/**
 * Additional blueprints for the knowledge base: static sites, event-driven processing and private-network APIs.
 * Like every other blueprint they are code, so each one is compiled and must pass every deploy-readiness gate before it is
 * written. They only use resource types in the catalog (no API Gateway, EventBridge, Kinesis, SNS, Service Bus, ...).
 */
import type { ArchitectureSpec } from '@/lib/ai/architectureSpec';
import { SpecBuilder, awsCore, azureCore, type Cfg } from './builder';
import { awsRegionOf, AWS_SIZING } from './awsPatterns';
import { azureData, azureRegionOf, storageAndVault } from './azurePatterns';
import type { Requirements } from './requirements';

const cap = (s: string) => s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const slug = (s: string) => s.replace(/[^a-z0-9]/g, '');

// ─── AWS ──────────────────────────────────────────────────────────────────────────────

/** Static website: S3 origin behind CloudFront with a WAF. No servers, no network to run. */
export function awsStaticSite(r: Requirements): ArchitectureSpec {
  const region = awsRegionOf(r.region);
  const b = new SpecBuilder();
  const cloud = b.add('aws-cloud', 'aws_cloud_boundary', `AWS — ${region.id}`);
  const r53 = b.add('r53', 'aws_route53', 'Route 53 DNS', cloud, { domainName: `${r.app}.example.com` });
  const cf = b.add('cf', 'aws_cloudfront', 'CloudFront Distribution', cloud, { priceClass: r.scale === 'large' ? 'PriceClass_All' : 'PriceClass_100' });
  const waf = b.add('waf-edge', 'aws_waf', 'CloudFront WAF', cloud, { scope: 'CLOUDFRONT', rateLimitEnabled: true });
  const site = b.add('site', 'aws_s3', 'Static Site Bucket', cloud, { bucketName: `${r.app}-site-${region.id}` });
  b.connect(r53, cf); b.connect(waf, cf); b.connect(cf, site);
  return b.build(`${cap(r.app)} on AWS — static website`, `Route 53 sends visitors to CloudFront, which serves the site from a private S3 bucket behind a WAF. No servers to patch and no network to run; sized by CloudFront price class (${r.scale} tier), deployed with ${region.id} as the origin region.`);
}

/** Event-driven processing: uploads land in S3, a queue buffers the work, Lambda workers write results to DynamoDB. */
export function awsEventDriven(r: Requirements): ArchitectureSpec {
  const region = awsRegionOf(r.region);
  const sz = AWS_SIZING[r.scale];
  const b = new SpecBuilder();
  const cloud = b.add('aws-cloud', 'aws_cloud_boundary', `AWS — ${region.id}`);
  const uploads = b.add('uploads', 'aws_s3', 'Uploads Bucket', cloud, { bucketName: `${r.app}-uploads-${region.id}` });
  const ingest = b.add('ingest', 'aws_lambda', 'Ingest Function', undefined, { ...sz.lambda, tracingMode: 'Active', runtime: 'nodejs22.x' });
  const queue = b.add('queue', 'aws_sqs', 'Work Queue', cloud, { name: `${r.app}-work` });
  const worker = b.add('worker', 'aws_lambda', 'Worker Function', undefined, { ...sz.lambda, tracingMode: 'Active', runtime: 'nodejs22.x' });
  const table = b.add('ddb', 'aws_dynamodb', 'Results Table', undefined, { name: `${r.app}-results`, billingMode: 'PAY_PER_REQUEST' });
  const results = b.add('results', 'aws_s3', 'Processed Output Bucket', cloud, { bucketName: `${r.app}-output-${region.id}` });
  const iam = b.add('lambda-role', 'aws_iam', 'Lambda Execution Role', cloud, { trustedService: 'lambda.amazonaws.com' });
  b.connect(ingest, uploads); b.connect(ingest, queue); b.connect(queue, worker);
  b.connect(worker, table); b.connect(worker, results);
  b.connect(iam, ingest); b.connect(iam, worker);
  const cw = b.add('cloudwatch', 'aws_cloudwatch', 'CloudWatch Alarms', undefined, { namespace: 'AWS/Lambda', metricName: 'Errors', threshold: 1, comparisonOperator: 'GreaterThanOrEqualToThreshold' });
  b.connect(cw, ingest); b.connect(cw, worker);
  return b.build(`${cap(r.app)} on AWS — event-driven processing`, `An ingest function stores incoming files in S3 and queues the work in SQS; worker functions drain the queue, write results to DynamoDB and processed output to S3. The queue absorbs bursts and retries failures. Sized for the ${r.scale} tier in ${region.id}.`);
}

/** Lambda inside the VPC behind a WAF-protected ALB: an API that must reach private databases without a public endpoint. */
export function awsLambdaPrivateApi(r: Requirements): ArchitectureSpec {
  const region = awsRegionOf(r.region);
  const sz = AWS_SIZING[r.scale];
  const b = new SpecBuilder();
  const core = awsCore(b, { region, nat: true });
  const alb = b.add('alb', 'aws_alb', 'Application Load Balancer', core.pub[0], { certificateArn: `arn:aws:acm:${region.id}:123456789012:certificate/REPLACE-WITH-YOUR-CERTIFICATE-ID` });
  const r53 = b.add('r53', 'aws_route53', 'Route 53 DNS', core.boundary, { domainName: `${r.app}.example.com` });
  const waf = b.add('waf-alb', 'aws_waf', 'Regional WAF', core.boundary, { scope: 'REGIONAL', defaultAction: 'ALLOW', managedRuleGroups: ['AWSManagedRulesCommonRuleSet', 'AWSManagedRulesKnownBadInputsRuleSet'], rateLimitEnabled: true });
  b.connect(r53, alb); b.connect(core.igw, alb); b.connect(waf, alb);
  const fns = ['a', 'b'].map((z, i) => b.add(`fn-${z}`, 'aws_lambda', `API Function ${z.toUpperCase()}`, core.app[i], { ...sz.lambda, tracingMode: 'Active', runtime: 'nodejs22.x' }));
  fns.forEach((f) => b.connect(alb, f));
  const db = b.add('rds', 'aws_rds', 'PostgreSQL Multi-AZ Database', core.data[0], { instanceClass: sz.rds.instanceClass, allocatedStorage: sz.rds.allocatedStorage });
  const assets = b.add('assets', 'aws_s3', 'Assets Bucket', core.boundary, { bucketName: `${r.app}-assets-${region.id}` });
  const iam = b.add('lambda-role', 'aws_iam', 'Lambda Execution Role', core.boundary, { trustedService: 'lambda.amazonaws.com' });
  fns.forEach((f, i) => { b.connect(f, db); b.connect(f, assets); b.connect(f, core.nat![i]); b.connect(iam, f); });
  const sg = (id: string, label: string, target: string, cfg: NonNullable<Cfg>) => { b.add(id, 'aws_sg', label, core.vpc, cfg); b.connect(id, target); };
  sg('sg-alb', 'Load Balancer Security Group', alb, { allowHttp: false, allowHttps: true });
  sg('sg-db', 'Database Security Group', db, { allowHttp: false, allowHttps: false, sourceCidr: '10.0.0.0/8' });
  const cw = b.add('cloudwatch', 'aws_cloudwatch', 'CloudWatch Alarms', undefined, { namespace: 'AWS/Lambda', metricName: 'Errors', threshold: 1, comparisonOperator: 'GreaterThanOrEqualToThreshold' });
  [alb, ...fns, db].forEach((t) => b.connect(cw, t));
  return b.build(`${cap(r.app)} on AWS — private Lambda API behind a load balancer`, `A WAF-protected Application Load Balancer invokes Lambda functions that run in private app subnets, so they can reach a Multi-AZ PostgreSQL database in isolated data subnets without any public endpoint. Outbound calls go through NAT gateways. Sized for the ${r.scale} tier in ${region.id}.`);
}

// ─── Azure ────────────────────────────────────────────────────────────────────────────

/** Static website: a storage account's static website behind Front Door with a WAF policy (the content is public by design, so the account accepts the network that serves it). */
export function azureStaticSite(r: Requirements): ArchitectureSpec {
  const region = azureRegionOf(r.region);
  const b = new SpecBuilder();
  const boundary = b.add('azure-cloud', 'azure_cloud_boundary', `Azure — ${region.id}`, undefined, { region: region.id });
  const storage = b.add('storage', 'azure_storage', 'Static Site Storage Account', boundary, {
    name: `${slug(r.app)}site`, sku: r.regulated ? 'Standard_GRS' : 'Standard_ZRS', httpsOnly: true, allowBlobPublicAccess: false,
    minimumTlsVersion: 'TLS1_2', networkDefaultAction: 'Allow', staticWebsite: true, blobVersioningEnabled: true, blobSoftDeleteRetentionDays: 14,
  });
  const fd = b.add('fd', 'azure_front_door', 'Front Door', boundary, {
    name: `${slug(r.app)}-fd`, sku: r.regulated ? 'Premium_AzureFrontDoor' : 'Standard_AzureFrontDoor', httpsOnly: true, originHostName: `${slug(r.app)}site.blob.core.windows.net`,
  });
  const waf = b.add('fd-waf', 'azure_waf', 'Front Door WAF Policy', boundary, { name: `${slug(r.app)}fdwaf`, mode: 'Prevention' });
  b.connect(waf, fd); b.connect(fd, storage);
  return b.build(`${cap(r.app)} on Azure — static website`, `Front Door with a WAF policy in Prevention mode serves the site from a storage account's static website, with anonymous blob access disabled. Front Door adds caching, HTTPS and the firewall in front of it. No servers to manage; deployed in ${region.id} (${r.scale} tier).`);
}

/** Functions inside the VNet behind a WAF Application Gateway, with the chosen database on a private subnet. */
export function azureFunctionsPrivateApi(r: Requirements): ArchitectureSpec {
  const region = azureRegionOf(r.region);
  const b = new SpecBuilder();
  const core = azureCore(b, { region, tiers: { bastion: false } });
  const agw = b.add('agw', 'azure_app_gateway', 'Application Gateway (WAF v2)', core.web, { name: `${slug(r.app)}-agw`, sku: 'WAF_v2', wafEnabled: true, wafMode: 'Prevention', zones: '1,2,3', autoscaleEnabled: true, minCapacity: 2, maxCapacity: 5 });
  const fn = b.add('func', 'azure_functions', 'API Function App', core.app, { name: `${slug(r.app)}-api`, runtime: 'node', osType: 'Linux', planType: 'EP1', alwaysOn: true, httpsOnly: true, minimumTlsVersion: '1.2', publicNetworkAccess: false });
  b.connect(agw, fn);
  const data = azureData(b, r, core);
  const { storage, vault } = storageAndVault(b, r, core);
  for (const d of [data.sql, data.cache, data.cosmos, data.bus]) if (d) b.connect(fn, d);
  b.connect(fn, storage); b.connect(fn, vault);
  const nsg = (id: string, label: string, subnet: string, cfg: NonNullable<Cfg>) => { b.add(id, 'azure_nsg', label, core.vnet, cfg); b.connect(id, subnet); };
  nsg('nsg-web', 'Web NSG', core.web, { allowHttp: false, allowHttps: true });
  nsg('nsg-app', 'App NSG', core.app, { allowHttp: true, allowHttps: false, sourceCidr: '10.0.0.0/8' });
  nsg('nsg-data', 'Data NSG', core.data, { allowHttp: false, allowHttps: false, sourceCidr: '10.0.0.0/8' });
  return b.build(`${cap(r.app)} on Azure — private Functions API behind Application Gateway`, `A WAF-enabled Application Gateway fronts an Azure Functions app that runs inside the VNet with public access disabled; Azure SQL, storage and Key Vault accept private traffic only. Deployed in ${region.id}.`);
}
