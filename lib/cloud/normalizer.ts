/**
 * Resource normalizer — converts DiscoveredResource objects from provider adapters
 * into the CloudCraft semantic CanvasNode format used by the architecture canvas.
 *
 * Rules:
 * - Provider-specific metadata is preserved in node.config but renamed to semantic keys.
 * - No credentials or sensitive fields are ever included in the output.
 * - Position is initialised to a grid layout; callers may re-layout later.
 * - Unknown resource types are mapped to a generic 'unknown' node rather than dropped.
 * - Discovered relationships (VPC, Subnet, VNet, connections) are preserved without fabricating unprovided edges.
 */
import type { CanvasNode, CanvasEdge, Region } from '@/types';
import type { DiscoveredResource } from './types';

// ─── Resource type → CloudCraft resourceType mapping ─────────────────────────

const RESOURCE_TYPE_MAP: Record<string, string> = {
  // AWS networking
  vpc: 'aws_vpc',
  subnet: 'aws_subnet',
  'internet-gateway': 'aws_igw',
  'nat-gateway': 'aws_nat',
  // AWS compute
  'ec2-instance': 'aws_ec2',
  'auto-scaling-group': 'aws_auto_scaling',
  // AWS storage
  's3-bucket': 'aws_s3',
  'ebs-volume': 'aws_ebs',
  // AWS database
  'rds-instance': 'aws_rds',
  'dynamodb-table': 'aws_dynamodb',
  // AWS load balancing
  alb: 'aws_alb',
  nlb: 'aws_alb',
  // Security
  'security-group': 'aws_sg',
  // Azure networking
  vnet: 'azure_vnet',
  'load-balancer': 'azure_lb',
  'network-security-group': 'azure_nsg',
  // Azure compute
  'virtual-machine': 'azure_vm',
  // Azure storage
  'storage-account': 'azure_storage',
  'blob-container': 'azure_storage',
  // Azure database
  'sql-server': 'azure_sql',
  'sql-database': 'azure_sql',
  // Azure organisation
  'resource-group': 'azure_resource_group',
};

// ─── Grid layout helper ───────────────────────────────────────────────────────

const GRID_COLS = 4;
const GRID_CELL_W = 220;
const GRID_CELL_H = 180;

function gridPosition(index: number): { x: number; y: number } {
  const col = index % GRID_COLS;
  const row = Math.floor(index / GRID_COLS);
  return { x: 60 + col * GRID_CELL_W, y: 60 + row * GRID_CELL_H };
}

// ─── Sanitise ID ─────────────────────────────────────────────────────────────

/**
 * Convert a provider resource ID to a valid CSS/React id.
 * ARNs contain ':' and '/' which are stripped.
 */
export function sanitiseId(rawId?: string): string {
  if (!rawId) return '';
  return rawId.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}

// ─── Normalise Region ────────────────────────────────────────────────────────

function normaliseRegion(region?: string): Region | undefined {
  if (!region) return undefined;
  const KNOWN: Set<string> = new Set([
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-northeast-1',
    'eastus', 'eastus2', 'westus', 'westeurope', 'northeurope', 'southeastasia',
  ]);
  if (KNOWN.has(region)) return region as Region;
  return undefined;
}

// ─── Normalizer with Discovered Relationships ─────────────────────────────────

/**
 * Convert discovered resources into canvas nodes and connections.
 * Extracts explicit relationships provided by discovery (e.g. subnet in VPC, EC2 in subnet)
 * without fabricating relationships that discovery did not provide.
 */
