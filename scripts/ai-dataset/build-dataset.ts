/**
 * Builds the gpt-4o-mini fine-tuning dataset.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/ai-dataset/build-dataset.ts [--out datasets/ai-architect]
 *
 * Every assistant message is a blueprint that was compiled by CloudCraft's own engine and
 * passed all deploy-readiness gates (assessment, hardening, validator, canonical validation,
 * connectivity, layout, network addressing, Terraform). Blueprints that fail are dropped and
 * reported, never written. Output is deterministic for a given seed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHITECT_SYSTEM_PROMPT, CATALOG_TYPES, evaluateSpec, type ArchitectureSpec } from '@/lib/ai/architectureSpec';
import { buildRepairPrompt } from '@/lib/ai/architectRepair';
import { adjustPrompt } from '@/lib/ai/verifiedBase';
import { withHints } from '@/lib/ai/repairHints';
import { hardenSpec } from './harden';
import { awsThreeTier, awsEcs, awsEks, awsServerless } from './awsPatterns';
import { azureThreeTier, azureAppService, azureServerless, azureAks } from './azurePatterns';
import { multiAwsAzureDr, multiActiveActive } from './multiPatterns';
import { awsStaticSite, awsEventDriven, awsLambdaPrivateApi, azureStaticSite, azureFunctionsPrivateApi } from './morePatterns';
import { awsQueueWorker, awsMicroservices, azureGatewayAppService } from './extraPatterns';
import { AWS_REGIONS, AZURE_REGIONS } from './builder';
import { APP_NAMES, PATTERN_TEXT, PROMPT_STYLES, promptFor, vagueRequirements, type Database, type PromptStyle, type Requirements, type Scale } from './requirements';

type Blueprint = (r: Requirements) => ArchitectureSpec;
interface PatternDef { id: string; provider: Requirements['provider']; fn: Blueprint; target: number; dims: (keyof Requirements)[]; fixed?: Partial<Requirements> }

const PATTERNS: PatternDef[] = [
  { id: 'aws-three-tier', provider: 'aws', fn: awsThreeTier, target: 80, dims: ['region', 'scale', 'db', 'cache', 'cdn', 'regulated', 'queue'] },
  { id: 'aws-ecs', provider: 'aws', fn: awsEcs, target: 70, dims: ['region', 'scale', 'db', 'cache', 'cdn', 'regulated', 'queue'] },
  { id: 'aws-eks', provider: 'aws', fn: awsEks, target: 60, dims: ['region', 'scale', 'db', 'cache', 'cdn', 'regulated', 'queue'] },
  { id: 'aws-serverless', provider: 'aws', fn: awsServerless, target: 40, dims: ['region', 'scale', 'regulated', 'queue'], fixed: { db: 'nosql', cache: false, cdn: true } },
  { id: 'azure-three-tier', provider: 'azure', fn: azureThreeTier, target: 80, dims: ['region', 'scale', 'db', 'cache', 'cdn', 'regulated', 'queue'] },
  { id: 'azure-app-service', provider: 'azure', fn: azureAppService, target: 60, dims: ['region', 'scale', 'db', 'cache', 'cdn', 'regulated', 'queue'] },
  { id: 'azure-serverless', provider: 'azure', fn: azureServerless, target: 30, dims: ['region', 'scale', 'cdn', 'regulated'], fixed: { db: 'nosql', cache: false, queue: false } },
  { id: 'azure-aks', provider: 'azure', fn: azureAks, target: 60, dims: ['region', 'scale', 'db', 'cache', 'cdn', 'regulated', 'queue'] },
  { id: 'aws-static-site', provider: 'aws', fn: awsStaticSite, target: 12, dims: ['region', 'scale'], fixed: { db: 'none', cache: false, cdn: true, queue: false } },
  { id: 'aws-event-driven', provider: 'aws', fn: awsEventDriven, target: 12, dims: ['region', 'scale'], fixed: { db: 'nosql', cache: false, cdn: false, queue: false } },
  { id: 'aws-lambda-private-api', provider: 'aws', fn: awsLambdaPrivateApi, target: 12, dims: ['region', 'scale'], fixed: { db: 'postgres', cache: false, cdn: false, queue: false } },
  { id: 'azure-static-site', provider: 'azure', fn: azureStaticSite, target: 6, dims: ['region', 'regulated'], fixed: { db: 'none', cache: false, cdn: true, queue: false } },
  { id: 'azure-functions-private-api', provider: 'azure', fn: azureFunctionsPrivateApi, target: 3, dims: ['region'], fixed: { db: 'sql', cache: false, cdn: false, queue: false } },
  { id: 'aws-queue-worker', provider: 'aws', fn: awsQueueWorker, target: 60, dims: ['region', 'scale', 'db', 'cache', 'cdn', 'regulated'], fixed: { queue: true } },
  { id: 'aws-microservices', provider: 'aws', fn: awsMicroservices, target: 50, dims: ['region', 'scale', 'cache', 'cdn', 'regulated'], fixed: { db: 'postgres', queue: true } },
  { id: 'azure-gateway-app-service', provider: 'azure', fn: azureGatewayAppService, target: 50, dims: ['region', 'scale', 'db', 'cache', 'regulated', 'queue'], fixed: { cdn: false } },
  { id: 'multi-aws-azure-dr', provider: 'multi', fn: multiAwsAzureDr, target: 40, dims: ['region', 'regionB', 'scale', 'db', 'cache', 'regulated'], fixed: { cdn: false, queue: false } },
  { id: 'multi-active-active', provider: 'multi', fn: multiActiveActive, target: 40, dims: ['region', 'regionB', 'scale', 'db', 'cache', 'regulated'], fixed: { cdn: false, queue: false } },
];

const EVAL_PER_PATTERN = 4;
const SEED = 20260929;

// Deterministic PRNG (mulberry32) so the dataset is reproducible.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const SCALES: Scale[] = ['small', 'medium', 'large'];
const DBS: Database[] = ['postgres', 'mysql', 'nosql', 'none'];
const DBS_AZURE: Database[] = ['postgres', 'mysql', 'sql', 'nosql', 'none'];
/** A multi-cloud design uses the same engine on both sides, so only the engines both clouds offer. */
const DBS_MULTI: Database[] = ['postgres', 'mysql', 'nosql', 'none'];

