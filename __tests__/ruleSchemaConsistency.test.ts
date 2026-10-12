/**
 * The assessment rules promise (lib/engines/assessment/rules/aws.ts header) that every rule reads the SAME settings the resource
 * definitions and the Terraform generator use, "so a finding, its Auto-Fix and the generated HCL always refer to the same fact".
 * Nothing enforced that. This does, for every rule and every resource type it applies to:
 *
 *  1. every setting a rule reads exists in the resource definition (a typo would make the check read nothing);
 *  2. a design with the resource's default settings never produces INSUFFICIENT_DATA (the AI generator's deploy gate rejects it,
 *     and a rule that cannot be evaluated on defaults is a rule that cannot be passed);
 *  3. every setting an Auto-Fix patch writes exists in the resource definition;
 *  4. every setting a rule reads actually changes the generated Terraform (otherwise a finding can be "fixed" in the form with
 *     no effect on what is deployed). Known exceptions are listed below WITH A REASON, and the list is itself checked, so it can
 *     neither hide a new gap nor outlive the gap it describes.
 *
 * Found by this check when it was written: Azure Front Door `cachingEnabled` was read by a rule but never emitted.
 */
import { ALL_RULES } from '@/lib/engines/assessment/rules';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { getResourceDefinition } from '@/lib/resources';
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { CanvasNode } from '@/types';

/** `type.setting` → why changing it cannot change the Terraform today. */
const KNOWN_TERRAFORM_GAPS: Record<string, string> = {
  'aws_ebs.snapshotSchedule': 'AWS-EBS-002: the generator does not emit AWS Backup or Data Lifecycle Manager resources, so the rule is manual-only.',
  'aws_s3.loggingEnabled': 'AWS-S3-003: the generator does not emit aws_s3_bucket_logging (it needs a target log bucket), so the rule is manual-only.',
};

/** Settings that only take effect together with another setting, so the probe sets that one first. */
const CONTEXT: Record<string, Record<string, unknown>> = {
  'azure_app_gateway.wafEnabled': { sku: 'WAF_v2' },
  'azure_app_gateway.wafMode': { sku: 'WAF_v2', wafEnabled: true },
  // Private access and zone redundancy exist only on the higher tiers; on the lower ones the generator keeps the default and says so.
  'azure_acr.publicNetworkAccess': { sku: 'Premium' }, 'azure_acr.zoneRedundant': { sku: 'Premium' },
  'azure_service_bus.publicNetworkAccess': { sku: 'Premium' }, 'azure_service_bus.zoneRedundant': { sku: 'Premium' },
  'azure_api_management.zones': { sku: 'Premium' },
  'azure_postgres.highAvailability': { skuName: 'GP_Standard_D2ds_v5' }, 'azure_mysql.highAvailability': { skuName: 'GP_Standard_D2ds_v4' },
};

type Def = NonNullable<ReturnType<typeof getResourceDefinition>>;

const isAzure = (type: string) => type.startsWith('azure_');
const nodeOf = (type: string, def: Def): CanvasNode => ({
  id: 'r', type: 'cloudNode', resourceType: type, provider: isAzure(type) ? 'azure' : 'aws', label: 'r', position: { x: 0, y: 0 }, config: { ...def.defaultConfig },
} as CanvasNode);
const known = (def: Def, key: string) => key in def.defaultConfig || def.configSchema.some((c) => c.key === key);

const resourceRules = ALL_RULES.filter((r) => r.scope === 'resource');

/** type.setting → the rules that read it, from the evidence each evaluation records. */
const readBy = (() => {
  const out = new Map<string, Set<string>>();
  for (const rule of resourceRules) {
    for (const type of rule.resourceTypes ?? []) {
      const def = getResourceDefinition(type);
      if (!def) continue;
      const a = runAssessment({ nodes: [nodeOf(type, def)], edges: [] });
      for (const e of a.evaluations.filter((x) => x.ruleId === rule.id)) {
        for (const item of e.evidence ?? []) {
          if (!item.field) continue;
          const key = `${type}.${item.field}`;
          (out.get(key) ?? out.set(key, new Set()).get(key)!).add(rule.id);
        }
      }
    }
  }
  return out;
})();

