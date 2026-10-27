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
  // Classify custom containers/groups (e.g. s3grp, loggrp, dr, edgegrp, secgrp)
  const isCustomContainer = (n: CanvasNode) =>
    (n.type === 'containerNode' || n.resourceType === 'containerNode' || n.resourceType === 'groupNode') &&
    !vpcNodes.some((v) => v.id === n.id) &&
    !subnetNodes.some((s) => s.id === n.id);

  const customContainers = nonBoundaryNodes.filter(isCustomContainer);
  const leafNodes = nonBoundaryNodes.filter(
    (n) =>
      !vpcNodes.some((v) => v.id === n.id) &&
      !subnetNodes.some((s) => s.id === n.id) &&
      !customContainers.some((c) => c.id === n.id)
  );

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

  // Associate leaves to subnets and custom containers
  const subnetChildrenMap = new Map<string, CanvasNode[]>();
  const containerChildrenMap = new Map<string, CanvasNode[]>();
  const uncontainedLeaves: CanvasNode[] = [];

  for (const s of subnetNodes) {
    subnetChildrenMap.set(s.id, []);
  }
  for (const c of customContainers) {
    containerChildrenMap.set(c.id, []);
  }

  // Pre-identify custom container roles
  const isEdgeContainer = (c: CanvasNode) => {
    const lbl = (c.label || '').toLowerCase();
    const cid = (c.id || '').toLowerCase();
    return lbl.includes('edge') || lbl.includes('ingress') || lbl.includes('global') || lbl.includes('cdn') || cid.includes('edge');
  };
  const isDrContainer = (c: CanvasNode) => {
    const lbl = (c.label || '').toLowerCase();
    const cid = (c.id || '').toLowerCase();
    return lbl.includes('dr') || lbl.includes('disaster') || lbl.includes('osaka') || lbl.includes('backup') || cid === 'dr';
  };
  const isLoggingContainer = (c: CanvasNode) => {
    const lbl = (c.label || '').toLowerCase();
    const cid = (c.id || '').toLowerCase();
    return !isDrContainer(c) && (lbl.includes('log') || lbl.includes('audit') || lbl.includes('trail') || cid === 'loggrp');
  };
  const isStorageContainer = (c: CanvasNode) => {
    const lbl = (c.label || '').toLowerCase();
    const cid = (c.id || '').toLowerCase();
    return !isDrContainer(c) && !isLoggingContainer(c) && (lbl.includes('storage') || lbl.includes('s3') || cid === 's3grp');
  };
  const isSecurityContainer = (c: CanvasNode) => {
    const lbl = (c.label || '').toLowerCase();
    const cid = (c.id || '').toLowerCase();
    return (
      lbl.includes('security') ||
      lbl.includes('iam') ||
      lbl.includes('governance') ||
      lbl.includes('observability') ||
      lbl.includes('ai') ||
      cid === 'secgrp'
    );
  };

  const edgeContainerTarget = customContainers.find(isEdgeContainer);
  const drContainerTarget = customContainers.find(isDrContainer);
  const logContainerTarget = customContainers.find(isLoggingContainer);
  const s3ContainerTarget = customContainers.find(isStorageContainer);
  const secContainerTarget = customContainers.find(isSecurityContainer);

  for (const leaf of leafNodes) {
    const targetGroupId = leaf.groupId || leaf.parentId;
    if (targetGroupId && containerChildrenMap.has(targetGroupId)) {
      containerChildrenMap.get(targetGroupId)!.push(leaf);
      continue;
    } else if (targetGroupId && subnetChildrenMap.has(targetGroupId)) {
      subnetChildrenMap.get(targetGroupId)!.push(leaf);
      continue;
    }

    // Heuristic association for subnets
    if (
      leaf.resourceType === 'aws_rds' ||
      leaf.resourceType === 'azure_sql' ||
      leaf.resourceType === 'aws_elasticache' ||
      leaf.resourceType === 'azure_redis' ||
      leaf.resourceType === 'azure_postgres' ||
      leaf.resourceType === 'azure_mysql'
    ) {
      const dbSubnet = subnetNodes.find(isDatabaseSubnet) || subnetNodes[subnetNodes.length - 1];
      if (dbSubnet) {
        subnetChildrenMap.get(dbSubnet.id)!.push({ ...leaf, groupId: dbSubnet.id });
        continue;
      }
    } else if (
      leaf.resourceType === 'aws_alb' ||
      leaf.resourceType === 'azure_app_gateway' ||
      leaf.resourceType === 'aws_nat'
    ) {
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

    // Heuristics for custom containers (Edge, Storage, DR, Logging, Security)
    const leafLbl = (leaf.label || '').toLowerCase();
    const leafId = (leaf.id || '').toLowerCase();

    // 1. Edge services -> Edge container
    if (
      edgeContainerTarget &&
      (leaf.resourceType === 'aws_cloudfront' ||
       leaf.resourceType === 'aws_waf' ||
       leaf.resourceType === 'azure_front_door' ||
       leaf.resourceType === 'azure_cdn' ||
       leafLbl.includes('cloudfront') ||
       leafLbl.includes('waf'))
    ) {
      containerChildrenMap.get(edgeContainerTarget.id)!.push({ ...leaf, groupId: edgeContainerTarget.id });
      continue;
    }

    // 2. DR Storage Replicas -> DR container
    const isDrReplica =
      (leaf.resourceType === 'aws_s3' || leaf.resourceType === 'azure_storage' || leaf.resourceType === 'azure_blob') &&
      (leafLbl.includes('crr') ||
       leafLbl.includes('osaka') ||
       leafLbl.includes('replica') ||
       leafLbl.includes('dr') ||
       leafId.includes('crr'));
    if (drContainerTarget && isDrReplica) {
      containerChildrenMap.get(drContainerTarget.id)!.push({ ...leaf, groupId: drContainerTarget.id });
      continue;
    }

    // 3. Regional Storage -> Storage container
    if (s3ContainerTarget && (leaf.resourceType === 'aws_s3' || leaf.resourceType === 'azure_storage' || leaf.resourceType === 'azure_blob')) {
      containerChildrenMap.get(s3ContainerTarget.id)!.push({ ...leaf, groupId: s3ContainerTarget.id });
      continue;
    }

    // 4. Logging / Audit services -> Logging container
    if (logContainerTarget && (leaf.resourceType === 'aws_config' || leaf.resourceType === 'aws_cloudtrail' || leafLbl.includes('cloudtrail') || leafLbl.includes('config'))) {
      containerChildrenMap.get(logContainerTarget.id)!.push({ ...leaf, groupId: logContainerTarget.id });
      continue;
    }

    // 5. Security, IAM, Observability & Governance -> Security container
    if (
      secContainerTarget &&
      (leaf.resourceType.includes('iam') ||
       leaf.resourceType === 'aws_kms' ||
       leaf.resourceType === 'aws_secretsmanager' ||
       leaf.resourceType.includes('guardduty') ||
       leaf.resourceType.includes('security_hub') ||
       leaf.resourceType === 'aws_cloudwatch' ||
       leaf.resourceType === 'aws_sns' ||
       leaf.resourceType.includes('bedrock') ||
       leafLbl.includes('role') ||
       leafLbl.includes('user') ||
       leafLbl.includes('policy') ||
       leafLbl.includes('iam') ||
       leafLbl.includes('kms') ||
       leafLbl.includes('secret') ||
       leafLbl.includes('guardduty') ||
       leafLbl.includes('cloudwatch') ||
       leafLbl.includes('sns') ||
       leafLbl.includes('monitoring') ||
       leafLbl.includes('deployer'))
    ) {
      containerChildrenMap.get(secContainerTarget.id)!.push({ ...leaf, groupId: secContainerTarget.id });
      continue;
    }

    uncontainedLeaves.push(leaf);
  }

  const updatedNodes: CanvasNode[] = [];
  const LEAF_CARD_W = 180;
  const LEAF_CARD_H = 100;

  // Classify uncontained leaves
  const edgeIngressOrder: Record<string, number> = {
    aws_client: 0,
    azure_client: 0,
    aws_internet: 1,
    azure_internet: 1,
    aws_route53: 2,
    azure_front_door: 2,
    aws_cloudfront: 3,
    azure_cdn: 3,
    aws_waf: 4,
    azure_waf: 4,
  };

  const vpcGatewayOrder: Record<string, number> = {
    aws_igw: 1,
    azure_public_ip: 2,
    aws_route_table: 3,
    aws_sg: 4,
    azure_nsg: 4,
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

  const edgeContainers = customContainers.filter(isEdgeContainer);
  const leftContainers = customContainers.filter(
    (c) =>
      !edgeContainers.includes(c) &&
      (isDrContainer(c) ||
        isLoggingContainer(c) ||
        isStorageContainer(c) ||
        c.position.x < (primaryVpc?.position.x ?? 400)) &&
      !isSecurityContainer(c)
  );
  const rightContainers = customContainers.filter((c) => !edgeContainers.includes(c) && !leftContainers.includes(c));

  // Determine starting coordinates dynamically based on actual left container widths
  let maxLeftContainerWidth = 0;
  for (const lc of leftContainers) {
    const children = containerChildrenMap.get(lc.id) || [];
    const cols = children.length <= 1 ? 1 : 2;
    const padX = 40;
    const colStep = 270;
    const computedW = Math.max(lc.width || 380, padX * 2 + (cols - 1) * colStep + LEAF_CARD_W);
    maxLeftContainerWidth = Math.max(maxLeftContainerWidth, computedW);
  }

  const leftFlankW = maxLeftContainerWidth > 0 ? maxLeftContainerWidth : 0;
  const VPC_START_X = startX + (leftFlankW > 0 ? leftFlankW + 90 : 40);
  let maxEdgeBottom = 0;
  if (edgeContainers.length > 0) {
    for (const ec of edgeContainers) {
      const padTop = 85;
      const ecH = Math.max(ec.height || 210, padTop + LEAF_CARD_H + 35);
      maxEdgeBottom = Math.max(maxEdgeBottom, 35 + ecH);
    }
  } else if (edgeIngressNodes.length > 0) {
    maxEdgeBottom = 70 + LEAF_CARD_H;
  }
  const hasEdgeIngress = edgeIngressNodes.length > 0 || edgeContainers.length > 0;
  const VPC_START_Y = hasEdgeIngress ? Math.max(295, maxEdgeBottom + 45) : 80;
  const hasVpcGateways = vpcGatewayNodes.length > 0;

  // ── Layout Edge Containers & Ingress at top outside VPC
  if (edgeContainers.length > 0) {
    let eX = VPC_START_X + 20;
    edgeContainers.forEach((ec) => {
      const children = containerChildrenMap.get(ec.id) || [];
      const cols = Math.max(1, children.length);
      const padTop = 85;
      const ecW = Math.max(ec.width || 380, 40 * 2 + (cols - 1) * 210 + LEAF_CARD_W);
      const ecH = Math.max(ec.height || 210, padTop + LEAF_CARD_H + 35);

      children.forEach((child, idx) => {
        updatedNodes.push({
          ...child,
          position: { x: eX + 40 + idx * 210, y: 35 + padTop },
          groupId: ec.id,
        });
      });

      updatedNodes.push({
        ...ec,
        position: { x: eX, y: 35 },
        width: ecW,
        height: ecH,
        groupId: primaryBoundary ? primaryBoundary.id : undefined,
      });

      eX += ecW + 40;
    });
  } else if (hasEdgeIngress) {
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

  // ── Layout Left Flank Containers (e.g. S3 Storage, Logging, DR)
  if (leftContainers.length > 0) {
    let lY = VPC_START_Y;
    leftContainers.forEach((lc) => {
      const children = containerChildrenMap.get(lc.id) || [];
      const cols = children.length <= 1 ? 1 : 2;
      const rows = Math.ceil(children.length / cols) || 1;
      const padTop = 95;
      const padX = 40;
      const colStep = 270;
      const rowStep = 210;

      const lcW = Math.max(lc.width || 380, padX * 2 + (cols - 1) * colStep + LEAF_CARD_W);
      const lcH = Math.max(lc.height || 220, padTop + (rows - 1) * rowStep + 130 + 35);

      children.forEach((child, idx) => {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        updatedNodes.push({
          ...child,
          position: {
            x: startX + 30 + padX + col * colStep,
            y: lY + padTop + row * rowStep,
          },
          groupId: lc.id,
        });
      });

      updatedNodes.push({
        ...lc,
        position: { x: startX + 30, y: lY },
        width: lcW,
        height: lcH,
        groupId: primaryBoundary ? primaryBoundary.id : undefined,
      });

      lY += lcH + 40;
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

  const COL_WIDTH = 720;
  const COL_GAP = 140;
  const SUB_PADDING_X = 60;
  const SUB_PADDING_Y = 100; // generous 100px clearance below subnet header, badges, and CIDRs
  const SUB_GAP_Y = 130; // 130px open horizontal highway corridor between tiers for edges/badges

  const maxVpcWidth = 50 * 2 + maxCols * COL_WIDTH + (maxCols - 1) * COL_GAP;

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

  let currentSubnetY = hasVpcGateways ? gwY + LEAF_CARD_H + 60 : VPC_START_Y + 75;

  for (const tier of tiers) {
    let currentTierMaxH = 220;

    tier.forEach((subnet, colIdx) => {
      const children = subnetChildrenMap.get(subnet.id) || [];
      const childCols = Math.max(1, Math.min(children.length, 2));
      const childRows = Math.ceil(children.length / childCols) || 1;

      const subWidth = tier.length === 1 && maxCols > 1 ? maxCols * COL_WIDTH + (maxCols - 1) * COL_GAP : COL_WIDTH;
      const subHeight = Math.max(220, SUB_PADDING_Y + (childRows - 1) * 210 + 130 + 40);
      const subX = VPC_START_X + 40 + colIdx * (COL_WIDTH + COL_GAP);
      const subY = currentSubnetY;

      currentTierMaxH = Math.max(currentTierMaxH, subHeight);

      // Position children inside subnet with expansive spacing
      if (children.length === 1) {
        const childX = subX + Math.round((subWidth - LEAF_CARD_W) / 2);
        const childY = subY + SUB_PADDING_Y;
        updatedNodes.push({
          ...children[0],
          position: { x: childX, y: childY },
          groupId: subnet.id,
        });
      } else if (children.length === 2) {
        const cGap = Math.max(160, subWidth - SUB_PADDING_X * 2 - LEAF_CARD_W * 2);
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
        const colStep = (subWidth - SUB_PADDING_X * 2 - LEAF_CARD_W) / Math.max(1, childCols - 1);
        children.forEach((child, idx) => {
          const col = idx % childCols;
          const row = Math.floor(idx / childCols);
          const childX = subX + SUB_PADDING_X + col * colStep;
          const childY = subY + SUB_PADDING_Y + row * 240;
          updatedNodes.push({
            ...child,
            position: { x: childX, y: childY },
            groupId: subnet.id,
          });
        });
      }

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
  const vpcHeight = Math.max(560, currentSubnetY - SUB_GAP_Y + 40 - VPC_START_Y);
  if (vpcNodes.length > 0) {
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

  // ── Layout Right Flank Custom Containers (e.g. AI, Security, Observability & Governance)
  let rightFlankX = VPC_START_X + maxVpcWidth + 160;
  let flankY = Math.max(VPC_START_Y + 20, 210);

  if (rightContainers.length > 0) {
    rightContainers.forEach((rc) => {
      const children = containerChildrenMap.get(rc.id) || [];
      const cols = children.length <= 3 ? children.length : children.length <= 6 ? 2 : 3;
      const rows = Math.ceil(children.length / (cols || 1)) || 1;
      const padTop = 100; // 100px clearance ensures container header never touches child nodes
      const padX = 50;
      const colStep = 340;
      const rowStep = 250;

      const computedW = padX * 2 + (Math.max(1, cols) - 1) * colStep + LEAF_CARD_W;
      const computedH = padTop + (rows - 1) * rowStep + 130 + 45;
      const rcW = Math.max(560, computedW);
      const rcH = Math.max(500, computedH);

      children.forEach((child, idx) => {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        updatedNodes.push({
          ...child,
          position: {
            x: rightFlankX + padX + col * colStep,
            y: flankY + padTop + row * rowStep,
          },
          groupId: rc.id,
        });
      });

      updatedNodes.push({
        ...rc,
        position: { x: rightFlankX, y: flankY },
        width: rcW,
        height: rcH,
        groupId: primaryBoundary ? primaryBoundary.id : undefined,
      });

      rightFlankX += rcW + 50;
    });
  }

  // ── Layout Loose Regional Services in an adaptive, compact multi-column 2D grid
  // Generous horizontal (280px) and vertical (220px) clearances eliminate any text/edge-label collisions.
  let looseMaxY = flankY;
  if (remainingLeaves.length > 0) {
    const ROW_STEP_Y = 220; // 220px row step gives 90px clear air below card text for edge routing & pills
    const COL_STEP_X = 280; // 280px col step gives 135px horizontal clearance between node texts for edge pills
    const targetMaxRows = Math.max(3, Math.min(5, Math.floor((vpcHeight - 40) / ROW_STEP_Y)) || 4);
    const flankCols = Math.max(2, Math.min(4, Math.ceil(remainingLeaves.length / targetMaxRows)));

    // Categorize nodes so related services sit next to each other
    const categoryPriority = (rType: string) => {
      const t = rType.toLowerCase();
      if (t.includes('iam') || t.includes('role') || t.includes('user') || t.includes('identity')) return 1;
      if (t.includes('kms') || t.includes('secret') || t.includes('guardduty') || t.includes('waf') || t.includes('shield')) return 2;
      if (t.includes('s3') || t.includes('dynamo') || t.includes('blob') || t.includes('storage') || t.includes('ebs')) return 3;
      if (t.includes('cloudwatch') || t.includes('cloudtrail') || t.includes('config') || t.includes('monitor') || t.includes('log')) return 4;
      if (t.includes('sqs') || t.includes('sns') || t.includes('event') || t.includes('kinesis')) return 5;
      return 6;
    };

    const sortedRemaining = [...remainingLeaves].sort(
      (a, b) => categoryPriority(a.resourceType) - categoryPriority(b.resourceType)
    );

    const flankStartY = Math.max(VPC_START_Y + 30, 210);

    sortedRemaining.forEach((node, idx) => {
      const col = idx % flankCols;
      const row = Math.floor(idx / flankCols);
      const nodeX = rightFlankX + col * COL_STEP_X;
      const nodeY = flankStartY + row * ROW_STEP_Y;

      updatedNodes.push({
        ...node,
        position: { x: nodeX, y: nodeY },
        groupId: primaryBoundary ? primaryBoundary.id : undefined,
      });
    });

    const totalRows = Math.ceil(remainingLeaves.length / flankCols);
    looseMaxY = flankStartY + (totalRows - 1) * ROW_STEP_Y + 140;
    rightFlankX += flankCols * COL_STEP_X + 40;
  }

  const totalEndX = rightFlankX + 40;
  const totalMaxY = Math.max(currentSubnetY + 80, flankY + 80, looseMaxY + 80);

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
  const isAws = (n: CanvasNode) => {
    if (n.provider === 'aws' || n.resourceType.startsWith('aws_') || n.resourceType === 'aws_cloud_boundary') {
      return true;
    }
    if (n.type === 'containerNode' || n.resourceType === 'containerNode' || n.resourceType === 'groupNode') {
      const hasAwsChild = nodes.some(
        (child) =>
          (child.groupId === n.id || child.parentId === n.id) &&
          (child.provider === 'aws' || child.resourceType.startsWith('aws_'))
      );
      if (hasAwsChild) return true;
      const hasAnyAws = nodes.some((other) => other.provider === 'aws' || other.resourceType.startsWith('aws_'));
      const hasAnyAzure = nodes.some((other) => other.provider === 'azure' || other.resourceType.startsWith('azure_'));
      if (hasAnyAws && !hasAnyAzure) return true;
    }
    return false;
  };

  const isAzure = (n: CanvasNode) => {
    if (n.provider === 'azure' || n.resourceType.startsWith('azure_') || n.resourceType === 'azure_cloud_boundary') {
      return true;
    }
    if (n.type === 'containerNode' || n.resourceType === 'containerNode' || n.resourceType === 'groupNode') {
      const hasAzChild = nodes.some(
        (child) =>
          (child.groupId === n.id || child.parentId === n.id) &&
          (child.provider === 'azure' || child.resourceType.startsWith('azure_'))
      );
      if (hasAzChild) return true;
      const hasAnyAzure = nodes.some((other) => other.provider === 'azure' || other.resourceType.startsWith('azure_'));
      const hasAnyAws = nodes.some((other) => other.provider === 'aws' || other.resourceType.startsWith('aws_'));
      if (hasAnyAzure && !hasAnyAws) return true;
    }
    return false;
  };

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

  // Z-Order: Boundary (-3) -> VPC/VNet (-2) -> Custom Containers (-1.5) -> Subnets (-1) -> Leaf nodes (1)
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
      if (n.type === 'containerNode' || n.resourceType === 'containerNode' || n.resourceType === 'groupNode') {
        return -1.5;
      }
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

