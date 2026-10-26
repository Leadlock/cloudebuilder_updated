/** AKS clusters get a network policy engine (Trivy AZU-0043), but a saved design that never had one is not changed: that would replace a running cluster. */
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import { defaultConfig, generateContainerFiles } from '@/lib/engines/containers/dockerTemplates';
import { getResourceDefinition } from '@/lib/resources';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

const aks = (config: Record<string, unknown>): string => {
  const r = { id: 'k', resourceType: 'azure_aks', provider: 'azure', label: 'k', positionX: 0, positionY: 0, configJson: JSON.stringify({ name: 'k', ...config }), region: null, groupId: null, locked: false, architectureId: 'a' } as DbArchitectureResource;
  return new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources: [r], connections: [] }).files.find((f) => f.filename === 'main.tf')?.content ?? '';
};

describe('the AKS node', () => {
  it('a new node asks for the Azure network policy engine', () => {
    const def = getResourceDefinition('azure_aks')!;
    expect(def.defaultConfig['networkPolicy']).toBe('azure');
    expect(aks({ ...def.defaultConfig })).toMatch(/network_profile \{\n\s+network_plugin = "azure"\n\s+network_policy = "azure"/);
  });
  it('a saved design without the setting is left exactly as it was', () => {
    expect(aks({})).not.toContain('network_policy');
  });
  it('Calico is allowed with either plugin, Azure only with the Azure plugin, and none writes nothing', () => {
    expect(aks({ networkPlugin: 'kubenet', networkPolicy: 'calico' })).toContain('network_policy = "calico"');
    expect(aks({ networkPlugin: 'kubenet', networkPolicy: 'azure' })).not.toContain('network_policy');
    expect(aks({ networkPolicy: 'none' })).not.toContain('network_policy');
    expect(aks({ networkPolicy: 'evil"\n}' })).not.toContain('evil');
  });
});

describe('the AKS cluster of Container Templates', () => {
  it('has the Azure network policy engine', () => {
    const c = defaultConfig('node'); c.aks = { ...c.aks, enabled: true };
    const r = generateContainerFiles(c);
    if (!r.ok) throw new Error(r.errors.join('; '));
    const tf = r.files.filter((f) => f.path.endsWith('.tf')).map((f) => f.content).join('\n');
    expect(tf).toMatch(/network_plugin_mode = "overlay"\n(?:\s*#.*\n)?\s+network_policy\s+= "azure"/);
  });
});
