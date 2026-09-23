/**
 * Resource normalizer — converts DiscoveredResource / CloudResource objects
 * into CloudCraft's canonical CanvasNode & CanvasEdge format for React Flow.
 *
 * Rules:
 * - Each node receives `importState: 'imported'`.
 * - Cloud identifiers (ARN, resource ID, region, account/subscription ID, source, lastImportedAt)
 *   are preserved in node.config.
 * - No credentials or sensitive fields are ever included.
 * - Containers (VPC, VNet, Subnet, Resource Group) are assigned container dimensions and 'containerNode' type.
 * - Leaf nodes are grouped into their parent container (groupId).
 * - Full topology relationships (containment, traffic, network, security, storage) are converted to CanvasEdges.
 * - Unknown resource types are mapped to a graceful "Unsupported/Imported Resource" node rather than dropped.
 */
import type { CanvasNode, CanvasEdge, Region } from '@/types';
import type { DiscoveredResource } from './types';
import type { CloudResource, CloudRelationship } from './discovery/types';
import { getResourceDefinition } from '@/lib/resources';

// ─── Resource type → CloudCraft resourceType mapping ─────────────────────────

const RESOURCE_TYPE_MAP: Record<string, string> = {
  // AWS networking
  vpc: 'aws_vpc',
  subnet: 'aws_subnet',
  'internet-gateway': 'aws_igw',
  'nat-gateway': 'aws_nat',
  'route-table': 'aws_route_table',
  // AWS compute
  'ec2-instance': 'aws_ec2',
  'auto-scaling-group': 'aws_auto_scaling',
  lambda: 'aws_lambda',
  ecs: 'aws_ecs',
  eks: 'aws_eks',
  // AWS storage
  's3-bucket': 'aws_s3',
  'ebs-volume': 'aws_ebs',
  // AWS database
  'rds-instance': 'aws_rds',
  'dynamodb-table': 'aws_dynamodb',
  elasticache: 'aws_elasticache',
  // AWS load balancing
  alb: 'aws_alb',
  nlb: 'aws_alb',
  'target-group': 'aws_alb',
  // AWS CDN
  cloudfront: 'aws_cloudfront',
  // AWS DNS / monitoring / firewall
  'hosted-zone': 'aws_route53',
  'cloudwatch-alarm': 'aws_cloudwatch',
  'waf-web-acl': 'aws_waf',
  // AWS Security
  'security-group': 'aws_sg',
  'iam-role': 'aws_iam',
  'network-acl': 'aws_nacl',
  'kms-key': 'aws_kms',
  // AWS messaging
  'sqs-queue': 'aws_sqs',
  // Azure networking
  vnet: 'azure_vnet',
  'load-balancer': 'azure_lb',
  'application-gateway': 'azure_app_gateway',
  'network-security-group': 'azure_nsg',
  'public-ip': 'azure_public_ip',
  // Azure compute
  'virtual-machine': 'azure_vm',
  aks: 'azure_aks',
  functions: 'azure_functions',
  // Azure storage
  'storage-account': 'azure_storage',
  'blob-container': 'azure_storage',
  // Azure database
  'sql-server': 'azure_sql',
  'sql-database': 'azure_sql',
  // Azure security & org
  'key-vault': 'azure_key_vault',
  'resource-group': 'azure_resource_group',
};

// ─── Grid layout helper ───────────────────────────────────────────────────────

const GRID_COLS = 4;
const GRID_CELL_W = 260;
const GRID_CELL_H = 200;

function gridPosition(index: number): { x: number; y: number } {
  const col = index % GRID_COLS;
  const row = Math.floor(index / GRID_COLS);
  return { x: 80 + col * GRID_CELL_W, y: 80 + row * GRID_CELL_H };
}

// ─── Sanitise ID ─────────────────────────────────────────────────────────────

export function sanitiseId(rawId?: string): string {
  if (!rawId) return '';
  return rawId.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}

// ─── Normalise Region ────────────────────────────────────────────────────────

function normaliseRegion(region?: string): Region | undefined {
  if (!region) return undefined;
  const cleaned = region.toLowerCase().replace(/\s+/g, '');
  return cleaned as Region;
}

// ─── Normalizer with Discovered Relationships ─────────────────────────────────

