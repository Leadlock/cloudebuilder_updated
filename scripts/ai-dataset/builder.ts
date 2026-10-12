/**
 * Small DSL for authoring architecture blueprints, plus the network "cores" every
 * pattern builds on. Blueprints are code, not prose, so every dataset example is
 * compiled and gated by the real engine before it is written.
 */
import type { ArchitectureSpec, SpecConnection, SpecResource } from '@/lib/ai/architectureSpec';

export type Cfg = SpecResource['config'];

export class SpecBuilder {
  resources: SpecResource[] = [];
  connections: SpecConnection[] = [];
  private ids = new Set<string>();

  add(id: string, type: string, label: string, parent?: string, config?: Cfg): string {
    if (this.ids.has(id)) throw new Error(`duplicate id ${id}`);
    this.ids.add(id);
    const r: SpecResource = { id, type, label };
    if (parent) r.parent = parent;
    if (config && Object.keys(config).length) r.config = config;
    this.resources.push(r);
    return id;
  }

  connect(from: string, to: string, label?: string): void {
    this.connections.push(label ? { from, to, label } : { from, to });
  }

  /** Remove a resource and every connection touching it (used by pattern variants). */
  build(name: string, summary: string): ArchitectureSpec {
    return { name, summary, resources: this.resources, connections: this.connections };
  }
}

// ─── Regions ──────────────────────────────────────────────────────────────────

export interface AwsRegion { id: string; label: string; octet: number }
export const AWS_REGIONS: AwsRegion[] = [
  { id: 'us-east-1', label: 'US East (N. Virginia)', octet: 10 },
  { id: 'us-west-2', label: 'US West (Oregon)', octet: 20 },
  { id: 'eu-west-1', label: 'Europe (Ireland)', octet: 30 },
  { id: 'eu-central-1', label: 'Europe (Frankfurt)', octet: 40 },
  { id: 'ap-south-1', label: 'Asia Pacific (Mumbai)', octet: 50 },
  { id: 'ap-southeast-1', label: 'Asia Pacific (Singapore)', octet: 60 },
];

export interface AzureRegion { id: string; label: string; octet: number }
/** Locations offered by the azure_resource_group definition. */
export const AZURE_REGIONS: AzureRegion[] = [
  { id: 'eastus', label: 'East US', octet: 110 },
  { id: 'westeurope', label: 'West Europe', octet: 120 },
  { id: 'southeastasia', label: 'Southeast Asia', octet: 130 },
  { id: 'westus2', label: 'West US 2', octet: 140 },
  { id: 'northeurope', label: 'North Europe', octet: 150 },
];

// ─── AWS network core ─────────────────────────────────────────────────────────

export interface AwsCoreOptions {
  region: AwsRegion;
  prefix?: string;
  /** Tiers to create. Subnets are always created in two AZs. */
  tiers?: { public?: boolean; app?: boolean; data?: boolean };
  nat?: boolean;
  boundaryLabel?: string;
  octet?: number;
}

export interface AwsCore {
  boundary: string; vpc: string; igw: string;
  pub: [string, string]; app: [string, string]; data: [string, string];
  nat: [string, string] | null;
  az: [string, string];
}

export function awsCore(b: SpecBuilder, o: AwsCoreOptions): AwsCore {
  const p = o.prefix ?? '';
  const oc = o.octet ?? o.region.octet;
  const az: [string, string] = [`${o.region.id}a`, `${o.region.id}b`];
  const tiers = { public: true, app: true, data: true, ...(o.tiers ?? {}) };
  const boundary = b.add(`${p}aws-cloud`, 'aws_cloud_boundary', o.boundaryLabel ?? `AWS — ${o.region.id}`);
  const vpc = b.add(`${p}vpc`, 'aws_vpc', 'Production VPC', boundary, { cidrBlock: `10.${oc}.0.0/16` });
  const igw = b.add(`${p}igw`, 'aws_igw', 'Internet Gateway', vpc);
  const mk = (tier: 'public' | 'app' | 'data', label: string, base: number): [string, string] => {
    if (!tiers[tier]) return ['', ''];
    return [0, 1].map((i) => b.add(`${p}${tier}-${i === 0 ? 'a' : 'b'}`, 'aws_subnet', `${label} Subnet ${i === 0 ? 'A' : 'B'}`, vpc, { cidrBlock: `10.${oc}.${base + i}.0/24`, availabilityZone: az[i] })) as [string, string];
  };
  const pub = mk('public', 'Public', 0);
  const app = mk('app', 'App', 10);
  const data = mk('data', 'Data', 20);
  let nat: [string, string] | null = null;
  if (o.nat && tiers.public) {
    nat = [b.add(`${p}nat-a`, 'aws_nat', 'NAT Gateway A', pub[0]), b.add(`${p}nat-b`, 'aws_nat', 'NAT Gateway B', pub[1])];
    b.connect(nat[0], igw); b.connect(nat[1], igw);
  }
  return { boundary, vpc, igw, pub, app, data, nat, az };
}

// ─── Azure network core ───────────────────────────────────────────────────────

export interface AzureCoreOptions {
  region: AzureRegion;
  prefix?: string;
  tiers?: { web?: boolean; app?: boolean; data?: boolean; bastion?: boolean };
  boundaryLabel?: string;
  octet?: number;
}

export interface AzureCore { boundary: string; rg: string; vnet: string; web: string; app: string; data: string; bastionSubnet: string; /** Second octet of the network's address space, for subnets added later. */ octet: number }

export function azureCore(b: SpecBuilder, o: AzureCoreOptions): AzureCore {
  const p = o.prefix ?? '';
  const oc = o.octet ?? o.region.octet;
  const tiers = { web: true, app: true, data: true, bastion: false, ...(o.tiers ?? {}) };
  const boundary = b.add(`${p}azure-cloud`, 'azure_cloud_boundary', o.boundaryLabel ?? `Azure — ${o.region.id}`, undefined, { region: o.region.id });
  // The layout engine treats resource groups and VNets as sibling network containers, so
  // blueprints place the VNet and regional services directly in the cloud boundary.
  const rg = boundary;
  const vnet = b.add(`${p}vnet`, 'azure_vnet', 'Production VNet', boundary, { addressSpace: `10.${oc}.0.0/16` });
  const web = tiers.web ? b.add(`${p}web-subnet`, 'azure_subnet', 'Web Subnet', vnet, { addressPrefix: `10.${oc}.0.0/24` }) : '';
  const app = tiers.app ? b.add(`${p}app-subnet`, 'azure_subnet', 'App Subnet', vnet, { addressPrefix: `10.${oc}.10.0/24` }) : '';
  const data = tiers.data ? b.add(`${p}data-subnet`, 'azure_subnet', 'Data Subnet', vnet, { addressPrefix: `10.${oc}.20.0/24` }) : '';
  const bastionSubnet = tiers.bastion ? b.add(`${p}bastion-subnet`, 'azure_subnet', 'Bastion Subnet', vnet, { addressPrefix: `10.${oc}.30.0/24` }) : '';
  return { boundary, rg, vnet, web, app, data, bastionSubnet, octet: oc };
}

/** Deterministic pick helper for option lattices. */
export function pick<T>(arr: T[], i: number): T { return arr[i % arr.length]; }
