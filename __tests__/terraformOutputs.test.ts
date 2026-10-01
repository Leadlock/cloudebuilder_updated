/**
 * Every `output` in outputs.tf must point at something that is actually declared. An output that references a managed
 * resource which was generated as a `data` source (an imported / existing resource) makes Terraform fail on every plan,
 * apply and destroy: "Reference to undeclared resource".
 */
import { terraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

const row = (id: string, resourceType: string, provider: 'aws' | 'azure', label: string, config: Record<string, unknown> = {}): DbArchitectureResource => ({
  id, resourceType, provider, label, positionX: 0, positionY: 0, configJson: JSON.stringify(config), region: null, groupId: null, locked: false, architectureId: 'arch-1',
});

/** The six resource types that get outputs, with the settings they need to be generated. */
const OUTPUT_TYPES: [string, 'aws' | 'azure', Record<string, unknown>][] = [
  ['aws_alb', 'aws', {}], ['aws_rds', 'aws', {}], ['aws_s3', 'aws', {}], ['aws_vpc', 'aws', {}],
  ['azure_sql', 'azure', {}], ['azure_storage', 'azure', {}], ['azure_blob', 'azure', {}],
];

/** Managed-resource references (`type.name`, not `data.type.name`) used as output values. */
function referencedManagedResources(outputs: string): { type: string; name: string }[] {
  return [...outputs.matchAll(/^\s*value\s*=\s*(?!data\.)((?:aws|azurerm)_[a-z0-9_]+)\.([A-Za-z0-9_-]+)\./gm)].map((m) => ({ type: m[1]!, name: m[2]! }));
}
const declared = (files: { content: string }[], type: string, name: string) => files.some((f) => new RegExp(`resource\\s+"${type}"\\s+"${name}"`).test(f.content));

function generate(resources: DbArchitectureResource[]) {
  const out = terraformGenerator.generate({ architectureId: 'arch-1', projectId: 'proj-1', resources, connections: [], projectName: 'demo' });
  const outputs = out.files.find((f) => f.filename === 'outputs.tf')?.content ?? '';
  return { outputs, files: out.files.filter((f) => f.filename !== 'outputs.tf') };
}

describe('outputs.tf only references declared resources', () => {
  it.each(OUTPUT_TYPES)('%s: a normal (managed) resource gets an output that resolves', (type, provider, cfg) => {
    const { outputs, files } = generate([row('r1', type, provider, 'cloudcraft', cfg)]);
    const refs = referencedManagedResources(outputs);
    for (const ref of refs) expect(declared(files, ref.type, ref.name)).toBe(true);
  });

  it.each(OUTPUT_TYPES)('%s: an imported (existing) resource gets no output pointing at a managed resource', (type, provider, cfg) => {
    const { outputs, files } = generate([row('r1', type, provider, 'cloudcraft', { ...cfg, imported: true })]);
    expect(referencedManagedResources(outputs)).toEqual([]);
    for (const ref of referencedManagedResources(outputs)) expect(declared(files, ref.type, ref.name)).toBe(true);
  });

  it('also honours importState: "imported"', () => {
    const { outputs } = generate([row('r1', 'azure_storage', 'azure', 'cloudcraft', { importState: 'imported' })]);
    expect(outputs).not.toContain('azurerm_storage_account.cloudcraft.name');
  });

  it('the failing case from a real teardown: an imported Azure storage account named "cloudcraft"', () => {
    const { outputs, files } = generate([row('sa', 'azure_storage', 'azure', 'cloudcraft', { imported: true })]);
    expect(files.some((f) => /data\s+"azurerm_storage_account"\s+"cloudcraft"/.test(f.content))).toBe(true);   // declared as existing…
    expect(outputs).not.toMatch(/value\s*=\s*azurerm_storage_account\.cloudcraft/);                           // …so no output may treat it as managed
  });

  it('a mix keeps outputs for the managed resources and drops only the imported ones', () => {
    const { outputs, files } = generate([
      row('b1', 'aws_s3', 'aws', 'assets', {}),
      row('b2', 'aws_s3', 'aws', 'existing-bucket', { imported: true }),
    ]);
    expect(outputs).toContain('assets_bucket_arn');
    expect(outputs).not.toContain('existing_bucket_bucket_arn');
    for (const ref of referencedManagedResources(outputs)) expect(declared(files, ref.type, ref.name)).toBe(true);
  });
});
