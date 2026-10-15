/**
 * The generic Terraform generator (lib/resources/catalog/universalHcl.ts) writes a block from a type's name, so it must only do that for a real,
 * defined resource. A box that is only drawn on the canvas (the cloud boundary around a diagram) and a type nobody defined get the old answer:
 * a warning, and no made-up Terraform resource (which Terraform would refuse with "Invalid resource type").
 */
import { terraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import { CANVAS_ONLY_TYPES, canGenerateGenericBlock } from '@/lib/resources/genericTerraform';
import { allCatalogResources } from '@/lib/resources';
import { TEMPLATES } from '@/lib/templates';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

const row = (id: string, resourceType: string, provider: string): DbArchitectureResource => ({
  id, resourceType, provider, label: 'X', positionX: 0, positionY: 0, configJson: '{}', region: null, groupId: null, locked: false, architectureId: 'a',
});
const generate = (resources: DbArchitectureResource[]) => terraformGenerator.generate({ architectureId: 'a', projectId: 'p', resources, connections: [], projectName: 'demo' });
const blocks = (resources: DbArchitectureResource[]) => [...generate(resources).files.map((f) => f.content).join('\n').matchAll(/^resource "([a-z0-9_]+)" "/gm)].map((m) => m[1]!);

describe('which types may become a generic block', () => {
  test('the two canvas-only boxes and an undefined type may not; every catalog type may', () => {
    expect(CANVAS_ONLY_TYPES).toEqual(new Set(['aws_cloud_boundary', 'azure_cloud_boundary']));
    expect(canGenerateGenericBlock('aws_cloud_boundary')).toBe(false);
    expect(canGenerateGenericBlock('azure_cloud_boundary')).toBe(false);
    expect(canGenerateGenericBlock('aws_xyzunknown')).toBe(false);
    expect(canGenerateGenericBlock('')).toBe(false);
    for (const d of allCatalogResources.filter((x) => !CANVAS_ONLY_TYPES.has(x.type))) expect({ type: d.type, ok: canGenerateGenericBlock(d.type) }).toEqual({ type: d.type, ok: true });
  });
});

describe('the generator', () => {
  test.each([['aws', 'aws_cloud_boundary'], ['azure', 'azure_cloud_boundary']])('%s: the cloud boundary writes no Terraform resource of its own', (provider, type) => {
    expect(blocks([row('b', type, provider)]).filter((b) => b.includes('boundary'))).toEqual([]);
  });

  test.each([['aws', 'aws_xyzunknown'], ['azure', 'azure_xyzunknown']])('%s: an undefined type is reported, not written', (provider, type) => {
    const r = row('u', type, provider);
    expect(blocks([r]).filter((b) => b.includes('xyzunknown'))).toEqual([]);
    expect(generate([r]).warnings.some((w) => w.includes(type))).toBe(true);
  });

  test('a real catalog type still becomes a generic block', () => {
    expect(blocks([row('e', 'aws_vpc_endpoint', 'aws')])).toContain('aws_vpc_endpoint');
  });

  test('a template with its cloud boundary generates no made-up resource, for every template', () => {
    const found: string[] = [];
    for (const t of TEMPLATES) {
      const g = t.generate({ region: t.provider === 'azure' ? 'eastus' : 'us-east-1', environment: 'production' });
      const resources = g.nodes.map((n) => ({ ...row(n.id, n.resourceType, n.provider), label: n.label, configJson: JSON.stringify(n.config ?? {}), groupId: n.groupId ?? null }));
      if (blocks(resources).some((b) => b.includes('cloud_boundary'))) found.push(t.id);
    }
    expect(found).toEqual([]);
  });
});