function lattice(p: PatternDef): Requirements[] {
  const awsRegions = AWS_REGIONS.map((r) => r.id);
  const azRegions = AZURE_REGIONS.map((r) => r.id);
  const primary = p.provider === 'azure' ? azRegions : awsRegions;
  const opts: Record<string, unknown[]> = {
    region: primary, regionB: azRegions, scale: SCALES, db: p.provider === 'aws' ? DBS : p.provider === 'azure' ? DBS_AZURE : DBS_MULTI,
    cache: [true, false], cdn: [true, false], regulated: [false, true], queue: [false, true],
  };
  let combos: Partial<Requirements>[] = [{}];
  for (const d of p.dims) combos = combos.flatMap((c) => (opts[d] as unknown[]).map((v) => ({ ...c, [d]: v })));
  return combos.map((c) => ({ provider: p.provider, pattern: p.id, region: primary[0], scale: 'medium', db: 'none', cache: false, cdn: false, regulated: false, queue: false, app: 'app', ...p.fixed, ...c }) as Requirements);
}

const hashOf = (spec: ArchitectureSpec) => createHash('sha256').update(JSON.stringify([spec.resources, spec.connections])).digest('hex').slice(0, 16);
const chat = (user: string, assistant: string) => ({ messages: [{ role: 'system', content: ARCHITECT_SYSTEM_PROMPT }, { role: 'user', content: user }, { role: 'assistant', content: assistant }] });
const tokens = (s: string) => Math.ceil(s.length / 4); // rough: ~4 characters per token

// ─── Repair examples: real failures produced by mutating a passing blueprint ──────────────

