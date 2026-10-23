/**
 * What the scanner looks at: the files CloudBuilder generates, for every deployment target and a spread of canvas designs, written the way a customer receives them
 * (and, for a release it runs itself, the way it runs them). Each case is a folder of files.
 */
import { defaultConfig, generateContainerFiles, withDeployTarget, type ContainerConfig } from '../../lib/engines/containers/dockerTemplates';
import { defaultProject, generateProjectFiles, LAYERS, type Layer, type StackProject } from '../../lib/engines/containers/stackProject';
import { TerraformGenerator } from '../../lib/engines/terraform/TerraformGenerator';
import { evaluateSpec } from '../../lib/ai/architectureSpec';
import { awsThreeTier, awsEcs, awsEks, awsServerless } from '../ai-dataset/awsPatterns';
import { awsQueueWorker, awsMicroservices, azureGatewayAppService } from '../ai-dataset/extraPatterns';
import { awsStaticSite, awsEventDriven, awsLambdaPrivateApi, azureStaticSite, azureFunctionsPrivateApi } from '../ai-dataset/morePatterns';
import { azureThreeTier, azureAppService, azureServerless, azureAks } from '../ai-dataset/azurePatterns';
import type { Requirements } from '../ai-dataset/requirements';
import type { DbArchitectureConnection, DbArchitectureResource } from '../../lib/repositories/architectureRepository';

export interface ScanCase { name: string; group: 'container-project' | 'container-service' | 'design'; files: Array<{ path: string; content: string }> }

const project = (on: Layer[], target: StackProject['deploy']['target'], edit: (p: StackProject) => void = () => {}): StackProject => {
  const p = defaultProject();
  p.name = 'shop';
  for (const l of LAYERS) p.layers[l].enabled = on.includes(l);
  p.layers.backend.config.env = [{ key: 'JWT_SECRET', value: '', secret: true }];
  p.deploy.target = target;
  p.deploy.k8s.registry = 'ghcr.io/acme';
  edit(p);
  return p;
};

function containerProjects(): ScanCase[] {
  const out: ScanCase[] = [];
  const add = (name: string, p: StackProject, forRelease = false) => {
    const r = generateProjectFiles(p, { forRelease });
    if (!r.ok) throw new Error(`${name}: ${r.errors.join('; ')}`);
    out.push({ name, group: 'container-project', files: r.files.map((f) => ({ path: f.path, content: f.content })) });
  };
  const apps: Layer[] = ['frontend', 'backend', 'api'];
  const withDb: Layer[] = ['frontend', 'backend', 'api', 'database'];
  add('project-ec2', project(withDb, 'ec2'));
  add('project-ec2-release', project(withDb, 'ec2'), true);
  add('project-ecs', project(apps, 'ecs'));
  add('project-ecs-release', project(apps, 'ecs'), true);
  add('project-ecs-https', project(apps, 'ecs', (p) => { p.deploy.ecs.certificateArn = 'arn:aws:acm:us-east-1:123456789012:certificate/abc-123'; p.deploy.ecs.allowedCidr = '203.0.113.0/24'; }));
  add('project-azure-vm', project(withDb, 'azure-vm'));
  add('project-azure-vm-release', project(withDb, 'azure-vm'), true);
  add('project-container-apps', project(apps, 'container-apps'));
  add('project-container-apps-release', project(apps, 'container-apps'), true);
  add('project-aks', project(apps, 'aks'));
  add('project-kubernetes', project(apps, 'kubernetes'));
  return out;
}

function containerServices(): ScanCase[] {
  const out: ScanCase[] = [];
  for (const target of ['ec2', 'ecs', 'azure-vm', 'container-apps', 'aks', 'kubernetes'] as const) {
    const c: ContainerConfig = withDeployTarget({ ...defaultConfig('node'), appName: 'orders-api', port: 3000, healthPath: '/health', env: [{ key: 'LOG_LEVEL', value: 'info' }, { key: 'API_TOKEN', value: '', secret: true }] }, target);
    c.k8s.image = 'ghcr.io/acme/orders-api:1.0';
    const r = generateContainerFiles(c);
    if (!r.ok) throw new Error(`service-${target}: ${r.errors.join('; ')}`);
    out.push({ name: `service-${target}`, group: 'container-service', files: r.files.map((f) => ({ path: f.path, content: f.content })) });
  }
  return out;
}

const awsBase: Requirements = { provider: 'aws', pattern: '', region: 'us-east-1', scale: 'medium', db: 'postgres', cache: true, cdn: true, regulated: false, queue: true, app: 'storefront' };
const azureBase: Requirements = { ...awsBase, provider: 'azure', region: 'westeurope' };

const DESIGNS: Array<[string, Requirements, (r: Requirements) => unknown]> = [
  ['aws-three-tier', awsBase, awsThreeTier], ['aws-three-tier-regulated', { ...awsBase, regulated: true }, awsThreeTier], ['aws-ecs', awsBase, awsEcs], ['aws-eks', awsBase, awsEks],
  ['aws-serverless', { ...awsBase, db: 'nosql', cache: false }, awsServerless], ['aws-queue-worker', awsBase, awsQueueWorker], ['aws-microservices', awsBase, awsMicroservices],
  ['aws-static-site', { ...awsBase, db: 'none', cache: false, queue: false }, awsStaticSite], ['aws-event-driven', awsBase, awsEventDriven], ['aws-lambda-private-api', awsBase, awsLambdaPrivateApi],
  ['azure-three-tier', azureBase, azureThreeTier], ['azure-three-tier-regulated', { ...azureBase, regulated: true }, azureThreeTier], ['azure-app-service', azureBase, azureAppService],
  ['azure-serverless', { ...azureBase, db: 'nosql', cache: false }, azureServerless], ['azure-aks', azureBase, azureAks], ['azure-gateway-app-service', { ...azureBase, cdn: false, db: 'mysql' }, azureGatewayAppService],
  ['azure-static-site', { ...azureBase, db: 'none', cache: false, queue: false }, azureStaticSite], ['azure-functions-private', { ...azureBase, db: 'sql', cache: false, cdn: false, queue: false }, azureFunctionsPrivateApi],
];

function toDb(nodes: any[], edges: any[]): { resources: DbArchitectureResource[]; connections: DbArchitectureConnection[] } {   // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    resources: nodes.map((n) => ({ id: n.id, resourceType: n.resourceType, provider: n.provider, label: n.label, positionX: 0, positionY: 0, configJson: JSON.stringify(n.config ?? {}), region: n.region ?? null, groupId: n.groupId ?? null, architectureId: 'a' } as DbArchitectureResource)),
    connections: edges.map((e) => ({ id: e.id, label: null, edgeType: null, sourceId: e.source, targetId: e.target, architectureId: 'a' } as DbArchitectureConnection)),
  };
}

function designs(): ScanCase[] {
  return DESIGNS.map(([name, req, build]) => {
    const ev = evaluateSpec(build(req));
    if (!ev.graph) throw new Error(`${name}: no graph`);
    const { resources, connections } = toDb(ev.graph.nodes, ev.graph.edges);
    const gen = new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources, connections });
    return { name, group: 'design' as const, files: gen.files.map((f) => ({ path: f.filename, content: f.content })) };
  });
}

export function scanCases(): ScanCase[] { return [...containerProjects(), ...containerServices(), ...designs()]; }
