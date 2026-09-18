/**
 * CloudCraft — Architecture Auto-Fix Engine
 *
 * Provides deterministic, multi-pass architecture repair with strict safety guarantees:
 * - Validate -> Repair -> Revalidate lifecycle.
 * - Only executes deterministic safe repairs:
 *   - Detaches dangling edges
 *   - Removes self-referential connections
 *   - Deduplicates redundant relationships
 *   - Clears orphan / broken container parent pointers
 *   - Rectifies cross-cloud containment
 *   - Un-nests illegal nested subnets and inverted network hierarchy
 *   - Allocates missing network containers and subnets for uncontained workloads
 *   - Resolves overlapping coordinates via topological auto-layout
 * - If no deterministic safe repair exists, explicitly returns "Manual action required".
 * - Never deletes or mutates valid user infrastructure merely to make validation pass.
 */

import { CanvasNode, CanvasEdge, ProviderMode, ScaleProfile, CloudProvider, inferNodeProvider } from '@/types';
import { toCanonicalGraph, validateCanonicalArchitecture, CanonicalArchitectureGraph } from '@/lib/domain/canonicalArchitecture';
import { autoLayoutArchitecture } from '@/lib/canvas/autoLayout';

export interface AutoFixResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  changesApplied: string[];
  isValid: boolean;
  remainingIssues: string[];
  manualActionsRequired: string[];
  iterationCount: number;
}

export class ArchitectureAutoFixEngine {
  private static instance: ArchitectureAutoFixEngine;

  public static getInstance(): ArchitectureAutoFixEngine {
    if (!ArchitectureAutoFixEngine.instance) {
      ArchitectureAutoFixEngine.instance = new ArchitectureAutoFixEngine();
    }
    return ArchitectureAutoFixEngine.instance;
  }

  public fixArchitecture(
    inputNodes: CanvasNode[],
    inputEdges: CanvasEdge[],
    canonical?: CanonicalArchitectureGraph
  ): AutoFixResult {
    return this.repairArchitecture(inputNodes, inputEdges, canonical);
  }

  public autoFix(
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    provider: CloudProvider = 'aws',
    providerMode: ProviderMode = 'AWS',
  ) {
    const canonical = toCanonicalGraph({
      id: 'autofix-graph',
      name: 'Auto-Fix Analysis',
      provider,
      providerMode,
      nodes,
      edges,
    });
    const validationBefore = validateCanonicalArchitecture(canonical);
    const repairResult = this.repairArchitecture(nodes, edges, canonical);
    const afterCanonical = toCanonicalGraph({
      id: 'autofix-graph-after',
      name: 'Auto-Fix Analysis After',
      provider,
      providerMode,
      nodes: repairResult.nodes,
      edges: repairResult.edges,
    });
    const validationAfter = validateCanonicalArchitecture(afterCanonical);

    const manualActionsRequired = repairResult.manualActionsRequired?.map((action, idx) => ({
      id: `manual-action-${idx}`,
      description: action,
    })) || [];

    return {
      fixed: repairResult.changesApplied.length > 0,
      nodes: repairResult.nodes,
      edges: repairResult.edges,
      actionsTaken: repairResult.changesApplied,
      validationBefore,
      validationAfter,
      manualActionsRequired,
    };
  }

