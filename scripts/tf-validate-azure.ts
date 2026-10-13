/**
 * Generates Terraform for representative Azure designs and runs `terraform validate` on each (needs a terraform binary: TERRAFORM_BIN).
 * Not part of `npm test`: it downloads the azurerm provider. Run: TERRAFORM_BIN=/path/to/terraform npx tsx --tsconfig tsconfig.json scripts/tf-validate-azure.ts [dir]
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { TerraformGenerator } from '../lib/engines/terraform/TerraformGenerator';
import { evaluateSpec } from '../lib/ai/architectureSpec';
import { azureThreeTier, azureAks, azureAppService, azureServerless } from './ai-dataset/azurePatterns';
import { azureFunctionsPrivateApi, azureStaticSite } from './ai-dataset/morePatterns';
import { azureGatewayAppService } from './ai-dataset/extraPatterns';
import type { Requirements } from './ai-dataset/requirements';
import type { DbArchitectureConnection, DbArchitectureResource } from '../lib/repositories/architectureRepository';

const bin = process.env.TERRAFORM_BIN ?? 'terraform';
const root = process.argv[2] ?? '/tmp/tf-validate';
const base: Requirements = { provider: 'azure', pattern: '', region: 'westeurope', scale: 'medium', db: 'postgres', cache: true, cdn: true, regulated: false, queue: true, app: 'shop' };
const cases: Array<[string, Requirements, (r: Requirements) => unknown]> = [
  ['three-tier-pg', base, azureThreeTier], ['three-tier-mysql', { ...base, db: 'mysql', regulated: true }, azureThreeTier], ['three-tier-sql', { ...base, db: 'sql' }, azureThreeTier],
  ['app-service', { ...base, db: 'postgres' }, azureAppService], ['aks', { ...base, db: 'postgres' }, azureAks], ['serverless', { ...base, db: 'nosql', cache: false }, azureServerless],
  ['gateway-app', { ...base, cdn: false, db: 'mysql' }, azureGatewayAppService], ['functions-private', { ...base, db: 'sql', cache: false, cdn: false, queue: false }, azureFunctionsPrivateApi],
  ['static-site', { ...base, db: 'none', cache: false, queue: false }, azureStaticSite],
];

function toDb(nodes: any[], edges: any[]): { resources: DbArchitectureResource[]; connections: DbArchitectureConnection[] } {
  return {
    resources: nodes.map((n) => ({ id: n.id, resourceType: n.resourceType, provider: n.provider, label: n.label, positionX: 0, positionY: 0, configJson: JSON.stringify(n.config ?? {}), region: null, groupId: n.groupId ?? n.parentId ?? null, locked: false, architectureId: 'a' } as DbArchitectureResource)),
    connections: edges.map((e) => ({ id: e.id, label: null, edgeType: null, sourceId: e.source, targetId: e.target, architectureId: 'a' } as DbArchitectureConnection)),
  };
}

/** Every managed service and the network pieces around them, drawn by hand (no AI), to check the generated HCL of each. */
function kitchenSink(): { nodes: any[]; edges: any[] } {
  const n = (id: string, resourceType: string, config: Record<string, unknown> = {}, groupId?: string) => ({ id, resourceType, provider: 'azure', label: id, config: { name: id, ...config }, groupId });
  const nodes = [
    n('vnet', 'azure_vnet', { addressSpace: '10.0.0.0/16' }),
    n('fw-subnet', 'azure_subnet', { addressPrefix: '10.0.1.0/24' }, 'vnet'), n('web-subnet', 'azure_subnet', { addressPrefix: '10.0.2.0/24' }, 'vnet'), n('app-subnet', 'azure_subnet', { addressPrefix: '10.0.4.0/23' }, 'vnet'),
    n('bastion-subnet', 'azure_subnet', { addressPrefix: '10.0.6.0/24' }, 'vnet'), n('vm-subnet', 'azure_subnet', { addressPrefix: '10.0.7.0/24' }, 'vnet'),
    n('fw', 'azure_firewall', { sku: 'Premium', zones: '1,2,3', dnsProxy: true }, 'fw-subnet'), n('rt', 'azure_route_table', {}, 'vnet'),
    n('agw', 'azure_app_gateway', { sku: 'WAF_v2', wafEnabled: true, zones: '1,2' }, 'web-subnet'), n('nsg-web', 'azure_nsg', { allowHttps: true }, 'vnet'), n('nsg-app', 'azure_nsg', { allowHttp: true, sourceCidr: '10.0.0.0/8' }, 'vnet'),
    n('nsg-bastion', 'azure_nsg', { allowHttps: true }, 'vnet'), n('bastion', 'azure_bastion', {}, 'bastion-subnet'),
    n('aca', 'azure_container_apps', { cpu: '1', minReplicas: 0, maxReplicas: 10, zoneRedundant: true, externalIngress: false }, 'app-subnet'),
    n('aca2', 'azure_container_apps', { image: 'myreg.azurecr.io/app:1' }),
    n('mon', 'azure_monitor'), n('eh', 'azure_event_hubs', { sku: 'Premium', capacity: 2, hubNames: 'events, audit', retentionDays: 30, zoneRedundant: true }),
    n('eg', 'azure_event_grid', { inputSchema: 'CloudEventSchemaV1_0' }), n('apim', 'azure_api_management', { sku: 'Premium', capacity: 2, zones: '1,2,3' }), n('apim2', 'azure_api_management', { sku: 'Consumption' }),
    n('func', 'azure_functions'),
    n('ctr', 'azure_container_service', { name: 'orders-api', allowedCidr: '10.0.0.0/8', imageTag: 'v2' }, 'app-subnet'),
  ];
  const e = (a: string, b: string) => ({ id: `${a}-${b}`, source: a, target: b });
  return { nodes, edges: [e('nsg-web', 'web-subnet'), e('nsg-app', 'app-subnet'), e('nsg-bastion', 'bastion-subnet'), e('rt', 'app-subnet'), e('rt', 'fw'), e('aca', 'mon'), e('apim', 'func')] };
}