type Mutation = { id: string; apply: (s: ArchitectureSpec) => ArchitectureSpec | null };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** First candidate that CloudCraft actually rejects — a mutation that leaves the design valid teaches nothing. */
const firstBroken = (candidates: ArchitectureSpec[]): ArchitectureSpec | null => candidates.find((c) => !evaluateSpec(c).ok) ?? null;
const byType = (s: ArchitectureSpec, type: string) => s.resources.find((r) => r.type === type);
/** The relational database of an Azure design, whichever engine it uses. */
const azureDb = (s: ArchitectureSpec) => byType(s, 'azure_sql') ?? byType(s, 'azure_postgres') ?? byType(s, 'azure_mysql');
const MUTATIONS: Mutation[] = [
  { id: 'drop-certificate', apply: (s) => { const c = clone(s); const r = byType(c, 'aws_alb'); if (!r?.config?.certificateArn) return null; delete r.config.certificateArn; return c; } },
  { id: 'drop-waf', apply: (s) => { const c = clone(s); const w = c.resources.find((r) => r.id.endsWith('waf-alb')); if (!w) return null; c.resources = c.resources.filter((r) => r !== w); c.connections = c.connections.filter((x) => x.from !== w.id && x.to !== w.id); return c; } },
  { id: 'drop-security-group', apply: (s) => { const c = clone(s); const g = c.resources.find((r) => /(^|-)sg-db$/.test(r.id) || /(^|-)nsg-data$/.test(r.id)); if (!g) return null; c.resources = c.resources.filter((r) => r !== g); c.connections = c.connections.filter((x) => x.from !== g.id && x.to !== g.id); return c; } },
  { id: 'public-database', apply: (s) => { const c = clone(s); const d = byType(c, 'aws_rds') ?? azureDb(c); if (!d) return null; d.config = { ...(d.config ?? {}), ...(d.type === 'aws_rds' ? { publiclyAccessible: true } : { publicNetworkAccess: true }) }; return c; } },
  // The service has its public endpoint switched off but the design never says how the application reaches it.
  { id: 'drop-private-endpoint', apply: (s) => { const c = clone(s); const pe = c.resources.find((r) => r.type === 'azure_private_endpoint'); if (!pe) return null; c.resources = c.resources.filter((r) => r !== pe); c.connections = c.connections.filter((x) => x.from !== pe.id && x.to !== pe.id); return c; } },
  { id: 'public-storage', apply: (s) => { const c = clone(s); const d = byType(c, 'azure_storage'); if (!d) return null; d.config = { ...(d.config ?? {}), allowBlobPublicAccess: true, networkDefaultAction: 'Allow' }; return c; } },
  { id: 'unencrypted-database', apply: (s) => { const c = clone(s); const d = byType(c, 'aws_rds'); if (!d) return null; d.config = { ...(d.config ?? {}), storageEncrypted: false }; return c; } },
  { id: 'single-az', apply: (s) => { const c = clone(s); const d = byType(c, 'aws_rds') ?? azureDb(c); if (!d) return null; d.config = { ...(d.config ?? {}), ...(d.type === 'aws_rds' ? { multiAz: false } : d.type === 'azure_sql' ? { zoneRedundant: false } : { highAvailability: 'Disabled' }) }; return c; } },
  { id: 'invalid-setting', apply: (s) => { const c = clone(s); const a = byType(c, 'aws_auto_scaling'); if (!a) return null; a.config = { ...(a.config ?? {}), instanceType: 't3.gigantic' }; return c; } },
  { id: 'unknown-setting', apply: (s) => { const c = clone(s); const a = byType(c, 'aws_alb') ?? byType(c, 'azure_app_gateway'); if (!a) return null; a.config = { ...(a.config ?? {}), highAvailability: true }; return c; } },
  { id: 'reversed-connection', apply: (s) => { const c = clone(s); const i = c.connections.findIndex((x) => /rds$|sql$|cache$|redis$|cosmos$|ddb$|postgres$|mysql$|bus$/.test(x.to)); if (i < 0) return null; const x = c.connections[i]; c.connections[i] = { ...x, from: x.to, to: x.from }; return c; } },
  { id: 'orphan-resource', apply: (s) => { const c = clone(s); const a = c.resources.find((r) => /assets$|storage$/.test(r.id)); if (!a) return null; c.connections = c.connections.filter((x) => x.from !== a.id && x.to !== a.id); return c; } },
  { id: 'wrong-parent', apply: (s) => { const c = clone(s); const a = c.resources.find((r) => r.type === 'aws_rds' || r.type === 'azure_sql' || r.type === 'azure_postgres' || r.type === 'azure_mysql'); const pub = c.resources.find((r) => /(^|-)public-a$|(^|-)web-subnet$/.test(r.id)); if (!a || !pub || a.parent === pub.id) return null; a.parent = pub.id; return c; } },
  { id: 'overlapping-cidr', apply: (s) => { const c = clone(s); const subs = c.resources.filter((r) => r.type === 'aws_subnet'); if (subs.length < 2) return null; subs[1].config = { ...(subs[1].config ?? {}), cidrBlock: String(subs[0].config?.cidrBlock ?? '10.0.0.0/24') }; return c; } },
  { id: 'dangling-connection', apply: (s) => { const c = clone(s); if (!c.connections.length) return null; c.connections.push({ from: c.connections[0].from, to: 'does-not-exist' }); return c; } },

  // Mistakes an untuned model was observed making against CloudCraft's rules (see the evaluation in README).
  // snake_case setting names: the real names are camelCase, e.g. cidr_block instead of cidrBlock.
  { id: 'snake-case-setting', apply: (s) => {
    const c = clone(s);
    const r = c.resources.find((x) => x.config && Object.keys(x.config).some((k) => /[A-Z]/.test(k)));
    if (!r) return null;
    const key = Object.keys(r.config!).find((k) => /[A-Z]/.test(k))!;
    const { [key]: value, ...rest } = r.config!;
    r.config = { ...rest, [key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)]: value };
    return c;
  } },
  // Ids must be lower-case-and-hyphen; models write Web_Server. References are renamed consistently so BAD_ID is the only problem.
  { id: 'bad-id', apply: (s) => {
    const c = clone(s);
    const r = c.resources.find((x) => x.parent && x.id.includes('-'));
    if (!r) return null;
    const oldId = r.id; const newId = oldId.replace(/-/g, '_').toUpperCase();
    r.id = newId;
    for (const x of c.resources) if (x.parent === oldId) x.parent = newId;
    for (const x of c.connections) { if (x.from === oldId) x.from = newId; if (x.to === oldId) x.to = newId; }
    return c;
  } },
  // Workload placed straight in the VPC/VNet instead of its subnet.
  { id: 'wrong-parent-vpc', apply: (s) => {
    const byId = new Map(s.resources.map((x) => [x.id, x]));
    return firstBroken(s.resources.filter((x) => { const p = x.parent ? byId.get(x.parent) : undefined; return p?.type.endsWith('subnet') && p.parent; }).map((r) => {
      const c = clone(s); c.resources.find((x) => x.id === r.id)!.parent = byId.get(r.parent!)!.parent; return c;
    }));
  } },
  // A WAF (or any leaf) used as if it were a container.
  { id: 'parent-not-container', apply: (s) => {
    const c = clone(s);
    const waf = c.resources.find((x) => x.type.endsWith('_waf') && x.parent);
    const lb = c.resources.find((x) => x.type === 'aws_alb' || x.type === 'azure_app_gateway');
    if (!waf || !lb) return null;
    waf.parent = lb.id;
    return c;
  } },
  // A connection drawn from a subnet (a container) to a data store.
  { id: 'subnet-connection', apply: (s) => {
    const data = s.resources.find((x) => x.type === 'aws_rds' || x.type === 'azure_sql' || x.type === 'azure_postgres' || x.type === 'azure_mysql');
    if (!data) return null;
    return firstBroken(s.resources.filter((x) => x.type.endsWith('subnet')).map((sub) => { const c = clone(s); c.connections.push({ from: sub.id, to: data.id }); return c; }));
  } },
  // ── Mistakes found by running the real model over 34 free-form prompts (scripts/ai-dataset/batch-failures.ts). ──
  // A firewall that is placed but never attached to the load balancer.
  { id: 'waf-unconnected', apply: (s) => { const c = clone(s); const w = c.resources.find((r) => r.type === 'aws_waf' || r.type === 'azure_waf'); if (!w) return null; const n = c.connections.length; c.connections = c.connections.filter((x) => x.from !== w.id && x.to !== w.id); return c.connections.length < n ? c : null; } },
  // Subnet address ranges left out, so every subnet falls back to the same default and they overlap.
  { id: 'subnets-default-cidr', apply: (s) => { const c = clone(s); const subs = c.resources.filter((r) => r.type === 'aws_subnet' && r.config?.cidrBlock); if (subs.length < 2) return null; for (const r of subs) delete r.config!.cidrBlock; return c; } },
  // Availability zones left out, so every subnet lands in one zone.
  { id: 'subnets-no-zone', apply: (s) => { const c = clone(s); const subs = c.resources.filter((r) => r.type === 'aws_subnet' && r.config?.availabilityZone); if (subs.length < 2) return null; for (const r of subs) delete r.config!.availabilityZone; return c; } },
  // The load balancer is not connected to the compute behind it.
  { id: 'alb-not-connected', apply: (s) => { const c = clone(s); const lb = c.resources.find((r) => r.type === 'aws_alb'); if (!lb) return null; const n = c.connections.length; c.connections = c.connections.filter((x) => x.from !== lb.id || !/^(asg|svc|web|fn|eks)/.test(x.to)); return c.connections.length < n ? c : null; } },
  // Connections that name an internet gateway the design never declared.
  { id: 'igw-undeclared', apply: (s) => { const c = clone(s); const i = c.resources.find((r) => r.type === 'aws_igw'); if (!i) return null; c.resources = c.resources.filter((r) => r !== i); return c; } },
  // Internet gateway and NAT gateways floating, connected to nothing.
  { id: 'gateways-floating', apply: (s) => { const c = clone(s); const g = c.resources.filter((r) => r.type === 'aws_igw' || r.type === 'aws_nat').map((r) => r.id); if (!g.length) return null; const n = c.connections.length; c.connections = c.connections.filter((x) => !g.includes(x.from) && !g.includes(x.to)); return c.connections.length < n ? c : null; } },
  // Parent that does not exist.
  { id: 'unknown-parent', apply: (s) => {
    const c = clone(s);
    const r = c.resources.find((x) => x.parent && x.type !== 'aws_subnet' && x.type !== 'azure_subnet');
    if (!r) return null;
    r.parent = `${r.parent}-tier`;
    return c;
  } },
];

