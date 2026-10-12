/**
 * Generates Terraform for AWS designs that use the Container service node and runs `terraform validate` on each (needs a terraform
 * binary: TERRAFORM_BIN). Not part of `npm test`: it downloads the aws provider. Run: TERRAFORM_BIN=/path/to/terraform npx tsx --tsconfig tsconfig.json scripts/tf-validate-aws.ts [dir]
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { TerraformGenerator } from '../lib/engines/terraform/TerraformGenerator';
const bin = process.env.TERRAFORM_BIN ?? 'terraform';
const root = process.argv[2] ?? '/tmp/tf-validate-aws';
const n = (id: string, resourceType: string, config: Record<string, unknown> = {}, groupId?: string) => ({ id, resourceType, provider: 'aws', label: id, config: { name: id, ...config }, groupId });
const sets: Record<string, any[]> = {
  'in-subnet': [n('vpc', 'aws_vpc', { cidrBlock: '10.0.0.0/16' }), n('sub', 'aws_subnet', { cidrBlock: '10.0.1.0/24' }, 'vpc'), n('app', 'aws_container_service', { name: 'orders-api', elasticIp: true, imageTag: 'v2' }, 'sub')],
  'bare': [n('app', 'aws_container_service', { name: 'site', stack: 'static', port: 8080 })],
};
rmSync(root, { recursive: true, force: true });
let failed = 0;
for (const [name, nodes] of Object.entries(sets)) {
  const resources = nodes.map((x) => ({ id: x.id, resourceType: x.resourceType, provider: x.provider, label: x.label, positionX: 0, positionY: 0, configJson: JSON.stringify(x.config), region: null, groupId: x.groupId ?? null, locked: false, architectureId: 'a' })) as any[];
  const out = new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources, connections: [] });
  const dir = join(root, name); mkdirSync(dir, { recursive: true });
  for (const f of out.files) writeFileSync(join(dir, f.filename), f.content);
  console.log(name, out.files.map((f) => f.filename).join(','), 'warnings:', out.warnings);
  const run = (a: string[]) => spawnSync(bin, a, { cwd: dir, encoding: 'utf8', env: { ...process.env, TF_IN_AUTOMATION: '1', TF_PLUGIN_CACHE_DIR: join(root, '.plugins') } });
  mkdirSync(join(root, '.plugins'), { recursive: true });
  const init = run(['init', '-backend=false', '-input=false', '-no-color']);
  if (init.status !== 0) { console.log('INIT FAILED', (init.stderr || init.stdout).slice(0, 600)); failed++; continue; }
  const v = run(['validate', '-no-color']);
  console.log(name, v.status === 0 ? 'valid' : 'INVALID\n' + (v.stderr || v.stdout).slice(0, 2000));
  if (v.status) failed++;
}
process.exit(failed ? 1 : 0);
