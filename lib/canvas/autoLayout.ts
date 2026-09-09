/**
 * Architecture Auto-Layout Engine for CloudCraft
 *
 * Organizes cloud resources into logical architectural tiers:
 * 1. External Ingress / Gateways (Internet, IGW, Route53, ALB)
 * 2. VPC / VNet Container boundaries
 * 3. Public Subnets (NAT, Web EC2, ALB)
 * 4. Private App Subnets (App EC2, ASG, ECS)
 * 5. Private Database Subnets (RDS, Aurora, DynamoDB)
 * 6. Regional Managed Services (S3, KMS, IAM, CloudWatch)
 */

import { CanvasNode, CanvasEdge } from '@/types';
import { getResourceDefinition } from '@/lib/resources';

export interface LayoutResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export function autoLayoutArchitecture(nodes: CanvasNode[], edges: CanvasEdge[]): LayoutResult {
  if (nodes.length === 0) return { nodes, edges };

  // 1. Classify nodes
  const vpcNodes = nodes.filter((n) => n.resourceType === 'aws_vpc' || n.resourceType === 'azure_vnet' || n.resourceType === 'azure_resource_group');
  const subnetNodes = nodes.filter((n) => n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet');
  const leafNodes = nodes.filter((n) => !vpcNodes.includes(n) && !subnetNodes.includes(n));

  // Determine Subnet tiers based on config/name/children
  const isPublicSubnet = (s: CanvasNode) => {
    const name = (s.label || '').toLowerCase();
    const mapPublic = s.config?.mapPublicIpOnLaunch === true;
    return mapPublic || name.includes('public') || name.includes('dmz') || name.includes('web');
  };

  const isDatabaseSubnet = (s: CanvasNode) => {
    const name = (s.label || '').toLowerCase();
    return name.includes('db') || name.includes('data') || name.includes('database');
  };

  // Associate leaves to subnets
  const subnetChildrenMap = new Map<string, CanvasNode[]>();
  const uncontainedLeaves: CanvasNode[] = [];

  for (const s of subnetNodes) {
    subnetChildrenMap.set(s.id, []);
  }

  for (const leaf of leafNodes) {
    // Check if leaf explicitly belongs to a subnet via groupId or parentId
    const targetSubnetId = leaf.groupId || leaf.parentId;
    if (targetSubnetId && subnetChildrenMap.has(targetSubnetId)) {
      subnetChildrenMap.get(targetSubnetId)!.push(leaf);
    } else {
      // Heuristic association for auto-layout if not yet placed:
      if (leaf.resourceType === 'aws_rds' || leaf.resourceType === 'azure_sql') {
        const dbSubnet = subnetNodes.find(isDatabaseSubnet) || subnetNodes[subnetNodes.length - 1];
        if (dbSubnet) {
          subnetChildrenMap.get(dbSubnet.id)!.push({ ...leaf, groupId: dbSubnet.id });
          continue;
        }
      } else if (leaf.resourceType === 'aws_alb' || leaf.resourceType === 'aws_nat') {
        const pubSubnet = subnetNodes.find(isPublicSubnet) || subnetNodes[0];
        if (pubSubnet) {
          subnetChildrenMap.get(pubSubnet.id)!.push({ ...leaf, groupId: pubSubnet.id });
          continue;
        }
      } else if (leaf.resourceType === 'aws_ec2' || leaf.resourceType === 'azure_vm' || leaf.resourceType === 'aws_auto_scaling') {
        const privSubnet = subnetNodes.find((s) => !isPublicSubnet(s) && !isDatabaseSubnet(s)) || subnetNodes[0];
        if (privSubnet) {
          subnetChildrenMap.get(privSubnet.id)!.push({ ...leaf, groupId: privSubnet.id });
          continue;
        }
      }
      uncontainedLeaves.push(leaf);
    }
  }

  // Position layout coordinates
  const updatedNodes: CanvasNode[] = [];
  const SUB_PADDING_X = 25;
  const SUB_PADDING_Y = 55;
  const LEAF_CARD_W = 180;
  const LEAF_CARD_H = 100;
  const LEAF_GAP_X = 20;
  const LEAF_GAP_Y = 20;

  // Layout Subnets and their children
  const subnetDimensions = new Map<string, { x: number; y: number; width: number; height: number }>();

  // Sort subnets: Public first, App second, Database last
  const sortedSubnets = [...subnetNodes].sort((a, b) => {
    const aScore = isPublicSubnet(a) ? 1 : isDatabaseSubnet(a) ? 3 : 2;
    const bScore = isPublicSubnet(b) ? 1 : isDatabaseSubnet(b) ? 3 : 2;
    return aScore - bScore;
  });

  const VPC_START_X = 80;
  const VPC_START_Y = 160;
  const VPC_PADDING_X = 35;
  const VPC_HEADER_H = 65;
  const SUB_GAP_Y = 30;

  let currentSubnetY = VPC_START_Y + VPC_HEADER_H;
  let maxVpcWidth = 720;

  for (const subnet of sortedSubnets) {
    const children = subnetChildrenMap.get(subnet.id) || [];
    const childCols = Math.max(1, Math.min(children.length, 3));
    const childRows = Math.ceil(children.length / childCols) || 1;

    const subWidth = Math.max(340, SUB_PADDING_X * 2 + childCols * LEAF_CARD_W + (childCols - 1) * LEAF_GAP_X);
    const subHeight = Math.max(180, SUB_PADDING_Y + childRows * LEAF_CARD_H + (childRows - 1) * LEAF_GAP_Y + 25);

    const subX = VPC_START_X + VPC_PADDING_X;
    const subY = currentSubnetY;

    subnetDimensions.set(subnet.id, { x: subX, y: subY, width: subWidth, height: subHeight });

    // Position children inside subnet
    children.forEach((child, idx) => {
      const col = idx % childCols;
      const row = Math.floor(idx / childCols);
      const childX = subX + SUB_PADDING_X + col * (LEAF_CARD_W + LEAF_GAP_X);
      const childY = subY + SUB_PADDING_Y + row * (LEAF_CARD_H + LEAF_GAP_Y);

      updatedNodes.push({
        ...child,
        position: { x: childX, y: childY },
        groupId: subnet.id,
      });
    });

    // Add updated subnet node
    const primaryVpc = vpcNodes[0];
    updatedNodes.push({
      ...subnet,
      position: { x: subX, y: subY },
      width: subWidth,
      height: subHeight,
      groupId: primaryVpc ? primaryVpc.id : subnet.groupId,
    });

    maxVpcWidth = Math.max(maxVpcWidth, subWidth + VPC_PADDING_X * 2);
    currentSubnetY += subHeight + SUB_GAP_Y;
  }

  // Layout VPC container
  if (vpcNodes.length > 0) {
    const vpcHeight = Math.max(480, currentSubnetY - VPC_START_Y + 30);
    vpcNodes.forEach((vpc, i) => {
      updatedNodes.push({
        ...vpc,
        position: { x: VPC_START_X + i * (maxVpcWidth + 40), y: VPC_START_Y },
        width: maxVpcWidth,
        height: vpcHeight,
      });
    });
  }

  // Layout Ingress / Top Gateways (IGW, Internet, Route53) above VPC
  const ingressTypes = new Set(['aws_igw', 'azure_public_ip', 'aws_route_table']);
  const ingressNodes = uncontainedLeaves.filter((n) => ingressTypes.has(n.resourceType));
  const remainingLeaves = uncontainedLeaves.filter((n) => !ingressTypes.has(n.resourceType));

  ingressNodes.forEach((node, i) => {
    updatedNodes.push({
      ...node,
      position: { x: VPC_START_X + VPC_PADDING_X + i * (LEAF_CARD_W + 30), y: 50 },
    });
  });

  // Layout Regional / External Services to the right of VPC (S3, KMS, IAM, CloudWatch)
  const rightFlankX = VPC_START_X + maxVpcWidth + 60;
  let flankY = VPC_START_Y;

  remainingLeaves.forEach((node) => {
    updatedNodes.push({
      ...node,
      position: { x: rightFlankX, y: flankY },
    });
    flankY += LEAF_CARD_H + 25;
  });

  // Order nodes so container nodes (VPC, VNet) are rendered first (bottom-most in z-index)
  // followed by Subnets, followed by leaf nodes (top-most)
  const zOrderedNodes = updatedNodes.sort((a, b) => {
    const getZ = (n: CanvasNode) => {
      if (n.resourceType === 'aws_vpc' || n.resourceType === 'azure_vnet' || n.resourceType === 'azure_resource_group') return 0;
      if (n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet') return 1;
      return 2;
    };
    return getZ(a) - getZ(b);
  });

  return { nodes: zOrderedNodes, edges };
}