describe('rules and resource definitions agree', () => {
  test('every resource rule applies to resource types that exist', () => {
    for (const rule of resourceRules) for (const type of rule.resourceTypes ?? []) expect([rule.id, type, Boolean(getResourceDefinition(type))]).toEqual([rule.id, type, true]);
  });

  test('every setting a rule reads exists in the resource definition', () => {
    const missing: string[] = [];
    for (const [key, rules] of readBy) {
      const type = key.slice(0, key.indexOf('.'));
      const field = key.slice(key.indexOf('.') + 1);
      if (!known(getResourceDefinition(type)!, field)) missing.push(`${key} (read by ${[...rules].join(', ')})`);
    }
    expect(missing).toEqual([]);
    expect(readBy.size).toBeGreaterThan(100); // the probe really found the settings, so the checks above are not vacuous
  });

  test('a resource with its default settings is never "insufficient data" for any rule', () => {
    const insufficient: string[] = [];
    for (const rule of resourceRules) {
      for (const type of rule.resourceTypes ?? []) {
        const def = getResourceDefinition(type)!;
        const a = runAssessment({ nodes: [nodeOf(type, def)], edges: [] });
        for (const e of a.evaluations.filter((x) => x.ruleId === rule.id && x.status === 'INSUFFICIENT_DATA')) insufficient.push(`${rule.id} on ${type}: ${e.observation}`);
      }
    }
    expect(insufficient).toEqual([]);
  });

  test('every setting an Auto-Fix writes exists in the resource definition', () => {
    const bad: string[] = [];
    for (const rule of resourceRules) {
      if (!rule.autoFix?.patch) continue;
      for (const type of rule.resourceTypes ?? []) {
        const def = getResourceDefinition(type)!;
        const resource = { id: 'r', resourceType: type, config: { ...def.defaultConfig } } as never;
        const patch = rule.autoFix.patch({ ...nodeOf(type, def) } as never, resource) ?? {};
        for (const key of Object.keys(patch)) if (!known(def, key)) bad.push(`${rule.id} writes "${key}" which ${type} does not have`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('every setting a rule reads reaches the generated Terraform', () => {
  const generate = (type: string, config: Record<string, unknown>): string => {
    try {
      return new TerraformGenerator().generate({
        architectureId: 'a', projectId: 'p', connections: [],
        resources: [{ id: 'r1', resourceType: type, provider: isAzure(type) ? 'azure' : 'aws', label: 'r1', positionX: 0, positionY: 0, configJson: JSON.stringify({ name: 'r1', ...config }), region: null, groupId: null, locked: false, architectureId: 'a' }],
      }).files.map((f) => f.content).join('\n');
    } catch (e) { return `THROW:${(e as Error).message}`; }
  };

  const candidates = (def: Def, key: string, v: unknown): unknown[] => {
    const out: unknown[] = [];
    const field = def.configSchema.find((c) => c.key === key);
    if (typeof v === 'boolean') out.push(!v);
    for (const o of field?.options ?? []) if (o.value !== v) out.push(o.value);
    if (typeof v === 'number') out.push(v + 7, 60, 30, 1, 100);
    if (typeof v === 'string') out.push(`${v}-changed`, 'my-valid-name', 'Standard_LRS', 'Deny');
    if (Array.isArray(v)) out.push(['postgresql'], ['api', 'audit'], ['arn:aws:iam::aws:policy/ReadOnlyAccess']);
    // A setting with no default (undefined) has no type to infer from, so always also try a few generic values.
    out.push('changed', 'my-valid-name', 'arn:aws:kms:us-east-1:111122223333:key/abcd-1234', 60, true, false);
    return out;
  };
  /** Every switch on and every bucket named, so a setting that only matters once another is enabled still shows an effect. */
  const allOn = (def: Def): Record<string, unknown> => {
    const c: Record<string, unknown> = { ...def.defaultConfig };
    for (const [k, v] of Object.entries(c)) { if (typeof v === 'boolean') c[k] = true; if (/bucket/i.test(k)) c[k] = 'my-valid-name'; }
    return c;
  };

  const changesTerraform = (key: string): boolean => {
    const type = key.slice(0, key.indexOf('.'));
    const field = key.slice(key.indexOf('.') + 1);
    const def = getResourceDefinition(type)!;
    for (const base of [{ ...def.defaultConfig, ...CONTEXT[key] }, { ...allOn(def), ...CONTEXT[key] }]) {
      const before = generate(type, base);
      if (before.startsWith('THROW:')) continue;
      for (const value of candidates(def, field, base[field])) {
        if (JSON.stringify(value) === JSON.stringify(base[field])) continue;
        if (generate(type, { ...base, [field]: value }) !== before) return true;
      }
    }
    return false;
  };

  const gaps = [...readBy.keys()].sort().filter((key) => !changesTerraform(key));

  test('no setting is read by a rule yet ignored by Terraform, apart from the documented gaps', () => {
    const unexplained = gaps.filter((k) => !(k in KNOWN_TERRAFORM_GAPS)).map((k) => `${k} (read by ${[...readBy.get(k)!].join(', ')})`);
    expect(unexplained).toEqual([]);
  });

  test('every documented gap is still a gap (fix it, then delete it from the list)', () => {
    const stale = Object.keys(KNOWN_TERRAFORM_GAPS).filter((k) => !gaps.includes(k));
    expect(stale).toEqual([]);
  });

  test('Azure Front Door caching off omits the cache block, and on writes it', () => {
    const off = generate('azure_front_door', { cachingEnabled: false });
    const on = generate('azure_front_door', { cachingEnabled: true });
    expect(off).not.toMatch(/\bcache\s*\{/);
    expect(on).toMatch(/\bcache\s*\{\s*query_string_caching_behavior/);
  });
});
