/**
 * The "Container service" node on the canvas, and how it relates to the Container Templates form.
 *
 * The node keeps the settings every engine needs (cost, review, Terraform) as plain fields in its configuration, plus the whole form
 * state (encoded, see encodeContainerConfig) in `containerConfig` so "Open in Container Templates" gets back exactly what was added (secret values are never in it).
 * The plain fields win when they differ from the JSON, because they are what the properties panel edits.
 */
import { defaultConfig, STACKS, validate, withDeployTarget, type ContainerConfig, type DeployTarget } from './dockerTemplates';
import { parseStoredConfig, stripSecrets } from './stored';

export const CONTAINER_SERVICE_TYPE = 'aws_container_service';
export const AZURE_CONTAINER_SERVICE_TYPE = 'azure_container_service';
/** The Container Apps resource that already existed on the canvas; the form can fill it in and be filled from it. */
export const CONTAINER_APPS_TYPE = 'azure_container_apps';
/** Every canvas resource that the Container Templates form can create or edit. */
export const CONTAINER_NODE_TYPES: readonly string[] = [CONTAINER_SERVICE_TYPE, AZURE_CONTAINER_SERVICE_TYPE, CONTAINER_APPS_TYPE];

/** The canvas resource a deployment target maps to, or null when the target has no matching resource (a cluster is drawn with its own resource). */
export function nodeTypeForTarget(target: DeployTarget): string | null {
  return target === 'ec2' ? CONTAINER_SERVICE_TYPE : target === 'azure-vm' ? AZURE_CONTAINER_SERVICE_TYPE : target === 'container-apps' ? CONTAINER_APPS_TYPE : null;
}

/**
 * The form state is kept on the node as URL-safe base64, not JSON text: every string in a design is escaped before it reaches Terraform
 * (quotes, backslashes and "${" are rewritten), which would corrupt JSON and silently drop its environment variables. Base64 has none of those.
 */
export function encodeContainerConfig(c: ContainerConfig): string {
  let bin = '';
  new TextEncoder().encode(JSON.stringify(stripSecrets(c))).forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeContainerConfig(text: string): ContainerConfig | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return parseStoredConfig(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
  } catch { return null; }
}

export type NodeConfig = Record<string, unknown>;

const str = (v: unknown, d: string) => (typeof v === 'string' && v !== '' ? v : d);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** The node's settings as they are before the form is involved. */
export function defaultNodeConfig(): NodeConfig {
  const d = defaultConfig('node');
  return {
    name: 'my-container-service', stack: d.stack, port: d.port, healthPath: d.healthPath, runAsNonRoot: d.runAsNonRoot,
    memoryLimit: d.memoryLimit, cpuLimit: d.cpuLimit, restart: d.restart,
    instanceType: 't3.small', storageGb: 20, allowedCidr: '10.0.0.0/16', imageTag: 'v1', elasticIp: false, scanImage: true,
    containerConfig: '',
  };
}

/** The node from a form state (what "Add to architecture" creates). */
export function nodeConfigFromContainer(c: ContainerConfig): NodeConfig {
  return {
    name: c.appName, stack: c.stack, port: c.port, healthPath: c.healthPath, runAsNonRoot: c.runAsNonRoot,
    memoryLimit: c.memoryLimit, cpuLimit: c.cpuLimit, restart: c.restart,
    instanceType: c.ec2.instanceType, storageGb: c.ec2.volumeGb, allowedCidr: c.ec2.allowedCidr, imageTag: c.ec2.imageTag,
    elasticIp: c.ec2.elasticIp, scanImage: c.ec2.scanImage,
    containerConfig: encodeContainerConfig(c),
  };
}

