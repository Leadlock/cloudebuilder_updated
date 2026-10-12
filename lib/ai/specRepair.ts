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
 *  4. Azure data services left with their insecure defaults get the settings the verified patterns use (SQL auditing and threat detection on,
 *     private-only access, TLS 1.2; Redis private-only, no plain-text port), and Azure subnets with no network security group get one;
 *  4b. an Azure service whose public endpoint is off (Storage, SQL, Key Vault, Redis, Cosmos DB…) gets a Private Endpoint in a subnet, because
 *     without one the application has no way to reach it; a private PostgreSQL or MySQL flexible server gets a subnet of its own;
 *  5. parts of the design that are not connected to the entry point are connected the usual way: load balancer to the compute it
 *     should serve, compute to the data stores, DNS to the load balancer.
 *
 * Every step is checked: if the repaired design compiles with MORE problems than before, that step is undone. Nothing here can make
 * a design that compiled stop compiling.
 */
import { compileSpec, parseSpec } from './architectureSpec';
import { getResourceDefinition } from '@/lib/resources';
import { endpointsOf, needsPrivateEndpoint, PRIVATE_LINK_TARGETS, SUBNET_INJECTED_TYPES } from '@/lib/engines/assessment/privateAccess';

interface SRes { id?: unknown; type?: unknown; label?: unknown; parent?: unknown; config?: Record<string, unknown> }
interface SConn { from?: unknown; to?: unknown }
interface Spec { resources?: SRes[]; connections?: SConn[]; [k: string]: unknown }