let failed = 0;
rmSync(root, { recursive: true, force: true });
const all: Array<[string, () => { nodes: any[]; edges: any[] }]> = [
  ...cases.map(([name, req, fn]): [string, () => { nodes: any[]; edges: any[] }] => [name, () => { const ev = evaluateSpec(fn(req)); if (!ev.graph) throw new Error(`no graph (${ev.stage})`); return ev.graph; }]),
  ['kitchen-sink', kitchenSink],
];
for (const [name, build] of all) {
  let graph: { nodes: any[]; edges: any[] };
  try { graph = build(); } catch (e) { console.log(`${name}: ${(e as Error).message}`); failed++; continue; }
  const { resources, connections } = toDb(graph.nodes, graph.edges);
  const out = new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources, connections });
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const f of out.files) writeFileSync(join(dir, f.filename), f.content);
  const run = (args: string[]) => spawnSync(bin, args, { cwd: dir, encoding: 'utf8', env: { ...process.env, TF_IN_AUTOMATION: '1', TF_PLUGIN_CACHE_DIR: join(root, '.plugins') } });
  mkdirSync(join(root, '.plugins'), { recursive: true });
  const init = run(['init', '-backend=false', '-input=false', '-no-color']);
  if (init.status !== 0) { console.log(`${name}: INIT FAILED\n${(init.stderr || init.stdout).slice(0, 800)}`); failed++; continue; }
  const v = run(['validate', '-no-color']);
  if (v.status === 0) console.log(`${name}: valid  (${out.files.length} files, warnings: ${out.warnings.length})`);
  else { failed++; console.log(`${name}: INVALID\n${(v.stderr || v.stdout).slice(0, 2500)}`); }
}
process.exit(failed ? 1 : 0);