/** The form state for a node: the stored JSON (if any and valid) with the node's plain fields applied on top. Always EC2-enabled. */
export function containerConfigFromNode(node: NodeConfig): ContainerConfig {
  const dn = defaultNodeConfig();
  const stored = typeof node['containerConfig'] === 'string' && node['containerConfig'] ? decodeContainerConfig(node['containerConfig'] as string) : null;
  const base = stored ?? defaultConfig(STACKS.find((s) => s === node['stack']) ?? 'node');
  const stack = STACKS.find((s) => s === node['stack']) ?? base.stack;
  const withStack = stack === base.stack ? base : { ...defaultConfig(stack), env: base.env };
  return withDeployTarget({
    ...withStack,
    appName: str(node['name'], withStack.appName),
    port: num(node['port'], withStack.port),
    healthPath: str(node['healthPath'], withStack.healthPath),
    runAsNonRoot: bool(node['runAsNonRoot'], withStack.runAsNonRoot),
    memoryLimit: str(node['memoryLimit'], withStack.memoryLimit),
    cpuLimit: str(node['cpuLimit'], withStack.cpuLimit),
    restart: (['no', 'always', 'unless-stopped', 'on-failure'] as const).find((r) => r === node['restart']) ?? withStack.restart,
    ec2: {
      ...withStack.ec2,
      enabled: true,
      instanceType: str(node['instanceType'], stored ? withStack.ec2.instanceType : str(dn['instanceType'], withStack.ec2.instanceType)),
      volumeGb: num(node['storageGb'], stored ? withStack.ec2.volumeGb : num(dn['storageGb'], withStack.ec2.volumeGb)),
      allowedCidr: str(node['allowedCidr'], stored ? withStack.ec2.allowedCidr : str(dn['allowedCidr'], withStack.ec2.allowedCidr)),
      imageTag: str(node['imageTag'], stored ? withStack.ec2.imageTag : str(dn['imageTag'], withStack.ec2.imageTag)),
      elasticIp: bool(node['elasticIp'], withStack.ec2.elasticIp),
      scanImage: bool(node['scanImage'], withStack.ec2.scanImage),
    },
  }, 'ec2'); // the canvas node is always the EC2 deployment, whatever target the form had
}

/** Why the node cannot produce a deployment yet (empty when it can). */
export function nodeProblems(node: NodeConfig): string[] {
  return validate(containerConfigFromNode(node));
}

// ─── Azure: Docker on a VM ───────────────────────────────────────────────────

/** The Azure VM node's settings as they are before the form is involved. Private by default, like the AWS node. */
export function defaultAzureNodeConfig(): NodeConfig {
  const d = defaultConfig('node');
  return {
    name: 'my-container-service', stack: d.stack, port: d.port, healthPath: d.healthPath, runAsNonRoot: d.runAsNonRoot,
    memoryLimit: d.memoryLimit, cpuLimit: d.cpuLimit, restart: d.restart,
    vmSize: 'Standard_B2s', diskGb: 30, allowedCidr: '10.0.0.0/16', imageTag: 'v1', scanImage: true,
    containerConfig: '',
  };
}

export function azureNodeConfigFromContainer(c: ContainerConfig): NodeConfig {
  return {
    name: c.appName, stack: c.stack, port: c.port, healthPath: c.healthPath, runAsNonRoot: c.runAsNonRoot,
    memoryLimit: c.memoryLimit, cpuLimit: c.cpuLimit, restart: c.restart,
    vmSize: c.azvm.size, diskGb: c.azvm.diskGb, allowedCidr: c.azvm.allowedCidr, imageTag: c.azvm.imageTag, scanImage: c.azvm.scanImage,
    containerConfig: encodeContainerConfig(c),
  };
}

function storedOrDefault(node: NodeConfig): { stored: ContainerConfig | null; base: ContainerConfig } {
  const stored = typeof node['containerConfig'] === 'string' && node['containerConfig'] ? decodeContainerConfig(node['containerConfig'] as string) : null;
  const stack = STACKS.find((x) => x === node['stack']);
  const first = stored ?? defaultConfig(stack ?? 'node');
  return { stored, base: stack && stack !== first.stack ? { ...defaultConfig(stack), env: first.env } : first };
}

