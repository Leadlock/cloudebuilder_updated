/**
 * The generated files carry the four fixes the scan asked for, and the ones that must not change stay as they were.
 */
import { defaultConfig, generateContainerFiles, withDeployTarget } from '@/lib/engines/containers/dockerTemplates';
import { defaultProject, generateProjectFiles, LAYERS } from '@/lib/engines/containers/stackProject';
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

const res = (id: string, resourceType: string, config: Record<string, unknown> = {}): DbArchitectureResource => ({ id, resourceType, provider: 'aws', label: id, positionX: 0, positionY: 0, configJson: JSON.stringify({ name: id, ...config }), region: null, groupId: null, architectureId: 'a' } as DbArchitectureResource);
const tf = (resources: DbArchitectureResource[]) => new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources, connections: [] }).files.map((f) => f.content).join('\n');

describe('the static site\'s Dockerfile says which user it runs as', () => {
  test('USER 101, in the final stage, before the port, with the unprivileged nginx image', () => {
    const r = generateContainerFiles({ ...defaultConfig('static'), appName: 'site' });
    expect(r.ok).toBe(true);
    const d = r.ok ? r.files.find((f) => f.path === 'Dockerfile')!.content : '';
    const last = d.slice(d.lastIndexOf('FROM '));
    expect(last).toMatch(/^FROM nginxinc\/nginx-unprivileged:/);
    expect(last.indexOf('USER 101')).toBeGreaterThan(0);
    expect(last.indexOf('USER 101')).toBeLessThan(last.indexOf('EXPOSE'));
  });
  test('and so does a project\'s Frontend', () => {
    const p = defaultProject(); p.name = 'shop';
    for (const l of LAYERS) p.layers[l].enabled = ['frontend', 'api'].includes(l);
    const r = generateProjectFiles(p);
    expect(r.ok && r.files.find((f) => f.path === 'frontend/Dockerfile')!.content).toMatch(/\nUSER 101\nEXPOSE /);
  });
  test('the other stacks keep the user they had', () => {
    const r = generateContainerFiles({ ...defaultConfig('node'), appName: 'api' });
    const d = r.ok ? r.files.find((f) => f.path === 'Dockerfile')!.content : '';
    expect(d).toContain('USER app');
    expect(d).not.toContain('USER 101');
  });
});

describe('a load balancer drawn on the canvas drops invalid headers, when it can', () => {
  test('an application load balancer does', () => {
    expect(tf([res('lb', 'aws_alb')])).toMatch(/resource "aws_lb" "lb" \{[\s\S]*?drop_invalid_header_fields = true/);
  });
  test('a network load balancer is left alone: the setting is not valid there', () => {
    const out = tf([res('nlb', 'aws_alb', { lbType: 'network' })]);
    expect(out).toContain('load_balancer_type = "network"');
    expect(out).not.toContain('drop_invalid_header_fields');
  });
});

describe('a launch template drawn on the canvas needs the metadata session token (IMDSv2)', () => {
  test('metadata_options requires tokens, with a hop limit that still lets containers on the instance in', () => {
    const out = tf([res('asg', 'aws_auto_scaling')]);
    expect(out).toMatch(/resource "aws_launch_template" "asg_lt" \{[\s\S]*?metadata_options \{[\s\S]*?http_endpoint\s+= "enabled"[\s\S]*?http_tokens\s+= "required"[\s\S]*?http_put_response_hop_limit = 2/);
  });
});

describe('an AKS cluster says that role-based access control is on', () => {
  test('the single service, and the project', () => {
    const single = generateContainerFiles(withDeployTarget({ ...defaultConfig('node'), appName: 'api', port: 3000 }, 'aks'));
    expect(single.ok && single.files.find((f) => f.path === 'aks/main.tf')!.content).toContain('role_based_access_control_enabled = true');
    const p = defaultProject(); p.name = 'shop'; p.deploy.target = 'aks';
    for (const l of LAYERS) p.layers[l].enabled = ['backend', 'api'].includes(l);
    const proj = generateProjectFiles(p);
    expect(proj.ok && proj.files.find((f) => f.path === 'aks/main.tf')!.content).toContain('role_based_access_control_enabled = true');
  });
});
