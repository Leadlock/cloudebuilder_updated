/**
 * Generates the knowledge base (Markdown for humans, JSONL chunks for a vector store /
 * file-search upload) from the code that actually enforces the rules, so it cannot drift:
 * resource catalog, valid connections, assessment rules, blueprint patterns and guidelines.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/ai-dataset/build-knowledge-base.ts [--out datasets/ai-architect/knowledge-base]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allResources } from '@/lib/resources';
import { CATALOG_TYPES, evaluateSpec, type ArchitectureSpec } from '@/lib/ai/architectureSpec';
import { relationshipEngine } from '@/lib/engines/relationship/RelationshipEngine';
import { ALL_RULES } from '@/lib/engines/assessment/rules';
import { RULESET_VERSION } from '@/lib/engines/assessment/types';
import { hardenSpec } from './harden';
import { awsThreeTier, awsEcs, awsEks, awsServerless } from './awsPatterns';
import { azureThreeTier, azureAppService, azureServerless, azureAks } from './azurePatterns';
import { multiAwsAzureDr, multiActiveActive } from './multiPatterns';
import { awsStaticSite, awsEventDriven, awsLambdaPrivateApi, azureStaticSite, azureFunctionsPrivateApi } from './morePatterns';
import { awsQueueWorker, awsMicroservices, azureGatewayAppService } from './extraPatterns';
import { PATTERN_TEXT, type Requirements } from './requirements';

interface Chunk { id: string; title: string; text: string; metadata: Record<string, string> }
const chunks: Chunk[] = [];
const add = (id: string, title: string, text: string, metadata: Record<string, string>) => chunks.push({ id, title, text, metadata });
const usable = allResources.filter((r) => CATALOG_TYPES.includes(r.type));

// ─── 1. Resource catalog ────────────────────────────────────────────────────────────────
function catalogSection(): string {
  const out: string[] = ['# Resource catalog', '', 'Every resource type the CloudCraft canvas, validator and Terraform generator understand. Use only these types and only the settings listed. Settings not listed do not exist and are rejected.', ''];
  for (const r of usable) {
    const lines: string[] = [`## ${r.type} — ${r.label}`, `Provider: ${r.provider}; category: ${r.category}.`];
    if (r.description) lines.push(r.description);
    if (r.isContainer) lines.push(`Container. May contain: ${(r.allowedChildren ?? []).join(', ') || 'nothing'}.`);
    const parents = allResources.filter((p) => p.allowedChildren?.includes(r.type)).map((p) => p.type);
    lines.push(parents.length ? `Allowed parent(s): ${parents.join(', ')}.` : r.isContainer ? 'Top-level container.' : 'No container: omit "parent".');
    const rules = ALL_RULES.filter((x) => x.resourceTypes?.includes(r.type));
    if (rules.length) lines.push(`Assessment rules that check this type: ${rules.map((x) => `${x.id} (${x.severity.toLowerCase()})`).join(', ')}. Satisfy them in the design instead of leaving them to fail.`);
    lines.push('Settings:');
    for (const f of r.configSchema) {
      const opts = f.options?.length ? ` one of [${f.options.map((o) => o.value).join(', ')}]` : '';
      const range = f.min !== undefined || f.max !== undefined ? ` range ${f.min ?? '…'}–${f.max ?? '…'}` : '';
      lines.push(`- ${f.key} (${f.type}${opts}${range}); default ${JSON.stringify(r.defaultConfig[f.key] ?? f.defaultValue ?? null)}`);
    }
    const text = lines.join('\n');
    out.push(text, '');
    add(`catalog-${r.type}`, `${r.type} — ${r.label}`, text, { kind: 'resource', provider: r.provider, type: r.type });
  }
  return out.join('\n');
}

// ─── 2. Connection rules ────────────────────────────────────────────────────────────────
// The relationship engine is deliberately permissive (it accepts, e.g., EC2 → Route 53), so
// "accepted" is not "sensible". The recommended list is therefore taken from connections that
// appear in verified designs; the engine is consulted only for the inferred protocol/port.
const node = (t: string, id: string) => ({ id, type: 'cloudNode', resourceType: t, provider: t.startsWith('azure') ? 'azure' : 'aws', label: t, position: { x: 0, y: 0 }, config: {} }) as never;
function connectionSection(pairs: Map<string, number>): string {
  const bySource = new Map<string, [string, number][]>();
  for (const [k, n] of pairs) { const [a, b] = k.split('>'); bySource.set(a, [...(bySource.get(a) ?? []), [b, n]]); }
  const out: string[] = ['# Connection rules', '', 'Direction matters: connect from the caller to the callee. The lists below are the connections used by gate-verified designs, with the protocol and port CloudCraft infers (do not supply them). The engine accepts some other pairs (it is permissive), but they are not meaningful architectures; prefer these.', ''];
  for (const [a, list] of [...bySource].sort()) {
    const lines = list.sort((x, y) => y[1] - x[1]).map(([b, n]) => {
      const A = node(a, 'a'); const B = node(b, 'b');
      const r = relationshipEngine.validateConnection(A, B, [A, B], []);
      return `- ${b} (${r.relationshipType}${r.protocol ? `, ${r.protocol}` : ''}${r.port ? `:${r.port}` : ''}; seen in ${n} verified designs)`;
    });
    const text = `## ${a} connects to\n${lines.join('\n')}`;
    out.push(text, '');
    add(`connections-${a}`, `Recommended connections from ${a}`, text, { kind: 'connections', provider: a.startsWith('azure') ? 'azure' : 'aws', type: a });
  }
  const cross = 'Cross-cloud connections: the engine accepts them only from compute (EC2, VM/VMSS, Lambda, Functions) to compute, storage or SQL, or when either end is a gateway/CDN/edge service (Application Gateway, CloudFront, Front Door). Route 53 → Application Gateway is used for failover and weighted routing; an Azure VM Scale Set → S3 is used for asset replication.';
  out.push('## Cross-cloud', cross, '');
  add('connections-cross-cloud', 'Cross-cloud connection rules', cross, { kind: 'connections', provider: 'multi' });
  return out.join('\n');
}

// ─── 3. Assessment rules ────────────────────────────────────────────────────────────────
function rulesSection(): string {
  const out: string[] = [`# Assessment rules (ruleset ${RULESET_VERSION})`, '', 'A design is only "deploy-ready" if none of these rules fails or warns at MEDIUM severity or above. Read the recommendation to see how to satisfy each rule.', ''];
  for (const r of ALL_RULES) {
    const text = [
      `## ${r.id} — ${r.title}`,
      `Provider: ${r.provider}; service: ${r.service}; severity: ${r.severity}; pillar: ${r.wellArchitected.pillar}${r.wellArchitected.practice ? ` (${r.wellArchitected.practice})` : ''}.`,
      r.description, `Why it matters: ${r.rationale}`, `Recommendation: ${r.remediation.recommendation}`,
      r.resourceTypes?.length ? `Applies to: ${r.resourceTypes.join(', ')}.` : 'Applies to the whole architecture.',
    ].join('\n');
    out.push(text, '');
    add(`rule-${r.id}`, `${r.id} — ${r.title}`, text, { kind: 'rule', provider: r.provider, severity: r.severity, rule: r.id });
  }
  return out.join('\n');
}

// ─── 4. Patterns ────────────────────────────────────────────────────────────────────────
const SAMPLE: Requirements = { provider: 'aws', pattern: '', region: 'us-east-1', regionB: 'westeurope', scale: 'medium', db: 'postgres', cache: true, cdn: true, regulated: false, queue: false, app: 'storefront' };
const PATTERN_FNS: Record<string, { fn: (r: Requirements) => ArchitectureSpec; req: Partial<Requirements>; when: string }> = {
  'aws-three-tier': { fn: awsThreeTier, req: {}, when: 'VM-based web apps that need OS-level control; two Auto Scaling groups in private app subnets behind a WAF-protected ALB. The default for a general production web platform (booking, shop, portal, monolith, lift and shift) when nothing else is specified.' },
  'aws-ecs': { fn: awsEcs, req: {}, when: 'Containerised services, Docker containers, containers without Kubernetes, without managing a cluster or servers (ECS Fargate).' },
  'aws-eks': { fn: awsEks, req: {}, when: 'Kubernetes (k8s) platforms, Helm, a managed Kubernetes cluster, machine-learning inference APIs; private control-plane endpoint.' },
  'aws-serverless': { fn: awsServerless, req: { db: 'nosql', cache: false }, when: 'Serverless: Lambda functions with DynamoDB and no servers at all, pay per use and nothing running 24/7, for APIs, hackathons, mobile backends and static sites with unpredictable load.' },
  'azure-three-tier': { fn: azureThreeTier, req: { provider: 'azure', region: 'eastus' }, when: 'VM-based web apps on Azure virtual machines (Windows or Linux), lift and shift, redundancy and zone redundancy, using VM Scale Sets behind a WAF Application Gateway with a managed database.' },
  'azure-app-service': { fn: azureAppService, req: { provider: 'azure', region: 'eastus' }, when: 'PaaS web apps that do not need VM control.' },
  'azure-serverless': { fn: azureServerless, req: { provider: 'azure', region: 'eastus', db: 'nosql', cache: false }, when: 'Event-driven APIs on Azure Functions with Cosmos DB.' },
  'azure-aks': { fn: azureAks, req: { provider: 'azure', region: 'eastus' }, when: 'Kubernetes platforms on Azure; private cluster.' },
  'aws-static-site': { fn: awsStaticSite, req: { db: 'none', cache: false }, when: 'Static website, marketing site, landing page, documentation site or single-page app (SPA) served from S3 behind a CDN (CloudFront) and a WAF: static hosting, no servers, no containers, no database.' },
  'aws-event-driven': { fn: awsEventDriven, req: { db: 'nosql', cache: false, cdn: false }, when: 'Background processing of uploads or events: S3 and SQS buffer the work, Lambda workers write results to DynamoDB.' },
  'aws-lambda-private-api': { fn: awsLambdaPrivateApi, req: { db: 'postgres', cache: false, cdn: false }, when: 'APIs on Lambda that must reach a private relational database; an ALB with WAF invokes functions in private subnets.' },
  'azure-static-site': { fn: azureStaticSite, req: { provider: 'azure', region: 'eastus', db: 'none', cache: false }, when: 'Static website, marketing site, landing page, documentation site or single-page app (SPA) on Azure served from Blob storage behind a CDN (Front Door) and a WAF policy: static hosting, no servers, no containers, no database.' },
  'azure-functions-private-api': { fn: azureFunctionsPrivateApi, req: { provider: 'azure', region: 'eastus', db: 'sql', cache: false, cdn: false }, when: 'A private serverless API on Azure: Azure Functions inside the VNet (no public endpoint) that must reach a private Azure SQL database, with an Application Gateway WAF in front.' },
  'aws-queue-worker': { fn: awsQueueWorker, req: { queue: true }, when: 'Web applications that hand slow or bursty work (video processing, emails, reports, order processing) to background workers: web services on ECS Fargate put jobs on an SQS queue and a separate worker service drains it.' },
  'aws-microservices': { fn: awsMicroservices, req: { db: 'postgres', queue: true }, when: 'Several small services (for example accounts, orders and payments) on ECS behind one load balancer, each owning its data, talking to each other through an SQS events queue.' },
  'azure-gateway-app-service': { fn: azureGatewayAppService, req: { provider: 'azure', region: 'eastus', cdn: false }, when: 'A regional PaaS web app that must not be publicly reachable: an Application Gateway WAF is the only entry point and the App Service has public network access disabled; data services are private.' },
  'multi-aws-azure-dr': { fn: multiAwsAzureDr, req: { provider: 'multi', cdn: false }, when: 'Multi-cloud disaster recovery (DR): AWS production (primary) with a scaled-down Azure standby for resilience, DNS failover (fail over from AWS to Azure) and asset replication.' },
  'multi-active-active': { fn: multiActiveActive, req: { provider: 'multi', cdn: false }, when: 'Two clouds serving traffic at once via weighted DNS.' },
};
const usedPairs = new Map<string, number>();
function tally(spec: ArchitectureSpec) {
  const type = new Map(spec.resources.map((r) => [r.id, r.type]));
  const seen = new Set<string>();
  for (const c of spec.connections) { const k = `${type.get(c.from)}>${type.get(c.to)}`; if (!seen.has(k)) { seen.add(k); usedPairs.set(k, (usedPairs.get(k) ?? 0) + 1); } }
}
function patternSection(): string {
  const out: string[] = ['# Architecture patterns', '', 'Reference designs. Each sample below passed every deploy-readiness gate.', ''];
  for (const [id, p] of Object.entries(PATTERN_FNS)) {
    const req = { ...SAMPLE, pattern: id, ...p.req } as Requirements;
    const spec = hardenSpec(p.fn(req)).spec;
    for (const v of [{}, { regulated: true, scale: 'large' as const, cdn: false }, { db: 'none' as const, cache: false }, { db: 'nosql' as const }]) {
      const alt = hardenSpec(p.fn({ ...req, ...v })).spec;
      if (evaluateSpec(alt).ok) tally(alt);
    }
    const ev = evaluateSpec(spec);
    if (!ev.ok) throw new Error(`pattern sample ${id} failed gates: ${ev.issues.map((i) => i.message).join('; ')}`);
    const placeholders = (ev.deploymentInputs ?? []).map((d) => `${d.resourceLabel}.${d.setting}`);
    const text = [
      `## ${id} — ${PATTERN_TEXT[id].title}`, `Use when: ${p.when}`, `Typical requests: ${PATTERN_TEXT[id].phrases.join('; ')}.`, `Summary: ${spec.summary}`,
      `Resources: ${spec.resources.map((r) => r.type).filter((t, i, a) => a.indexOf(t) === i).join(', ')}.`,
      placeholders.length ? `Values you must supply before deploying: ${placeholders.join(', ')}.` : 'No account-specific values required.',
      'Sample design (JSON):', JSON.stringify(spec),
    ].join('\n');
    out.push(text, '');
    add(`pattern-${id}`, `Pattern: ${PATTERN_TEXT[id].title}`, text, { kind: 'pattern', provider: req.provider, pattern: id });
  }
  return out.join('\n');
}

// ─── 5. Guidelines (each line is enforced by a gate or rule; see the gate named) ──────────
const GUIDELINES: { title: string; text: string }[] = [
  { title: 'Network layout', text: 'Create a cloud boundary, then a VPC or VNet inside it, then subnets inside the network. Name subnets by role (public/web, app, data): the layout engine classifies tiers from the name. Give every subnet a unique CIDR inside the network range; overlapping CIDRs fail the network-addressing gate. Use two subnets per tier in two availability zones for AWS.' },
  { title: 'Placement', text: 'Entry points (load balancers, application gateways, NAT gateways) go in public/web subnets. Application compute goes in private app subnets. Databases and caches go in data subnets. Managed regional services (S3, storage accounts, Key Vault, SQS, Service Bus, Container Registry, Azure Monitor, Route 53, CloudFront, Front Door, WAF) sit in the cloud boundary or resource group. An Azure PostgreSQL or MySQL flexible server is placed in a subnet of its own (a delegated subnet that holds nothing else); Private Endpoints go in the data subnet.' },
  { title: 'Connectivity', text: 'Every resource must be connected to the rest of the design or the connectivity gate fails. Draw edges from caller to callee: Route 53 → CloudFront/ALB, WAF → the resource it protects, ALB → compute, compute → database/cache/queue/storage. Security groups, NSGs and network ACLs attach to the subnet or workload they protect with one edge. IAM roles connect to the compute that assumes them. CloudWatch connects to the resources it alarms on.' },
  { title: 'Edge protection', text: 'Every internet-facing ALB has a regional WAF connected to it and an HTTPS listener with a certificate; every CloudFront distribution and Front Door has a WAF. Application Gateway uses the WAF_v2 SKU with the WAF in Prevention mode.' },
  { title: 'Data protection', text: 'Databases and caches are never publicly accessible, are encrypted, and are Multi-AZ / zone-redundant where the setting exists. Storage disables public access and defaults network access to Deny. Key Vault uses RBAC, purge protection and a Deny network default.' },
  { title: 'Compute', text: 'Use Auto Scaling groups or VM Scale Sets rather than a fixed count of single instances. Enable health checks against the load balancer. Container and Kubernetes clusters use private endpoints.' },
  { title: 'Settings', text: 'Only set configuration keys that exist for the resource type, with values from the listed options. Unknown keys and invalid values are rejected before any other check runs. Account-specific values (TLS certificate ARNs, container images) are written as REPLACE-WITH-YOUR-* placeholders and must be supplied before deployment.' },
  { title: 'One boundary per cloud', text: 'A design has at most one AWS cloud boundary and one Azure cloud boundary. Two AWS regions, or two Azure regions, cannot be drawn in one design: the layout and the overlap gate reject it. For high availability inside one cloud use two availability zones (AWS) or zone-redundant services (Azure). Cross-region or cross-cloud resilience is modelled only with the multi-cloud patterns (AWS plus Azure). If the user asks for two regions of the same cloud, design the primary region and say in the summary that the second region and data replication must be added separately.' },
  { title: 'Static sites and event-driven workloads', text: 'Static content needs no network and no compute: on AWS use S3 as a private origin behind CloudFront with a WAF; on Azure use a storage account with staticWebsite true (and networkDefaultAction Allow, because a website is public by design; keep allowBlobPublicAccess false) behind Front Door with a WAF, connecting Front Door to the storage account. A firewalled storage account (Deny) cannot be reached by Front Door unless it is on the Premium tier with a Private Link origin. Background work uses a queue between a producer and workers so bursts are buffered and failures retried (SQS with Lambda or Auto Scaling workers on AWS). On Azure the queue is Service Bus (azure_service_bus): the producer connects to it and Functions can be triggered from it (service bus → function).' },
  { title: 'Queue workers and microservices', text: 'Background work goes through an SQS queue: the web service connects to the queue (web → queue) and the worker service reads from it (queue → worker). Run web and worker services as separate ECS services in the private app subnets, one per availability zone. For several services behind one load balancer, connect the load balancer to each service, give each service the data store it needs (compute → database/table), and connect services to each other only through the queue (producer → queue → consumer), never directly.' },
  { title: 'Use the service that was asked for', text: 'Never swap one service for another. PostgreSQL is aws_rds (engine postgres) on AWS and azure_postgres on Azure; MySQL is aws_rds (engine mysql) or azure_mysql; only a request for SQL Server or Azure SQL uses azure_sql. A request for a message queue uses aws_sqs or azure_service_bus; a container registry is azure_acr; monitoring and logging on Azure is azure_monitor (Log Analytics with Application Insights). If a requested service is not in the catalog, say so in the summary instead of substituting another.' },
  { title: 'Private access on Azure', text: 'When a service has its public endpoint off (Storage with network default Deny, Key Vault, Azure SQL, Redis, Cosmos DB, and Container Registry or Service Bus on the Premium tier), the application can only reach it through a Private Endpoint: add an azure_private_endpoint in a subnet, connect it to the service (endpoint → service), and connect the application to the service as usual. One endpoint reaches one service. Service Bus and Container Registry only support private endpoints on the Premium tier; on Standard they keep public access with TLS 1.2. PostgreSQL and MySQL flexible servers do not use an endpoint: place the server in a subnet that holds nothing else.' },
  { title: 'Azure integration and edge services', text: 'Event Hubs (azure_event_hubs) ingests event streams and Event Grid (azure_event_grid) routes events; connect the producer to them (producer → hub) and Event Hubs or Event Grid to a Function to trigger it. API Management (azure_api_management) sits between the entry point and the backends: Front Door or Application Gateway → API Management → compute. Its publisher name and email are REPLACE-WITH-YOUR-* placeholders the person supplies; Developer has no SLA and Consumption is pay per call. Azure Firewall (azure_firewall) goes in a subnet of its own and a route table connected to it sends the subnets\' traffic through it (route table → firewall, and route table → each subnet it applies to). Container Apps (azure_container_apps) run containers without a cluster: set the image to a REPLACE-WITH-YOUR-CONTAINER-IMAGE placeholder; to reach private data services place the app in a subnet of its own that is a /23 or larger.' },
  { title: 'Tiers and availability zones', text: 'A request for a three-tier application means three tiers: a web tier, an API (application) tier and a data tier. Give each compute tier its own resource (for example two VM Scale Sets) and connect web → API → data. When high availability is asked for, spread the tiers across zones: set zones on VM Scale Sets and Application Gateway to "1,2,3", use zone-redundant databases (highAvailability ZoneRedundant for PostgreSQL and MySQL, zoneRedundant for Azure SQL) and ZRS storage.' },
  { title: 'Common mistakes and how to avoid them', text: 'These mistakes were measured in real model output. (1) A WAF that is placed but not connected: always connect WAF → the load balancer or CDN it protects. (2) Subnets with no cidrBlock or availabilityZone: every subnet needs its own /24 inside the VPC range (10.x.1.0/24, 10.x.2.0/24, …) and the two subnets of a tier belong in two zones (us-east-1a and us-east-1b). (3) Using an internet gateway in a connection without declaring it: add an aws_igw resource inside the VPC and connect it to the load balancer; NAT gateways connect to it. (4) A load balancer that is not connected to the compute behind it: draw ALB → each service or Auto Scaling group. (5) A load balancer with no certificateArn: set the REPLACE-WITH-YOUR-CERTIFICATE-ID placeholder. (6) A data store, bucket or cache connected to nothing: connect the compute that uses it. (7) Inventing a setting name such as listener: use only the settings listed for the type.' },
  { title: 'Known limits of the catalog', text: 'The catalog has no API Gateway, EventBridge, Kinesis, SNS or Logic Apps resources. Azure relational databases are Azure SQL, PostgreSQL and MySQL flexible servers. Cross-cloud connections are accepted only from compute to compute/storage/SQL, or through gateway/CDN/edge services. Do not invent resource types to fill those gaps; state the limitation in the summary instead.' },
];
function guidelinesSection(): string {
  const out = ['# Design guidelines', ''];
  for (const g of GUIDELINES) { out.push(`## ${g.title}`, g.text, ''); add(`guideline-${g.title.toLowerCase().replace(/[^a-z]+/g, '-')}`, g.title, g.text, { kind: 'guideline' }); }
  return out.join('\n');
}

function main() {
  const outDir = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'datasets/ai-architect/knowledge-base';
  mkdirSync(outDir, { recursive: true });
  const patterns = patternSection(); // fills usedPairs
  const files: [string, string][] = [
    ['design-guidelines.md', guidelinesSection()],
    ['resource-catalog.md', catalogSection()],
    ['connection-rules.md', connectionSection(usedPairs)],
    ['assessment-rules.md', rulesSection()],
    ['architecture-patterns.md', patterns],
  ];
  for (const [name, body] of files) writeFileSync(join(outDir, name), body);
  writeFileSync(join(outDir, 'knowledge-base.jsonl'), chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');
  const byKind = chunks.reduce<Record<string, number>>((m, c) => { m[c.metadata.kind] = (m[c.metadata.kind] ?? 0) + 1; return m; }, {});
  console.log(JSON.stringify({ outDir, chunks: chunks.length, byKind, rulesetVersion: RULESET_VERSION }, null, 2));
}
main();
