/**
 * Model-facing architecture spec, its compiler, and the deploy-readiness gates.
 *
 * A language model should decide WHAT to build (resources, containment, connections, the
 * few settings that matter) — not emit canvas coordinates, edge protocols or 20 default
 * config fields per resource. So the model produces a compact `ArchitectureSpec`, and this
 * module deterministically expands it into the canonical CloudBuilder graph
 * (CanvasNode[] / CanvasEdge[]) using the same pieces the app already uses:
 *
 *   spec → resource-catalog defaults → RelationshipEngine (edge type / protocol / port)
 *        → autoLayout → canonical graph
 *
 * `checkDeployReadiness` then applies the gates a graph must pass before it is described as
 * "ready to deploy". The same function filters the fine-tuning dataset and scores a fine-tuned
 * model's output, so training data and evaluation can never disagree.
 *
 * Nothing here is a substitute for a real deployment test: the gates prove the design is
 * internally consistent, secure by CloudBuilder's rule set and renders to Terraform — not that
 * account quotas, IAM permissions, naming collisions or provider outages will allow apply.
 */
import type { CanvasEdge, CanvasNode, ConfigField } from '@/types';
import { allResources, getResourceDefinition } from '@/lib/resources';
import { relationshipEngine } from '@/lib/engines/relationship/RelationshipEngine';
import { autoLayoutArchitecture } from '@/lib/canvas/autoLayout';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { architectureValidator } from '@/lib/engines/validation/ArchitectureValidator';
import { toCanonicalGraph, validateCanonicalArchitecture } from '@/lib/domain/canonicalArchitecture';
import { generateCanonicalTerraform } from '@/lib/engines/assessment/autofix';
import { autoRepairGraph } from './autoRepair';

// ─── Spec ─────────────────────────────────────────────────────────────────────

export interface SpecResource {
  /** Unique, lowercase kebab-case identifier used by connections and `parent`. */
  id: string;
  /** A CloudBuilder resource type, e.g. "aws_rds". Must exist in the catalog. */
  type: string;
  /** Human-readable name shown on the canvas. */
  label: string;
  /** Id of the containing resource (subnet, VPC/VNet, resource group or cloud boundary). */
  parent?: string;
  /** Only settings that differ from the catalog defaults. Keys must exist for the type. */
  config?: Record<string, string | number | boolean | string[]>;
}

export interface SpecConnection {
  from: string;
  to: string;
  /** Optional short caption; defaults to the relationship engine's label. */
  label?: string;
}

export interface ArchitectureSpec {
  name: string;
  summary: string;
  resources: SpecResource[];
  connections: SpecConnection[];
}

// ─── Catalog vocabulary ───────────────────────────────────────────────────────

const NOT_USABLE = /_(unsupported|unknown)$/;
/**
 * Palette resources the AI architect is not offered. The container service is configured from Container Templates (it carries a stack, a
 * start-up script and an image), and the fine-tuned model has never seen it, so letting the model place it would produce unreviewed designs.
 */
export const CANVAS_ONLY_TYPES: ReadonlySet<string> = new Set([
  'aws_container_service',
  'azure_container_service',
  'aws_apigatewayv2',
  'aws_api_gateway',
  'aws_docdb',
  'aws_secretsmanager',
  'aws_client',
  'aws_sns',
  'aws_eventbridge',
  'aws_cognito',
  'aws_step_functions',
  // A third-party service is reviewed from the team's answers about it, which a model cannot give.
  'aws_external_service',
  'azure_external_service',
]);
export const CATALOG_TYPES: string[] = allResources.map((r) => r.type).filter((t) => !NOT_USABLE.test(t) && !CANVAS_ONLY_TYPES.has(t));
const CATALOG_SET = new Set(CATALOG_TYPES);

const isContainerType = (type: string) => getResourceDefinition(type)?.isContainer === true;
const providerOf = (type: string): 'aws' | 'azure' => (type.startsWith('azure_') ? 'azure' : 'aws');

/** Compact, model-readable list of every usable resource type, grouped by provider. */
export function catalogVocabulary(): string {
  const line = (p: 'aws' | 'azure') => `${p.toUpperCase()}: ${CATALOG_TYPES.filter((t) => providerOf(t) === p).join(', ')}`;
  return [line('aws'), line('azure')].join('\n');
}

