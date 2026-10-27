/**
 * Dataflow Connection & Resource Health Evaluator
 *
 * Evaluates whether a canvas resource has active dataflow lines connected to it,
 * and determines if it is "working correctly" (green) or "needs manual configuration" (red).
 */

import { CanvasNode, CanvasEdge } from '@/types';
import { getResourceDefinition } from '@/lib/resources';
import { relationshipEngine } from '@/lib/engines/relationship/RelationshipEngine';

export interface DataflowConnectionStatus {
  isConnected: boolean;
  isConfigured: boolean; // true = working correctly (green), false = needs manual config (red)
  status: 'connected_healthy' | 'needs_manual_config' | 'disconnected';
  connectedEdgeCount: number;
  issues?: string[];
  connectedNodeIds?: string[];
}

/**
 * Checks whether an edge represents an active data or network flow connection
 * (as opposed to structural containment like "subnet in vpc").
 */
export function isDataflowOrConnectionEdge(edge: { relationshipType?: string; edgeType?: string; label?: unknown }): boolean {
  const rel = String(edge.relationshipType || edge.edgeType || '').toLowerCase();
  const lbl = typeof edge.label === 'string' ? edge.label.toLowerCase() : '';

  // Exclude purely structural containment relationships
  if (
    rel === 'contains' ||
    rel === 'containment' ||
    rel === 'in_container' ||
    lbl === 'subnet in vpc' ||
    lbl === 'subnet in vnet' ||
    lbl === 'vnet in resource group' ||
    lbl === 'igw attached to vpc' ||
    lbl.includes('in vpc') ||
    lbl.includes('in subnet') ||
    lbl.includes('in vnet')
  ) {
    return false;
  }

  return true;
}

/**
 * Evaluates the dataflow connection and configuration status of a resource.
 */
export function evaluateResourceDataflowStatus(
  node: CanvasNode,
  allNodes: CanvasNode[] = [],
  allEdges: CanvasEdge[] = []
): DataflowConnectionStatus {
  const nodeId = node.id;

  // 1. Find all active dataflow/traffic edges connected to this resource
  const connectedEdges = allEdges.filter((e) => {
    if (e.source !== nodeId && e.target !== nodeId) return false;
    return isDataflowOrConnectionEdge(e);
  });

  if (connectedEdges.length === 0) {
    return {
      isConnected: false,
      isConfigured: false,
      status: 'disconnected',
      connectedEdgeCount: 0,
      connectedNodeIds: [],
    };
  }

  const issues: string[] = [];
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
  const connectedNodeIds = connectedEdges.map((e) => (e.source === nodeId ? e.target : e.source));

  const cfg = node.config || {};

  // 2. Check for explicit unconfigured or manual configuration flags
  if (
    cfg.manualConfigRequired === true ||
    cfg.needsConfiguration === true ||
    cfg.configured === false ||
    (node as any).status === 'unconfigured' ||
    cfg.status === 'unconfigured'
  ) {
    issues.push('Resource is explicitly flagged for manual configuration.');
  }

  // 3. Check for configuration errors
  if ((node as any).hasErrors === true || cfg.status === 'error' || (node as any).status === 'error') {
    issues.push('Resource has configuration errors that need resolution.');
  }

  // 4. Validate connected edges using RelationshipEngine
  for (const edge of connectedEdges) {
    if (edge.validationStatus === 'invalid') {
      issues.push(`Dataflow line (${edge.label || edge.id}) has invalid topology.`);
      continue;
    }

    const srcNode = nodeMap.get(edge.source);
    const tgtNode = nodeMap.get(edge.target);
    if (srcNode && tgtNode) {
      const connResult = relationshipEngine.validateConnection(srcNode, tgtNode, allNodes, allEdges);
      if (!connResult.isValid && connResult.error) {
        issues.push(`Connection issue with ${srcNode.id === nodeId ? tgtNode.label : srcNode.label}: ${connResult.error.message}`);
      }
    }
  }

  // 5. Resource-specific required configuration checks
  const rType = node.resourceType;
  const def = getResourceDefinition(rType);

  // Compute instances (EC2, Azure VM, Container Services)
  if (rType === 'aws_ec2') {
    if (!cfg.instanceType && !def?.defaultConfig?.instanceType) {
      issues.push('EC2 instance type must be specified.');
    }
    if (!node.groupId || node.groupId === 'vpc') {
      issues.push('EC2 instance must be placed inside a Subnet.');
    }
  } else if (rType === 'azure_vm') {
    if (!cfg.size && !def?.defaultConfig?.size) {
      issues.push('Azure VM size must be selected.');
    }
    if (!node.groupId) {
      issues.push('Azure VM must be assigned to a Subnet.');
    }
  } else if (rType === 'aws_rds') {
    if (!cfg.engine && !def?.defaultConfig?.engine) {
      issues.push('RDS database engine must be configured.');
    }
    if (!node.groupId || node.groupId === 'vpc') {
      issues.push('RDS database must reside in a private Database Subnet.');
    }
  } else if (rType === 'azure_sql') {
    if (!cfg.tier && !def?.defaultConfig?.tier) {
      issues.push('Azure SQL tier must be selected.');
    }
    if (!node.groupId) {
      issues.push('Azure SQL must be placed in a Subnet.');
    }
  } else if (rType === 'aws_s3') {
    if (!cfg.bucketName && !cfg.name && !node.label) {
      issues.push('S3 Bucket name is required.');
    }
  } else if (rType === 'aws_lambda' || rType === 'azure_function') {
    if (!cfg.runtime && !def?.defaultConfig?.runtime) {
      issues.push('Runtime execution environment must be configured.');
    }
  } else if (rType === 'aws_subnet' || rType === 'azure_subnet') {
    if (!cfg.cidrBlock) {
      issues.push('Subnet CIDR block must be specified.');
    }
  } else if (rType === 'aws_vpc' || rType === 'azure_vnet') {
    if (!cfg.cidrBlock) {
      issues.push('Virtual network CIDR block must be specified.');
    }
  }

  // 6. Schema-driven required field validation
  if (def && def.configSchema) {
    for (const field of def.configSchema) {
      if (field.required && field.key !== 'name' && field.key !== 'region') {
        const val = cfg[field.key];
        const defaultVal = def.defaultConfig?.[field.key];
        if ((val === undefined || val === null || val === '') && (defaultVal === undefined || defaultVal === null || defaultVal === '')) {
          issues.push(`Required field "${field.label || field.key}" is missing.`);
        }
      }
    }
  }

  // If any issues found, it needs manual configuration (RED)
  if (issues.length > 0) {
    return {
      isConnected: true,
      isConfigured: false,
      status: 'needs_manual_config',
      connectedEdgeCount: connectedEdges.length,
      issues,
      connectedNodeIds,
    };
  }

  // Everything is valid and working correctly (GREEN)
  return {
    isConnected: true,
    isConfigured: true,
    status: 'connected_healthy',
    connectedEdgeCount: connectedEdges.length,
    connectedNodeIds,
  };
}
