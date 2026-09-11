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

export interface LayoutResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export function autoLayoutArchitecture(nodes: CanvasNode[], edges: CanvasEdge[]): LayoutResult {
  if (nodes.length === 0) return { nodes, edges };

  // 0. Extract existing Cloud Provider Boundaries
  const boundaryNodes = nodes.filter(
    (n) => n.resourceType === 'cloud_provider_boundary' || n.resourceType === 'aws_cloud_boundary' || n.resourceType === 'azure_cloud_boundary'
  );
  const nonBoundaryNodes = nodes.filter((n) => !boundaryNodes.includes(n));

  // 1. Classify nodes
  const vpcNodes = nonBoundaryNodes.filter((n) => n.resourceType === 'aws_vpc' || n.resourceType === 'azure_vnet' || n.resourceType === 'azure_resource_group');
  const subnetNodes = nonBoundaryNodes.filter((n) => n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet');
  const leafNodes = nonBoundaryNodes.filter((n) => !vpcNodes.includes(n) && !subnetNodes.includes(n));

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
  // Determine if we have top ingress nodes (Internet, CloudFront, IGW)
  const hasInternet = uncontainedLeaves.some((n) => n.resourceType === 'aws_internet');
  const hasCloudFront = uncontainedLeaves.some((n) => n.resourceType === 'aws_cloudfront');
  const hasIgw = uncontainedLeaves.some((n) => n.resourceType === 'aws_igw' || n.resourceType === 'azure_public_ip');

  let vpcStartY = 60;
  if (hasInternet && hasCloudFront) {
    vpcStartY = 310;
  } else if (hasInternet || hasCloudFront || hasIgw) {
    vpcStartY = 190;
  }

  const VPC_START_Y = vpcStartY;
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

  // Layout Ingress / Top Gateways (Internet -> CloudFront -> IGW) above VPC
  const ingressOrder: Record<string, number> = {
    aws_internet: 1,
    aws_cloudfront: 2,
    aws_igw: 3,
    azure_public_ip: 3,
    aws_route_table: 4,
  };

  const ingressNodes = uncontainedLeaves
    .filter((n) => ingressOrder[n.resourceType] !== undefined)
    .sort((a, b) => (ingressOrder[a.resourceType] || 99) - (ingressOrder[b.resourceType] || 99));

  const remainingLeaves = uncontainedLeaves.filter((n) => ingressOrder[n.resourceType] === undefined);

  // Position ingress pipeline centered above the primary subnet entry
  const ingressCenterX = VPC_START_X + VPC_PADDING_X + SUB_PADDING_X;
  if (hasInternet && hasCloudFront) {
    const internetNode = ingressNodes.find((n) => n.resourceType === 'aws_internet');
    const cloudFrontNode = ingressNodes.find((n) => n.resourceType === 'aws_cloudfront');
    const otherIngress = ingressNodes.filter((n) => n !== internetNode && n !== cloudFrontNode);

    if (internetNode) {
      updatedNodes.push({
        ...internetNode,
        position: { x: ingressCenterX, y: 30 },
      });
    }
    if (cloudFrontNode) {
      updatedNodes.push({
        ...cloudFrontNode,
        position: { x: ingressCenterX, y: 160 },
      });
    }
    otherIngress.forEach((node, i) => {
      updatedNodes.push({
        ...node,
        position: { x: ingressCenterX + (i + 1) * (LEAF_CARD_W + 30), y: 155 },
      });
    });
  } else {
    ingressNodes.forEach((node, i) => {
      updatedNodes.push({
        ...node,
        position: { x: VPC_START_X + VPC_PADDING_X + i * (LEAF_CARD_W + 30), y: 40 },
      });
    });
  }

  // Layout Regional / External Services to the right of VPC (S3, KMS, IAM, CloudWatch)
  const rightFlankX = VPC_START_X + maxVpcWidth + 60;
  let flankY = Math.max(VPC_START_Y, 200);

  remainingLeaves.forEach((node) => {
    updatedNodes.push({
      ...node,
      position: { x: rightFlankX, y: flankY },
    });
    flankY += LEAF_CARD_H + 25;
  });

  // Layout Cloud Provider Boundaries if present
  if (boundaryNodes.length > 0) {
    for (const bNode of boundaryNodes) {
      const bProvider = bNode.provider ?? (bNode.resourceType.includes('azure') ? 'azure' : 'aws');
      const enclosed = updatedNodes.filter((n) => {
        const nProvider = n.provider ?? (n.resourceType.startsWith('azure_') ? 'azure' : 'aws');
        return nProvider === bProvider;
      });

      if (enclosed.length > 0) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const n of enclosed) {
          const w = n.width || 180;
          const h = n.height || 100;
          minX = Math.min(minX, n.position.x);
          minY = Math.min(minY, n.position.y);
          maxX = Math.max(maxX, n.position.x + w);
          maxY = Math.max(maxY, n.position.y + h);
        }

        const bPaddingX = 40;
        const bPaddingTop = 60;
        const bPaddingBottom = 40;

        updatedNodes.push({
          ...bNode,
          position: {
            x: Math.max(20, minX - bPaddingX),
            y: Math.max(20, minY - bPaddingTop),
          },
          width: Math.max(880, maxX - minX + bPaddingX * 2),
          height: Math.max(520, maxY - minY + bPaddingTop + bPaddingBottom),
          config: {
            ...bNode.config,
            resourceCount: enclosed.length,
          },
        });
      } else {
        updatedNodes.push(bNode);
      }
    }
  }

  // Order nodes so container nodes (Boundary -> VPC/VNet -> Subnets -> Leaf nodes)
  const zOrderedNodes = updatedNodes.sort((a, b) => {
    const getZ = (n: CanvasNode) => {
      if (n.resourceType === 'cloud_provider_boundary' || n.resourceType === 'aws_cloud_boundary' || n.resourceType === 'azure_cloud_boundary') return -1;
      if (n.resourceType === 'aws_vpc' || n.resourceType === 'azure_vnet' || n.resourceType === 'azure_resource_group') return 0;
      if (n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet') return 1;
      return 2;
    };
    return getZ(a) - getZ(b);
  });

  return { nodes: zOrderedNodes, edges };
}