/** Which types may contain which, and which have no container at all (they omit "parent"). */
export function containmentRules(): string {
  const contained = new Set<string>();
  const lines: string[] = [];
  for (const r of allResources) {
    if (!r.isContainer || !r.allowedChildren?.length) continue;
    const children = r.allowedChildren.filter((c) => !CANVAS_ONLY_TYPES.has(c));
    children.forEach((c) => contained.add(c));
    lines.push(`${r.type} may contain: ${children.join(', ')}`);
  }
  const top = CATALOG_TYPES.filter((t) => !contained.has(t) && !isContainerType(t));
  lines.push(`No container, so omit "parent": ${top.join(', ')}`);
  lines.push('aws_lambda and azure_functions also omit "parent" when they run outside the network (no VPC/VNet integration).');
  return lines.join('\n');
}

export const SPEC_JSON_SHAPE =
  '{"name":string,"summary":string,"resources":[{"id":string,"type":string,"label":string,"parent"?:string,"config"?:{...}}],"connections":[{"from":string,"to":string,"label"?:string}]}';

/** Constant system prompt used for fine-tuning and for inference with the fine-tuned model. */
export const ARCHITECT_SYSTEM_PROMPT = [
  'You are CloudCraft\'s cloud architect. Turn the user\'s requirements into a complete, deployable AWS, Azure or multi-cloud architecture that follows the AWS and Azure Well-Architected Frameworks.',
  'Reply with ONLY one JSON object of this shape: ' + SPEC_JSON_SHAPE + '.',
  'Rules: use only the resource types listed below; every resource has the parent its containment rule requires (top-level cloud boundaries and the types listed as having no container omit "parent"); every resource is connected; connect from the caller to the callee (compute → database, never the reverse); put workloads in private subnets, entry points in public subnets, data stores in data subnets; span two availability zones for anything highly available; do not output coordinates; set config only where it differs from the secure defaults.',
  'Available resource types:\n' + catalogVocabulary(),
  'Containment rules:\n' + containmentRules(),
].join('\n');

// ─── Parsing & schema checks ──────────────────────────────────────────────────

export interface SpecIssue { code: string; message: string; resourceId?: string }

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function checkConfigValue(field: ConfigField, value: unknown): string | null {
  switch (field.type) {
    case 'boolean': return typeof value === 'boolean' ? null : 'must be true or false';
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      if (field.min !== undefined && value < field.min) return `must be ≥ ${field.min}`;
      if (field.max !== undefined && value > field.max) return `must be ≤ ${field.max}`;
      return null;
    }
    case 'select': {
      const allowed = (field.options ?? []).map((o) => o.value);
      // Numeric options are stored as text ("300") yet the catalog's own defaults use numbers (periodSeconds: 300),
      // so a number that matches an option is correct, not an error. Without this a model that answers 300 repeats the
      // same "must be one of: 10, 30, 60, 300" rejection forever, because the message never shows the quotes.
      const ok = typeof value === 'string' ? (allowed.length === 0 || allowed.includes(value)) : typeof value === 'number' && allowed.includes(String(value));
      return ok ? null : `must be one of: ${allowed.join(', ')}`;
    }
    case 'multiselect': {
      const allowed = (field.options ?? []).map((o) => o.value);
      return Array.isArray(value) && value.every((v) => typeof v === 'string' && (allowed.length === 0 || allowed.includes(v))) ? null : `must be a list drawn from: ${allowed.join(', ')}`;
    }
    case 'text': case 'cidr': return typeof value === 'string' ? null : 'must be a string';
    default: return null;
  }
}

/**
 * Free-text settings that are really enumerations elsewhere in the catalog. The Auto Scaling
 * group's instance type is text in the UI but must be a real EC2 size, so validate it against
 * the EC2 definition rather than let a model invent one.
 */
const BORROWED_OPTIONS: Record<string, { fromType: string; key: string }> = {
  'aws_auto_scaling.instanceType': { fromType: 'aws_ec2', key: 'instanceType' },
};

function borrowedOptionError(type: string, key: string, value: unknown): string | null {
  const b = BORROWED_OPTIONS[`${type}.${key}`];
  if (!b) return null;
  const f = getResourceDefinition(b.fromType)?.configSchema.find((c) => c.key === b.key);
  const allowed = (f?.options ?? []).map((o) => o.value);
  return allowed.length && (typeof value !== 'string' || !allowed.includes(value)) ? `must be one of: ${allowed.join(', ')}` : null;
}

