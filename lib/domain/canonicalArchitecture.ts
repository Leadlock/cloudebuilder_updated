/**
 * Canonical Architecture Model — CloudBuilder Commercial Standard
 *
 * Serves as the single authoritative domain representation of cloud architectures.
 * Every visual placement, relationship, dependency, validation, security analysis,
 * cost calculation, advisor result, Well-Architected review, Terraform generation,
 * and save/load system operates from this canonical model.
 */

import { CanvasNode, CanvasEdge, CloudProvider, ProviderMode, Region, RelationshipType, NetworkScope, ValidationStatus, ScaleProfile, cloudProviderToProviderMode, providerModeToCloudProvider } from '@/types';
import { getResourceDefinition } from '@/lib/resources';
import { isCrossCloudConnectionSupported } from '@/lib/engines/relationship/RelationshipEngine';

export interface CanonicalResource {
  id: string;
  resourceType: string;
  provider: CloudProvider;
  label: string;
  region?: Region;
  availabilityZone?: string;
  isContainer: boolean;
  parentId?: string | null;
  position: { x: number; y: number };
  dimensions: { width: number; height: number };
  config: Record<string, unknown>;
  tags?: Record<string, string>;
  deploymentDependencies: string[];
  logicalReferences: string[];
  importState?: 'imported' | 'cloudcraft-managed' | 'new' | 'modified' | 'planned';
}

export interface CanonicalRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  relationshipType: RelationshipType;
  direction: 'unidirectional' | 'bidirectional';
  networkScope: NetworkScope;
  protocol?: string;
  port?: string | number;
  label?: string;
  inferred?: boolean;
  validationStatus: ValidationStatus;
  validationMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface CanonicalArchitectureGraph {
  version: number;
  hash: string;
  projectId?: string;
  environment?: string;
  provider: CloudProvider;
  providerMode?: ProviderMode;
  region?: Region;
  scaleProfile?: ScaleProfile;
  resources: CanonicalResource[];
  relationships: CanonicalRelationship[];
  metadata: {
    name?: string;
    updatedAt: string;
    resourceCount: number;
    relationshipCount: number;
  };
}

export interface CanonicalValidationIssue {
  code: string;
  category:
    | 'STRUCTURE'
    | 'RELATIONSHIPS'
    | 'CONTAINMENT'
    | 'DEPENDENCIES'
    | 'CLOUD_COMPATIBILITY'
    | 'NETWORKING'
    | 'SECURITY'
    | 'CONFIGURATION'
    | 'TERRAFORM'
    | 'COST';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  message: string;
  technicalReason: string;
  affectedResourceIds: string[];
  suggestedAction: string;
}

export interface CanonicalValidationReport {
  isValid: boolean;
  criticalCount: number;
  highCount: number;
  issues: CanonicalValidationIssue[];
  errors: string[];
}

/**
 * Deterministic hash computation for graph version tracking
 */
