/**
 * Mechanical repairs to a model-written design, applied before it is validated (inference only, like specSanitizer.ts).
 *
 * These are the mistakes a language model keeps making and that have exactly one sensible answer, so asking it again is slower and
 * less reliable than doing it here:
 *
 *  1. an internet-facing load balancer with no certificate setting gets the standard placeholder certificate, which CloudCraft
 *     already reports as a value the person must supply before deploying (it never invents a real certificate);
 *  2. an internet-facing load balancer with no web application firewall gets one, attached to it;
 *  3. subnets that share an address range (the model leaves it out, so every subnet gets the catalog default) get their own /24
 *     inside the network's range; a connection that names an internet gateway the design never declared gets one added;
 *  4. parts of the design that are not connected to the entry point are connected the usual way: load balancer to the compute it
 *     should serve, compute to the data stores, DNS to the load balancer.
 *
 * Every step is checked: if the repaired design compiles with MORE problems than before, that step is undone. Nothing here can make
 * a design that compiled stop compiling.
 */
import { compileSpec, parseSpec } from './architectureSpec';

interface SRes { id?: unknown; type?: unknown; label?: unknown; parent?: unknown; config?: Record<string, unknown> }
interface SConn { from?: unknown; to?: unknown }
interface Spec { resources?: SRes[]; connections?: SConn[]; [k: string]: unknown }

const CERT_PLACEHOLDER = (region: string) => `arn:aws:acm:${region}:123456789012:certificate/REPLACE-WITH-YOUR-CERTIFICATE-ID`;
const COMPUTE = new Set(['aws_auto_scaling', 'aws_ec2', 'aws_ecs', 'aws_lambda']);
const DATA = new Set(['aws_rds', 'aws_elasticache', 'aws_dynamodb', 'aws_s3']);
// Network edge pieces that must hang off the entry point: a firewall on the load balancer, the internet gateway to it, NAT to the gateway.
const EDGE = new Set(['aws_waf', 'aws_igw', 'aws_nat']);
const ENTRY = new Set(['aws_route53', 'aws_cloudfront', 'aws_alb']);
const sid = (r: SRes) => String(r.id ?? '');

function problems(spec: Spec): number {
  const parsed = parseSpec(spec);
  if (!parsed.spec) return parsed.issues.length + 1000;
  return compileSpec(parsed.spec).issues.length;
}

function regionOf(spec: Spec): string {
  for (const r of spec.resources ?? []) {
    const az = r.type === 'aws_subnet' ? r.config?.['availabilityZone'] : undefined;
    const m = typeof az === 'string' ? /^([a-z]{2}-[a-z]+-\d)[a-z]$/.exec(az) : null;
    if (m) return m[1]!;
  }
  return 'us-east-1';
}

function addCertificates(spec: Spec): number {
  let n = 0;
  const region = regionOf(spec);
  for (const r of spec.resources ?? []) {
    if (r.type !== 'aws_alb') continue;
    const cfg = (r.config ??= {});
    const https = cfg['listenerProtocol'] === undefined || cfg['listenerProtocol'] === 'HTTPS' || cfg['listenerProtocol'] === 'TLS';
    if (https && cfg['scheme'] !== 'internal' && !cfg['certificateArn']) { cfg['certificateArn'] = CERT_PLACEHOLDER(region); n++; }
  }
  return n;
}

function addWaf(spec: Spec): number {
  const resources = spec.resources ?? [];
  const connections = (spec.connections ??= []);
  const boundary = resources.find((r) => r.type === 'aws_cloud_boundary');
  if (!boundary) return 0;
  let n = 0;
  for (const alb of resources.filter((r) => r.type === 'aws_alb' && r.config?.['scheme'] !== 'internal')) {
    const hasWaf = connections.some((c) => c.to === alb.id && resources.some((w) => w.id === c.from && w.type === 'aws_waf'));
    if (hasWaf) continue;
    const id = `waf-${sid(alb)}`.slice(0, 63);
    if (resources.some((r) => r.id === id)) continue;
    resources.push({ id, type: 'aws_waf', label: 'Regional WAF', parent: boundary.id, config: { scope: 'REGIONAL', defaultAction: 'ALLOW', managedRuleGroups: ['AWSManagedRulesCommonRuleSet', 'AWSManagedRulesKnownBadInputsRuleSet'], rateLimitEnabled: true } });
    connections.push({ from: id, to: alb.id });
    n++;
  }
  return n;
}