/** Apply one mutation, or two different ones at once (models rarely make just one mistake). */
function mutate(spec: ArchitectureSpec, first: Mutation, second?: Mutation): ArchitectureSpec | null {
  const a = first.apply(spec);
  if (!a || !second) return a;
  return second.apply(a);
}

// ─── Build ────────────────────────────────────────────────────────────────────────────────

/** `group` is the hash of the underlying design: every row about the same design (its paraphrases and its repairs) shares one train/validation side, so validation never contains a design the model trained on. */
interface Row { pattern: string; provider: string; kind: 'design' | 'repair' | 'adjust'; req: Requirements; line: string; tokens: number; inputs: number; mutation?: string; style: string; group: string }

function main() {
  const outDir = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'datasets/ai-architect';
  const rand = rng(SEED);
  const rejected: { pattern: string; requirements: string; stage: string; issues: string[] }[] = [];
  const seenGraphs = new Set<string>();
  const design: Row[] = [];
  const evalSet: { id: string; requirements: Requirements; prompt: string }[] = [];
  const repairPool: { req: Requirements; prompt: string; spec: ArchitectureSpec; pattern: string; style: string; group: string }[] = [];
  let appCursor = 0; let styleCursor = 0; let dupes = 0; let evaluated = 0;

  for (const p of PATTERNS) {
    const pool = shuffle(lattice(p), rand);
    let kept = 0; let held = 0;
    for (const req0 of pool) {
      if (kept >= p.target && held >= EVAL_PER_PATTERN) break;
      const isEval = kept >= p.target;
      const style: PromptStyle = PROMPT_STYLES[styleCursor++ % PROMPT_STYLES.length]!;
      const named: Requirements = { ...req0, app: APP_NAMES[appCursor++ % APP_NAMES.length] };
      // A vague prompt says less, so the design must be the sensible default for everything it leaves out.
      const req = style === 'vague' ? vagueRequirements(named, p.fixed) : named;
      evaluated++;
      let spec: ArchitectureSpec;
      try { spec = hardenSpec(p.fn(req)).spec; } catch (e) { rejected.push({ pattern: p.id, requirements: JSON.stringify(req), stage: 'build', issues: [(e as Error).message] }); continue; }
      const ev = evaluateSpec(spec);
      if (!ev.ok) { rejected.push({ pattern: p.id, requirements: JSON.stringify(req), stage: ev.stage, issues: ev.issues.slice(0, 5).map((i) => `${i.code}: ${i.message}`) }); continue; }
      const h = hashOf(spec);
      if (seenGraphs.has(h)) { dupes++; continue; }
      seenGraphs.add(h);
      const prompt = promptFor(req, style, Math.floor(rand() * 1000));
      if (isEval) { evalSet.push({ id: `eval-${evalSet.length + 1}`, requirements: req, prompt }); held++; continue; }
      const json = JSON.stringify(spec);
      design.push({ pattern: p.id, provider: p.provider, kind: 'design', req, line: JSON.stringify(chat(prompt, json)), tokens: tokens(ARCHITECT_SYSTEM_PROMPT) + tokens(prompt) + tokens(json), inputs: ev.deploymentInputs?.length ?? 0, style, group: h });
      repairPool.push({ req, prompt, spec, pattern: p.id, style, group: h });
      kept++;
      // ~30% of designs also appear with a differently worded request, so the model learns that
      // phrasing changes the words, not the architecture.
      if (rand() < 0.3) {
        const alts = PROMPT_STYLES.filter((x) => x !== 'vague' && x !== style);
        const altStyle = alts[Math.floor(rand() * alts.length)]!;
        const altPrompt = promptFor(req, altStyle, Math.floor(rand() * 1000));
        design.push({ pattern: p.id, provider: p.provider, kind: 'design', req, line: JSON.stringify(chat(altPrompt, json)), tokens: tokens(ARCHITECT_SYSTEM_PROMPT) + tokens(altPrompt) + tokens(json), inputs: ev.deploymentInputs?.length ?? 0, style: altStyle, group: h });
      }
    }
  }

  // Repair examples: one per ~7 designs, using a mutation that genuinely fails a gate.
  const repairs: Row[] = [];
  const mutationCounts: Record<string, number> = {};
  const picks = shuffle(repairPool, rng(SEED + 1)).slice(0, Math.floor(repairPool.length / 2.5));
  for (const item of picks) {
    const order = shuffle(MUTATIONS, rand);
    for (const m of order) {
      // ~45% of repairs try to break the design in two different ways at once; the validator reports the
      // earliest failing stage first, and the model must still return the fully corrected design.
      const second = rand() < 0.45 ? order.find((o) => o.id !== m.id) : undefined;
      let broken = mutate(item.spec, m, second);
      let pair = second;
      if (!broken && second) { broken = mutate(item.spec, m); pair = undefined; }
      if (!broken) continue;
      const ev = evaluateSpec(broken);
      if (ev.ok || !ev.issues.length) continue;
      // Same message format the app sends on a retry (withHints adds the valid setting names / allowed parents).
      const user = buildRepairPrompt(item.prompt, JSON.stringify(broken), ev.stage, withHints(ev.issues));
      const json = JSON.stringify(item.spec);
      const label = pair ? `${m.id}+${pair.id}` : m.id;
      repairs.push({ pattern: item.pattern, provider: item.req.provider, kind: 'repair', req: item.req, mutation: label, line: JSON.stringify(chat(user, json)), tokens: tokens(ARCHITECT_SYSTEM_PROMPT) + tokens(user) + tokens(json), inputs: 0, style: item.style, group: item.group });
      mutationCounts[label] = (mutationCounts[label] ?? 0) + 1;
      break;
    }
  }

  // Adjust examples: the app's fallback asks the model to change the closest VERIFIED design as little as possible (adjustPrompt).
  // Here the verified design is another one of the same pattern, and the answer is the design for THIS request, so the model learns to
  // keep the structure (ids, parents, zones, security groups, connections) and change only what the request needs.
  const adjusts: Row[] = [];
  const byPattern = new Map<string, typeof repairPool>();
  for (const item of repairPool) byPattern.set(item.pattern, [...(byPattern.get(item.pattern) ?? []), item]);
  const adjustRand = rng(SEED + 3);
  for (const [pattern, items] of byPattern) {
    if (items.length < 2) continue;
    const targets = shuffle(items, adjustRand).slice(0, Math.max(1, Math.floor(items.length / 4)));
    for (const t of targets) {
      const base = items.find((x) => x.group !== t.group && x.req.provider === t.req.provider);
      if (!base) continue;
      const user = adjustPrompt(t.prompt, { title: PATTERN_TEXT[pattern]?.title ?? pattern, patternId: `pattern-${pattern}`, spec: base.spec });
      const json = JSON.stringify(t.spec);
      adjusts.push({ pattern, provider: t.req.provider, kind: 'adjust', req: t.req, line: JSON.stringify(chat(user, json)), tokens: tokens(ARCHITECT_SYSTEM_PROMPT) + tokens(user) + tokens(json), inputs: 0, style: t.style, group: t.group });
    }
  }

  // Train / validation split by DESIGN (~10% of designs): a design's paraphrases and its repair examples all
  // land on the same side, so validation loss is measured on architectures the model never trained on.
  const all = [...design, ...repairs, ...adjusts];
  const train: Row[] = []; const val: Row[] = [];
  for (const r of shuffle(all, rng(SEED + 2))) (parseInt(r.group.slice(0, 6), 16) % 10 === 0 ? val : train).push(r);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'train.jsonl'), train.map((r) => r.line).join('\n') + '\n');
  writeFileSync(join(outDir, 'validation.jsonl'), val.map((r) => r.line).join('\n') + '\n');
  writeFileSync(join(outDir, 'eval-prompts.jsonl'), evalSet.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(outDir, 'rejected.json'), JSON.stringify(rejected, null, 2) + '\n');

  const count = (rows: Row[], f: (r: Row) => string) => rows.reduce<Record<string, number>>((m, r) => { const k = f(r); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const sum = (rows: Row[]) => rows.reduce((a, r) => a + r.tokens, 0);
  const manifest = {
    seed: SEED,
    examples: { train: train.length, validation: val.length, designs: design.length, repairs: repairs.length, adjusts: adjusts.length, heldOutEvalPrompts: evalSet.length },
    byProvider: count(all, (r) => r.provider),
    byPattern: count(all, (r) => r.pattern),
    byPromptStyle: count(design, (r) => r.style),
    byScale: count(design, (r) => r.req.scale),
    byPrimaryRegion: count(design, (r) => r.req.region),
    byDatabase: count(design, (r) => r.req.db),
    regulated: count(design, (r) => String(r.req.regulated)),
    repairMutations: mutationCounts,
    tokensEstimate: { train: sum(train), validation: sum(val), perEpochTrainNote: 'Estimated at 4 characters per token; billing uses the real tokenizer.', systemPrompt: tokens(ARCHITECT_SYSTEM_PROMPT) },
    designsWithDeploymentPlaceholders: design.filter((r) => r.inputs > 0).length,
    catalogTypes: CATALOG_TYPES.length,
    generation: { candidatesEvaluated: evaluated, rejectedByGates: rejected.length, duplicatesSkipped: dupes },
    guarantees: 'Every assistant design in train.jsonl and validation.jsonl passed all deploy-readiness gates in lib/ai/architectureSpec.ts. Repair examples target the gate-passing design.',
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest, null, 2));
  if (rejected.length) console.log(`\n${rejected.length} candidate(s) rejected — see ${join(outDir, 'rejected.json')}`);
}

main();
