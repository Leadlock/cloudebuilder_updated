/**
 * A project made of up to four services at once: a Frontend, a Backend, an API and a Database. Each is optional and independent: choosing one never
 * changes another. One project produces one set of files: a folder per service (its Dockerfile, nginx config and sample app) and a single
 * docker-compose.yml, .env.example and README for all of them.
 *
 * With exactly one service switched on, the result is exactly what the single-service generator (dockerTemplates.ts) produces, deployment files
 * included. With two or more the services run together with Docker Compose; the services are connected like this:
 *   - the Frontend reaches the API (or the Backend when there is no API): a static site through /api/ in its own nginx, other frontends through API_URL;
 *   - the API and the Backend get the Database's address and a shared password (DATABASE_URL and friends);
 *   - the API reaches the Backend through BACKEND_URL when both exist.
 * Deploying a combined project to a server is not part of this module.
 */
import {
  composeServiceBlock, defaultConfig, generateContainerFiles, nginxConf, usesExistingImage, validate, withDeployTarget,
  type ContainerConfig, type GeneratedFile, type GenerateResult, type ServiceBlockOptions,
} from './dockerTemplates';
import { databaseOf, dbAppEnv } from './databases';
import { databaseServiceBlock } from './databaseFiles';
import { currentOption, pickStackOption } from './stackOptions';
import { yq } from './shared';
import {
  generateStackEc2Files, stackEc2Defaults, stackEc2Warnings, estimateStackEc2Cost, validateStackEc2,
} from './stackEc2Deploy';
import {
  generateStackAzureFiles, stackAzureDefaults, stackAzureWarnings, estimateStackAzureCost, validateStackAzure,
} from './stackAzureDeploy';
import type { StackDeployBase } from './stackEc2Deploy';
import type { Ec2Config, Ec2Cost } from './ec2Deploy';
import type { AzVmConfig } from './azureVmDeploy';
import type { ContainerFinding } from './checks';

export type Layer = 'frontend' | 'backend' | 'api' | 'database';
/** The order the layers are shown in. */
export const LAYERS: readonly Layer[] = ['frontend', 'backend', 'api', 'database'];
export const LAYER_LABEL: Record<Layer, string> = { frontend: 'Frontend', backend: 'Backend', api: 'API', database: 'Database' };

export interface LayerState { enabled: boolean; config: ContainerConfig }
/** Where a project of several services is deployed. Docker Compose on your own machine is always possible; EC2 or an Azure VM runs the whole compose file on one server. */
export type ProjectTarget = 'none' | 'ec2' | 'azure-vm';
export interface ProjectDeploy { target: ProjectTarget; ec2: Ec2Config; azvm: AzVmConfig }
export interface StackProject { name: string; layers: Record<Layer, LayerState>; deploy: ProjectDeploy }

export const defaultProjectDeploy = (): ProjectDeploy => ({ target: 'none', ec2: stackEc2Defaults(), azvm: stackAzureDefaults() });

/** What each layer starts as when it is switched on. */
const DEFAULT_OPTION: Record<Layer, string> = { frontend: 'spa', backend: 'node', api: 'fastapi', database: 'db-postgres' };

export const layerDefault = (layer: Layer): ContainerConfig => pickStackOption(defaultConfig('node'), DEFAULT_OPTION[layer]);

/** A new project: the Backend (Node.js) switched on, as the form always started, and the other three ready but off. */
export function defaultProject(): StackProject {
  return {
    name: 'my-app',
    deploy: defaultProjectDeploy(),
    layers: Object.fromEntries(LAYERS.map((l) => [l, { enabled: l === 'backend', config: layerDefault(l) }])) as Record<Layer, LayerState>,
  };
}

export const enabledLayers = (p: StackProject): Layer[] => LAYERS.filter((l) => p.layers[l].enabled);