export function computeGraphHash(
  resourcesOrGraph: CanonicalResource[] | CanonicalArchitectureGraph,
  relationshipsParam: CanonicalRelationship[] = [],
  scaleProfileParam?: ScaleProfile
): string {
  let resources: CanonicalResource[];
  let relationships: CanonicalRelationship[];
  let scaleProfile: ScaleProfile | undefined = scaleProfileParam;

  if (Array.isArray(resourcesOrGraph)) {
    resources = resourcesOrGraph;
    relationships = relationshipsParam;
  } else {
    resources = resourcesOrGraph.resources || [];
    relationships = resourcesOrGraph.relationships || [];
    if (!scaleProfile) scaleProfile = resourcesOrGraph.scaleProfile;
  }

  const sortedRes = [...resources]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => `${r.id}:${r.resourceType}:${r.parentId || ''}:${JSON.stringify(r.config)}`)
    .join('|');

  const sortedRel = [...relationships]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((rel) => `${rel.sourceId}:${rel.relationshipType}:${rel.targetId}`)
    .join('|');

  const scaleStr = scaleProfile ? `${scaleProfile.expectedUsers}:${scaleProfile.availabilityTarget}` : '';

  let hash = 0;
  const str = `${sortedRes}#${sortedRel}#${scaleStr}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `h-${Math.abs(hash).toString(16)}`;
}

/**
 * Converts Canvas Nodes and Edges to the Canonical Architecture Graph
 */
export function toCanonicalGraph(
  nodesOrObj:
    | CanvasNode[]
    | {
        id?: string;
        name?: string;
        nodes: CanvasNode[];
        edges?: CanvasEdge[];
        version?: number;
        projectId?: string;
        environment?: string;
        provider?: CloudProvider;
        providerMode?: ProviderMode;
        region?: Region;
        scaleProfile?: ScaleProfile;
      },
  edgesParam: CanvasEdge[] = [],
  optionsParam: {
    projectId?: string;
    environment?: string;
    version?: number;
    name?: string;
    provider?: CloudProvider;
    providerMode?: ProviderMode;
    region?: Region;
    scaleProfile?: ScaleProfile;
  } = {}
): CanonicalArchitectureGraph {
  let nodes: CanvasNode[];
  let edges: CanvasEdge[];
  let options: Record<string, any>;

  if (Array.isArray(nodesOrObj)) {
    nodes = nodesOrObj;
    edges = edgesParam;
    options = optionsParam;
  } else {
    nodes = nodesOrObj.nodes || [];
    edges = nodesOrObj.edges || [];
    options = nodesOrObj;
  }

  const resources: CanonicalResource[] = nodes.map((node) => {
    const def = getResourceDefinition(node.resourceType);
    const isContainer = def?.isContainer ?? (
      node.resourceType.includes('vpc') ||
      node.resourceType.includes('vnet') ||
      node.resourceType.includes('subnet') ||
      node.resourceType.includes('boundary') ||
      node.resourceType.includes('resource_group')
    );

    const width = node.width || (isContainer ? def?.defaultWidth || 400 : 180);
    const height = node.height || (isContainer ? def?.defaultHeight || 240 : 100);

    const rawConfig = (node.config || {}) as Record<string, unknown>;
    const tags = (rawConfig.tags as Record<string, string>) || {};

    // Extract logical dependencies or references
    const logicalReferences: string[] = [];
    if (rawConfig.subnetId && typeof rawConfig.subnetId === 'string') logicalReferences.push(rawConfig.subnetId);
    if (rawConfig.vpcId && typeof rawConfig.vpcId === 'string') logicalReferences.push(rawConfig.vpcId);
    if (rawConfig.securityGroupId && typeof rawConfig.securityGroupId === 'string') logicalReferences.push(rawConfig.securityGroupId);

    return {
      id: node.id,
      resourceType: node.resourceType,
      provider: node.provider || (node.resourceType.startsWith('azure_') ? 'azure' : 'aws'),
      label: node.label,
      region: node.region || (rawConfig.region as Region),
      availabilityZone: (rawConfig.availabilityZone as string) || undefined,
      isContainer,
      parentId: node.groupId || node.parentId || null,
      position: { x: node.position.x, y: node.position.y },
      dimensions: { width, height },
      config: rawConfig,
      tags,
      deploymentDependencies: [],
      logicalReferences,
      importState: node.importState,
    };
  });

  const relationships: CanonicalRelationship[] = edges.map((edge) => {
    const relType: RelationshipType = edge.relationshipType || (edge.edgeType as RelationshipType) || 'NETWORK_FLOW';
    const networkScope: NetworkScope = edge.networkScope || 'private';
    const validationStatus: ValidationStatus = edge.validationStatus || 'valid';

    return {
      id: edge.id || `${edge.source}:${relType}:${edge.target}`,
      sourceId: edge.source,
      targetId: edge.target,
      relationshipType: relType,
      direction: edge.direction || 'unidirectional',
      networkScope,
      protocol: edge.protocol,
      port: edge.port,
      label: edge.label,
      inferred: edge.inferred || false,
      validationStatus,
      validationMessage: edge.validationMessage,
    };
  });

  const scaleProfile: ScaleProfile | undefined = options.scaleProfile;
  const hash = computeGraphHash(resources, relationships, scaleProfile);
  const detectedProvider: CloudProvider =
    options.provider ||
    (options.providerMode ? providerModeToCloudProvider(options.providerMode) : undefined) ||
    (resources.some((r) => r.provider === 'aws') && resources.some((r) => r.provider === 'azure')
      ? 'multi'
      : resources[0]?.provider || 'aws');
  const detectedProviderMode: ProviderMode =
    options.providerMode || cloudProviderToProviderMode(detectedProvider);

  return {
    version: options.version || 1,
    hash,
    projectId: options.projectId,
    environment: options.environment,
    provider: detectedProvider,
    providerMode: detectedProviderMode,
    region: options.region,
    scaleProfile,
    resources,
    relationships,
    metadata: {
      name: options.name,
      updatedAt: new Date().toISOString(),
      resourceCount: resources.length,
      relationshipCount: relationships.length,
    },
  };
}

/**
 * Converts a Canonical Architecture Graph back to Canvas Nodes and Edges
 */
export function fromCanonicalGraph(graph: CanonicalArchitectureGraph): {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  scaleProfile?: ScaleProfile;
  providerMode?: ProviderMode;
} {
  const nodes: CanvasNode[] = graph.resources.map((res) => ({
    id: res.id,
    type: res.isContainer ? 'containerNode' : 'cloudNode',
    resourceType: res.resourceType,
    provider: res.provider,
    label: res.label,
    position: { x: res.position.x, y: res.position.y },
    width: res.dimensions.width,
    height: res.dimensions.height,
    groupId: res.parentId || undefined,
    parentId: res.parentId || undefined,
    region: res.region,
    config: { ...res.config },
    importState: res.importState,
  }));

  const edges: CanvasEdge[] = graph.relationships.map((rel) => ({
    id: rel.id,
    source: rel.sourceId,
    target: rel.targetId,
    label: rel.label,
    relationshipType: rel.relationshipType,
    edgeType: rel.relationshipType,
    direction: rel.direction,
    networkScope: rel.networkScope,
    protocol: rel.protocol,
    port: rel.port,
    inferred: rel.inferred,
    validationStatus: rel.validationStatus,
    validationMessage: rel.validationMessage,
  }));

  return { nodes, edges, scaleProfile: graph.scaleProfile, providerMode: graph.providerMode };
}

/**
 * Canonical Architecture Validation
 * Enforces structural correctness, prevents invalid containment and impossible connections.
 */
export function validateCanonicalArchitecture(graph: CanonicalArchitectureGraph): CanonicalValidationReport {
  const issues: CanonicalValidationIssue[] = [];
  const resMap = new Map<string, CanonicalResource>(graph.resources.map((r) => [r.id, r]));

  // Cloud Provider Mode Isolation Check
  const mode = graph.providerMode;
  if (mode === 'AWS' || mode === 'AZURE') {
    for (const res of graph.resources) {
      if (mode === 'AWS' && (res.provider === 'azure' || res.resourceType.startsWith('azure_'))) {
        issues.push({
          code: 'INVALID_CLOUD_PROVIDER_RESOURCE',
          category: 'CLOUD_COMPATIBILITY',
          severity: 'critical',
          message: `Azure resource "${res.label}" (${res.resourceType}) cannot exist in an AWS-only architecture.`,
          technicalReason: 'The architecture provider mode is set to AWS. Azure resources cannot be deployed to AWS infrastructure.',
          affectedResourceIds: [res.id],
          suggestedAction: 'Switch architecture to Multi-Cloud mode or remove Azure resources.',
        });
      } else if (mode === 'AZURE' && (res.provider === 'aws' || res.resourceType.startsWith('aws_'))) {
        issues.push({
          code: 'INVALID_CLOUD_PROVIDER_RESOURCE',
          category: 'CLOUD_COMPATIBILITY',
          severity: 'critical',
          message: `AWS resource "${res.label}" (${res.resourceType}) cannot exist in an Azure-only architecture.`,
          technicalReason: 'The architecture provider mode is set to Azure. AWS resources cannot be deployed to Azure infrastructure.',
          affectedResourceIds: [res.id],
          suggestedAction: 'Switch architecture to Multi-Cloud mode or remove AWS resources.',
        });
      }
    }
  }

  // 1. Structure: Orphaned parents & self-parenting & circular containment
  for (const res of graph.resources) {
    if (res.parentId) {
      if (res.parentId === res.id) {
        issues.push({
          code: 'SELF_PARENTING',
          category: 'STRUCTURE',
          severity: 'critical',
          message: `Resource "${res.label}" cannot be its own parent container.`,
          technicalReason: 'A resource cannot physically or logically encapsulate itself.',
          affectedResourceIds: [res.id],
          suggestedAction: 'Clear the parent container assignment.',
        });
      } else if (!resMap.has(res.parentId)) {
        issues.push({
          code: 'ORPHAN_PARENT_POINTER',
          category: 'STRUCTURE',
          severity: 'high',
          message: `Resource "${res.label}" references missing parent container "${res.parentId}".`,
          technicalReason: 'Dangling container pointers corrupt Terraform scope and network association.',
          affectedResourceIds: [res.id],
          suggestedAction: 'Assign the resource to an active container on the canvas.',
        });
      } else {
        // Check circular containment
        const visited = new Set<string>([res.id]);
        let curr = resMap.get(res.parentId);
        while (curr && curr.parentId) {
          if (visited.has(curr.id)) {
            issues.push({
              code: 'CIRCULAR_PARENT_CONTAINMENT',
              category: 'STRUCTURE',
              severity: 'critical',
              message: `Circular container containment detected involving "${res.label}".`,
              technicalReason: 'Container containment graphs must be strictly acyclic (DAG).',
              affectedResourceIds: Array.from(visited),
              suggestedAction: 'Break the circular parent-child reference.',
            });
            break;
          }
          visited.add(curr.id);
          curr = resMap.get(curr.parentId);
        }
      }
    }
  }

  // 2. Containment & Cloud Compatibility
  const currentMode = graph.providerMode || cloudProviderToProviderMode(graph.provider);
  for (const res of graph.resources) {
    if (currentMode === 'AWS' && (res.provider === 'azure' || res.resourceType.startsWith('azure_'))) {
      issues.push({
        code: 'INCOMPATIBLE_PROVIDER_RESOURCE',
        category: 'CLOUD_COMPATIBILITY',
        severity: 'critical',
        message: `Azure resource "${res.label}" is incompatible with AWS-only architecture mode.`,
        technicalReason: 'The architecture is configured for AWS only.',
        affectedResourceIds: [res.id],
        suggestedAction: 'Switch architecture mode to Multi-Cloud or remove the Azure resource.',
      });
    } else if (currentMode === 'AZURE' && (res.provider === 'aws' || res.resourceType.startsWith('aws_'))) {
      issues.push({
        code: 'INCOMPATIBLE_PROVIDER_RESOURCE',
        category: 'CLOUD_COMPATIBILITY',
        severity: 'critical',
        message: `AWS resource "${res.label}" is incompatible with Azure-only architecture mode.`,
        technicalReason: 'The architecture is configured for Azure only.',
        affectedResourceIds: [res.id],
        suggestedAction: 'Switch architecture mode to Multi-Cloud or remove the AWS resource.',
      });
    }

    if (!res.parentId || !resMap.has(res.parentId)) {
      // Check for uncontained Subnets
      if (res.resourceType.includes('subnet')) {
        issues.push({
          code: 'UNCONTAINED_SUBNET',
          category: 'CONTAINMENT',
          severity: 'critical',
          message: `Subnet "${res.label}" is not contained inside a VPC or Virtual Network.`,
          technicalReason: 'Subnets must reside inside a VPC (AWS) or Virtual Network (Azure).',
          affectedResourceIds: [res.id],
          suggestedAction: 'Place the subnet inside a valid VPC or VNet.',
        });
      }
      continue;
    }

    const parent = resMap.get(res.parentId)!;

    // Cross-Provider Containment
    if (res.provider !== parent.provider && parent.provider !== 'multi' && res.provider !== 'multi') {
      issues.push({
        code: 'ILLEGAL_CROSS_PROVIDER_CONTAINMENT',
        category: 'CLOUD_COMPATIBILITY',
        severity: 'critical',
        message: `Illegal cross-provider containment: ${res.provider.toUpperCase()} resource "${res.label}" cannot be placed inside ${parent.provider.toUpperCase()} container "${parent.label}".`,
        technicalReason: 'Cloud provider networking fabrics are isolated. Resources cannot execute inside an alien cloud container.',
        affectedResourceIds: [res.id, parent.id],
        suggestedAction: `Move "${res.label}" to an appropriate ${res.provider.toUpperCase()} container.`,
      });
    }

    // Prohibit EC2/VM inside EC2/VM
    if ((res.resourceType === 'aws_ec2' || res.resourceType === 'azure_vm') &&
        (parent.resourceType === 'aws_ec2' || parent.resourceType === 'azure_vm')) {
      issues.push({
        code: 'NESTED_VIRTUAL_MACHINE',
        category: 'CONTAINMENT',
        severity: 'critical',
        message: `Compute instance "${res.label}" cannot be contained inside another compute instance "${parent.label}".`,
        technicalReason: 'Virtual machines must be contained in Subnets, not nested inside each other.',
        affectedResourceIds: [res.id, parent.id],
        suggestedAction: 'Move the instance into a valid Subnet container.',
      });
    }

    // Prohibit Subnet inside Subnet
    if (res.resourceType.includes('subnet') && parent.resourceType.includes('subnet')) {
      issues.push({
        code: 'NESTED_SUBNET',
        category: 'CONTAINMENT',
        severity: 'critical',
        message: `Subnet "${res.label}" cannot be nested inside another Subnet "${parent.label}".`,
        technicalReason: 'Subnets must exist directly within a VPC (AWS) or Virtual Network (Azure).',
        affectedResourceIds: [res.id, parent.id],
        suggestedAction: 'Reparent the subnet to the VPC or VNet.',
      });
    }

    // Prohibit VPC inside Subnet
    if ((res.resourceType === 'aws_vpc' || res.resourceType === 'azure_vnet') && parent.resourceType.includes('subnet')) {
      issues.push({
        code: 'INVERTED_NETWORK_HIERARCHY',
        category: 'CONTAINMENT',
        severity: 'critical',
        message: `Network container "${res.label}" cannot be placed inside a Subnet "${parent.label}".`,
        technicalReason: 'Hierarchy requires VPC/VNet -> Subnet -> Workloads.',
        affectedResourceIds: [res.id, parent.id],
        suggestedAction: 'Reparent the VPC to the Cloud Boundary or canvas root.',
      });
    }

    // Compute directly in VPC without Subnet
    if ((res.resourceType === 'aws_ec2' || res.resourceType === 'azure_vm' || res.resourceType === 'aws_auto_scaling' || res.resourceType === 'azure_vmss') &&
        (parent.resourceType === 'aws_vpc' || parent.resourceType === 'azure_vnet' || parent.resourceType === 'azure_resource_group')) {
      issues.push({
        code: 'COMPUTE_DIRECT_IN_VPC',
        category: 'CONTAINMENT',
        severity: 'critical',
        message: `Compute resource "${res.label}" is placed directly in "${parent.label}" without a Subnet.`,
        technicalReason: 'Virtual machines and compute instances must reside within a Subnet for ENI/NIC binding and IP addressing.',
        affectedResourceIds: [res.id, parent.id],
        suggestedAction: 'Move the compute resource into a valid Subnet container.',
      });
    }

    // RDS / Database directly in VPC without Subnet
    if ((res.resourceType === 'aws_rds' || res.resourceType === 'azure_sql') &&
        (parent.resourceType === 'aws_vpc' || parent.resourceType === 'azure_vnet' || parent.resourceType === 'azure_resource_group')) {
      issues.push({
        code: 'DATABASE_DIRECT_IN_VPC',
        category: 'CONTAINMENT',
        severity: 'critical',
        message: `Database "${res.label}" is placed directly in "${parent.label}" without a Subnet.`,
        technicalReason: 'Cloud managed databases require explicit private subnet assignment for network security group isolation and IP allocation.',
        affectedResourceIds: [res.id, parent.id],
        suggestedAction: 'Move the database into a dedicated Private Database Subnet.',
      });
    }
  }

  // 3. Relationships & Edge Invariants
  const seenEdges = new Set<string>();

  for (const rel of graph.relationships) {
    const source = resMap.get(rel.sourceId);
    const target = resMap.get(rel.targetId);

    // Dangling edges
    if (!source || !target) {
      issues.push({
        code: 'DANGLING_EDGE',
        category: 'RELATIONSHIPS',
        severity: 'high',
        message: `Relationship "${rel.id}" connects non-existent resource "${!source ? rel.sourceId : rel.targetId}".`,
        technicalReason: 'Source or target resource is missing from the canonical graph.',
        affectedResourceIds: [rel.sourceId, rel.targetId].filter((id) => resMap.has(id)),
        suggestedAction: 'Remove or reconnect the broken relationship edge.',
      });
      continue;
    }

    // Self-connections
    if (rel.sourceId === rel.targetId) {
      issues.push({
        code: 'SELF_CONNECTION',
        category: 'RELATIONSHIPS',
        severity: 'critical',
        message: `Resource "${source.label}" cannot connect to itself.`,
        technicalReason: 'Self-referential network loops are technically invalid.',
        affectedResourceIds: [source.id],
        suggestedAction: 'Delete the self-referential edge.',
      });
    }

    // Duplicate edges
    const edgeKey = `${rel.sourceId}:${rel.relationshipType}:${rel.targetId}`;
    if (seenEdges.has(edgeKey)) {
      issues.push({
        code: 'DUPLICATE_EDGE',
        category: 'RELATIONSHIPS',
        severity: 'medium',
        message: `Duplicate relationship between "${source.label}" and "${target.label}".`,
        technicalReason: 'Multiple identical relationship edges create redundant routing paths.',
        affectedResourceIds: [source.id, target.id],
        suggestedAction: 'Remove the duplicate edge.',
      });
    }
    seenEdges.add(edgeKey);

    // Impossible cross-cloud relationships
    // Uses the same isCrossCloudConnectionSupported() heuristic as
    // RelationshipEngine.validateConnection's canvas-creation gate, so this
    // validator can never disagree with the canvas about whether an edge is
    // structurally legitimate — see that function's doc comment.
    if (source.provider !== target.provider && source.provider !== 'multi' && target.provider !== 'multi') {
      const isSupported = isCrossCloudConnectionSupported(source.resourceType, target.resourceType);

      if (!isSupported) {
        issues.push({
          code: 'UNSUPPORTED_DIRECT_CROSS_CLOUD_EDGE',
          category: 'CLOUD_COMPATIBILITY',
          severity: 'critical',
          message: `Direct link from ${source.provider.toUpperCase()} ("${source.label}") to ${target.provider.toUpperCase()} ("${target.label}") is not viable.`,
          technicalReason: 'Direct private Ethernet/IP transport between AWS and Azure does not exist without a VPN tunnel, ExpressRoute/DirectConnect interconnect, or public HTTPS gateway.',
          affectedResourceIds: [source.id, target.id],
          suggestedAction: 'Route cross-cloud communication through a Cross-Cloud VPN Tunnel or public API gateway.',
        });
      }
    }
  }

  // 4. Scale Profile Validation
  if (graph.scaleProfile) {
    if (graph.scaleProfile.expectedUsers <= 0) {
      issues.push({
        code: 'INVALID_SCALE_USERS',
        category: 'CONFIGURATION',
        severity: 'high',
        message: 'Scale profile expected users must be greater than zero.',
        technicalReason: 'Capacity sizing and cost calculations require a positive non-zero target user count.',
        affectedResourceIds: [],
        suggestedAction: 'Set expected users to at least 100.',
      });
    }
  }

  const crit = issues.filter((i) => i.severity === 'critical').length;
  const high = issues.filter((i) => i.severity === 'high').length;

  return {
    isValid: crit === 0 && high === 0,
    criticalCount: crit,
    highCount: high,
    issues,
    errors: issues.map((i) => i.message),
  };
}
