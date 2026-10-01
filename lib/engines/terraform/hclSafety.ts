/**
 * HCL safety for generated Terraform.
 *
 * Everything a user can type (resource labels, ids, settings, tags, region, state-backend names) ends up inside
 * generated .tf files that `terraform apply` later executes. Without care, a value such as
 * `x"\n provisioner "local-exec" { command = "..." }` breaks out of its string and becomes code on the machine
 * that runs Terraform. Three layers stop that:
 *
 *  1. `sanitizeResourcesForHcl` — applied to every resource before generation: strings can no longer end their
 *     quotes, start an interpolation (`${`, `%{`), span lines or close a heredoc; ids become identifier-safe.
 *  2. `assertSafeHcl` — applied to the generated files: constructs that run commands or fetch code
 *     (provisioners, `local-exec`, the `external` data source, modules) are refused outright.
 *  3. Strict patterns for state-backend names (see `backendConfig.ts`).
 */
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';

export class TerraformSafetyError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Generated Terraform was refused because it contains constructs CloudCraft never emits: ${problems.join('; ')}`);
    this.name = 'TerraformSafetyError';
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Makes a value safe inside a double-quoted HCL string: cannot close the quote, interpolate, or span lines. */
export function escapeHclString(value: string): string {
  return value
    .replace(CONTROL_CHARS, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // Function replacers: in a replacement *string*, "$$" means one literal "$", which would silently undo this.
    .replace(/\$\{/g, () => '$${')
    .replace(/%\{/g, () => '%%{')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/**
 * Makes a multi-line value (e.g. a user-data script) safe inside a `<<-EOF` heredoc: newlines and quotes are kept,
 * but interpolation is disabled and no line can be the terminator.
 */
export function escapeHclHeredoc(value: string): string {
  return value
    .replace(CONTROL_CHARS, '')
    .replace(/\r/g, '')
    .replace(/\$\{/g, () => '$${')
    .replace(/%\{/g, () => '%%{')
    .replace(/^([ \t]*)EOF[ \t]*$/gm, (_m, indent: string) => `${indent}EOF_`);
}

/** Keys whose values are multi-line scripts rendered in heredocs by the generator. */
const HEREDOC_KEYS = new Set(['userData']);

function sanitizeValue(key: string, value: unknown): unknown {
  if (typeof value === 'string') return HEREDOC_KEYS.has(key) ? escapeHclHeredoc(value) : escapeHclString(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(key, v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [escapeHclString(k), sanitizeValue(k, v)]));
  }
  return value;
}

/** Ids are used to build resource addresses and references; keep them to identifier characters. */
export function hclSafeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_') || 'id';
}

const SAFE_TYPE = /^[a-z0-9_]+$/;
const SAFE_REGION = /^[a-z0-9-]{2,40}$/;

export interface SanitizedHclInput {
  resources: DbArchitectureResource[];
  connections: DbArchitectureConnection[];
}

/** Returns a copy of the input in which every user-controlled string is safe to place in generated HCL. */
export function sanitizeResourcesForHcl(resources: DbArchitectureResource[], connections: DbArchitectureConnection[]): SanitizedHclInput {
  // Ids may collide after cleaning ("a b" and "a_b"); keep them distinct so references still resolve to one resource each.
  const idMap = new Map<string, string>();
  const used = new Set<string>();
  const mapId = (raw: string): string => {
    const known = idMap.get(raw);
    if (known) return known;
    let safe = hclSafeId(raw);
    while (used.has(safe)) safe = `${safe}_`;
    used.add(safe); idMap.set(raw, safe);
    return safe;
  };
  resources.forEach((r) => mapId(r.id));
  const ref = (raw: string | null): string | null => (raw === null ? null : idMap.get(raw) ?? hclSafeId(raw));

  const cleanResources = resources.map((r): DbArchitectureResource => {
    let config: unknown = {};
    try { config = JSON.parse(r.configJson || '{}'); } catch { config = {}; }
    return {
      ...r,
      id: mapId(r.id),
      resourceType: SAFE_TYPE.test(r.resourceType) ? r.resourceType : 'invalid_resource_type',
      label: escapeHclString(r.label ?? ''),
      configJson: JSON.stringify(sanitizeValue('', config)),
      region: r.region !== null && SAFE_REGION.test(r.region) ? r.region : null,
      groupId: ref(r.groupId),
      architectureId: hclSafeId(r.architectureId),
    };
  });
  const cleanConnections = connections.map((c): DbArchitectureConnection => ({
    ...c,
    id: hclSafeId(c.id),
    label: c.label === null ? null : escapeHclString(c.label),
    sourceId: ref(c.sourceId) ?? c.sourceId,
    targetId: ref(c.targetId) ?? c.targetId,
  }));
  return { resources: cleanResources, connections: cleanConnections };
}

/** Anything that runs commands, loads code or pulls in other modules. CloudCraft's generator emits none of these. */
const FORBIDDEN: { pattern: RegExp; problem: string }[] = [
  // Anchored to block syntax at the start of a line: after escaping, a value cannot start a new line, so only a real
  // block (or a multi-line heredoc script) can match — an innocent label such as "Provisioner service" cannot.
  { pattern: /^\s*provisioner\s+"?[\w-]+"?\s*\{/im, problem: 'provisioner block' },
  { pattern: /^\s*data\s+"?external"?\s+"/im, problem: 'external data source' },
  { pattern: /^\s*module\s+"/im, problem: 'module block' },
  { pattern: /^\s*source\s*=\s*"(?!hashicorp\/)/im, problem: 'non-HashiCorp provider/module source' },
];

/** Throws `TerraformSafetyError` if any generated file contains a forbidden construct. Comments are ignored. */
export function assertSafeHcl(files: { filename: string; content: string }[]): void {
  const problems: string[] = [];
  for (const f of files) {
    // Heredoc bodies are plain strings: escapeHclHeredoc guarantees no line can close one early, so a script that
    // merely mentions these words is not code. Comments are ignored too.
    const code = f.content
      .replace(/<<-?EOF\n[\s\S]*?\n[ \t]*EOF[ \t]*(?=\n|$)/g, '<<EOF-body-removed')
      .split('\n').filter((l) => !/^\s*(#|\/\/)/.test(l)).join('\n');
    for (const { pattern, problem } of FORBIDDEN) {
      if (pattern.test(code)) problems.push(`${f.filename}: ${problem}`);
    }
  }
  if (problems.length > 0) throw new TerraformSafetyError(problems);
}

/** Canvas-shaped variant for the legacy single-file generator in lib/analysis.ts. */
export function sanitizeCanvasForHcl<N extends { id: string; resourceType: string; label: string; config?: Record<string, unknown>; groupId?: string | null }, E extends { id: string; source: string; target: string }>(
  nodes: N[], edges: E[],
): { nodes: N[]; edges: E[] } {
  const idMap = new Map<string, string>();
  const used = new Set<string>();
  const mapId = (raw: string): string => {
    const known = idMap.get(raw);
    if (known) return known;
    let safe = hclSafeId(raw);
    while (used.has(safe)) safe = `${safe}_`;
    used.add(safe); idMap.set(raw, safe);
    return safe;
  };
  nodes.forEach((n) => mapId(n.id));
  return {
    nodes: nodes.map((n) => ({
      ...n,
      id: mapId(n.id),
      resourceType: SAFE_TYPE.test(n.resourceType) ? n.resourceType : 'invalid_resource_type',
      label: escapeHclString(n.label ?? ''),
      config: sanitizeValue('', n.config ?? {}) as Record<string, unknown>,
      ...(n.groupId ? { groupId: idMap.get(n.groupId) ?? hclSafeId(n.groupId) } : {}),
    })),
    edges: edges.map((e) => ({ ...e, id: hclSafeId(e.id), source: idMap.get(e.source) ?? hclSafeId(e.source), target: idMap.get(e.target) ?? hclSafeId(e.target) })),
  };
}