  public repairArchitecture(
    inputNodes: CanvasNode[],
    inputEdges: CanvasEdge[],
    canonical?: CanonicalArchitectureGraph
  ): AutoFixResult {
    let currentNodes: CanvasNode[] = JSON.parse(JSON.stringify(inputNodes));
    let currentEdges: CanvasEdge[] = JSON.parse(JSON.stringify(inputEdges));
    const allChanges: string[] = [];

    const graphOptions = {
      providerMode: canonical?.providerMode,
      scaleProfile: canonical?.scaleProfile,
    };

    // ── STEP 1: VALIDATE INITIAL STATE ───────────────────────────────────────
    const initialGraph = toCanonicalGraph(currentNodes, currentEdges, graphOptions);
    const initialReport = validateCanonicalArchitecture(initialGraph);

    // ── STEP 2: DETERMINISTIC SAFE REPAIRS (UP TO 5 PASSES) ──────────────────
    const MAX_PASSES = 5;
    let iteration = 0;

    for (; iteration < MAX_PASSES; iteration++) {
      const passChanges: string[] = [];
      const nodeMap = new Map<string, CanvasNode>(currentNodes.map((n) => [n.id, n]));

      // 1. Clean Dangling Edges (Missing Source or Target)
      const initialEdgeCount = currentEdges.length;
      currentEdges = currentEdges.filter(
        (e) => nodeMap.has(e.source) && nodeMap.has(e.target)
      );
      const danglingRemoved = initialEdgeCount - currentEdges.length;
      if (danglingRemoved > 0) {
        passChanges.push(`Removed ${danglingRemoved} dangling edge(s) referencing missing nodes`);
      }

      // 2. Remove Self-Connections
      const beforeSelfCount = currentEdges.length;
      currentEdges = currentEdges.filter((e) => e.source !== e.target);
      const selfRemoved = beforeSelfCount - currentEdges.length;
      if (selfRemoved > 0) {
        passChanges.push(`Removed ${selfRemoved} invalid self-referential connection(s)`);
      }

      // 3. Deduplicate Edges
      const seenEdges = new Set<string>();
      const dedupedEdges: CanvasEdge[] = [];
      let dupsRemoved = 0;
      for (const e of currentEdges) {
        const relType = e.relationshipType || e.edgeType || 'NETWORK_FLOW';
        const key = `${e.source}:${relType}:${e.target}`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          dedupedEdges.push(e);
        } else {
          dupsRemoved++;
        }
      }
      if (dupsRemoved > 0) {
        currentEdges = dedupedEdges;
        passChanges.push(`Removed ${dupsRemoved} duplicate relationship edge(s)`);
      }

      // 4. Clear Broken or Self-Referencing Parent Pointers
      for (const node of currentNodes) {
        const parentId = node.groupId || node.parentId;
        if (parentId && !nodeMap.has(parentId)) {
          node.groupId = undefined;
          node.parentId = undefined;
          passChanges.push(`Cleared broken parent container pointer on "${node.label}"`);
        }
        if (node.groupId === node.id || node.parentId === node.id) {
          node.groupId = undefined;
          node.parentId = undefined;
          passChanges.push(`Cleared self-parenting reference on "${node.label}"`);
        }
      }

      // 5. Fix Cross-Cloud Containment
      for (const node of currentNodes) {
        const pId = node.groupId || node.parentId;
        if (!pId || !nodeMap.has(pId)) continue;
        const parent = nodeMap.get(pId)!;
        const nodeProvider = inferNodeProvider(node);
        const parentProvider = inferNodeProvider(parent);

        if (nodeProvider !== parentProvider) {
          node.groupId = undefined;
          node.parentId = undefined;

          // Detach only — do NOT fabricate a replacement cross-cloud edge.
          // A container (subnet/vnet/resource group) is not an addressable
          // application endpoint, so inventing a "VPN / HTTPS" link to it
          // would assert a specific network fact (protocol, port, tunnel
          // topology) that Auto-Fix has no basis to know is what the user
          // actually intends. The illegal containment is removed; if a real
          // cross-cloud connection is needed, the user draws it explicitly
          // and it is validated by the same rules as any other edge.
          passChanges.push(`Fixed illegal cross-cloud containment: detached ${nodeProvider.toUpperCase()} "${node.label}" from ${parentProvider.toUpperCase()} "${parent.label}" (no replacement connection was inferred — draw one explicitly if needed)`);
        }
      }

      // 6. Fix Inverted Network Hierarchy (VPC/VNet inside Subnet)
      for (const node of currentNodes) {
        const pId = node.groupId || node.parentId;
        if (!pId || !nodeMap.has(pId)) continue;
        const parent = nodeMap.get(pId)!;
        if ((node.resourceType === 'aws_vpc' || node.resourceType === 'azure_vnet') && parent.resourceType.includes('subnet')) {
          node.groupId = undefined;
          node.parentId = undefined;
          passChanges.push(`Reparented inverted network container "${node.label}" outside "${parent.label}"`);
        }
      }

      // 7. Fix Nested Subnets (Subnet inside Subnet)
      for (const node of currentNodes) {
        if (!node.resourceType.includes('subnet')) continue;
        const pId = node.groupId || node.parentId;
        if (!pId || !nodeMap.has(pId)) continue;
        const parent = nodeMap.get(pId)!;
        if (parent.resourceType.includes('subnet')) {
          node.groupId = parent.groupId;
          node.parentId = parent.parentId;
          passChanges.push(`Reparented nested subnet "${node.label}" directly to parent network container`);
        }
      }

      // 8. Ensure Subnets are in a VPC / VNet
      for (const node of currentNodes) {
        if (!node.resourceType.includes('subnet')) continue;
        const pId = node.groupId || node.parentId;
        const parent = pId ? nodeMap.get(pId) : undefined;

        if (!parent || (!parent.resourceType.includes('vpc') && !parent.resourceType.includes('vnet'))) {
          const isAzure = node.provider === 'azure' || node.resourceType.startsWith('azure_');
          const targetVpcType = isAzure ? 'azure_vnet' : 'aws_vpc';
          let matchingVpc = currentNodes.find((n) => n.resourceType === targetVpcType);

          if (!matchingVpc) {
            const newVpcId = isAzure ? 'autofix-azure-vnet-prod' : 'autofix-aws-vpc-prod';
            matchingVpc = {
              id: newVpcId,
              type: 'containerNode',
              resourceType: targetVpcType,
              provider: isAzure ? 'azure' : 'aws',
              label: isAzure ? 'Production VNet (10.0.0.0/16)' : 'Production VPC (10.0.0.0/16)',
              position: { x: Math.max(20, node.position.x - 40), y: Math.max(20, node.position.y - 120) },
              width: 820,
              height: 540,
              config: isAzure ? { addressSpace: '10.0.0.0/16', name: 'prod-vnet' } : { cidrBlock: '10.0.0.0/16', enableDnsSupport: true, enableDnsHostnames: true, name: 'prod-vpc' },
            };
            currentNodes.push(matchingVpc);
            nodeMap.set(matchingVpc.id, matchingVpc);
            passChanges.push(`Synthesized missing ${isAzure ? 'Virtual Network' : 'VPC'} container "${matchingVpc.label}"`);
          }

          node.groupId = matchingVpc.id;
          node.parentId = matchingVpc.id;
          passChanges.push(`Placed uncontained subnet "${node.label}" into network container "${matchingVpc.label}"`);
        }
      }

      // 9. Fix Compute Directly in VPC/VNet or Naked (Requires Subnet)
      for (const node of currentNodes) {
        const isCompute =
          node.resourceType === 'aws_ec2' ||
          node.resourceType === 'azure_vm' ||
          node.resourceType === 'aws_auto_scaling' ||
          node.resourceType === 'azure_vmss';

        if (!isCompute) continue;
        const pId = node.groupId || node.parentId;
        const parent = pId ? nodeMap.get(pId) : undefined;
        const isParentSubnet = parent && parent.resourceType.includes('subnet');

        if (!isParentSubnet) {
          const isAzure = node.provider === 'azure' || node.resourceType.startsWith('azure_');
          const subnetType = isAzure ? 'azure_subnet' : 'aws_subnet';
          const vpcType = isAzure ? 'azure_vnet' : 'aws_vpc';

          let vpc = (parent && (parent.resourceType.includes('vpc') || parent.resourceType.includes('vnet')))
            ? parent
            : currentNodes.find((n) => n.resourceType === vpcType);

          if (!vpc) {
            const newVpcId = isAzure ? 'autofix-azure-vnet-prod' : 'autofix-aws-vpc-prod';
            vpc = {
              id: newVpcId,
              type: 'containerNode',
              resourceType: vpcType,
              provider: isAzure ? 'azure' : 'aws',
              label: isAzure ? 'Production VNet (10.0.0.0/16)' : 'Production VPC (10.0.0.0/16)',
              position: { x: Math.max(20, node.position.x - 60), y: Math.max(20, node.position.y - 140) },
              width: 820,
              height: 540,
              config: isAzure ? { addressSpace: '10.0.0.0/16' } : { cidrBlock: '10.0.0.0/16', enableDnsSupport: true, enableDnsHostnames: true },
            };
            currentNodes.push(vpc);
            nodeMap.set(vpc.id, vpc);
            passChanges.push(`Created missing ${isAzure ? 'Virtual Network' : 'VPC'} container for compute workloads`);
          }

          let appSubnet = currentNodes.find(
            (n) =>
              (n.groupId === vpc!.id || n.parentId === vpc!.id) &&
              n.resourceType === subnetType &&
              !n.label.toLowerCase().includes('db') &&
              !n.label.toLowerCase().includes('data')
          );

          if (!appSubnet) {
            const newSubnetId = isAzure ? 'autofix-app-sub-azure' : 'autofix-app-sub-aws';
            appSubnet = {
              id: newSubnetId,
              type: 'containerNode',
              resourceType: subnetType,
              provider: isAzure ? 'azure' : 'aws',
              label: isAzure ? 'App Workload Subnet (10.0.10.0/24)' : 'Private App Subnet (10.0.10.0/24)',
              groupId: vpc.id,
              parentId: vpc.id,
              position: { x: vpc.position.x + 40, y: vpc.position.y + 120 },
              width: 420,
              height: 200,
              config: isAzure ? { addressPrefix: '10.0.10.0/24' } : { cidrBlock: '10.0.10.0/24', mapPublicIpOnLaunch: false },
            };
            currentNodes.push(appSubnet);
            nodeMap.set(appSubnet.id, appSubnet);
            passChanges.push(`Created application subnet "${appSubnet.label}"`);
          }

          node.groupId = appSubnet.id;
          node.parentId = appSubnet.id;
          passChanges.push(`Placed compute resource "${node.label}" into valid application subnet "${appSubnet.label}"`);
        }
      }

      // 10. Fix Database Directly in VPC/VNet or Naked (Requires DB Subnet)
      for (const node of currentNodes) {
        const isDb =
          node.resourceType === 'aws_rds' ||
          node.resourceType === 'azure_sql' ||
          node.resourceType === 'aws_elasticache' ||
          node.resourceType === 'azure_redis';

        if (!isDb) continue;
        const pId = node.groupId || node.parentId;
        const parent = pId ? nodeMap.get(pId) : undefined;
        const isParentDbSubnet =
          parent &&
          parent.resourceType.includes('subnet') &&
          (parent.label.toLowerCase().includes('db') ||
            parent.label.toLowerCase().includes('data') ||
            parent.label.toLowerCase().includes('database') ||
            parent.label.toLowerCase().includes('sql'));

        if (!isParentDbSubnet) {
          const isAzure = node.provider === 'azure' || node.resourceType.startsWith('azure_');
          const subnetType = isAzure ? 'azure_subnet' : 'aws_subnet';
          const vpcType = isAzure ? 'azure_vnet' : 'aws_vpc';

          let vpc = (parent && (parent.resourceType.includes('vpc') || parent.resourceType.includes('vnet')))
            ? parent
            : (parent?.groupId ? nodeMap.get(parent.groupId) : undefined);

          if (!vpc) {
            vpc = currentNodes.find((n) => n.resourceType === vpcType);
          }

          if (!vpc) {
            const newVpcId = isAzure ? 'autofix-azure-vnet-prod' : 'autofix-aws-vpc-prod';
            vpc = {
              id: newVpcId,
              type: 'containerNode',
              resourceType: vpcType,
              provider: isAzure ? 'azure' : 'aws',
              label: isAzure ? 'Production VNet (10.0.0.0/16)' : 'Production VPC (10.0.0.0/16)',
              position: { x: Math.max(20, node.position.x - 60), y: Math.max(20, node.position.y - 140) },
              width: 820,
              height: 540,
              config: isAzure ? { addressSpace: '10.0.0.0/16' } : { cidrBlock: '10.0.0.0/16', enableDnsSupport: true, enableDnsHostnames: true },
            };
            currentNodes.push(vpc);
            nodeMap.set(vpc.id, vpc);
            passChanges.push(`Created network container for database layer`);
          }

          let dbSubnet = currentNodes.find(
            (n) =>
              (n.groupId === vpc!.id || n.parentId === vpc!.id) &&
              n.resourceType === subnetType &&
              (n.label.toLowerCase().includes('db') || n.label.toLowerCase().includes('data') || n.label.toLowerCase().includes('database'))
          );

          if (!dbSubnet) {
            const newSubnetId = isAzure ? 'autofix-db-sub-azure' : 'autofix-db-sub-aws';
            dbSubnet = {
              id: newSubnetId,
              type: 'containerNode',
              resourceType: subnetType,
              provider: isAzure ? 'azure' : 'aws',
              label: isAzure ? 'Data Tier Subnet (10.0.20.0/24)' : 'Private Database Subnet (10.0.20.0/24)',
              groupId: vpc.id,
              parentId: vpc.id,
              position: { x: vpc.position.x + 40, y: vpc.position.y + 300 },
              width: 420,
              height: 180,
              config: isAzure ? { addressPrefix: '10.0.20.0/24' } : { cidrBlock: '10.0.20.0/24', mapPublicIpOnLaunch: false },
            };
            currentNodes.push(dbSubnet);
            nodeMap.set(dbSubnet.id, dbSubnet);
            passChanges.push(`Created dedicated database subnet "${dbSubnet.label}"`);
          }

          node.groupId = dbSubnet.id;
          node.parentId = dbSubnet.id;
          passChanges.push(`Moved database "${node.label}" into dedicated database subnet "${dbSubnet.label}"`);
        }
      }

      // 11. Overlapping Node Collisions
      let hasOverlap = false;
      const nonContainers = currentNodes.filter((n) => !n.type?.includes('container') && !n.resourceType.includes('boundary'));
      for (let i = 0; i < nonContainers.length; i++) {
        for (let j = i + 1; j < nonContainers.length; j++) {
          if (Math.abs(nonContainers[i].position.x - nonContainers[j].position.x) < 40 &&
              Math.abs(nonContainers[i].position.y - nonContainers[j].position.y) < 40) {
            hasOverlap = true;
            break;
          }
        }
        if (hasOverlap) break;
      }

      if (hasOverlap) {
        const layoutRes = autoLayoutArchitecture(currentNodes, currentEdges);
        currentNodes = layoutRes.nodes;
        currentEdges = layoutRes.edges;
        passChanges.push('Re-aligned overlapping resources using deterministic auto-layout');
      }

      if (passChanges.length > 0) {
        allChanges.push(...passChanges);
      }

      // ── STEP 3: REVALIDATE AFTER PASS ─────────────────────────────────────
      const midGraph = toCanonicalGraph(currentNodes, currentEdges, graphOptions);
      const midReport = validateCanonicalArchitecture(midGraph);

      if (midReport.isValid || passChanges.length === 0) {
        break;
      }
    }

    // ── STEP 4: FINAL REVALIDATION & MANUAL ACTION EXTRACTION ────────────────
    const finalGraph = toCanonicalGraph(currentNodes, currentEdges, graphOptions);
    const finalReport = validateCanonicalArchitecture(finalGraph);

    const manualActionsRequired: string[] = [];
    if (!finalReport.isValid) {
      for (const issue of finalReport.issues) {
        manualActionsRequired.push(
          `Manual action required: ${issue.message} — ${issue.suggestedAction} [${issue.code}]`
        );
      }
    }

    return {
      nodes: currentNodes,
      edges: currentEdges,
      changesApplied: allChanges,
      isValid: finalReport.isValid,
      remainingIssues: finalReport.errors,
      manualActionsRequired,
      iterationCount: iteration + 1,
    };
  }
}

export const architectureAutoFixEngine = ArchitectureAutoFixEngine.getInstance();
