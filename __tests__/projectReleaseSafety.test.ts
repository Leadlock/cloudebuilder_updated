/**
 * The Terraform CloudCraft plans for a release is checked by the same guard as every generated Terraform (no provisioners, modules, external data or
 * non-HashiCorp sources). Every target's release bundle, and its downloadable files, must pass it: this was found by planning a real EC2 release.
 */
import { assertSafeHcl } from '@/lib/engines/terraform/hclSafety';
import { defaultProject, generateProjectFiles, LAYERS, type Layer, type StackProject } from '@/lib/engines/containers/stackProject';

const project = (target: StackProject['deploy']['target'], on: Layer[]): StackProject => {
  const p = defaultProject();
  p.name = 'shop';
  for (const l of LAYERS) p.layers[l].enabled = on.includes(l);
  p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }];
  p.deploy.target = target;
  return p;
};

describe.each(['ec2', 'ecs', 'azure-vm', 'container-apps'] as const)('the %s Terraform', (target) => {
  const on: Layer[] = target === 'ec2' || target === 'azure-vm' ? ['frontend', 'backend', 'api', 'database'] : ['frontend', 'backend', 'api'];
  test.each([true, false])('passes the safety guard (for a release: %s)', (forRelease) => {
    const r = generateProjectFiles(project(target, on), { forRelease });
    if (!r.ok) throw new Error(r.errors.join('; '));
    const tf = r.files.filter((f) => /\.tf$/.test(f.path)).map((f) => ({ filename: f.path, content: f.content }));
    expect(tf.length).toBeGreaterThan(0);
    expect(() => assertSafeHcl(tf)).not.toThrow();
  });
});