export function parseSpec(input: unknown): { spec?: ArchitectureSpec; issues: SpecIssue[] } {
  const issues: SpecIssue[] = [];
  let raw: unknown = input;
  if (typeof input === 'string') {
    try { raw = JSON.parse(input); } catch (e) { return { issues: [{ code: 'INVALID_JSON', message: `Not valid JSON: ${(e as Error).message}` }] }; }
  }
  if (!raw || typeof raw !== 'object') return { issues: [{ code: 'NOT_AN_OBJECT', message: 'The spec must be a JSON object.' }] };
  const s = raw as Partial<ArchitectureSpec>;
  if (typeof s.name !== 'string' || !s.name.trim()) issues.push({ code: 'MISSING_NAME', message: '"name" is required.' });
  if (typeof s.summary !== 'string') issues.push({ code: 'MISSING_SUMMARY', message: '"summary" is required.' });
  if (!Array.isArray(s.resources) || s.resources.length === 0) issues.push({ code: 'NO_RESOURCES', message: '"resources" must be a non-empty array.' });
  if (!Array.isArray(s.connections)) issues.push({ code: 'NO_CONNECTIONS', message: '"connections" must be an array.' });
  if (issues.length) return { issues };

  const seen = new Set<string>();
  for (const r of s.resources!) {
    if (!r || typeof r !== 'object') { issues.push({ code: 'BAD_RESOURCE', message: 'Each resource must be an object.' }); continue; }
    if (typeof r.id !== 'string' || !ID_RE.test(r.id)) issues.push({ code: 'BAD_ID', message: `Resource id "${String(r.id)}" must be lowercase kebab-case.`, resourceId: String(r.id) });
    else if (seen.has(r.id)) issues.push({ code: 'DUPLICATE_ID', message: `Duplicate resource id "${r.id}".`, resourceId: r.id });
    else seen.add(r.id);
    if (typeof r.type !== 'string' || !CATALOG_SET.has(r.type)) { issues.push({ code: 'UNKNOWN_TYPE', message: `Unknown resource type "${String(r.type)}". Use only catalog types.`, resourceId: r.id }); continue; }
    if (typeof r.label !== 'string' || !r.label.trim()) issues.push({ code: 'MISSING_LABEL', message: `Resource "${r.id}" needs a label.`, resourceId: r.id });
    if (r.config !== undefined) {
      if (!r.config || typeof r.config !== 'object' || Array.isArray(r.config)) { issues.push({ code: 'BAD_CONFIG', message: `Resource "${r.id}": config must be an object.`, resourceId: r.id }); continue; }
      const schema = new Map((getResourceDefinition(r.type)?.configSchema ?? []).map((f) => [f.key, f]));
      for (const [k, v] of Object.entries(r.config)) {
        const f = schema.get(k);
        if (!f) { issues.push({ code: 'UNKNOWN_CONFIG_KEY', message: `Resource "${r.id}" (${r.type}) has no setting "${k}".`, resourceId: r.id }); continue; }
        const bad = checkConfigValue(f, v) ?? borrowedOptionError(r.type, k, v);
        if (bad) issues.push({ code: 'BAD_CONFIG_VALUE', message: `Resource "${r.id}" setting "${k}" ${bad}.`, resourceId: r.id });
      }
    }
  }
  for (const c of s.connections!) {
    if (!c || typeof c.from !== 'string' || typeof c.to !== 'string') { issues.push({ code: 'BAD_CONNECTION', message: 'Each connection needs string "from" and "to".' }); continue; }
    if (!seen.has(c.from)) issues.push({ code: 'UNKNOWN_ENDPOINT', message: `Connection from unknown resource "${c.from}".` });
    if (!seen.has(c.to)) issues.push({ code: 'UNKNOWN_ENDPOINT', message: `Connection to unknown resource "${c.to}".` });
  }
  for (const r of s.resources!) {
    if (r?.parent !== undefined && !seen.has(r.parent)) issues.push({ code: 'UNKNOWN_PARENT', message: `Resource "${r.id}" has unknown parent "${r.parent}".`, resourceId: r.id });
  }
  return issues.length ? { issues } : { spec: s as ArchitectureSpec, issues: [] };
}

