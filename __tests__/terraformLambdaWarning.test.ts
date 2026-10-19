/**
 * A generated Lambda deploys "placeholder.zip". CloudBuilder's own deploy writes that file, but Terraform run anywhere else stops at plan with
 * "no such file", so the generator says so.
 */
import { terraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

const row = (id: string, resourceType: string, label: string): DbArchitectureResource => ({
  id, resourceType, provider: 'aws', label, positionX: 0, positionY: 0, configJson: '{}', region: null, groupId: null, locked: false, architectureId: 'arch-1',
});
const generate = (resources: DbArchitectureResource[]) => terraformGenerator.generate({ architectureId: 'arch-1', projectId: 'p-1', resources, connections: [], projectName: 'demo' });

describe('Lambda placeholder package', () => {
  test('a design with a Lambda warns that placeholder.zip is needed outside CloudBuilder, naming the function', () => {
    const out = generate([row('l1', 'aws_lambda', 'Order Worker')]);
    const warning = out.warnings.find((w) => w.includes('placeholder.zip'));
    expect(warning).toBeDefined();
    expect(warning).toContain('Order Worker');
    expect(out.files.find((f) => f.filename === 'main.tf')!.content).toContain('filebase64sha256("placeholder.zip")');
  });

  test('a design without a Lambda has no such warning', () => {
    const out = generate([row('v1', 'aws_vpc', 'Main VPC')]);
    expect(out.warnings.some((w) => w.includes('placeholder.zip'))).toBe(false);
  });
});