const CERT_PLACEHOLDER = (region: string) => `arn:aws:acm:${region}:123456789012:certificate/REPLACE-WITH-YOUR-CERTIFICATE-ID`;
const COMPUTE = new Set(['aws_auto_scaling', 'aws_ec2', 'aws_ecs', 'aws_lambda', 'azure_app_service', 'azure_functions', 'azure_vmss', 'azure_vm', 'azure_aks']);
const DATA = new Set(['aws_rds', 'aws_elasticache', 'aws_dynamodb', 'aws_s3', 'azure_sql', 'azure_cosmos_db', 'azure_redis', 'azure_storage', 'azure_key_vault', 'azure_postgres', 'azure_mysql', 'azure_service_bus', 'azure_acr', 'azure_monitor']);
// Network edge pieces that must hang off the entry point: a firewall on the load balancer, the internet gateway to it, NAT to the gateway.
const EDGE = new Set(['aws_waf', 'aws_igw', 'aws_nat', 'azure_waf']);
const ENTRY = new Set(['aws_route53', 'aws_cloudfront', 'aws_alb', 'azure_front_door', 'azure_app_gateway', 'azure_lb']);
/** The things that take traffic from the internet and pass it to compute. */
const FRONT = ['aws_alb', 'azure_app_gateway', 'azure_front_door', 'azure_lb'];
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

    const front = () => FRONT.map((t) => inMain(t)[0]).find(Boolean);
    let changed = false;
    for (const x of loose) {
      const type = String(x.type);
      if (COMPUTE.has(type)) { const lb = front(); if (lb) { link(lb, x); changed = true; } }
      else if (DATA.has(type)) { const caller = inMain(COMPUTE)[0]; if (caller) { link(caller, x); changed = true; } }
      else if (type === 'aws_alb') { const dns = inMain('aws_route53')[0] ?? inMain('aws_cloudfront')[0]; if (dns) { link(dns, x); changed = true; } }
      else if (type === 'aws_waf' || type === 'azure_waf') { const target = front() ?? inMain('aws_cloudfront')[0]; if (target) { link(x, target); changed = true; } }
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

/** Settings the verified patterns give these services. Only keys the design left out, or set to the insecure value, are changed. */
const SECURE_SETTINGS: Record<string, { set: Record<string, unknown>; insecure: Record<string, unknown> }> = {
  azure_sql: {
    set: { publicNetworkAccess: false, allowAzureServices: false, minimumTlsVersion: '1.2', auditingEnabled: true, threatDetectionEnabled: true },
    insecure: { publicNetworkAccess: true, allowAzureServices: true, auditingEnabled: false, threatDetectionEnabled: false },
  },
  azure_redis: {
    set: { enableNonSslPort: false, publicNetworkAccessEnabled: false, minimumTlsVersion: '1.2' },
    insecure: { enableNonSslPort: true, publicNetworkAccessEnabled: true },
  },
  azure_postgres: {
    set: { publicNetworkAccess: false, requireSecureTransport: true, minimumTlsVersion: 'TLSv1.2' },
    insecure: { publicNetworkAccess: true, requireSecureTransport: false },
  },
  azure_mysql: {
    set: { publicNetworkAccess: false, requireSecureTransport: true, minimumTlsVersion: 'TLSv1.2' },
    insecure: { publicNetworkAccess: true, requireSecureTransport: false },
  },
};

function secureDefaults(spec: Spec): number {
  let n = 0;
  for (const r of spec.resources ?? []) {
    const rule = SECURE_SETTINGS[String(r.type)];
    if (!rule) continue;
    const cfg = (r.config ??= {});
    let changed = false;
    for (const [k, v] of Object.entries(rule.set)) {
      if (!(k in cfg) || cfg[k] === rule.insecure[k]) { if (cfg[k] !== v) { cfg[k] = v; changed = true; } }
    }
    if (changed) n++;
  }
  return n;
}

/** Every Azure subnet is protected by a network security group: the web tier takes HTTPS only, the rest only private traffic. */
function addSubnetNsgs(spec: Spec): number {
  const resources = spec.resources ?? [];
  const connections = (spec.connections ??= []);
  let n = 0;
  for (const subnet of resources.filter((r) => r.type === 'azure_subnet')) {
    const protectedAlready = connections.some((c) => c.to === subnet.id && resources.some((x) => x.id === c.from && x.type === 'azure_nsg'));
    if (protectedAlready) continue;
    const vnet = resources.find((r) => r.id === subnet.parent && r.type === 'azure_vnet');
    if (!vnet) continue;
    const id = ('nsg-' + sid(subnet).replace(/-subnet$/, '')).slice(0, 63);
    if (resources.some((r) => r.id === id)) continue;
    const web = /web|public|gateway|bastion/i.test(sid(subnet) + String(subnet.label ?? ''));
    resources.push({ id, type: 'azure_nsg', label: String(subnet.label ?? sid(subnet)).replace(/ Subnet$/i, '') + ' NSG', parent: vnet.id, config: web ? { allowHttp: false, allowHttps: true } : { allowHttp: false, allowHttps: false, sourceCidr: '10.0.0.0/8' } });
    connections.push({ from: id, to: subnet.id });
    n++;
  }
  return n;
}

/** Where each kind of resource belongs: the subnet tier it goes in. */
const TIER: Record<string, 'web' | 'app' | 'data'> = {
  aws_alb: 'web', aws_nat: 'web', azure_app_gateway: 'web', azure_lb: 'web', azure_bastion: 'web',
  aws_auto_scaling: 'app', aws_ec2: 'app', aws_ecs: 'app', aws_lambda: 'app', azure_vm: 'app', azure_vmss: 'app', azure_functions: 'app', azure_aks: 'app',
  aws_rds: 'data', aws_elasticache: 'data', azure_sql: 'data', azure_redis: 'data', azure_postgres: 'data', azure_mysql: 'data',
};
const TIER_WORDS: Record<'web' | 'app' | 'data', RegExp> = { web: /public|web|gateway/i, app: /app|private|compute|workload/i, data: /data|db|database/i };
const NETWORK = new Set(['aws_vpc', 'azure_vnet']);
const SUBNET = new Set(['aws_subnet', 'azure_subnet']);

/** A workload placed straight in the VPC or VNet instead of its subnet goes into the subnet of its tier (spread over the zones). */
function placeInSubnets(spec: Spec): number {
  const resources = spec.resources ?? [];
  const taken = new Map<string, number>();
  let n = 0;
  for (const r of resources) {
    const tier = TIER[String(r.type)];
    const parent = resources.find((p) => p.id === r.parent);
    if (!tier || !parent || !NETWORK.has(String(parent.type))) continue;
    const candidates = resources.filter((x) => SUBNET.has(String(x.type)) && x.parent === parent.id && TIER_WORDS[tier].test(sid(x) + ' ' + String(x.label ?? '')));
    if (candidates.length === 0) continue;
    const i = taken.get(tier) ?? 0;
    taken.set(tier, i + 1);
    r.parent = candidates[i % candidates.length]!.id;
    n++;
  }
  return n;
}

/** Placement is shown by nesting, never by a traffic line: a connection to or from a subnet, VPC or boundary (other than a security group) is dropped. */
function dropContainerEdges(spec: Spec): number {
  const resources = spec.resources ?? [];
  const byId = new Map(resources.map((r) => [sid(r), r]));
  const container = (id: unknown) => { const t = String(byId.get(String(id))?.type ?? ''); return NETWORK.has(t) || SUBNET.has(t) || t.endsWith('_cloud_boundary'); };
  const guard = (id: unknown) => /_(sg|nsg|nacl|route_table)$/.test(String(byId.get(String(id))?.type ?? ''));
  const before = (spec.connections ?? []).length;
  spec.connections = (spec.connections ?? []).filter((c) => !((container(c.from) && !guard(c.to)) || (container(c.to) && !guard(c.from))));
  return before - spec.connections.length;
}

/** A security group or NSG with no connection (or placed outside the network) protects the subnet whose name matches it. */
function attachLooseGroups(spec: Spec): number {
  const resources = spec.resources ?? [];
  const connections = (spec.connections ??= []);
  const network = resources.filter((r) => NETWORK.has(String(r.type)));
  let n = 0;
  for (const g of resources.filter((r) => r.type === 'azure_nsg' || r.type === 'aws_sg')) {
    const net = resources.find((r) => r.id === g.parent && NETWORK.has(String(r.type))) ?? (network.length === 1 ? network[0] : undefined);
    if (!net) continue;
    let changed = false;
    if (g.parent !== net.id) { g.parent = net.id; changed = true; }
    const attached = connections.some((c) => c.from === g.id || c.to === g.id);
    if (!attached && g.type === 'azure_nsg') {
      const guarded = new Set(connections.filter((c) => resources.some((x) => x.id === c.from && x.type === 'azure_nsg')).map((c) => c.to));
      const open = resources.filter((r) => r.type === 'azure_subnet' && r.parent === net.id && !guarded.has(r.id));
      const words = (sid(g) + ' ' + String(g.label ?? '')).toLowerCase();
      const match = open.find((s) => (['web', 'public', 'app', 'data'] as const).some((w) => words.includes(w) && (sid(s) + ' ' + String(s.label ?? '')).toLowerCase().includes(w)));
      if (match) { connections.push({ from: g.id, to: match.id }); changed = true; }
    }
    if (changed) n++;
  }
  return n;
}

const effective = (r: SRes): Record<string, unknown> => ({ ...(getResourceDefinition(String(r.type))?.defaultConfig ?? {}), ...(r.config ?? {}) });

/** The next /24 inside the network's range that no subnet uses. */
function freeSubnetCidr(vnet: SRes, subnets: SRes[]): string | null {
  const net = range(vnet.config?.['addressSpace'] ?? '10.0.0.0/16');
  if (!net || net.prefix > 24) return null;
  const used = subnets.map((x) => range(x.config?.['addressPrefix'] ?? '10.0.1.0/24')).filter((x): x is NonNullable<ReturnType<typeof range>> => !!x);
  for (let start = net.start; start + 255 <= net.end; start += 256) {
    if (!used.some((u) => u.start <= start + 255 && start <= u.end)) {
      const o = [Math.floor(start / 16777216) % 256, Math.floor(start / 65536) % 256, Math.floor(start / 256) % 256];
      return `${o[0]}.${o[1]}.${o[2]}.0/24`;
    }
  }
  return null;
}

/** A subnet for something that must have one to itself. Returns its id, or null when there is no network or no free range. */
function addSubnet(spec: Spec, vnet: SRes, id: string, label: string): string | null {
  const resources = spec.resources ?? [];
  if (resources.some((r) => r.id === id)) return id;
  const cidr = freeSubnetCidr(vnet, resources.filter((r) => r.type === 'azure_subnet' && r.parent === vnet.id));
  if (!cidr) return null;
  resources.push({ id, type: 'azure_subnet', label, parent: vnet.id, config: { addressPrefix: cidr } });
  return id;
}

/** A PostgreSQL or MySQL flexible server with private access is placed in a subnet delegated to it, which can hold nothing else. */
function isolateFlexibleServers(spec: Spec): number {
  const resources = spec.resources ?? [];
  let n = 0;
  for (const s of resources.filter((r) => SUBNET_INJECTED_TYPES.has(String(r.type)) && effective(r)['publicNetworkAccess'] !== true)) {
    const vnet = resources.find((r) => r.type === 'azure_vnet');
    if (!vnet) continue;
    const here = resources.find((r) => r.id === s.parent && r.type === 'azure_subnet');
    const sameKindOnly = (sub: SRes) => resources.filter((x) => x.parent === sub.id).every((x) => x.type === s.type);
    if (here && sameKindOnly(here)) continue;
    const subnetId = addSubnet(spec, vnet, `${sid(s)}-subnet`.slice(0, 63), `${String(s.label ?? sid(s))} Subnet`);
    if (subnetId) { s.parent = subnetId; n++; }
  }
  return n;
}

/**
 * A service whose public endpoint is off gets a Private Endpoint, or its own application cannot reach it. The endpoint goes in a subnet that
 * is not delegated to a flexible server: a subnet that already holds private endpoints, then a data or private subnet, then a new one.
 */
function addPrivateEndpoints(spec: Spec): number {
  const resources = spec.resources ?? [];
  const connections = (spec.connections ??= []);
  const vnet = resources.find((r) => r.type === 'azure_vnet');
  if (!vnet) return 0;
  let n = 0;
  const served = (target: SRes) => endpointsOf(sid(target), resources.map((r) => ({ id: sid(r), resourceType: String(r.type) })), connections.map((c) => ({ source: String(c.from), target: String(c.to) }))).length > 0;
  const needy = () => resources.filter((r) => {
    const t = PRIVATE_LINK_TARGETS[String(r.type)];
    if (!t || !needsPrivateEndpoint(String(r.type), effective(r))) return false;
    const req = t.requires;
    return !(req && !req.values.includes(String(effective(r)[req.key]))) && !served(r);     // a tier that cannot have an endpoint is reported by the Terraform step
  });

  // An endpoint the design already has but never connected is connected to the service that needs one (the one it is named after, else the first).
  for (const pe of resources.filter((r) => r.type === 'azure_private_endpoint' && !connections.some((c) => c.from === r.id || c.to === r.id))) {
    const waiting = needy();
    const match = waiting.find((t) => `${sid(pe)} ${String(pe.label ?? '')}`.toLowerCase().includes(sid(t).toLowerCase()) || `${sid(pe)} ${String(pe.label ?? '')}`.toLowerCase().includes(String(t.label ?? '').toLowerCase())) ?? waiting[0];
    if (match) { connections.push({ from: sid(pe), to: sid(match) }); n++; }
  }

  for (const target of needy()) {
    const delegated = new Set(resources.filter((r) => SUBNET_INJECTED_TYPES.has(String(r.type)) && effective(r)['publicNetworkAccess'] !== true).map((r) => String(r.parent)));
    const subnets = resources.filter((r) => r.type === 'azure_subnet' && r.parent === vnet.id && !delegated.has(sid(r)));
    const text = (r: SRes) => `${sid(r)} ${String(r.label ?? '')}`;
    const home = subnets.find((r) => resources.some((x) => x.parent === r.id && x.type === 'azure_private_endpoint'))
      ?? subnets.find((r) => /endpoint|private-link|pe\b/i.test(text(r)))
      ?? subnets.find((r) => /data|db|database/i.test(text(r)))
      ?? subnets.find((r) => !/web|public|gateway|bastion/i.test(text(r)));
    const homeId = home ? sid(home) : addSubnet(spec, vnet, 'private-endpoints-subnet', 'Private Endpoints Subnet');
    if (!homeId) continue;
    const id = `pe-${sid(target)}`.slice(0, 63);
    if (resources.some((r) => r.id === id)) continue;
    resources.push({ id, type: 'azure_private_endpoint', label: `${String(target.label ?? sid(target))} Private Endpoint`, parent: homeId, config: {} });
    connections.push({ from: id, to: sid(target) });
    n++;
  }
  return n;
}

/** Services that receive from the application are drawn from the application to them: a monitor or registry "calling" compute is turned around. */
function flipReversedEdges(spec: Spec): number {
  const byId = new Map((spec.resources ?? []).map((r) => [sid(r), r]));
  let n = 0;
  for (const c of spec.connections ?? []) {
    const from = byId.get(String(c.from)); const to = byId.get(String(c.to));
    if (from && to && (from.type === 'azure_monitor' || from.type === 'azure_acr') && COMPUTE.has(String(to.type))) { [c.from, c.to] = [c.to, c.from]; n++; }
  }
  return n;
}

/** A setting whose value is not one of the allowed choices (an invented VM size, say) goes back to the default rather than failing the design. */
function resetInvalidChoices(spec: Spec): number {
  let n = 0;
  for (const r of spec.resources ?? []) {
    const fields = getResourceDefinition(String(r.type))?.configSchema ?? [];
    for (const f of fields) {
      const v = r.config?.[f.key];
      if (v === undefined || f.type !== 'select' || !f.options?.length) continue;
      if (!f.options.some((o) => String(o.value) === String(v))) { delete r.config![f.key]; n++; }
    }
  }
  return n;
}

export interface SpecRepairReport { reversed: number; privateEndpoints: number; flexSubnets: number; certificates: number; waf: number; connections: number; addressing: number; gateway: number; secured: number; nsgs: number; placed: number; containerEdges: number; groups: number; choices: number }

/** Returns the repaired design (a copy) and what was done. Steps that would make the design compile worse are undone. */
export function repairSpecInput(input: unknown): { value: unknown; report: SpecRepairReport } {
  const report: SpecRepairReport = { reversed: 0, privateEndpoints: 0, flexSubnets: 0, certificates: 0, waf: 0, connections: 0, addressing: 0, gateway: 0, secured: 0, nsgs: 0, placed: 0, containerEdges: 0, groups: 0, choices: 0 };
  if (!input || typeof input !== 'object' || !Array.isArray((input as Spec).resources)) return { value: input, report };

  let spec = JSON.parse(JSON.stringify(input)) as Spec;
  const step = (name: keyof SpecRepairReport, run: (s: Spec) => number) => {
    const trial = JSON.parse(JSON.stringify(spec)) as Spec;
    const before = problems(spec);
    const done = run(trial);
    if (done > 0 && problems(trial) <= before) { spec = trial; report[name] = done; }
  };
  step('choices', resetInvalidChoices);
  step('reversed', flipReversedEdges);
  step('placed', placeInSubnets);
  step('containerEdges', dropContainerEdges);
  step('addressing', fixAddressing);
  step('gateway', addMissingGateway);
  step('secured', secureDefaults);
  step('flexSubnets', isolateFlexibleServers);
  step('privateEndpoints', addPrivateEndpoints);
  step('groups', attachLooseGroups);
  step('nsgs', addSubnetNsgs);
  step('certificates', addCertificates);
  step('waf', addWaf);
  step('connections', connectLooseParts);
  return { value: spec, report };
}

export function describeSpecRepair(report: SpecRepairReport): string[] {
  const out: string[] = [];
  if (report.certificates > 0) out.push(`The load balancer had no certificate setting, so a placeholder was added: replace it with your own ACM certificate before deploying.`);
  if (report.waf > 0) out.push(`CloudCraft added a web application firewall in front of the internet-facing load balancer.`);
  if (report.secured > 0) out.push(`${report.secured} database or cache service(s) were left with insecure defaults, so CloudCraft made them private-only with auditing and TLS 1.2, as the verified patterns do.`);
  if (report.reversed > 0) out.push(`${report.reversed} connection(s) ran from a monitor or registry to the application, so they were turned around (the application sends telemetry and pulls images).`);
  if (report.privateEndpoints > 0) out.push(`${report.privateEndpoints} service(s) had their public endpoint switched off, so a Private Endpoint was added for each. Without one the application could not reach them.`);
  if (report.flexSubnets > 0) out.push(`${report.flexSubnets} database server(s) were given a subnet of their own, which a private PostgreSQL or MySQL flexible server needs.`);
  if (report.nsgs > 0) out.push(`${report.nsgs} subnet(s) had no network security group, so one was added to each.`);
  if (report.choices > 0) out.push(`${report.choices} setting(s) had a value that is not one of the allowed choices, so the default was used instead. Check those resources if you needed something specific.`);
  if (report.placed > 0) out.push(`${report.placed} resource(s) were placed in the network itself, so each was moved into the subnet of its tier.`);
  if (report.containerEdges > 0) out.push(`${report.containerEdges} connection(s) were drawn to or from a subnet or network, which is shown by placement and not by a line, so they were removed.`);
  if (report.groups > 0) out.push(`${report.groups} security group(s) were not attached to anything, so each was attached to the matching subnet.`);
  if (report.addressing > 0) out.push(`Subnets shared one address range, so ${report.addressing} of them were given their own.`);
  if (report.gateway > 0) out.push('The design used an internet gateway it never declared, so one was added.');
  if (report.connections > 0) out.push(`CloudCraft connected ${report.connections} part(s) of the design that the AI had left disconnected.`);
  return out;
}
