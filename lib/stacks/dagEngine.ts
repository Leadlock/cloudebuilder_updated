/**
 * Directed Acyclic Graph (DAG) Engine for Multi-Stack Infrastructure Orchestration.
 * Handles topological sorting, cycle detection, parallel tier calculation, and auto-clustering.
 */

import type { CanvasNode } from '@/types';
import type { DagExecutionTier, DagValidationResult, StackDefinition } from './types';

export class DagEngine {
  /**
   * Validates a collection of stacks and calculates parallel execution tiers.
   * Uses Kahn's algorithm for topological sorting and cycle detection.
   */
  public validateAndCalculateTiers(stacks: Record<string, StackDefinition>): DagValidationResult {
    const stackIds = Object.keys(stacks);
    if (stackIds.length === 0) {
      return { isValid: true, tiers: [] };
    }

    // In-degree calculation & adjacency list
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>(); // stackId -> stacks that depend on it

    for (const id of stackIds) {
      inDegree.set(id, 0);
      dependents.set(id, []);
    }

    const errors: string[] = [];

    for (const [id, stack] of Object.entries(stacks)) {
      for (const depId of stack.dependsOn) {
        if (!stacks[depId]) {
          errors.push(`Stack "${stack.name}" depends on non-existent stack "${depId}".`);
          continue;
        }
        inDegree.set(id, (inDegree.get(id) || 0) + 1);
        dependents.get(depId)?.push(id);
      }
    }

    if (errors.length > 0) {
      return { isValid: false, tiers: [], errors };
    }

    // Queue of stacks with in-degree 0
    let currentTierStacks: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) {
        currentTierStacks.push(id);
      }
    }

    const tiers: DagExecutionTier[] = [];
    let visitedCount = 0;
    let tierIndex = 0;

    while (currentTierStacks.length > 0) {
      tiers.push({
        tierIndex,
        stackIds: [...currentTierStacks],
      });
      visitedCount += currentTierStacks.length;
      tierIndex++;

      const nextTierStacks: string[] = [];

      for (const id of currentTierStacks) {
        const nextList = dependents.get(id) || [];
        for (const nextId of nextList) {
          const newDeg = (inDegree.get(nextId) || 1) - 1;
          inDegree.set(nextId, newDeg);
          if (newDeg === 0) {
            nextTierStacks.push(nextId);
          }
        }
      }

      currentTierStacks = nextTierStacks;
    }

    // Cycle check
    if (visitedCount < stackIds.length) {
      const remaining = stackIds.filter((id) => (inDegree.get(id) || 0) > 0);
      return {
        isValid: false,
        tiers: [],
        errors: [`Cyclic dependency detected among stacks: ${remaining.join(' <-> ')}`],
        cycles: [remaining],
      };
    }

    return {
      isValid: true,
      tiers,
    };
  }

  /**
   * Auto-clusters canvas nodes into standard decoupled enterprise infrastructure stacks:
   * 1. Network / Core Stack
   * 2. Data & Storage Stack (depends on Network)
   * 3. Compute Stack (depends on Network & Data)
   * 4. Ingress / App Gateway Stack (depends on Compute)
   */
  public autoClusterStacks(nodes: CanvasNode[]): Record<string, StackDefinition> {
    const networkNodes: string[] = [];
    const dataNodes: string[] = [];
    const computeNodes: string[] = [];
    const appNodes: string[] = [];
    const securityNodes: string[] = [];

    for (const node of nodes) {
      const rt = node.resourceType.toLowerCase();

      if (
        rt.includes('vpc') ||
        rt.includes('subnet') ||
        rt.includes('vnet') ||
        rt.includes('gateway') ||
        rt.includes('route')
      ) {
        networkNodes.push(node.id);
      } else if (
        rt.includes('rds') ||
        rt.includes('sql') ||
        rt.includes('database') ||
        rt.includes('dynamo') ||
        rt.includes('redis') ||
        rt.includes('s3') ||
        rt.includes('storage') ||
        rt.includes('cosmos')
      ) {
        dataNodes.push(node.id);
      } else if (
        rt.includes('ec2') ||
        rt.includes('vm') ||
        rt.includes('ecs') ||
        rt.includes('eks') ||
        rt.includes('container') ||
        rt.includes('lambda') ||
        rt.includes('function') ||
        rt.includes('auto_scaling')
      ) {
        computeNodes.push(node.id);
      } else if (
        rt.includes('alb') ||
        rt.includes('nlb') ||
        rt.includes('front_door') ||
        rt.includes('cloudfront') ||
        rt.includes('route53') ||
        rt.includes('api_gateway') ||
        rt.includes('app_service')
      ) {
        appNodes.push(node.id);
      } else {
        // Security groups, IAM, KMS, WAF
        securityNodes.push(node.id);
      }
    }

    const stacks: Record<string, StackDefinition> = {};

    // 1. Network Stack
    stacks['stack-network'] = {
      id: 'stack-network',
      name: 'Network Foundation (VPC & Subnets)',
      layer: 'network',
      description: 'Foundational networking, VPCs, subnets, and routing topology.',
      nodeIds: networkNodes.length > 0 ? networkNodes : (nodes[0] ? [nodes[0].id] : []),
      dependsOn: [],
      inputs: [],
      outputs: [
        { name: 'vpc_id', description: 'Primary VPC Identifier', valueType: 'string', exportValue: 'vpc-01a2b3c4' },
        { name: 'private_subnets', description: 'List of private subnet IDs', valueType: 'list', exportValue: ['subnet-a', 'subnet-b'] },
      ],
      status: 'idle',
    };

    // 2. Data Stack
    stacks['stack-data'] = {
      id: 'stack-data',
      name: 'Data & Storage (Databases & Buckets)',
      layer: 'data',
      description: 'Managed databases, persistence tiers, and object storage.',
      nodeIds: dataNodes,
      dependsOn: ['stack-network'],
      inputs: [
        { name: 'vpc_id', fromStackId: 'stack-network', fromOutput: 'vpc_id' },
        { name: 'subnet_ids', fromStackId: 'stack-network', fromOutput: 'private_subnets' },
      ],
      outputs: [
        { name: 'db_endpoint', description: 'Database Host Endpoint', valueType: 'string', exportValue: 'postgres.production.internal' },
        { name: 'db_port', description: 'Database TCP Port', valueType: 'number', exportValue: 5432 },
      ],
      status: 'idle',
    };

    // 3. Compute Stack
    stacks['stack-compute'] = {
      id: 'stack-compute',
      name: 'Compute & Workloads (VMs & Containers)',
      layer: 'compute',
      description: 'Application servers, containers, clusters, and microservices.',
      nodeIds: computeNodes,
      dependsOn: ['stack-network', 'stack-data'],
      inputs: [
        { name: 'vpc_id', fromStackId: 'stack-network', fromOutput: 'vpc_id' },
        { name: 'db_host', fromStackId: 'stack-data', fromOutput: 'db_endpoint' },
      ],
      outputs: [
        { name: 'cluster_arn', description: 'Workload Cluster ARN', valueType: 'string', exportValue: 'arn:aws:ecs:us-east-1:12345:cluster/app' },
        { name: 'service_target_group', description: 'ALB Target Group ARN', valueType: 'string', exportValue: 'arn:aws:elasticloadbalancing:tg/web' },
      ],
      status: 'idle',
    };

    // 4. Ingress / App Gateway Stack
    stacks['stack-ingress'] = {
      id: 'stack-ingress',
      name: 'Edge Ingress & CDN (ALB & Front Door)',
      layer: 'app',
      description: 'Public load balancers, CDN distributions, and API gateways.',
      nodeIds: appNodes,
      dependsOn: ['stack-compute'],
      inputs: [
        { name: 'target_group_arn', fromStackId: 'stack-compute', fromOutput: 'service_target_group' },
      ],
      outputs: [
        { name: 'public_dns', description: 'Public Application URL', valueType: 'string', exportValue: 'https://app.cloudbuilder.io' },
      ],
      status: 'idle',
    };

    // Security stack if nodes exist
    if (securityNodes.length > 0) {
      stacks['stack-security'] = {
        id: 'stack-security',
        name: 'Security & Access (IAM & WAF)',
        layer: 'security',
        description: 'Identity policies, roles, key management, and perimeter firewalls.',
        nodeIds: securityNodes,
        dependsOn: ['stack-network'],
        inputs: [],
        outputs: [],
        status: 'idle',
      };
    }

    return stacks;
  }
}

export const dagEngine = new DagEngine();
