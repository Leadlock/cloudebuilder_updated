/**
 * Architecture Auto-Layout Engine for CloudBuilder
 *
 * Organizes cloud resources into logical architectural tiers:
 * 1. External Ingress / Gateways (Internet, Route53, CloudFront, WAF, IGW, Front Door)
 * 2. VPC / VNet Container boundaries
 * 3. Public / Ingress Subnets (ALB, Application Gateway, NAT Gateway across AZs)
 * 4. Private App Subnets (EC2, VMSS, ASG, ECS across AZ-A & AZ-B)
 * 5. Private Database Subnets (RDS Multi-AZ, Azure SQL, Redis across AZs)
 * 6. Regional Managed Services (S3, Blob Storage, KMS, CloudWatch)
 *
 * Provider-aware: lays out AWS and Azure independently with zero cross-provider overlaps.
 * Multi-AZ-aware: arranges AZ-A and AZ-B subnets side-by-side in parallel columns.
 */

import { CanvasNode, CanvasEdge, RelationshipType } from '@/types';

export interface LayoutResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface ProviderLayoutContext {
  provider: 'aws' | 'azure';
  startX: number;
}

function layoutSingleProvider(
  providerNodes: CanvasNode[],
  context: ProviderLayoutContext
): { nodes: CanvasNode[]; endX: number; maxY: number } {
  const { provider, startX } = context;

  // 0. Extract existing Cloud Provider Boundaries
  const boundaryNodes = providerNodes.filter(
    (n) =>
      n.resourceType === 'cloud_provider_boundary' ||
      n.resourceType === 'aws_cloud_boundary' ||
      n.resourceType === 'azure_cloud_boundary'
  );
  const nonBoundaryNodes = providerNodes.filter((n) => !boundaryNodes.includes(n));

  // 1. Classify nodes
  const vpcNodes = nonBoundaryNodes.filter(
    (n) =>
      n.resourceType === 'aws_vpc' ||
      n.resourceType === 'azure_vnet' ||
      n.resourceType === 'azure_resource_group'
  );
  const subnetNodes = nonBoundaryNodes.filter(
    (n) => n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet'
  );
  const leafNodes = nonBoundaryNodes.filter((n) => !vpcNodes.includes(n) && !subnetNodes.includes(n));

  const primaryVpc = vpcNodes[0];
  const primaryBoundary = boundaryNodes[0];

  // Determine Subnet tiers based on config/name
  const isPublicSubnet = (s: CanvasNode) => {
    const name = (s.label || '').toLowerCase();
    const mapPublic = s.config?.mapPublicIpOnLaunch === true;
    return mapPublic || name.includes('public') || name.includes('dmz') || name.includes('web') || name.includes('ingress');
  };

  const isDatabaseSubnet = (s: CanvasNode) => {
    const name = (s.label || '').toLowerCase();
    return name.includes('db') || name.includes('data') || name.includes('database') || name.includes('sql');
  };

  // Associate leaves to subnets
  const subnetChildrenMap = new Map<string, CanvasNode[]>();
  const uncontainedLeaves: CanvasNode[] = [];

  for (const s of subnetNodes) {
    subnetChildrenMap.set(s.id, []);
  }

  for (const leaf of leafNodes) {
    const targetSubnetId = leaf.groupId || leaf.parentId;
    if (targetSubnetId && subnetChildrenMap.has(targetSubnetId)) {
      subnetChildrenMap.get(targetSubnetId)!.push(leaf);
    } else {
      // Heuristic association for auto-layout if not yet placed:
      if (leaf.resourceType === 'aws_rds' || leaf.resourceType === 'azure_sql' || leaf.resourceType === 'aws_elasticache' || leaf.resourceType === 'azure_redis' || leaf.resourceType === 'azure_postgres' || leaf.resourceType === 'azure_mysql') {
        const dbSubnet = subnetNodes.find(isDatabaseSubnet) || subnetNodes[subnetNodes.length - 1];
        if (dbSubnet) {
          subnetChildrenMap.get(dbSubnet.id)!.push({ ...leaf, groupId: dbSubnet.id });
          continue;
        }
      } else if (leaf.resourceType === 'aws_alb' || leaf.resourceType === 'azure_app_gateway' || leaf.resourceType === 'aws_nat') {
        const pubSubnet = subnetNodes.find(isPublicSubnet) || subnetNodes[0];
        if (pubSubnet) {
          subnetChildrenMap.get(pubSubnet.id)!.push({ ...leaf, groupId: pubSubnet.id });
          continue;
        }
      } else if (
        leaf.resourceType === 'aws_ec2' ||
        leaf.resourceType === 'azure_vm' ||
        leaf.resourceType === 'aws_auto_scaling' ||
        leaf.resourceType === 'azure_vmss'
      ) {
        const privSubnet = subnetNodes.find((s) => !isPublicSubnet(s) && !isDatabaseSubnet(s)) || subnetNodes[0];
        if (privSubnet) {
          subnetChildrenMap.get(privSubnet.id)!.push({ ...leaf, groupId: privSubnet.id });
          continue;
        }
      }
      uncontainedLeaves.push(leaf);
    }
  }

  const updatedNodes: CanvasNode[] = [];
  const LEAF_CARD_W = 180;
  const LEAF_CARD_H = 100;

  // Classify uncontained leaves into:
  // 1. External Edge Ingress (Route 53, CloudFront, Front Door, WAF) -> lives in Cloud Boundary ABOVE the VPC
  // 2. VPC Boundary Gateways (IGW, Public IP, Route Table) -> lives INSIDE VPC at top entrance
  // 3. Regional Managed Services (S3, Blob Storage, KMS, CloudWatch) -> lives on Right Flank in Cloud Boundary
  const edgeIngressOrder: Record<string, number> = {
    aws_internet: 1,
    aws_route53: 2,
    azure_front_door: 2,
    aws_cloudfront: 3,
    aws_waf: 4,
    azure_waf: 4,
  };

  const vpcGatewayOrder: Record<string, number> = {
    aws_igw: 1,
    azure_public_ip: 2,
    aws_route_table: 3,
  };

  const edgeIngressNodes = uncontainedLeaves
    .filter((n) => edgeIngressOrder[n.resourceType] !== undefined)
    .sort((a, b) => (edgeIngressOrder[a.resourceType] || 99) - (edgeIngressOrder[b.resourceType] || 99));

  const vpcGatewayNodes = uncontainedLeaves
    .filter((n) => vpcGatewayOrder[n.resourceType] !== undefined)
    .sort((a, b) => (vpcGatewayOrder[a.resourceType] || 99) - (vpcGatewayOrder[b.resourceType] || 99));

  const remainingLeaves = uncontainedLeaves.filter(
    (n) => edgeIngressOrder[n.resourceType] === undefined && vpcGatewayOrder[n.resourceType] === undefined
  );

  const hasEdgeIngress = edgeIngressNodes.length > 0;
  const VPC_START_X = startX + 40;
  const VPC_START_Y = hasEdgeIngress ? 210 : 80;
  const hasVpcGateways = vpcGatewayNodes.length > 0;

  // ── Layout External Edge Ingress at top outside VPC
  if (hasEdgeIngress) {
    let ingX = VPC_START_X + 40;
    edgeIngressNodes.forEach((node) => {
      updatedNodes.push({
        ...node,
        position: { x: ingX, y: 70 },
        groupId: primaryBoundary ? primaryBoundary.id : undefined,
      });
      ingX += LEAF_CARD_W + 40;
    });
  }

  // ── Layout Subnets in multi-AZ tiers:
  // Tier 1: Public/Ingress Subnets (AZ-A, AZ-B)
  // Tier 2: Private App Subnets (AZ-A, AZ-B)
  // Tier 3: Private DB Subnets (AZ-A, AZ-B)
  const tier1Subnets = subnetNodes.filter(isPublicSubnet);
  const tier3Subnets = subnetNodes.filter((s) => !tier1Subnets.includes(s) && isDatabaseSubnet(s));
  const tier2Subnets = subnetNodes.filter((s) => !tier1Subnets.includes(s) && !tier3Subnets.includes(s));

  const tiers = [tier1Subnets, tier2Subnets, tier3Subnets].filter((t) => t.length > 0);
  const maxCols = Math.max(1, ...tiers.map((t) => t.length));

  const COL_WIDTH = 460;
  const COL_GAP = 50;
  const SUB_PADDING_X = 25;
  const SUB_PADDING_Y = 65; // Ensures 65px clearance below subnet header, badges, and CIDRs
  const SUB_GAP_Y = 65; // 65px vertical corridor between tiers for edges/badges

  const maxVpcWidth = 40 * 2 + maxCols * COL_WIDTH + (maxCols - 1) * COL_GAP;

  // ── Layout VPC Gateways (e.g. Internet Gateway) inside VPC at top
  const gwY = VPC_START_Y + 55;
  if (hasVpcGateways) {
    const gwTotalW = vpcGatewayNodes.length * LEAF_CARD_W + (vpcGatewayNodes.length - 1) * 30;
    let gwStartX = VPC_START_X + Math.round((maxVpcWidth - gwTotalW) / 2);
    vpcGatewayNodes.forEach((gw) => {
      updatedNodes.push({
        ...gw,
        position: { x: gwStartX, y: gwY },
        groupId: primaryVpc ? primaryVpc.id : undefined,
      });
      gwStartX += LEAF_CARD_W + 30;
    });
  }

  let currentSubnetY = hasVpcGateways ? gwY + LEAF_CARD_H + 50 : VPC_START_Y + 70;

  for (const tier of tiers) {
    let currentTierMaxH = 180;

    tier.forEach((subnet, colIdx) => {
      const children = subnetChildrenMap.get(subnet.id) || [];
      const childCols = Math.max(1, Math.min(children.length, 2));
      const childRows = Math.ceil(children.length / childCols) || 1;

      // For single subnet spanning entire tier (e.g. Azure App Gateway or single tier):
      const subWidth = tier.length === 1 && maxCols > 1 ? maxCols * COL_WIDTH + (maxCols - 1) * COL_GAP : COL_WIDTH;
      const subHeight = Math.max(180, SUB_PADDING_Y + childRows * LEAF_CARD_H + (childRows - 1) * 20 + 25);
      const subX = VPC_START_X + 40 + colIdx * (COL_WIDTH + COL_GAP);
      const subY = currentSubnetY;

      currentTierMaxH = Math.max(currentTierMaxH, subHeight);

      // Position children inside subnet with clean padding
      if (children.length === 1) {
        const childX = subX + Math.round((subWidth - LEAF_CARD_W) / 2);
        const childY = subY + SUB_PADDING_Y;
        updatedNodes.push({
          ...children[0],
          position: { x: childX, y: childY },
          groupId: subnet.id,
        });
      } else if (children.length === 2) {
        const cGap = Math.max(20, subWidth - SUB_PADDING_X * 2 - LEAF_CARD_W * 2);
        children.forEach((child, idx) => {
          const childX = subX + SUB_PADDING_X + idx * (LEAF_CARD_W + cGap);
          const childY = subY + SUB_PADDING_Y;
          updatedNodes.push({
            ...child,
            position: { x: childX, y: childY },
            groupId: subnet.id,
          });
        });
      } else {
        children.forEach((child, idx) => {
          const col = idx % childCols;
          const row = Math.floor(idx / childCols);
          const childX = subX + SUB_PADDING_X + col * (LEAF_CARD_W + 20);
          const childY = subY + SUB_PADDING_Y + row * (LEAF_CARD_H + 20);
          updatedNodes.push({
            ...child,
            position: { x: childX, y: childY },
            groupId: subnet.id,
          });
        });
      }

      // Add updated subnet node
      updatedNodes.push({
        ...subnet,
        position: { x: subX, y: subY },
        width: subWidth,
        height: subHeight,
        groupId: primaryVpc ? primaryVpc.id : subnet.groupId,
      });
    });

    currentSubnetY += currentTierMaxH + SUB_GAP_Y;
  }

  // ── Layout VPC / VNet container
  if (vpcNodes.length > 0) {
    const vpcHeight = Math.max(520, currentSubnetY - SUB_GAP_Y + 35 - VPC_START_Y);
    vpcNodes.forEach((vpc, i) => {
      updatedNodes.push({
        ...vpc,
        position: { x: VPC_START_X + i * (maxVpcWidth + 40), y: VPC_START_Y },
        width: maxVpcWidth,
        height: vpcHeight,
        groupId: primaryBoundary ? primaryBoundary.id : undefined,
      });
    });
  }

  // ── Layout Regional Services (S3, Blob Storage, KMS, CloudWatch) to the right flank
  const rightFlankX = VPC_START_X + maxVpcWidth + 60;
  let flankY = Math.max(VPC_START_Y + 50, 240);

  remainingLeaves.forEach((node) => {
    updatedNodes.push({
      ...node,
      position: { x: rightFlankX, y: flankY },
      groupId: primaryBoundary ? primaryBoundary.id : undefined,
    });
    flankY += LEAF_CARD_H + 30;
  });

  const totalEndX = Math.max(rightFlankX + LEAF_CARD_W + 50, VPC_START_X + maxVpcWidth + 50);
  const totalMaxY = Math.max(currentSubnetY + 40, flankY + 40);

  // ── Layout Cloud Provider Boundary
  const boundariesToLayout = boundaryNodes.length > 0 ? boundaryNodes : [
    {
      id: `${provider}-cloud`,
      type: 'containerNode' as const,
      resourceType: `${provider}_cloud_boundary`,
      provider,
      label: provider === 'azure' ? 'Microsoft Azure (East US)' : 'Amazon Web Services (us-east-1)',
      position: { x: 30, y: 20 },
      width: 1240,
      height: 940,
      config: { region: provider === 'azure' ? 'eastus' : 'us-east-1' },
    }
  ];

  for (const bNode of boundariesToLayout) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of updatedNodes) {
      const w = n.width || 180;
      const h = n.height || 100;
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w);
      maxY = Math.max(maxY, n.position.y + h);
    }

    const bPaddingX = 50;
    const bPaddingTop = 80;
    const bPaddingBottom = 50;

    const bX = Math.max(20, minX - bPaddingX);
    const bY = Math.max(20, minY - bPaddingTop);
    const bW = Math.max(1050, maxX - bX + bPaddingX);
    const bH = Math.max(680, maxY - bY + bPaddingBottom);

    updatedNodes.unshift({
      ...bNode,
      position: { x: bX, y: bY },
      width: bW,
      height: bH,
      config: {
        ...bNode.config,
        resourceCount: updatedNodes.length,
      },
    });
  }

  return { nodes: updatedNodes, endX: totalEndX, maxY: totalMaxY };
}

