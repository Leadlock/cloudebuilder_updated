/**
 * More verified blueprints, added after the first dataset: shapes people ask for that the original patterns did not cover.
 * Same rules as every other pattern (see awsPatterns.ts): they are code, and nothing is written to the dataset unless it passes
 * every deploy-readiness gate.
 *
 *   aws-queue-worker   web tier on ECS plus a queue-driven worker service that does the slow work
 *   aws-microservices  several ECS services behind one load balancer, each with its own data store, talking through a queue
 *   azure-gateway-app-service  private App Service behind an Application Gateway WAF, no Front Door
 */
import type { ArchitectureSpec } from '@/lib/ai/architectureSpec';
import { SpecBuilder, awsCore, azureCore } from './builder';
import { AWS_SIZING, IMAGE, awsData, awsRegionOf, cap, certFor, edgeAndEntry, monitoring, regionalWaf, summary } from './awsPatterns';
import { AZURE_SIZING, azureData, azureRegionOf, cap as azCap, nsg, slug, storageAndVault, summary as azSummary } from './azurePatterns';
import type { Requirements } from './requirements';

/** A web service takes the request and puts the slow job on a queue; a separate worker service drains it. */
export function awsQueueWorker(r: Requirements): ArchitectureSpec {
  const region = awsRegionOf(r.region);
  const b = new SpecBuilder();
  const core = awsCore(b, { region, nat: true });
  const sz = AWS_SIZING[r.scale];
  const alb = b.add('alb', 'aws_alb', 'Application Load Balancer', core.pub[0], { certificateArn: certFor(region.id) });
  edgeAndEntry(b, r, core, alb);
  regionalWaf(b, r, alb);

  const web = ['a', 'b'].map((z, i) => b.add(`web-${z}`, 'aws_ecs', `Web Service ${z.toUpperCase()}`, core.app[i], {
    launchType: 'FARGATE', containerImage: IMAGE, cpu: sz.ecs.cpu, memory: sz.ecs.memory, desiredCount: sz.ecs.desiredCount, minCapacity: sz.ecs.minCapacity, maxCapacity: sz.ecs.maxCapacity,
  }));
  web.forEach((w) => b.connect(alb, w));

  const queue = b.add('queue', 'aws_sqs', 'Job Queue', core.boundary, { name: `${r.app}-jobs` });
  const worker = ['a', 'b'].map((z, i) => b.add(`worker-${z}`, 'aws_ecs', `Worker Service ${z.toUpperCase()}`, core.app[i], {
    launchType: 'FARGATE', containerImage: IMAGE, cpu: sz.ecs.cpu, memory: sz.ecs.memory, desiredCount: Math.max(1, sz.ecs.desiredCount - 1), minCapacity: 1, maxCapacity: sz.ecs.maxCapacity,
  }));
  web.forEach((w) => b.connect(w, queue));
  worker.forEach((w) => b.connect(queue, w));

  const data = awsData(b, r, core);
  const results = b.add('results', 'aws_s3', 'Results Bucket', core.boundary, { bucketName: `${r.app}-results-${region.id}` });
  for (const s of [...web, ...worker]) {
    if (data.db) b.connect(s, data.db);
    if (data.cache) b.connect(s, data.cache);
    if (data.nosql) b.connect(s, data.nosql);
  }
  worker.forEach((w) => b.connect(w, results));
  [...web, ...worker].forEach((s, i) => b.connect(s, core.nat![i % 2]!));
  const iam = b.add('task-role', 'aws_iam', 'ECS Task Role', core.boundary, { trustedService: 'ecs-tasks.amazonaws.com' });
  [...web, ...worker].forEach((s) => b.connect(iam, s));
  monitoring(b, core, [alb, ...web, ...worker, ...(data.db ? [data.db] : [])], 'AWS/ECS', 'CPUUtilization');
  return b.build(`${cap(r.app)} on AWS — web tier with queue-driven workers`, summary(r, region.id, 'Web services in private app subnets behind a WAF-protected Application Load Balancer hand slow jobs to an SQS queue; a separate worker service drains it and writes results to S3, so spikes never slow the web tier.'));
}