// ─── Compiler ─────────────────────────────────────────────────────────────────

export interface CompileResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  issues: SpecIssue[];
}

const kebabName = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function compileSpec(spec: ArchitectureSpec): CompileResult {
  const issues: SpecIssue[] = [];
  const nodes: CanvasNode[] = spec.resources.map((r) => {
    const def = getResourceDefinition(r.type)!;
    const container = isContainerType(r.type);
    return {
      id: r.id,
      type: container ? 'containerNode' : 'cloudNode',
      resourceType: r.type,
      provider: providerOf(r.type),
      label: r.label,
      position: { x: 0, y: 0 },
      ...(r.parent ? { groupId: r.parent, parentId: r.parent } : {}),
      ...(container ? { width: def.defaultWidth, height: def.defaultHeight } : {}),
      config: { ...def.defaultConfig, name: kebabName(r.label), ...(r.config ?? {}) },
    } as CanvasNode;
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Containment
  for (const n of nodes) {
    if (!n.groupId) continue;
    const parent = byId.get(n.groupId)!;
    const pDef = getResourceDefinition(parent.resourceType);
    if (!pDef?.isContainer) { issues.push({ code: 'PARENT_NOT_CONTAINER', message: `"${n.id}" is placed inside "${parent.id}" (${parent.resourceType}), which cannot contain resources.`, resourceId: n.id }); continue; }
    const v = relationshipEngine.validateContainment(n.resourceType, parent.resourceType, n.provider, parent.provider);
    if (!v.isAllowed) issues.push({ code: v.error?.code ?? 'INVALID_CONTAINMENT', message: `"${n.id}" cannot be inside "${parent.id}": ${v.error?.message ?? 'not allowed'}`, resourceId: n.id });
    else if (pDef.allowedChildren && !pDef.allowedChildren.includes(n.resourceType)) issues.push({ code: 'CHILD_NOT_ALLOWED', message: `${parent.resourceType} cannot contain ${n.resourceType}.`, resourceId: n.id });
  }

  // Connections — type / protocol / port / label are inferred by the relationship engine.
  const edges: CanvasEdge[] = [];
  const seenEdge = new Set<string>();
  for (const c of spec.connections) {
    const a = byId.get(c.from); const b = byId.get(c.to);
    if (!a || !b) continue;
    const key = `${c.from}->${c.to}`;
    if (seenEdge.has(key)) { issues.push({ code: 'DUPLICATE_CONNECTION', message: `Duplicate connection ${c.from} → ${c.to}.` }); continue; }
    seenEdge.add(key);
    const v = relationshipEngine.validateConnection(a, b, nodes, edges);
    if (!v.isValid) { issues.push({ code: v.error?.code ?? 'INVALID_CONNECTION', message: `${c.from} → ${c.to}: ${v.error?.message ?? 'not allowed'}` }); continue; }
    edges.push({
      id: `${c.from}:${v.relationshipType}:${c.to}`,
      source: c.from, target: c.to,
      label: c.label ?? v.label,
      edgeType: v.relationshipType, relationshipType: v.relationshipType,
      protocol: v.protocol, port: v.port, networkScope: v.networkScope,
      direction: 'unidirectional', inferred: false, validationStatus: 'valid',
    });
  }
  if (issues.length) return { nodes, edges, issues };

  const laid = autoLayoutArchitecture(nodes, edges);
  return { nodes: laid.nodes, edges: laid.edges, issues };
}

// ─── Layout geometry (mirrors InfraCanvas / report renderer) ──────────────────

export interface Box { id: string; x: number; y: number; w: number; h: number }

export function nodeBox(n: CanvasNode): Box {
  const def = getResourceDefinition(n.resourceType);
  const isBoundary = n.resourceType.endsWith('_cloud_boundary');
  const isVpc = ['aws_vpc', 'azure_vnet', 'azure_resource_group'].includes(n.resourceType);
  const isSubnet = n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet';
  return {
    id: n.id, x: n.position?.x ?? 0, y: n.position?.y ?? 0,
    w: n.width || def?.defaultWidth || (isBoundary ? 980 : isVpc ? 840 : isSubnet ? 380 : 180),
    h: n.height || def?.defaultHeight || (isBoundary ? 620 : isVpc ? 520 : isSubnet ? 200 : 100),
  };
}

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const contains = (outer: Box, inner: Box) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

// ─── Deployment inputs (account-specific values a design cannot know) ─────────

/** Marker used in generated designs for values only the deploying account can supply. */
export const PLACEHOLDER_MARKER = 'REPLACE-WITH-YOUR';
const PLACEHOLDER_RE = /REPLACE-WITH-YOUR-[A-Z0-9-]+/;

export interface DeploymentInput { resourceId: string; resourceLabel: string; setting: string; placeholder: string }

/** Every setting that still holds a placeholder — these must be filled before `apply`. */
export function collectDeploymentInputs(nodes: CanvasNode[]): DeploymentInput[] {
  const out: DeploymentInput[] = [];
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n.config ?? {})) {
      const text = typeof v === 'string' ? v : Array.isArray(v) ? v.join(',') : '';
      const m = PLACEHOLDER_RE.exec(text);
      if (m) out.push({ resourceId: n.id, resourceLabel: n.label, setting: k, placeholder: m[0] });
    }
  }
  return out;
}

