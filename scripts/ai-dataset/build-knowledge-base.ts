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
  'aws-three-tier': { fn: awsThreeTier, req: {}, when: 'VM-based web apps that need OS-level control; two Auto Scaling groups in private app subnets behind a WAF-protected ALB.' },
  'aws-ecs': { fn: awsEcs, req: {}, when: 'Containerised services without managing a cluster (Fargate).' },
  'aws-eks': { fn: awsEks, req: {}, when: 'Kubernetes platforms and microservices; private control-plane endpoint.' },
  'aws-serverless': { fn: awsServerless, req: { db: 'nosql', cache: false }, when: 'Event-driven APIs and static sites with unpredictable load.' },
  'azure-three-tier': { fn: azureThreeTier, req: { provider: 'azure', region: 'eastus' }, when: 'VM-based web apps on Azure using VM Scale Sets behind a WAF Application Gateway.' },
  'azure-app-service': { fn: azureAppService, req: { provider: 'azure', region: 'eastus' }, when: 'PaaS web apps that do not need VM control.' },
  'azure-serverless': { fn: azureServerless, req: { provider: 'azure', region: 'eastus', db: 'nosql', cache: false }, when: 'Event-driven APIs on Azure Functions with Cosmos DB.' },
  'azure-aks': { fn: azureAks, req: { provider: 'azure', region: 'eastus' }, when: 'Kubernetes platforms on Azure; private cluster.' },
  'multi-aws-azure-dr': { fn: multiAwsAzureDr, req: { provider: 'multi', cdn: false }, when: 'AWS primary with a scaled-down Azure standby and DNS failover.' },
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
      `## ${id} — ${PATTERN_TEXT[id].title}`, `Use when: ${p.when}`,
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
  { title: 'Placement', text: 'Entry points (load balancers, application gateways, NAT gateways) go in public/web subnets. Application compute goes in private app subnets. Databases and caches go in data subnets. Managed regional services (S3, storage accounts, Key Vault, SQS, Route 53, CloudFront, Front Door, WAF) sit in the cloud boundary or resource group.' },
  { title: 'Connectivity', text: 'Every resource must be connected to the rest of the design or the connectivity gate fails. Draw edges from caller to callee: Route 53 → CloudFront/ALB, WAF → the resource it protects, ALB → compute, compute → database/cache/queue/storage. Security groups, NSGs and network ACLs attach to the subnet or workload they protect with one edge. IAM roles connect to the compute that assumes them. CloudWatch connects to the resources it alarms on.' },
  { title: 'Edge protection', text: 'Every internet-facing ALB has a regional WAF connected to it and an HTTPS listener with a certificate; every CloudFront distribution and Front Door has a WAF. Application Gateway uses the WAF_v2 SKU with the WAF in Prevention mode.' },
  { title: 'Data protection', text: 'Databases and caches are never publicly accessible, are encrypted, and are Multi-AZ / zone-redundant where the setting exists. Storage disables public access and defaults network access to Deny. Key Vault uses RBAC, purge protection and a Deny network default.' },
  { title: 'Compute', text: 'Use Auto Scaling groups or VM Scale Sets rather than a fixed count of single instances. Enable health checks against the load balancer. Container and Kubernetes clusters use private endpoints.' },
  { title: 'Settings', text: 'Only set configuration keys that exist for the resource type, with values from the listed options. Unknown keys and invalid values are rejected before any other check runs. Account-specific values (TLS certificate ARNs, container images) are written as REPLACE-WITH-YOUR-* placeholders and must be supplied before deployment.' },
  { title: 'Known limits of the catalog', text: 'The catalog has no API Gateway, EventBridge, Kinesis, SNS, Service Bus, Event Hubs, Azure Monitor or Log Analytics resources. Azure relational databases are modelled as Azure SQL only. Cross-cloud connections are accepted only from compute to compute/storage/SQL, or through gateway/CDN/edge services. Do not invent resource types to fill those gaps; state the limitation in the summary instead.' },
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