export function autoLayoutArchitecture(nodes: CanvasNode[], edges: CanvasEdge[]): LayoutResult {
  if (nodes.length === 0) return { nodes, edges };

  // Partition nodes by provider
  const isAws = (n: CanvasNode) =>
    n.provider === 'aws' ||
    n.resourceType.startsWith('aws_') ||
    n.resourceType === 'aws_cloud_boundary';

  const isAzure = (n: CanvasNode) =>
    n.provider === 'azure' ||
    n.resourceType.startsWith('azure_') ||
    n.resourceType === 'azure_cloud_boundary';

  const awsNodes = nodes.filter(isAws);
  const azureNodes = nodes.filter(isAzure);
  const otherNodes = nodes.filter((n) => !isAws(n) && !isAzure(n));

  const finalNodes: CanvasNode[] = [];
  let currentStartX = 60;

  if (awsNodes.length > 0) {
    const awsLayout = layoutSingleProvider(awsNodes, { provider: 'aws', startX: currentStartX });
    finalNodes.push(...awsLayout.nodes);
    currentStartX = awsLayout.endX + 120;
  }

  if (azureNodes.length > 0) {
    const azLayout = layoutSingleProvider(azureNodes, { provider: 'azure', startX: currentStartX });
    finalNodes.push(...azLayout.nodes);
    currentStartX = azLayout.endX + 120;
  }

  if (otherNodes.length > 0) {
    otherNodes.forEach((n, idx) => {
      finalNodes.push({
        ...n,
        position: { x: currentStartX + (idx % 3) * 200, y: 80 + Math.floor(idx / 3) * 120 },
      });
    });
  }

  // Z-Order: Boundary (-3) -> VPC/VNet (-2) -> Subnets (-1) -> Leaf nodes (1)
  const zOrderedNodes = finalNodes.sort((a, b) => {
    const getZ = (n: CanvasNode) => {
      if (
        n.resourceType === 'cloud_provider_boundary' ||
        n.resourceType === 'aws_cloud_boundary' ||
        n.resourceType === 'azure_cloud_boundary'
      )
        return -3;
      if (
        n.resourceType === 'aws_vpc' ||
        n.resourceType === 'azure_vnet' ||
        n.resourceType === 'azure_resource_group'
      )
        return -2;
      if (n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet') return -1;
      return 1;
    };
    return getZ(a) - getZ(b);
  });

  // Edge sanitization & deduplication
  const validNodeIds = new Set(zOrderedNodes.map((n) => n.id));
  const seenEdges = new Set<string>();
  const cleanEdges: CanvasEdge[] = [];

  for (const e of edges) {
    if (!validNodeIds.has(e.source) || !validNodeIds.has(e.target)) {
      continue; // drop orphaned edge
    }
    const relType = e.relationshipType || (e.edgeType as RelationshipType) || 'NETWORK_FLOW';
    if (relType === 'CONTAINS') {
      continue; // drop container edge, containment is visual
    }
    const key = `${e.source}:${relType}:${e.target}`;
    if (seenEdges.has(key)) {
      continue; // deduplicate
    }
    seenEdges.add(key);
    cleanEdges.push({
      ...e,
      id: e.id && e.id.includes(':') ? e.id : key,
      relationshipType: relType,
    });
  }

  return { nodes: zOrderedNodes, edges: cleanEdges };
}

export const layoutByCloud = autoLayoutArchitecture;
export const layoutByNetwork = autoLayoutArchitecture;
export const layoutByTier = autoLayoutArchitecture;