// ─── CIDR helpers ─────────────────────────────────────────────────────────────

function parseCidr(cidr: unknown): { start: number; end: number } | null {
  if (typeof cidr !== 'string') return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return null;
  const oct = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (oct.some((o) => o > 255) || bits > 32) return null;
  const ip = ((oct[0] << 24) >>> 0) + (oct[1] << 16) + (oct[2] << 8) + oct[3];
  const size = 2 ** (32 - bits);
  const start = Math.floor(ip / size) * size;
  return { start, end: start + size - 1 };
}
const cidrOverlap = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start <= b.end && b.start <= a.end;

function networkRange(n: CanvasNode): unknown {
  if (n.resourceType === 'aws_vpc') return n.config?.cidrBlock;
  if (n.resourceType === 'azure_vnet') return n.config?.addressSpace;
  if (n.resourceType === 'aws_subnet') return n.config?.cidrBlock;
  if (n.resourceType === 'azure_subnet') return n.config?.addressPrefix;
  return undefined;
}

function checkAddressing(nodes: CanvasNode[]): string[] {
  const out: string[] = [];
  const nets = nodes.filter((n) => n.resourceType === 'aws_vpc' || n.resourceType === 'azure_vnet');
  const subs = nodes.filter((n) => n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet');
  for (const n of [...nets, ...subs]) if (!parseCidr(networkRange(n))) out.push(`"${n.label}" has an invalid or missing address range (${String(networkRange(n))}).`);
  for (let i = 0; i < nets.length; i++) for (let j = i + 1; j < nets.length; j++) {
    const a = parseCidr(networkRange(nets[i])); const b = parseCidr(networkRange(nets[j]));
    if (a && b && cidrOverlap(a, b)) out.push(`Networks "${nets[i].label}" and "${nets[j].label}" have overlapping address ranges.`);
  }
  const byParent = new Map<string, CanvasNode[]>();
  for (const s of subs) byParent.set(s.groupId ?? '', [...(byParent.get(s.groupId ?? '') ?? []), s]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const [pid, list] of byParent) {
    const parent = byId.get(pid);
    const pr = parent ? parseCidr(networkRange(parent)) : null;
    for (const s of list) {
      const r = parseCidr(networkRange(s));
      if (r && pr && !(r.start >= pr.start && r.end <= pr.end)) out.push(`Subnet "${s.label}" (${String(networkRange(s))}) is outside its network range (${String(networkRange(parent!))}).`);
    }
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = parseCidr(networkRange(list[i])); const b = parseCidr(networkRange(list[j]));
      if (a && b && cidrOverlap(a, b)) out.push(`Subnets "${list[i].label}" and "${list[j].label}" have overlapping address ranges.`);
    }
  }
  return out;
}

// ─── Deploy-readiness gates ───────────────────────────────────────────────────

export interface GateResult { gate: string; passed: boolean; details: string[] }

export interface DeployReadiness {
  ready: boolean;
  gates: GateResult[];
  metrics: {
    resources: number; connections: number; providers: string[];
    securityScore: number | null; securityCoveragePct: number | null;
    findings: { critical: number; high: number; medium: number; low: number };
    terraformResources: number;
  };
}

