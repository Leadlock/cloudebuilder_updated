/**
 * Helpers that give every resource rule the same evidence and missing-data
 * semantics:
 *  - every field the rule reads is recorded as evidence with its observed value;
 *  - if any required field is absent, the result is INSUFFICIENT_DATA (never PASS);
 *  - field labels come from the resource definition, so reports read
 *    "Publicly accessible: Yes" rather than raw config keys.
 */
import { getResourceDefinition } from '@/lib/resources';
import type {
  AssessResource, AssessContext, EvidenceItem, EvaluationStatus, RuleDefinition, RuleOutcome, Severity,
} from './types';

export const REVIEWED = '2026-09-24';

export function fieldLabel(resourceType: string, key: string): string {
  const def = getResourceDefinition(resourceType);
  const f = def?.configSchema.find((c) => c.key === key);
  if (f) return f.label;
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()).trim();
}

export function fmt(v: unknown): string {
  if (v === undefined) return 'Not specified';
  if (v === null) return 'None';
  if (v === true) return 'Enabled / Yes';
  if (v === false) return 'Disabled / No';
  if (v === '') return 'Empty';
  if (Array.isArray(v)) return v.length === 0 ? 'None' : v.map(String).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function isMissing(v: unknown): boolean {
  return v === undefined || v === null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Field-level provenance of a configuration value. */
export function fieldSource(r: AssessResource, field: string): Pick<EvidenceItem, 'source' | 'discoveredValue' | 'observedAt'> {
  const value = r.config[field];
  if (r.live && field in r.live.values && same(r.live.values[field], value)) {
    return { source: 'LIVE', observedAt: r.live.observedAt };
  }
  if (r.discovery && field in r.discovery.values) {
    const discovered = r.discovery.values[field];
    return same(discovered, value)
      ? { source: 'DISCOVERED', observedAt: r.discovery.discoveredAt }
      : { source: 'DESIGN', discoveredValue: fmt(discovered), observedAt: r.discovery.discoveredAt };
  }
  return { source: 'DESIGN' };
}

export function ev(r: AssessResource, field: string, expected?: string): EvidenceItem {
  return {
    field,
    label: fieldLabel(r.resourceType, field),
    observed: fmt(r.config[field]),
    expected,
    basis: 'CONFIGURATION',
    ...fieldSource(r, field),
  };
}

export interface CheckResult {
  status: Exclude<EvaluationStatus, 'NOT_EVALUATED' | 'INSUFFICIENT_DATA'>;
  observation: string;
  severity?: Severity;
  extraEvidence?: EvidenceItem[];
}

/**
 * Build a resource-scoped rule evaluation from the fields it depends on.
 * `required` fields must be present or the outcome is INSUFFICIENT_DATA.
 */
export function configEvaluator(
  required: string[],
  expected: Record<string, string>,
  check: (c: Record<string, unknown>, r: AssessResource, ctx: AssessContext) => CheckResult,
  optional: string[] = [],
): (r: AssessResource, ctx: AssessContext) => RuleOutcome {
  return (r, ctx) => {
    const missing = required.filter((k) => isMissing(r.config[k]));
    const evidence = [...required, ...optional].map((k) => ev(r, k, expected[k]));
    if (missing.length > 0) {
      const names = missing.map((k) => `"${fieldLabel(r.resourceType, k)}"`).join(', ');
      return {
        status: 'INSUFFICIENT_DATA',
        observation: r.discovery && r.importState === 'imported'
          ? `Discovery did not return ${names} for this resource, so this control cannot be evaluated.`
          : `The configuration does not specify ${names}, so this control cannot be evaluated.`,
        evidence,
        requiredData: r.discovery && r.importState === 'imported'
          ? `Grant discovery read access to ${missing.map((k) => fieldLabel(r.resourceType, k)).join(', ')}, or set the value explicitly.`
          : `Set or import: ${missing.map((k) => fieldLabel(r.resourceType, k)).join(', ')}.`,
      };
    }
    const res = check(r.config, r, ctx);
    return {
      status: res.status,
      observation: res.observation,
      evidence: [...evidence, ...(res.extraEvidence ?? [])],
      severity: res.severity,
    };
  };
}

/** Outcome for controls CloudBuilder cannot observe from an architecture design. */
export function notModelled(what: string, requiredData: string, resourceIds: string[] = []): RuleOutcome {
  return {
    status: 'NOT_EVALUATED',
    observation: `${what} is not represented in the CloudBuilder architecture model, so it was not evaluated.`,
    evidence: [{ label: what, observed: 'Not modelled in the architecture', basis: 'NOT_MODELLED' }],
    requiredData,
    resourceIds,
  };
}

export const PUBLIC_CIDRS = new Set(['0.0.0.0/0', '::/0']);
export const AZURE_ANY_SOURCES = new Set(['*', '0.0.0.0/0', '::/0', 'internet', 'any']);

export function isAzureAnySource(v: unknown): boolean {
  return typeof v === 'string' && AZURE_ANY_SOURCES.has(v.trim().toLowerCase());
}

/** Compact rule factory to keep rule files declarative. */
export function rule(def: RuleDefinition): RuleDefinition {
  if (!def.evaluate && !def.evaluateArchitecture) {
    throw new Error(`Rule ${def.id} has no evaluator`);
  }
  if (def.scope === 'resource' && (!def.resourceTypes || def.resourceTypes.length === 0)) {
    throw new Error(`Resource rule ${def.id} has no resourceTypes`);
  }
  return def;
}

/** True when an internet source (aws_internet / igw) is directly linked to the resource. */
export function directlyInternetLinked(r: AssessResource, ctx: AssessContext): boolean {
  return ctx.neighbors(r.id).some((n) => n.resourceType === 'aws_internet' || n.resourceType === 'aws_igw');
}