/** The form state for an Azure VM node. Always the Azure VM deployment, whatever target the stored form had. */
export function containerConfigFromAzureNode(node: NodeConfig): ContainerConfig {
  const dn = defaultAzureNodeConfig();
  const { stored, base } = storedOrDefault(node);
  const pick = <T,>(key: string, fallbackStored: T, fallbackNode: T, ok: (v: unknown) => v is T): T => (ok(node[key]) ? node[key] as T : stored ? fallbackStored : fallbackNode);
  const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
  return withDeployTarget({
    ...base,
    appName: str(node['name'], base.appName),
    port: num(node['port'], base.port),
    healthPath: str(node['healthPath'], base.healthPath),
    runAsNonRoot: bool(node['runAsNonRoot'], base.runAsNonRoot),
    memoryLimit: str(node['memoryLimit'], base.memoryLimit),
    cpuLimit: str(node['cpuLimit'], base.cpuLimit),
    restart: (['no', 'always', 'unless-stopped', 'on-failure'] as const).find((r) => r === node['restart']) ?? base.restart,
    azvm: {
      ...base.azvm,
      enabled: true,
      size: pick('vmSize', base.azvm.size, dn['vmSize'] as string, isStr),
      diskGb: pick('diskGb', base.azvm.diskGb, dn['diskGb'] as number, isNum),
      allowedCidr: pick('allowedCidr', base.azvm.allowedCidr, dn['allowedCidr'] as string, isStr),
      imageTag: pick('imageTag', base.azvm.imageTag, dn['imageTag'] as string, isStr),
      scanImage: pick('scanImage', base.azvm.scanImage, dn['scanImage'] as boolean, isBool),
    },
  }, 'azure-vm');
}

// ─── Azure Container Apps (the resource that already exists) ─────────────────

/** Settings for a Container Apps node from the form. The image stays what it was: it is a registry address only a deploy can know. */
export function acaNodeConfigFromContainer(c: ContainerConfig, existing: NodeConfig = {}): NodeConfig {
  return {
    ...existing,
    name: c.appName, cpu: String(c.aca.cpu), minReplicas: c.aca.minReplicas, maxReplicas: c.aca.maxReplicas,
    targetPort: c.port, externalIngress: c.aca.externalIngress,
    containerConfig: encodeContainerConfig(c),
  };
}

/** The form state for a Container Apps node: the stored form with the node's own settings on top. Always the Container Apps deployment. */
export function containerConfigFromAcaNode(node: NodeConfig): ContainerConfig {
  const { base } = storedOrDefault(node);
  const cpu = Number(node['cpu']);
  return withDeployTarget({
    ...base,
    appName: str(node['name'], base.appName),
    port: num(node['targetPort'], base.port),
    aca: {
      ...base.aca,
      enabled: true,
      cpu: Number.isFinite(cpu) && cpu > 0 ? cpu : base.aca.cpu,
      minReplicas: num(node['minReplicas'], base.aca.minReplicas),
      maxReplicas: num(node['maxReplicas'], base.aca.maxReplicas),
      externalIngress: bool(node['externalIngress'], base.aca.externalIngress),
    },
  }, 'container-apps');
}

// ─── by resource type ────────────────────────────────────────────────────────

export function containerConfigForNode(resourceType: string, node: NodeConfig): ContainerConfig {
  return resourceType === AZURE_CONTAINER_SERVICE_TYPE ? containerConfigFromAzureNode(node) : resourceType === CONTAINER_APPS_TYPE ? containerConfigFromAcaNode(node) : containerConfigFromNode(node);
}

export function nodeConfigFromContainerFor(resourceType: string, c: ContainerConfig, existing: NodeConfig = {}): NodeConfig {
  return resourceType === AZURE_CONTAINER_SERVICE_TYPE ? azureNodeConfigFromContainer(c) : resourceType === CONTAINER_APPS_TYPE ? acaNodeConfigFromContainer(c, existing) : nodeConfigFromContainer(c);
}

export function nodeProblemsFor(resourceType: string, node: NodeConfig): string[] {
  return validate(containerConfigForNode(resourceType, node));
}