/** Types that attach by association/containment rather than by traffic. */
const AMBIENT = new Set(['aws_sg', 'aws_nacl', 'aws_route_table', 'azure_nsg', 'azure_route_table', 'azure_firewall']);
/** Regional services that must still be wired to something. */
const CONTAINERLESS_MUST_CONNECT = new Set(['aws_iam', 'aws_kms', 'aws_cloudwatch']);

export function checkDeployReadiness(nodes: CanvasNode[], edges: CanvasEdge[]): DeployReadiness {
  const gates: GateResult[] = [];
  const gate = (name: string, details: string[]) => gates.push({ gate: name, passed: details.length === 0, details });

  // 1. Engine assessment: nothing at MEDIUM or above (any domain), no security failure of any severity
  //    except LOW/INFORMATIONAL, and no NOT_EVALUATED/INSUFFICIENT_DATA on resources we design.
  const a = runAssessment({ nodes, edges });
  const failing = a.findings.filter((f) => f.status === 'FAIL' || f.status === 'WARNING');
  gate('assessment', [
    ...failing.filter((f) => ['CRITICAL', 'HIGH', 'MEDIUM'].includes(f.severity)).map((f) => `${f.severity} ${f.ruleId}: ${f.title} (${f.resourceLabels.join(', ') || 'architecture'})`),
    ...a.evaluations.filter((e) => e.status === 'INSUFFICIENT_DATA').map((e) => `INSUFFICIENT_DATA ${e.ruleId} (${e.resourceLabels.join(', ')})`),
  ]);

  // 1b. Hardening: no remaining finding that has a safe, Terraform-verified fix. A design that
  //     leaves an available one-line hardening undone is not "best practice", even if only LOW.
  gate('hardening', failing
    .filter((f) => f.autoFix.available && f.autoFix.safety === 'SAFE_AUTOFIX')
    .map((f) => `${f.ruleId}: ${f.title} (${f.resourceLabels.join(', ')}) — safe fix available: ${f.autoFix.description ?? ''}`.trim()));

  // 2. Architecture validator
  const v = architectureValidator.validate(nodes, edges);
  gate('architecture-validator', v.findings.filter((f) => ['critical', 'high', 'medium'].includes(f.severity)).map((f) => `${f.severity} ${f.title ?? f.id}: ${f.description ?? ''}`.trim()));

  // 3. Canonical validation
  const canon = validateCanonicalArchitecture(toCanonicalGraph(nodes, edges));
  gate('canonical-validation', canon.issues.filter((i) => i.severity === 'critical' || i.severity === 'high').map((i) => `${i.severity} ${i.code}: ${i.message}`));

  // 4. Connectivity
  const leaves = nodes.filter((n) => !isContainerType(n.resourceType) && !n.resourceType.endsWith('_cloud_boundary'));
  const degree = new Map<string, number>();
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    for (const [x, y] of [[e.source, e.target], [e.target, e.source]]) {
      degree.set(x, (degree.get(x) ?? 0) + 1);
      if (!adj.has(x)) adj.set(x, new Set());
      adj.get(x)!.add(y);
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const conn: string[] = [];
  for (const n of leaves) {
    if ((degree.get(n.id) ?? 0) > 0) continue;
    const parent = n.groupId ? byId.get(n.groupId) : undefined;
    const insideNetwork = parent && !parent.resourceType.endsWith('_cloud_boundary');
    if (AMBIENT.has(n.resourceType) && insideNetwork) continue;
    if (CONTAINERLESS_MUST_CONNECT.has(n.resourceType) || !AMBIENT.has(n.resourceType)) conn.push(`"${n.label}" (${n.resourceType}) is not connected to anything.`);
    else conn.push(`"${n.label}" (${n.resourceType}) is neither connected nor placed in a network.`);
  }
  const workload = leaves.filter((n) => !AMBIENT.has(n.resourceType));
  if (workload.length > 1) {
    const start = workload[0].id; const seen = new Set([start]); const stack = [start];
    while (stack.length) for (const nb of adj.get(stack.pop()!) ?? []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    const cut = workload.filter((n) => !seen.has(n.id));
    if (cut.length) conn.push(`The architecture is split into disconnected parts; not reachable from "${workload[0].label}": ${cut.map((n) => n.label).join(', ')}.`);
  }
  gate('connectivity', conn);

  // 5. Layout: everything placed, children inside parents, no overlapping siblings
  const layout: string[] = [];
  const boxes = new Map(nodes.map((n) => [n.id, nodeBox(n)]));
  for (const n of nodes) {
    const b = boxes.get(n.id)!;
    if (b.x < 0 || b.y < 0) layout.push(`"${n.label}" has a negative position.`);
    if (n.position.x === 0 && n.position.y === 0 && nodes.length > 1) layout.push(`"${n.label}" was not positioned by the layout.`);
    if (n.groupId) {
      const p = boxes.get(n.groupId);
      if (p && !contains(p, b)) layout.push(`"${n.label}" extends outside its container "${byId.get(n.groupId)!.label}".`);
    }
  }
  const siblings = new Map<string, CanvasNode[]>();
  for (const n of nodes) siblings.set(n.groupId ?? '__root__', [...(siblings.get(n.groupId ?? '__root__') ?? []), n]);
  for (const list of siblings.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (overlap(boxes.get(list[i].id)!, boxes.get(list[j].id)!)) layout.push(`"${list[i].label}" overlaps "${list[j].label}".`);
    }
  }
  gate('layout', layout);

  // 5b. Network addressing: subnets inside their network's range, no overlaps among siblings,
  //     and no overlapping networks (they could never be peered or connected later).
  gate('network-addressing', checkAddressing(nodes));

  // 6. Terraform renders
  const tf = generateCanonicalTerraform(nodes, edges);
  const tfResources = (tf.match(/^resource "/gm) ?? []).length;
  const tfIssues: string[] = [];
  if (tf.includes('terraform generation failed')) tfIssues.push(tf.split('\n').find((l) => l.includes('failed')) ?? 'generation failed');
  const providers = Array.from(new Set(nodes.map((n) => n.provider)));
  if (tfResources === 0) tfIssues.push('No Terraform resources were generated.');
  gate('terraform', tfIssues);

  const count = (s: string) => failing.filter((f) => f.severity === s).length;
  return {
    ready: gates.every((g) => g.passed),
    gates,
    metrics: {
      resources: leaves.length, connections: edges.length, providers: providers as string[],
      securityScore: a.securityScore.score, securityCoveragePct: a.securityScore.coverage.coveragePct,
      findings: { critical: count('CRITICAL'), high: count('HIGH'), medium: count('MEDIUM'), low: count('LOW') },
      terraformResources: tfResources,
    },
  };
}

/** Parse → compile → gate, in one call. Used by dataset filtering and model evaluation. */
export function evaluateSpec(input: unknown, options: { autoRepair?: boolean } = {}): { autoRepairs?: string[]; ok: boolean; stage: 'parse' | 'compile' | 'gates' | 'ready'; issues: SpecIssue[]; spec?: ArchitectureSpec; graph?: { nodes: CanvasNode[]; edges: CanvasEdge[] }; readiness?: DeployReadiness; deploymentInputs?: DeploymentInput[] } {
  const parsed = parseSpec(input);
  if (!parsed.spec) return { ok: false, stage: 'parse', issues: parsed.issues };
  const compiled = compileSpec(parsed.spec);
  if (compiled.issues.length) return { ok: false, stage: 'compile', issues: compiled.issues, spec: parsed.spec };
  // At inference time, fix what CloudBuilder's own verified remediations can fix before judging the design (never when building training data).
  const repaired = options.autoRepair ? autoRepairGraph(compiled.nodes, compiled.edges) : null;
  const nodes = repaired?.nodes ?? compiled.nodes;
  const readiness = checkDeployReadiness(nodes, compiled.edges);
  return {
    ...(repaired && repaired.applied.length > 0 ? { autoRepairs: repaired.applied } : {}),
    ok: readiness.ready, stage: readiness.ready ? 'ready' : 'gates',
    issues: readiness.gates.filter((g) => !g.passed).flatMap((g) => g.details.map((d) => ({ code: g.gate.toUpperCase(), message: d }))),
    spec: parsed.spec, graph: { nodes, edges: compiled.edges }, readiness,
    deploymentInputs: collectDeploymentInputs(nodes),
  };
}