/** The layer a single-service configuration belongs to (a FastAPI service is an API, a static site a Frontend, a database a Database). */
export function layerOf(c: ContainerConfig): Layer {
  const o = currentOption(c);
  return o?.category === 'frontend' ? 'frontend' : o?.category === 'database' ? 'database' : 'backend';
}

/** A project of one service: that configuration in its layer, the others off. */
export function projectFromConfig(c: ContainerConfig, base: StackProject = defaultProject()): StackProject {
  const layer = layerOf(c);
  return {
    name: base.name,
    deploy: base.deploy,
    layers: Object.fromEntries(LAYERS.map((l) => [l, l === layer ? { enabled: true, config: c } : { enabled: false, config: base.layers[l].config }])) as Record<Layer, LayerState>,
  };
}

/** The same change to every layer's configuration, switched on or not (for example the region the project is in). */
export function mapLayerConfigs(p: StackProject, fn: (c: ContainerConfig) => ContainerConfig): StackProject {
  return { ...p, layers: Object.fromEntries(LAYERS.map((l) => [l, { ...p.layers[l], config: fn(p.layers[l].config) }])) as Record<Layer, LayerState> };
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;

/** A layer's configuration as it is used inside a combined project: its own name, run by compose, with no deployment, proxy or add-on services of its own. */
function inProject(p: StackProject, layer: Layer): ContainerConfig {
  return {
    ...withDeployTarget(p.layers[layer].config, 'none'),
    appName: `${p.name}-${layer}`, proxy: false, postgres: false, redis: false, mysql: false, mongodb: false, rabbitmq: false,
  };
}

/** Compose publishes a port to this machine; two services that listen on the same one need different ports here (not inside their containers). */
function hostPorts(configs: Partial<Record<Layer, ContainerConfig>>): Partial<Record<Layer, number>> {
  const used = new Set<number>();
  const out: Partial<Record<Layer, number>> = {};
  for (const layer of ['frontend', 'api', 'backend', 'database'] as const) {
    const c = configs[layer];
    if (!c) continue;
    let port = c.port;
    while (used.has(port)) port++;
    used.add(port);
    out[layer] = port;
  }
  return out;
}

/** Whether another service can wait for this one to report healthy: a database and every image CloudCraft builds have a health check. */
const hasHealthcheck = (c: ContainerConfig): boolean => !!databaseOf(c) || !usesExistingImage(c);

const line = (key: string, value: string) => `${key}: ${yq(value)}`;

export function validateProject(p: StackProject): string[] {
  const out: string[] = [];
  const on = enabledLayers(p);
  if (!NAME.test(p.name)) out.push('Project name: lowercase letters, digits, "-" and "_" only, up to 41 characters.');
  if (on.length === 0) out.push('Choose at least one service.');
  if (on.length > 1) for (const l of on) for (const e of validate(inProject(p, l))) out.push(`${LAYER_LABEL[l]}: ${e}`);
  return out;
}

export interface ProjectLayout {
  /** The service each part is reached on. */
  frontendUpstream: 'api' | 'backend' | null;
  hostPort: Partial<Record<Layer, number>>;
}

/** Everything the files need to agree on: which service the frontend talks to, and the ports on this machine. */
export function projectLayout(p: StackProject): ProjectLayout {
  const on = enabledLayers(p);
  const configs = Object.fromEntries(on.map((l) => [l, inProject(p, l)])) as Partial<Record<Layer, ContainerConfig>>;
  return { frontendUpstream: on.includes('api') ? 'api' : on.includes('backend') ? 'backend' : null, hostPort: hostPorts(configs) };
}

export function generateProjectFiles(p: StackProject): GenerateResult {
  const on = enabledLayers(p);
  if (on.length === 1) {
    // One service: exactly what a single configuration produces, with its own deployment.
    const only = on[0]!;
    return generateContainerFiles(p.layers[only].config);
  }
  const errors = validateProject(p);
  if (errors.length > 0) return { ok: false, errors };

  const layout = projectLayout(p);
  const cfg = Object.fromEntries(on.map((l) => [l, inProject(p, l)])) as Record<Layer, ContainerConfig>;
  const db = on.includes('database') ? cfg.database : null;
  const dbLines = db ? dbAppEnv(db, 'database').map((e) => line(e.key, e.value)) : [];
  const upstreamLayer = layout.frontendUpstream;

  const files: GeneratedFile[] = [];
  const warnings: string[] = [];
  const findings: ContainerFinding[] = [];

  // The files each service needs on its own (Dockerfile, nginx config, sample app) go in its folder; the compose file, .env.example and README are written once, below.
  for (const layer of on) {
    const r = generateContainerFiles(cfg[layer]);
    if (!r.ok) return { ok: false, errors: r.errors.map((e) => `${LAYER_LABEL[layer]}: ${e}`) };
    for (const f of r.files) {
      if (['docker-compose.yml', '.env.example', 'README.md'].includes(f.path)) continue;
      let content = f.content;
      if (layer === 'frontend' && f.path === 'nginx.conf' && upstreamLayer) {
        content = nginxConf(cfg.frontend, { host: upstreamLayer, port: cfg[upstreamLayer].port });
      }
      files.push({ ...f, path: `${layer}/${f.path}` });
      files[files.length - 1]!.content = content;
    }
    warnings.push(...r.warnings.map((w) => `${LAYER_LABEL[layer]}: ${w}`));
    findings.push(...r.findings.map((f) => ({ ...f, title: `${LAYER_LABEL[layer]}: ${f.title}`, file: f.file ? `${layer}/${f.file}` : f.file })));
  }

  if (on.includes('frontend') && !upstreamLayer) warnings.push('The Frontend is not connected to anything: add an API or a Backend for it to talk to.');
  if (db && !on.includes('api') && !on.includes('backend')) warnings.push('Nothing uses the Database: add an API or a Backend, which are given its address.');

  const entry = entryLayer(on);
  const compose = composeFor(p, on, cfg, layout, { mode: 'local', entry, db, dbLines, upstreamLayer });

  files.unshift(
    { path: 'docker-compose.yml', content: compose },
    { path: '.env.example', content: projectEnvExample(p, on, cfg) },
    { path: 'README.md', content: projectReadme(p, on, cfg, layout) },
  );
  let cost: Ec2Cost | undefined;
  if (p.deploy.target !== 'none') {
    const base = deployBase(p, on, cfg, layout, entry, composeFor(p, on, cfg, layout, { mode: 'deploy', entry, db, dbLines, upstreamLayer }));
    if (p.deploy.target === 'ec2') {
      const spec = { ...base, ec2: p.deploy.ec2 };
      const errors = validateStackEc2(spec);
      if (errors.length > 0) return { ok: false, errors };
      files.push(...generateStackEc2Files(spec));
      warnings.push(...stackEc2Warnings(spec));
      cost = estimateStackEc2Cost(spec);
    } else {
      const spec = { ...base, azvm: p.deploy.azvm };
      const errors = validateStackAzure(spec);
      if (errors.length > 0) return { ok: false, errors };
      files.push(...generateStackAzureFiles(spec));
      warnings.push(...stackAzureWarnings(spec));
      cost = estimateStackAzureCost(spec);
    }
  }
  return { ok: true, files, warnings, findings, ...(cost ? { cost } : {}) };
}

/** The service that is open to the network: the Frontend, else the API, else the Backend. */
const entryLayer = (on: Layer[]): Layer => (on.includes('frontend') ? 'frontend' : on.includes('api') ? 'api' : 'backend');

interface ComposeInput { mode: 'local' | 'deploy'; entry: Layer; db: ContainerConfig | null; dbLines: string[]; upstreamLayer: 'api' | 'backend' | null }

/**
 * The project's compose file. Locally every service is built from its folder and only the Frontend is published to the network. On a server
 * every built service runs from the image repository (\${REGISTRY} and \${TAG} are filled in by the server), and the one public service is the Frontend,
 * else the API, else the Backend.
 */
function composeFor(p: StackProject, on: Layer[], cfg: Record<Layer, ContainerConfig>, layout: ProjectLayout, i: ComposeInput): string {
  const { db, dbLines, upstreamLayer } = i;
  const deploy = i.mode === 'deploy';
  const dep = (layer: Layer) => ({ name: layer, condition: (hasHealthcheck(cfg[layer]) ? 'service_healthy' : 'service_started') as 'service_healthy' | 'service_started' });
  const image = (layer: Layer) => (deploy && !usesExistingImage(cfg[layer]) ? { image: `\${REGISTRY:?set REGISTRY}/${p.name}-${layer}:\${TAG:?set TAG}` } : {});
  const exposure = (layer: Layer): 'public' | 'local' => (deploy ? (layer === i.entry ? 'public' : 'local') : (layer === 'frontend' ? 'public' : 'local'));
  const block = (layer: Layer, o: Omit<ServiceBlockOptions, 'key' | 'context' | 'hostPort' | 'ports'>) =>
    composeServiceBlock(cfg[layer], { key: layer, context: `./${layer}`, hostPort: layout.hostPort[layer], ports: exposure(layer), ...image(layer), ...o });

  const services: string[] = [];
  if (db) services.push(databaseServiceBlock(db, { key: 'database', hostPort: layout.hostPort.database }));
  if (on.includes('backend')) services.push(block('backend', { extraEnv: dbLines, deps: db ? [dep('database')] : [] }));
  if (on.includes('api')) {
    services.push(block('api', {
      extraEnv: [...dbLines, ...(on.includes('backend') ? [line('BACKEND_URL', `http://backend:${cfg.backend.port}`)] : [])],
      deps: [...(db ? [dep('database')] : []), ...(on.includes('backend') ? [dep('backend')] : [])],
    }));
  }
  if (on.includes('frontend')) {
    const staticSite = cfg.frontend.stack === 'static' && !usesExistingImage(cfg.frontend);
    services.push(block('frontend', {
      // A static site reaches the API through /api/ in its own nginx; any other frontend is told where it is.
      extraEnv: upstreamLayer && !staticSite ? [line('API_URL', `http://${upstreamLayer}:${cfg[upstreamLayer].port}`)] : [],
      deps: upstreamLayer ? [dep(upstreamLayer)] : [],
    }));
  }
  return `${deploy ? '# The compose file the server runs (CloudCraft EC2 deployment). The server fills in REGISTRY and TAG.' : '# Start everything with: docker compose up --build'}
services:
${services.join('')}${db ? `\nvolumes:\n  database-data:\n` : ''}`;
}

/** Every secret of every service, once each, in the order the services are listed. */
export function projectSecrets(on: Layer[], cfg: Record<Layer, ContainerConfig>): string[] {
  return [...new Set(on.flatMap((l) => cfg[l].env.filter((v) => v.secret).map((v) => v.key)))];
}

function deployBase(p: StackProject, on: Layer[], cfg: Record<Layer, ContainerConfig>, layout: ProjectLayout, entry: Layer, compose: string): StackDeployBase {
  const dbConfig = on.includes('database') ? cfg.database : null;
  return {
    name: p.name,
    built: on.filter((l) => l !== 'database' && !usesExistingImage(cfg[l])),
    entry: { service: LAYER_LABEL[entry], port: layout.hostPort[entry]!, path: cfg[entry].healthPath || '/' },
    secrets: projectSecrets(on, cfg),
    generated: dbConfig ? dbConfig.env.filter((v) => v.secret).map((v) => v.key) : [],
    databaseLabel: dbConfig ? (databaseOf(dbConfig)?.label ?? 'Database') : null,
    compose,
  };
}

/** The variables the person has to set: every secret of every service, once each. */
function projectEnvExample(p: StackProject, on: Layer[], cfg: Record<Layer, ContainerConfig>): string {
  const lines = ['# Copy to .env and fill in. Never commit .env.', '# Use long random values without spaces or special characters: the database password is also put inside connection URLs.'];
  const seen = new Set<string>();
  for (const layer of on) {
    const keys = cfg[layer].env.filter((v) => v.secret && !seen.has(v.key)).map((v) => v.key);
    if (keys.length === 0) continue;
    lines.push('', `# ${LAYER_LABEL[layer]}`);
    for (const k of keys) { seen.add(k); lines.push(`${k}=`); }
  }
  void p;
  return `${lines.join('\n')}\n`;
}

function projectReadme(p: StackProject, on: Layer[], cfg: Record<Layer, ContainerConfig>, layout: ProjectLayout): string {
  const what = (l: Layer) => (databaseOf(cfg[l])?.label ?? currentOption(cfg[l])?.label ?? cfg[l].stack);
  const url = (l: Layer) => (l === 'database' ? `localhost:${layout.hostPort[l]} (this machine only)` : l === 'frontend' ? `http://localhost:${layout.hostPort[l]}` : `http://localhost:${layout.hostPort[l]} (this machine only)`);
  const secrets = [...new Set(on.flatMap((l) => cfg[l].env.filter((v) => v.secret).map((v) => v.key)))];
  const up = layout.frontendUpstream;
  const staticSite = on.includes('frontend') && cfg.frontend.stack === 'static' && !usesExistingImage(cfg.frontend);
  return `# ${p.name}

Generated by CloudCraft Container Templates: ${on.length} services that run together.

## Run everything

\`\`\`bash
cp .env.example .env   # fill in ${secrets.length ? secrets.join(', ') : 'nothing: no service needs a secret'}
docker compose up --build
\`\`\`

| Service | What it is | Folder | Address |
|---|---|---|---|
${on.map((l) => `| ${l} | ${LAYER_LABEL[l]}: ${what(l)} | ${l === 'database' ? '(official image)' : `\`${l}/\``} | ${url(l)} |`).join('\n')}

Put your own code in each service's folder (the same layout as a monorepo); each folder is built with its own Dockerfile.

## How they are connected

${[
  up && on.includes('frontend') ? (staticSite ? `- The Frontend sends requests to \`/api/\` on its own address to the ${LAYER_LABEL[up]} (nginx passes them on to \`${up}:${cfg[up].port}\`).` : `- The Frontend is given \`API_URL=http://${up}:${cfg[up].port}\` for the ${LAYER_LABEL[up]}.`) : '',
  on.includes('database') && (on.includes('api') || on.includes('backend')) ? `- ${[on.includes('api') ? 'The API' : '', on.includes('backend') ? 'The Backend' : ''].filter(Boolean).join(' and ')} get the Database's address as ${dbAppEnv(cfg.database, 'database').map((e) => `\`${e.key}\``).join(', ')}. The password comes from \`.env\`.` : '',
  on.includes('api') && on.includes('backend') ? `- The API reaches the Backend at \`BACKEND_URL=http://backend:${cfg.backend.port}\`.` : '',
].filter(Boolean).join('\n') || '- The services do not talk to each other.'}
- Each service starts when the ones it needs report healthy.
- Only the Frontend is open to the network. The other services and the Database are published on this machine only.
${on.includes('database') ? `
## The database

The data is in the Docker volume \`database-data\`. It survives \`docker compose down\`; \`docker compose down -v\` deletes it.
` : ''}
## Deploying

${p.deploy.target === 'ec2' ? `All the services run on one EC2 server: see \`ec2/README.md\`, or just run \`bash deploy.sh\`.` : p.deploy.target === 'azure-vm' ? `All the services run on one Azure VM: see \`azvm/README.md\`, or just run \`bash deploy.sh\`.` : 'Run it on any machine with Docker Compose, or choose "AWS EC2" or "Azure VM" (one server runs everything) for this project in CloudCraft to also get \`deploy.sh\`, \`destroy.sh\` and the Terraform that run all of it on one server.'}
`;
}
