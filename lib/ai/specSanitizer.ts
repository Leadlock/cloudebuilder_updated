/**
 * Cleans up the setting names in a model-written design before it is validated.
 *
 * The most common reason a design is rejected is a setting name CloudCraft does not have: usually the right
 * setting spelled differently ("cidr_block" for cidrBlock), sometimes an invented one ("allocatedStorageGb").
 * Every setting is optional — anything left out takes the secure default — so:
 *
 *  - a name that differs only in case / underscores / hyphens is RENAMED to the real setting (nothing lost);
 *  - a name that matches nothing is DROPPED and reported, and the resource keeps its default for it.
 *
 * Dropping cannot make a design less safe: the assessment, hardening and network gates still run on the final
 * configuration and reject it if a default is not good enough. A setting with a known name but an invalid VALUE is
 * deliberately NOT touched — that is a real mistake the model must fix, and dropping it would silently change the design.
 *
 * Used at inference (and by `evaluate-model.ts --production`); the dataset builder keeps the strict validator so
 * training data stays exact.
 */
import { CATALOG_TYPES } from './architectureSpec';
import { getResourceDefinition } from '@/lib/resources';
import { describeSpecRepair, type SpecRepairReport } from './specRepair';

export interface SanitizeReport {
  renamed: { type: string; from: string; to: string; resources: string[] }[];
  dropped: { type: string; setting: string; resources: string[] }[];
  /** Subnets moved to a second Availability Zone because the design put every subnet in one. */
  zonesSpread?: string[];
  /** Mechanical repairs made by specRepair.ts (certificate placeholder, WAF, loose parts connected). */
  specRepairs?: SpecRepairReport;
}

const EMPTY = (): SanitizeReport => ({ renamed: [], dropped: [] });
const CATALOG = new Set(CATALOG_TYPES);
const canonical = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

export function sanitizeSpecInput(input: unknown): { value: unknown; report: SanitizeReport } {
  const report = EMPTY();
  const resources = (input as { resources?: unknown } | null)?.resources;
  if (!input || typeof input !== 'object' || !Array.isArray(resources)) return { value: input, report };

  const value = JSON.parse(JSON.stringify(input)) as { resources: { id?: unknown; type?: unknown; config?: unknown }[] };
  const renamed = new Map<string, SanitizeReport['renamed'][number]>();
  const dropped = new Map<string, SanitizeReport['dropped'][number]>();

  for (const r of value.resources) {
    if (!r || typeof r.type !== 'string' || !CATALOG.has(r.type)) continue;
    if (!r.config || typeof r.config !== 'object' || Array.isArray(r.config)) continue;
    const keys = (getResourceDefinition(r.type)?.configSchema ?? []).map((f) => f.key);
    const byCanonical = new Map(keys.map((k) => [canonical(k), k]));
    const config = r.config as Record<string, unknown>;
    const id = String(r.id ?? '?');

    for (const key of Object.keys(config)) {
      if (keys.includes(key)) continue;
      const target = byCanonical.get(canonical(key));
      if (target && !(target in config)) {
        config[target] = config[key];
        const k = `${r.type}|${key}`; const e = renamed.get(k) ?? { type: r.type, from: key, to: target, resources: [] };
        e.resources.push(id); renamed.set(k, e);
      } else {
        const k = `${r.type}|${key}`; const e = dropped.get(k) ?? { type: r.type, setting: key, resources: [] };
        e.resources.push(id); dropped.set(k, e);
      }
      delete config[key];
    }
  }
  report.renamed = [...renamed.values()];
  report.dropped = [...dropped.values()];
  const spread = spreadSubnetZones(value.resources as SpecResource[]);
  if (spread.length > 0) report.zonesSpread = spread;
  return { value, report };
}

interface SpecResource { id?: unknown; type?: unknown; config?: unknown }

/**
 * A highly available design needs its subnets in at least two Availability Zones. Models often write the same zone on every subnet,
 * and asking them again rarely fixes it. When there are two or more subnets and they all name one zone, move some to the next zone
 * of the same region: subnets of the same kind (public / private, same name apart from a number or letter) alternate a, b, a, b, so
 * each kind spans two zones. Only that exact mistake is repaired; subnets with no zone, or already in several zones, are left alone.
 * Returns the ids that were moved.
 */
export function spreadSubnetZones(resources: SpecResource[]): string[] {
  const subnets = resources.filter((r) => r && r.type === 'aws_subnet' && r.config && typeof r.config === 'object' && !Array.isArray(r.config)) as { id?: unknown; config: Record<string, unknown> }[];
  if (subnets.length < 2) return [];
  // A subnet with no zone gets the catalog default (us-east-1a) when compiled, so for this purpose it is in that zone.
  const zones = new Set(subnets.map((s) => s.config['availabilityZone'] ?? 'us-east-1a'));
  const only = zones.size === 1 ? [...zones][0] : undefined;
  const match = typeof only === 'string' ? /^([a-z]{2}-[a-z]+-\d)([a-z])$/.exec(only) : null;
  if (!match) return [];
  const region = match[1]!;
  const letters = ['a', 'b'];
  const kind = (s: { id?: unknown; config: Record<string, unknown> }) => `${s.config['isPublic'] === true}|${String(s.id ?? '').toLowerCase().replace(/[\d_-]+[a-z]?$|\d+/g, '')}`;

  const seen = new Map<string, number>();
  const target = subnets.map((s) => { const k = kind(s); const n = seen.get(k) ?? 0; seen.set(k, n + 1); return letters[n % 2]!; });
  if (new Set(target).size < 2) subnets.forEach((_, i) => { target[i] = letters[i % 2]!; });   // every kind has one subnet: alternate overall

  const moved: string[] = [];
  subnets.forEach((s, i) => {
    const az = region + target[i];
    if (s.config['availabilityZone'] !== az) { s.config['availabilityZone'] = az; moved.push(String(s.id ?? '?')); }
  });
  return moved;
}

/** Sentences for the user about settings that were ignored (renames are lossless, so they are not worth a warning). */
export function describeSanitized(report: SanitizeReport): string[] {
  const out: string[] = report.specRepairs ? describeSpecRepair(report.specRepairs) : [];
  if (report.zonesSpread && report.zonesSpread.length > 0) out.push(`The AI placed every subnet in one Availability Zone, so CloudCraft spread ${report.zonesSpread.length} of them across two zones for high availability.`);
  if (report.dropped.length === 0) return out;
  const list = report.dropped.map((d) => `${d.type}.${d.setting} (${d.resources.slice(0, 3).join(', ')}${d.resources.length > 3 ? ', …' : ''})`).join('; ');
  out.push(`The AI used ${report.dropped.length} setting name${report.dropped.length === 1 ? '' : 's'} CloudCraft doesn't have, so the defaults were used instead: ${list}. Check those resources if you needed something specific.`);
  return out;
}