export function normalizeDiscoveredInfrastructure(
  resources: Array<DiscoveredResource | CloudResource>,
  relationships: CloudRelationship[] = [],
): {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
} {
  // 1. Build nodes
  const nodes: CanvasNode[] = resources.map((r, index) => {
    const rawType = (r.resourceType || 'unknown').toLowerCase();
    const provider = r.provider === 'azure' ? 'azure' : 'aws';

    let resourceType = RESOURCE_TYPE_MAP[rawType];
    if (!resourceType) {
      if (rawType === 'ec2' || rawType === 'ec2_instance') {
        resourceType = 'aws_ec2';
      } else if (rawType === 'rds' || rawType === 'rds_instance') {
        resourceType = 'aws_rds';
      } else if (provider === 'azure') {
        if (rawType === 'subnet') resourceType = 'azure_subnet';
        else if (rawType === 'nat-gateway') resourceType = 'azure_nat';
        else if (rawType === 'vm') resourceType = 'azure_vm';
        else {
          const candidate = `azure_${rawType.replace(/[^a-zA-Z0-9_]/g, '_')}`;
          resourceType = getResourceDefinition(candidate) ? candidate : 'azure_unknown';
        }
      } else {
        const candidate = `aws_${rawType.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        resourceType = getResourceDefinition(candidate) ? candidate : 'aws_unknown';
      }
    } else if (provider === 'azure' && rawType === 'subnet') {
      resourceType = 'azure_subnet';
    } else if (provider === 'azure' && rawType === 'nat-gateway') {
      resourceType = 'azure_nat';
    }

    const rawId = (r as DiscoveredResource).providerResourceId || (r as CloudResource).arn || (r as CloudResource).resourceId || `res-${index}`;
    const nodeId = sanitiseId(rawId) || `res-${index}`;
    const position = gridPosition(index);

    const isVpcOrVnet = resourceType === 'aws_vpc' || resourceType === 'azure_vnet' || resourceType === 'azure_resource_group';
    const isSubnet = resourceType === 'aws_subnet' || resourceType === 'azure_subnet';
    const isContainer = isVpcOrVnet || isSubnet;

    const width = isVpcOrVnet ? 780 : isSubnet ? 340 : 180;
    const height = isVpcOrVnet ? 500 : isSubnet ? 220 : 100;

    const source = (r.configuration?.source as string) || (provider === 'azure' ? 'azure-arm' : 'aws-api');
    const arn = (r as CloudResource).arn || (r as DiscoveredResource).providerResourceId || rawId;

    const config: Record<string, unknown> = {
      ...r.configuration,
      originalResourceType: rawType,
      name: r.name || rawId,
      providerResourceId: rawId,
      resourceId: (r as CloudResource).resourceId || rawId,
      arn,
      region: r.region,
      status: r.status,
      imported: true,
      importState: 'imported',
      source,
      lastImportedAt: (r as CloudResource).discoveredAt || new Date().toISOString(),
      _metadata: r.metadata,
    };

    return {
      id: nodeId,
      type: isContainer ? 'containerNode' : 'cloudNode',
      resourceType,
      provider,
      label: r.name || rawId,
      position,
      config,
      region: normaliseRegion(r.region),
      locked: false,
      importState: 'imported',
      width,
      height,
    };
  });

  // Fast lookup by providerResourceId, arn, raw id, and sanitised id
  const idByRawOrSanitised = new Map<string, string>();
  for (let i = 0; i < resources.length; i++) {
    const r = resources[i];
    const node = nodes[i];
    const raw = (r as DiscoveredResource).providerResourceId || (r as CloudResource).arn || (r as CloudResource).resourceId;
    if (raw) {
      idByRawOrSanitised.set(raw, node.id);
      idByRawOrSanitised.set(sanitiseId(raw), node.id);
    }
    const resId = (r as CloudResource).resourceId;
    if (resId) {
      idByRawOrSanitised.set(resId, node.id);
      idByRawOrSanitised.set(sanitiseId(resId), node.id);
    }
    const arn = (r as CloudResource).arn;
    if (arn) {
      idByRawOrSanitised.set(arn, node.id);
      idByRawOrSanitised.set(sanitiseId(arn), node.id);
    }
    idByRawOrSanitised.set(node.id, node.id);
  }

  // 2. Extract explicit relationships into CanvasEdges and group hierarchy
  const edges: CanvasEdge[] = [];
  const edgeSet = new Set<string>();

  function addEdge(sourceId: string, targetId: string, label?: string, edgeType: CanvasEdge['edgeType'] = 'network') {
    if (sourceId === targetId) return;
    const key = `${sourceId}->${targetId}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({
      id: `edge-disc-${sourceId}-${targetId}`,
      source: sourceId,
      target: targetId,
      label,
      edgeType,
    });
  }

  // Combine passed relationships with any embedded in metadata.relationships
  const allRelationships = [...relationships];
  for (const r of resources) {
    const rawId = (r as DiscoveredResource).providerResourceId || (r as CloudResource).arn || (r as CloudResource).resourceId;
    if (r.metadata && Array.isArray(r.metadata['relationships'])) {
      for (const rel of r.metadata['relationships'] as Array<{ targetResourceId: string; relationshipType?: string; label?: string }>) {
        if (rel.targetResourceId) {
          allRelationships.push({
            sourceResourceId: rawId,
            targetResourceId: rel.targetResourceId,
            relationshipType: (rel.relationshipType as any) || 'network',
            label: rel.label,
          });
        }
      }
    }
  }

  // Process relationships
  for (const rel of allRelationships) {
    const sourceNodeId = idByRawOrSanitised.get(rel.sourceResourceId) || idByRawOrSanitised.get(sanitiseId(rel.sourceResourceId));
    const targetNodeId = idByRawOrSanitised.get(rel.targetResourceId) || idByRawOrSanitised.get(sanitiseId(rel.targetResourceId));
    if (sourceNodeId && targetNodeId) {
      const edgeType = rel.relationshipType === 'traffic' ? 'data' : rel.relationshipType === 'security' ? 'security' : 'network';
      addEdge(sourceNodeId, targetNodeId, rel.label, edgeType);

      if (rel.relationshipType === 'containment') {
        const targetNode = nodes.find((n) => n.id === targetNodeId);
        if (targetNode && !targetNode.groupId) {
          targetNode.groupId = sourceNodeId;
        }
      }
    }
  }

  // Process per-resource functional configuration links
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
      addEdge(parentVpcId, node.id, 'VPC Subnet', 'network');
    }

    // Azure Subnet -> VNet
    const vnetId = (typeof cfg.vnetId === 'string' ? cfg.vnetId : null)
      || (typeof cfg.parentResourceId === 'string' && cfg.parentResourceId.includes('virtualNetworks') ? cfg.parentResourceId : null)
      || (typeof (r as CloudResource).parentResourceId === 'string' && (r as CloudResource).parentResourceId!.includes('virtualNetworks') ? (r as CloudResource).parentResourceId! : null);
    if (vnetId && idByRawOrSanitised.has(vnetId)) {
      const parentVnetId = idByRawOrSanitised.get(vnetId)!;
      if (node.resourceType === 'azure_subnet') {
        node.groupId = parentVnetId;
      }
      addEdge(parentVnetId, node.id, 'VNet Subnet', 'network');
    }

    // Compute / Database / ALB -> Subnet
    const subnetId = (typeof cfg.subnetId === 'string' ? cfg.subnetId : null)
      || (typeof cfg.parentResourceId === 'string' && (cfg.parentResourceId.includes('subnets') || cfg.parentResourceId.startsWith('subnet-')) ? cfg.parentResourceId : null)
      || (typeof (r as CloudResource).parentResourceId === 'string' && ((r as CloudResource).parentResourceId!.includes('subnets') || (r as CloudResource).parentResourceId!.startsWith('subnet-')) ? (r as CloudResource).parentResourceId! : null);
    if (subnetId && idByRawOrSanitised.has(subnetId)) {
      const parentSubnetId = idByRawOrSanitised.get(subnetId)!;
      if (!node.groupId) {
        node.groupId = parentSubnetId;
      }
      addEdge(parentSubnetId, node.id, 'Contains', 'network');
    } else if (vpcId && idByRawOrSanitised.has(vpcId) && node.resourceType !== 'aws_subnet') {
      const parentVpcId = idByRawOrSanitised.get(vpcId)!;
      if (!node.groupId) {
        node.groupId = parentVpcId;
      }
      addEdge(parentVpcId, node.id, 'VPC Resource', 'network');
    }

    // Internet Gateway -> VPC
    const attachedVpcId = typeof cfg.attachedVpcId === 'string' ? cfg.attachedVpcId : null;
    if (attachedVpcId && idByRawOrSanitised.has(attachedVpcId)) {
      const parentVpcId = idByRawOrSanitised.get(attachedVpcId)!;
      addEdge(node.id, parentVpcId, 'Gateway', 'network');
    }

    // Target Group / ALB -> Instances (Traffic)
    const targetInstanceIds = Array.isArray(cfg.targetInstanceIds) ? cfg.targetInstanceIds : [];
    for (const instId of targetInstanceIds) {
      if (typeof instId === 'string' && idByRawOrSanitised.has(instId)) {
        const instNodeId = idByRawOrSanitised.get(instId)!;
        addEdge(node.id, instNodeId, 'Forward', 'data');
      }
    }

    // EBS Volume -> EC2 Instance
    const attachedInstanceId = typeof cfg.attachedInstanceId === 'string' ? cfg.attachedInstanceId : null;
    if (attachedInstanceId && idByRawOrSanitised.has(attachedInstanceId)) {
      const instNodeId = idByRawOrSanitised.get(attachedInstanceId)!;
      addEdge(instNodeId, node.id, 'Volume', 'data');
    }
  }

  return { nodes, edges };
}

/**
 * Backward-compatible helper returning CanvasNode[].
 */
export function normalizeResources(resources: Array<DiscoveredResource | CloudResource>): CanvasNode[] {
  return normalizeDiscoveredInfrastructure(resources).nodes;
}