/** Several services behind one load balancer, each owning its data; orders talk to payments through a queue. */
export function awsMicroservices(r: Requirements): ArchitectureSpec {
  const region = awsRegionOf(r.region);
  const b = new SpecBuilder();
  const core = awsCore(b, { region, nat: true });
  const sz = AWS_SIZING[r.scale];
  const alb = b.add('alb', 'aws_alb', 'Application Load Balancer', core.pub[0], { certificateArn: certFor(region.id) });
  edgeAndEntry(b, r, core, alb);
  regionalWaf(b, r, alb);

  const service = (id: string, label: string, subnet: string) => b.add(id, 'aws_ecs', label, subnet, {
    launchType: 'FARGATE', containerImage: IMAGE, cpu: sz.ecs.cpu, memory: sz.ecs.memory, desiredCount: sz.ecs.desiredCount, minCapacity: sz.ecs.minCapacity, maxCapacity: sz.ecs.maxCapacity,
  });
  const accounts = service('svc-accounts', 'Accounts Service', core.app[0]);
  const orders = service('svc-orders', 'Orders Service', core.app[1]);
  const payments = service('svc-payments', 'Payments Service', core.app[0]);
  [accounts, orders, payments].forEach((s) => b.connect(alb, s));

  const data = awsData(b, { ...r, db: 'postgres' }, core);        // the relational store for accounts and orders
  const table = b.add('ddb', 'aws_dynamodb', 'Payments Table', undefined, { name: `${r.app}-payments`, billingMode: 'PAY_PER_REQUEST' });
  const events = b.add('events', 'aws_sqs', 'Order Events Queue', core.boundary, { name: `${r.app}-order-events` });
  b.connect(accounts, data.db!); b.connect(orders, data.db!);
  if (data.cache) b.connect(accounts, data.cache);
  b.connect(payments, table);
  b.connect(orders, events); b.connect(events, payments);
  [accounts, orders, payments].forEach((s, i) => b.connect(s, core.nat![i % 2]!));
  const iam = b.add('task-role', 'aws_iam', 'ECS Task Role', core.boundary, { trustedService: 'ecs-tasks.amazonaws.com' });
  [accounts, orders, payments].forEach((s) => b.connect(iam, s));
  monitoring(b, core, [alb, accounts, orders, payments, data.db!], 'AWS/ECS', 'CPUUtilization');
  return b.build(`${cap(r.app)} on AWS — microservices on ECS`, summary(r, region.id, 'Accounts, orders and payments run as separate ECS services behind one WAF-protected load balancer; accounts and orders share a Multi-AZ PostgreSQL database, payments keeps its own DynamoDB table, and orders hand work to payments through an SQS queue.'));
}

// ─── Azure ────────────────────────────────────────────────────────────────────────────

/** A regional, private web app: Application Gateway WAF in the web subnet in front of an App Service that has no public endpoint. */
export function azureGatewayAppService(r: Requirements): ArchitectureSpec {
  const region = azureRegionOf(r.region);
  const b = new SpecBuilder();
  const core = azureCore(b, { region, tiers: { web: true, app: false, data: true, bastion: false } });
  const sz = AZURE_SIZING[r.scale];
  const agw = b.add('agw', 'azure_app_gateway', 'Application Gateway (WAF v2)', core.web, {
    name: `${slug(r.app)}-agw`, sku: 'WAF_v2', wafEnabled: true, wafMode: 'Prevention', zones: '1,2,3', autoscaleEnabled: true, minCapacity: 2, maxCapacity: r.scale === 'large' ? 10 : 5,
  });
  const app = b.add('app', 'azure_app_service', 'Web App', undefined, {
    name: `${slug(r.app)}-web`, skuName: sz.appPlan.skuName, alwaysOn: true, httpsOnly: true, minimumTlsVersion: '1.2', ftpsState: 'Disabled', http2Enabled: true, healthCheckPath: '/health', publicNetworkAccess: false,
  });
  b.connect(agw, app);
  const data = azureData(b, r, core);
  const { storage, vault } = storageAndVault(b, r, core);
  for (const d of [data.sql, data.cache, data.cosmos, data.bus]) if (d) b.connect(app, d);
  b.connect(app, storage); b.connect(app, vault);
  nsg(b, core, 'nsg-web', 'Web NSG', core.web, { allowHttp: false, allowHttps: true });
  nsg(b, core, 'nsg-data', 'Data NSG', core.data, { allowHttp: false, allowHttps: false, sourceCidr: '10.0.0.0/8' });
  return b.build(`${azCap(r.app)} on Azure — private App Service behind Application Gateway`, azSummary(r, region.id, 'A WAF-enabled Application Gateway is the only public entry point; the App Service has public access disabled, and data services accept private traffic only.'));
}