function connectLooseParts(spec: Spec): number {
  const resources = spec.resources ?? [];
  const connections = (spec.connections ??= []);
  const handled = (r: SRes) => ENTRY.has(String(r.type)) || COMPUTE.has(String(r.type)) || DATA.has(String(r.type)) || EDGE.has(String(r.type));
  const nodes = resources.filter(handled);
  if (nodes.length < 2) return 0;

  const adjacency = () => {
    const adj = new Map<string, Set<string>>();
    for (const c of connections) {
      const a = String(c.from), b = String(c.to);
      if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a)!.add(b); adj.get(b)!.add(a);
    }
    return adj;
  };
  let added = 0;
  const link = (from: SRes, to: SRes) => { connections.push({ from: from.id, to: to.id }); added++; };

  for (let pass = 0; pass < 4; pass++) {
    const adj = adjacency();
    // The entry point (DNS, CDN or load balancer) anchors the design; if there is none, the first piece does.
    const start = sid(nodes.find((r) => ENTRY.has(String(r.type))) ?? nodes[0]!);
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) for (const nb of adj.get(stack.pop()!) ?? []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    const loose = nodes.filter((r) => !seen.has(sid(r)));
    if (loose.length === 0) break;
    const inMain = (types: Set<string> | string) => nodes.filter((r) => seen.has(sid(r)) && (typeof types === 'string' ? r.type === types : types.has(String(r.type))));

    let changed = false;
    for (const x of loose) {
      const type = String(x.type);
      if (COMPUTE.has(type)) { const alb = inMain('aws_alb')[0]; if (alb) { link(alb, x); changed = true; } }
      else if (DATA.has(type)) { const caller = inMain(COMPUTE)[0]; if (caller) { link(caller, x); changed = true; } }
      else if (type === 'aws_alb') { const dns = inMain('aws_route53')[0] ?? inMain('aws_cloudfront')[0]; if (dns) { link(dns, x); changed = true; } }
      else if (type === 'aws_waf') { const target = inMain('aws_alb')[0] ?? inMain('aws_cloudfront')[0]; if (target) { link(x, target); changed = true; } }
      else if (type === 'aws_igw') { const alb = inMain('aws_alb')[0]; if (alb) { link(x, alb); changed = true; } }
      else if (type === 'aws_nat') { const igw = inMain('aws_igw')[0]; if (igw) { link(x, igw); changed = true; } }
      else if (type === 'aws_route53' || type === 'aws_cloudfront') { const alb = inMain('aws_alb')[0]; if (alb) { link(x, alb); changed = true; } }
    }
    if (!changed) break;
  }
  return added;
}

const SUBNET_KEY: Record<string, { key: string; fallback: string }> = {
  aws_subnet: { key: 'cidrBlock', fallback: '10.0.1.0/24' },
  azure_subnet: { key: 'addressPrefix', fallback: '10.0.1.0/24' },
};
const NET_KEY: Record<string, string> = { aws_vpc: 'cidrBlock', azure_vnet: 'addressSpace' };

function range(cidr: unknown): { start: number; end: number; prefix: number } | null {
  const m = typeof cidr === 'string' ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr) : null;
  if (!m) return null;
  const [a, b, c, d, p] = m.slice(1).map(Number) as [number, number, number, number, number];
  if ([a, b, c, d].some((x) => x > 255) || p > 32) return null;
  const ip = ((a * 256 + b) * 256 + c) * 256 + d;
  const size = 2 ** (32 - p);
  const start = Math.floor(ip / size) * size;
  return { start, end: start + size - 1, prefix: p };
}