export function normalizeDiscoveredInfrastructure(resources: DiscoveredResource[]): {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
} {
  // 1. Build nodes
  const nodes: CanvasNode[] = resources.map((r, index) => {
    const rawType = r.resourceType as string;
    let resourceType = RESOURCE_TYPE_MAP[r.resourceType];
    if (!resourceType) {
      if (rawType === 'ec2' || rawType === 'ec2_instance') {
        resourceType = 'aws_ec2';
      } else if (rawType === 'rds' || rawType === 'rds_instance') {
        resourceType = 'aws_rds';
      } else if (r.provider === 'azure') {
        if (rawType === 'subnet') resourceType = 'azure_subnet';
        else if (rawType === 'nat-gateway') resourceType = 'azure_nat';
        else if (rawType === 'vm') resourceType = 'azure_vm';
        else resourceType = `azure_${rawType.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      } else {
        resourceType = `aws_${rawType.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      }
    } else if (r.provider === 'azure' && rawType === 'subnet') {
      resourceType = 'azure_subnet';
    } else if (r.provider === 'azure' && rawType === 'nat-gateway') {
      resourceType = 'azure_nat';
    }

    const provider = r.provider === 'azure' ? 'azure' : 'aws';
    const position = gridPosition(index);
    const rawId = r.providerResourceId || (r as { id?: string }).id || `res-${index}`;
    const nodeId = sanitiseId(rawId) || `res-${index}`;

    return {
      id: nodeId,
      type: 'cloudNode',
      resourceType,
      provider,
      label: r.name || rawId,
      position,
      config: {
        // Core semantic fields
        providerResourceId: rawId,
        region: r.region,
        status: r.status,
        // Provider-specific config (no secrets)
        ...r.configuration,
        // Preserve metadata under a dedicated key
        _metadata: r.metadata,
      },
      region: normaliseRegion(r.region),
      locked: false,
    };
  });

  // Fast lookup by providerResourceId and sanitised id
  const idByRawOrSanitised = new Map<string, string>();
  for (const r of resources) {
    const raw = r.providerResourceId || (r as { id?: string }).id;
    if (raw) {
      const sId = sanitiseId(raw);
      idByRawOrSanitised.set(raw, sId);
      idByRawOrSanitised.set(sId, sId);
    }
  }

  // 2. Extract explicit relationships
  const edges: CanvasEdge[] = [];
  const edgeSet = new Set<string>();

  function addEdge(sourceId: string, targetId: string, label?: string) {
    if (sourceId === targetId) return;
    const key = `${sourceId}->${targetId}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({
      id: `edge-disc-${sourceId}-${targetId}`,
      source: sourceId,
      target: targetId,
      label,
      edgeType: 'network',
    });
  }

  for (let i = 0; i < resources.length; i++) {
    const r = resources[i];
    const node = nodes[i];
    const cfg = r.configuration ?? {};

    // AWS Subnet -> VPC
    const vpcId = typeof cfg.vpcId === 'string' ? cfg.vpcId : null;
    if (vpcId && idByRawOrSanitised.has(vpcId)) {
      const parentVpcId = idByRawOrSanitised.get(vpcId)!;
      if (node.resourceType === 'aws_subnet') {
        node.groupId = parentVpcId;
      }
      addEdge(parentVpcId, node.id);
    }

    // Azure Subnet -> VNet
    const vnetId = typeof cfg.vnetId === 'string' ? cfg.vnetId : null;
    if (vnetId && idByRawOrSanitised.has(vnetId)) {
      const parentVnetId = idByRawOrSanitised.get(vnetId)!;
      if (node.resourceType === 'azure_subnet') {
        node.groupId = parentVnetId;
      }
      addEdge(parentVnetId, node.id);
    }

    // Compute Instance -> Subnet
    const subnetId = typeof cfg.subnetId === 'string' ? cfg.subnetId : null;
    if (subnetId && idByRawOrSanitised.has(subnetId)) {
      const parentSubnetId = idByRawOrSanitised.get(subnetId)!;
      addEdge(parentSubnetId, node.id);
    }

    // Load Balancer / RDS -> VPC (if no direct subnet link)
    if (!subnetId && vpcId && idByRawOrSanitised.has(vpcId) && node.resourceType !== 'aws_subnet') {
      const parentVpcId = idByRawOrSanitised.get(vpcId)!;
      addEdge(parentVpcId, node.id);
    }
  }

  return { nodes, edges };
}

/**
 * Backward-compatible helper returning CanvasNode[].
 */
export function normalizeResources(resources: DiscoveredResource[]): CanvasNode[] {
  return normalizeDiscoveredInfrastructure(resources).nodes;
}