function fixAddressing(spec: Spec): number {
  const resources = spec.resources ?? [];
  let n = 0;
  const byParent = new Map<string, SRes[]>();
  for (const r of resources) if (SUBNET_KEY[String(r.type)]) byParent.set(String(r.parent ?? ''), [...(byParent.get(String(r.parent ?? '')) ?? []), r]);
  for (const [parentId, subnets] of byParent) {
    if (subnets.length < 2) continue;
    const ranges = subnets.map((s) => range(s.config?.[SUBNET_KEY[String(s.type)]!.key] ?? SUBNET_KEY[String(s.type)]!.fallback));
    const overlap = ranges.some((a, i) => ranges.some((b, j) => i < j && a && b && a.start <= b.end && b.start <= a.end));
    if (!overlap) continue;
    const parent = resources.find((r) => r.id === parentId);
    const netCidr = parent ? (parent.config?.[NET_KEY[String(parent.type)] ?? ''] ?? '10.0.0.0/16') : '10.0.0.0/16';
    const net = range(netCidr);
    if (!net || net.prefix > 16 || subnets.length > 250) continue;      // only the usual /16 network is renumbered
    const [x, y] = [Math.floor(net.start / 16777216) % 256, Math.floor(net.start / 65536) % 256];
    subnets.forEach((s, i) => { (s.config ??= {})[SUBNET_KEY[String(s.type)]!.key] = `${x}.${y}.${i + 1}.0/24`; n++; });
  }
  return n;
}

function addMissingGateway(spec: Spec): number {
  const resources = spec.resources ?? [];
  const connections = spec.connections ?? [];
  const names = (c: SConn) => [String(c.from), String(c.to)];
  const declared = new Set(resources.map(sid));
  if (!connections.some((c) => names(c).includes('igw')) || declared.has('igw')) return 0;
  const vpc = resources.find((r) => r.type === 'aws_vpc');
  if (!vpc) return 0;
  resources.push({ id: 'igw', type: 'aws_igw', label: 'Internet Gateway', parent: vpc.id, config: {} });
  return 1;
}

export interface SpecRepairReport { certificates: number; waf: number; connections: number; addressing: number; gateway: number }

/** Returns the repaired design (a copy) and what was done. Steps that would make the design compile worse are undone. */
export function repairSpecInput(input: unknown): { value: unknown; report: SpecRepairReport } {
  const report: SpecRepairReport = { certificates: 0, waf: 0, connections: 0, addressing: 0, gateway: 0 };
  if (!input || typeof input !== 'object' || !Array.isArray((input as Spec).resources)) return { value: input, report };

  let spec = JSON.parse(JSON.stringify(input)) as Spec;
  const step = (name: keyof SpecRepairReport, run: (s: Spec) => number) => {
    const trial = JSON.parse(JSON.stringify(spec)) as Spec;
    const before = problems(spec);
    const done = run(trial);
    if (done > 0 && problems(trial) <= before) { spec = trial; report[name] = done; }
  };
  step('addressing', fixAddressing);
  step('gateway', addMissingGateway);
  step('certificates', addCertificates);
  step('waf', addWaf);
  step('connections', connectLooseParts);
  return { value: spec, report };
}

export function describeSpecRepair(report: SpecRepairReport): string[] {
  const out: string[] = [];
  if (report.certificates > 0) out.push(`The load balancer had no certificate setting, so a placeholder was added: replace it with your own ACM certificate before deploying.`);
  if (report.waf > 0) out.push(`CloudCraft added a web application firewall in front of the internet-facing load balancer.`);
  if (report.addressing > 0) out.push(`Subnets shared one address range, so ${report.addressing} of them were given their own.`);
  if (report.gateway > 0) out.push('The design used an internet gateway it never declared, so one was added.');
  if (report.connections > 0) out.push(`CloudCraft connected ${report.connections} part(s) of the design that the AI had left disconnected.`);
  return out;
}
