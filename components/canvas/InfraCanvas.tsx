'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
  BackgroundVariant,
  ReactFlowInstance,
  NodePositionChange,
  MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useApp, useActiveProject } from '@/context/AppContext';
import { CanvasNode, CanvasEdge, RelationshipType } from '@/types';
import { getResourceDefinition } from '@/lib/resources';
import { relationshipEngine } from '@/lib/engines/relationship/RelationshipEngine';
import CloudNode from './CloudNode';
import ContainerNode from './ContainerNode';
import CloudProviderBoundary from './CloudProviderBoundary';
import {
  TrafficEdge,
  LoadBalancesEdge,
  ConnectsToEdge,
  StoresInEdge,
  ResolvesToEdge,
  AssociationEdge,
  ReplicationEdge,
  CrossCloudEdge,
} from './ArchitectureEdges';
import ResourcePalette from './ResourcePalette';
import PropertiesPanel from './PropertiesPanel';
import CanvasToolbar from './CanvasToolbar';
import AddResourceModal from './AddResourceModal';
import { autoLayoutArchitecture } from '@/lib/canvas/autoLayout';
import { apiWellArchitectedService } from '@/lib/services/ApiWellArchitectedService';

const nodeTypes = {
  cloudNode: CloudNode,
  containerNode: ContainerNode,
  cloudProviderNode: CloudProviderBoundary,
};

const edgeTypes = {
  traffic: TrafficEdge,
  networkFlow: TrafficEdge,
  loadBalances: LoadBalancesEdge,
  connectsTo: ConnectsToEdge,
  storesIn: StoresInEdge,
  resolvesTo: ResolvesToEdge,
  association: AssociationEdge,
  associatedWith: AssociationEdge,
  replication: ReplicationEdge,
  crossCloud: CrossCloudEdge,
};

function toReactFlowNodes(
  canvasNodes: CanvasNode[],
  activeDragTargetId: string | null = null,
  isValidDrop = true,
  findingsMap?: Map<string, { critical: number; high: number; medium: number; total: number }>,
  showFindings = false
): Node[] {
  // Count children per container
  const childCountMap = new Map<string, number>();
  for (const n of canvasNodes) {
    if (n.groupId) {
      childCountMap.set(n.groupId, (childCountMap.get(n.groupId) || 0) + 1);
    }
  }

  // Order: Boundary (-3) -> VPC/VNet (-2) -> Subnet (-1) -> Leaf nodes (1)
  const sorted = [...canvasNodes].sort((a, b) => {
    const aIsBoundary = a.resourceType === 'cloud_provider_boundary' || a.resourceType === 'aws_cloud_boundary' || a.resourceType === 'azure_cloud_boundary';
    const bIsBoundary = b.resourceType === 'cloud_provider_boundary' || b.resourceType === 'aws_cloud_boundary' || b.resourceType === 'azure_cloud_boundary';
    if (aIsBoundary && !bIsBoundary) return -1;
    if (!aIsBoundary && bIsBoundary) return 1;

    const aIsVpc = a.resourceType === 'aws_vpc' || a.resourceType === 'azure_vnet' || a.resourceType === 'azure_resource_group';
    const bIsVpc = b.resourceType === 'aws_vpc' || b.resourceType === 'azure_vnet' || b.resourceType === 'azure_resource_group';
    if (aIsVpc && !bIsVpc) return -1;
    if (!aIsVpc && bIsVpc) return 1;

    const defA = getResourceDefinition(a.resourceType);
    const defB = getResourceDefinition(b.resourceType);
    if (defA?.isContainer && !defB?.isContainer) return -1;
    if (!defA?.isContainer && defB?.isContainer) return 1;
    return 0;
  });

  return sorted.map((n) => {
    const def = getResourceDefinition(n.resourceType);
    const isBoundary = n.resourceType === 'cloud_provider_boundary' || n.resourceType === 'aws_cloud_boundary' || n.resourceType === 'azure_cloud_boundary';
    const isContainer = def?.isContainer === true || isBoundary;
    const isVpc = n.resourceType === 'aws_vpc' || n.resourceType === 'azure_vnet' || n.resourceType === 'azure_resource_group';
    const isSubnet = n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet';

    const width = n.width || def?.defaultWidth || (isBoundary ? 880 : isVpc ? 780 : isSubnet ? 340 : 180);
    const height = n.height || def?.defaultHeight || (isBoundary ? 560 : isVpc ? 500 : isSubnet ? 220 : 100);

    const nodeType = isBoundary ? 'cloudProviderNode' : isContainer ? 'containerNode' : 'cloudNode';

    return {
      id: n.id,
      type: nodeType,
      position: n.position,
      data: {
        label: n.label,
        resourceType: n.resourceType,
        provider: n.provider,
        config: n.config,
        width,
        height,
        groupId: n.groupId,
        importState: n.importState ?? (n.config?.importState as any) ?? (n.config?.imported ? 'imported' : undefined),
        isDragTarget: activeDragTargetId === n.id,
        isValidDrop: activeDragTargetId === n.id ? isValidDrop : true,
        childCount: childCountMap.get(n.id) || 0,
        findingsSummary: findingsMap?.get(n.id),
        showFindings,
        region: (n.config?.region as string) || (n.provider === 'azure' ? 'eastus' : 'us-east-1'),
      },
      selected: n.selected,
      zIndex: isBoundary ? -3 : isVpc ? -2 : isSubnet ? -1 : 1,
    };
  });
}

function toReactFlowEdges(canvasEdges: CanvasEdge[]): Edge[] {
  return canvasEdges.map((e) => {
    const relType = e.relationshipType || (e.edgeType as string);
    let type = 'traffic';
    let color = '#38BDF8';

    if (relType === 'LOAD_BALANCES') {
      type = 'loadBalances';
      color = '#818CF8';
    } else if (relType === 'CONNECTS_TO') {
      type = 'connectsTo';
      color = '#10B981';
    } else if (relType === 'STORES_IN') {
      type = 'storesIn';
      color = '#14B8A6';
    } else if (relType === 'RESOLVES_TO') {
      type = 'resolvesTo';
      color = '#38BDF8';
    } else if (relType === 'ASSOCIATED_WITH' || relType === 'security' || relType === 'management') {
      type = 'association';
      color = '#94A3B8';
    } else if (relType === 'REPLICATES_TO') {
      type = 'replication';
      color = '#F59E0B';
    } else if (relType === 'cross-cloud' || e.networkScope === 'cross-cloud') {
      type = 'crossCloud';
      color = '#F59E0B';
    }

    const isAssociation = type === 'association';

    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      type,
      animated: !isAssociation,
      data: {
        relationshipType: e.relationshipType,
        protocol: e.protocol,
        port: e.port,
        networkScope: e.networkScope,
        direction: e.direction,
        inferred: e.inferred,
        validationStatus: e.validationStatus,
        reason: e.reason,
      },
      style: { stroke: color, strokeWidth: type === 'crossCloud' ? 2.5 : 2 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color,
        width: 14,
        height: 14,
      },
      labelStyle: { fontSize: 10, fill: type === 'crossCloud' ? '#FCD34D' : '#CBD5E1', fontFamily: 'monospace' },
    };
  });
}

export default function InfraCanvas() {
  const { state, dispatch } = useApp();
  const activeProject = useActiveProject();
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);
  const clipboardRef = useRef<Node[]>([]);
  const latestNodesRef = useRef<Node[]>([]);

  // Drag over target container state
  const [activeDragTargetId, setActiveDragTargetId] = useState<string | null>(null);
  const [isValidDropTarget, setIsValidDropTarget] = useState<boolean>(true);

  // Quick Add Resource modal
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  // Pre-connection validation error modal state
  const [connectionError, setConnectionError] = useState<{
    title: string;
    message: string;
    reason: string;
    alternatives: string[];
    sourceLabel: string;
    targetLabel: string;
  } | null>(null);

  // Undo/Redo history stacks
  const undoStack = useRef<{ nodes: Node[]; edges: Edge[] }[]>([]);
  const redoStack = useRef<{ nodes: Node[]; edges: Edge[] }[]>([]);

  const initialNodes = activeProject ? toReactFlowNodes(activeProject.nodes) : [];
  const initialEdges = activeProject ? toReactFlowEdges(activeProject.edges) : [];

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Provider filter for multi-cloud canvas
  const [canvasFilter, setCanvasFilter] = useState<'all' | 'aws' | 'azure'>('all');

  // Well-Architected findings overlay state
  const [showFindings, setShowFindings] = useState(false);
  const [findingsMap, setFindingsMap] = useState<Map<string, { critical: number; high: number; medium: number; total: number }>>(new Map());

  useEffect(() => {
    if (!showFindings || !activeProject) return;
    let isCancelled = false;
    apiWellArchitectedService.getAssessment().then((assessment) => {
      if (isCancelled || !assessment?.findings) return;
      const fMap = new Map<string, { critical: number; high: number; medium: number; total: number }>();
      for (const finding of assessment.findings) {
        for (const resId of (finding.affectedResourceIds || [])) {
          const current = fMap.get(resId) || { critical: 0, high: 0, medium: 0, total: 0 };
          current.total++;
          if (finding.severity === 'critical') current.critical++;
          else if (finding.severity === 'high') current.high++;
          else if (finding.severity === 'medium') current.medium++;
          fMap.set(resId, current);
        }
      }
      setFindingsMap(fMap);
    }).catch(() => {});
    return () => { isCancelled = true; };
  }, [showFindings, activeProject?.id, state.activeEnvironment]);

  useEffect(() => {
    setNodes((prevNodes) =>
      prevNodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          showFindings,
          findingsSummary: findingsMap.get(node.id) || { critical: 0, high: 0, medium: 0, total: 0 },
        },
      }))
    );
  }, [showFindings, findingsMap, setNodes]);

  useEffect(() => {
    latestNodesRef.current = nodes;
  }, [nodes]);

  // Track project/env/version changes
  const prevProjectRef = useRef<string | null>(null);
  const prevEnvRef = useRef<string | null>(null);
  const prevCanvasKey = useRef<number>(state.canvasKey);

  useEffect(() => {
    if (!activeProject) return;
    if (
      activeProject.id !== prevProjectRef.current ||
      state.activeEnvironment !== prevEnvRef.current ||
      state.canvasKey !== prevCanvasKey.current
    ) {
      prevProjectRef.current = activeProject.id;
      prevEnvRef.current = state.activeEnvironment;
      prevCanvasKey.current = state.canvasKey;
      const envNodes = toReactFlowNodes(activeProject.nodes);
      const envEdges = toReactFlowEdges(activeProject.edges);
      setNodes(envNodes);
      setEdges(envEdges);
      setSelectedNodeId(null);
      undoStack.current = [];
      redoStack.current = [];
      setCanUndo(false);
      setCanRedo(false);
    }
  }, [activeProject, state.activeEnvironment, state.canvasKey, setNodes, setEdges]);

  // ── History helpers ──────────────────────────────────────────────────────────
  const pushHistory = useCallback((n: Node[], e: Edge[]) => {
    undoStack.current.push({ nodes: n, edges: e });
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  // ── Canvas sync ──────────────────────────────────────────────────────────────
  const getCanvasNodes = useCallback((): CanvasNode[] => {
    if (!activeProject) return [];
    return nodes.map((n) => {
      const existing = activeProject.nodes.find((cn) => cn.id === n.id);
      return {
        id: n.id,
        type: n.type ?? 'cloudNode',
        resourceType: n.data.resourceType,
        provider: (existing?.provider ?? (activeProject.provider === 'multi' ? 'aws' : activeProject.provider)) as 'aws' | 'azure',
        label: n.data.label,
        position: n.position,
        config: existing?.config ?? {},
        selected: n.selected,
        groupId: n.data.groupId ?? existing?.groupId,
        width: n.data.width ?? existing?.width,
        height: n.data.height ?? existing?.height,
      };
    });
  }, [nodes, activeProject]);

  const getCanvasEdges = useCallback((): CanvasEdge[] => {
    return edges.map((e) => {
      const existing = activeProject?.edges.find((ce) => ce.id === e.id);
      const data = (e.data || {}) as Record<string, unknown>;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label as string | undefined,
        edgeType: (e.type as CanvasEdge['edgeType']) || existing?.edgeType || 'network',
        relationshipType: (data.relationshipType as RelationshipType) || existing?.relationshipType,
        protocol: (data.protocol as string) || existing?.protocol,
        port: (data.port as string | number) || existing?.port,
        networkScope: (data.networkScope as any) || existing?.networkScope,
        direction: (data.direction as any) || existing?.direction || 'unidirectional',
        inferred: (data.inferred as boolean) ?? existing?.inferred ?? false,
        validationStatus: (data.validationStatus as any) || existing?.validationStatus || 'valid',
        reason: (data.reason as string) || existing?.reason,
      };
    });
  }, [edges, activeProject]);

  const syncToStore = useCallback((newNodes?: Node[], newEdges?: Edge[]) => {
    const resolvedNodes = newNodes ?? nodes;
    const resolvedEdges = newEdges ?? edges;
    const cn: CanvasNode[] = resolvedNodes.map((n) => {
      const existing = activeProject?.nodes.find((cn) => cn.id === n.id);
      return {
        id: n.id,
        type: n.type ?? 'cloudNode',
        resourceType: n.data.resourceType,
        provider: (existing?.provider ?? (activeProject?.provider === 'multi' ? 'aws' : (activeProject?.provider ?? 'aws'))) as 'aws' | 'azure',
        label: n.data.label,
        position: n.position,
        config: existing?.config ?? {},
        groupId: n.data.groupId ?? existing?.groupId,
        width: n.data.width ?? existing?.width,
        height: n.data.height ?? existing?.height,
      } as CanvasNode;
    });
    const ce = resolvedEdges.map((e) => {
      const existing = activeProject?.edges.find((ce) => ce.id === e.id);
      const data = (e.data || {}) as Record<string, unknown>;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label as string | undefined,
        edgeType: (e.type as CanvasEdge['edgeType']) || existing?.edgeType || 'network',
        relationshipType: (data.relationshipType as RelationshipType) || existing?.relationshipType,
        protocol: (data.protocol as string) || existing?.protocol,
        port: (data.port as string | number) || existing?.port,
        networkScope: (data.networkScope as any) || existing?.networkScope,
        direction: (data.direction as any) || existing?.direction || 'unidirectional',
        inferred: (data.inferred as boolean) ?? existing?.inferred ?? false,
        validationStatus: (data.validationStatus as any) || existing?.validationStatus || 'valid',
        reason: (data.reason as string) || existing?.reason,
      } as CanvasEdge;
    });
    dispatch({ type: 'UPDATE_CANVAS', nodes: cn, edges: ce });
  }, [activeProject, dispatch, nodes, edges]);

  // ── Smart Connect with Pre-Connection Validation ─────────────────────────────
  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const sourceNode = nodes.find((n) => n.id === connection.source);
    const targetNode = nodes.find((n) => n.id === connection.target);
    if (!sourceNode || !targetNode) return;

    const currentCanvasNodes = getCanvasNodes();
    const currentCanvasEdges = getCanvasEdges();

    const sourceCanvas: CanvasNode = currentCanvasNodes.find((n) => n.id === connection.source) || {
      id: sourceNode.id,
      type: 'cloudNode',
      resourceType: sourceNode.data.resourceType,
      provider: sourceNode.data.provider,
      label: sourceNode.data.label,
      position: sourceNode.position,
      config: sourceNode.data.config || {},
      groupId: sourceNode.data.groupId,
    };

    const targetCanvas: CanvasNode = currentCanvasNodes.find((n) => n.id === connection.target) || {
      id: targetNode.id,
      type: 'cloudNode',
      resourceType: targetNode.data.resourceType,
      provider: targetNode.data.provider,
      label: targetNode.data.label,
      position: targetNode.position,
      config: targetNode.data.config || {},
      groupId: targetNode.data.groupId,
    };

    // Centralized Relationship Rule Engine Validation
    const validation = relationshipEngine.validateConnection(
      sourceCanvas,
      targetCanvas,
      currentCanvasNodes,
      currentCanvasEdges
    );

    if (!validation.isValid) {
      setConnectionError({
        title: 'Invalid Architectural Connection',
        message: validation.error?.message || 'Unsupported connection between resources.',
        reason: validation.error?.technicalReason || 'This connection violates cloud networking or security rules.',
        alternatives: validation.error?.suggestedAlternatives || ['Choose a valid intermediate proxy or application gateway.'],
        sourceLabel: sourceNode.data.label,
        targetLabel: targetNode.data.label,
      });
      return;
    }

    const relType = validation.relationshipType;
    let edgeReactType = 'traffic';
    let color = '#38BDF8';

    if (relType === 'LOAD_BALANCES') {
      edgeReactType = 'loadBalances';
      color = '#818CF8';
    } else if (relType === 'CONNECTS_TO') {
      edgeReactType = 'connectsTo';
      color = '#10B981';
    } else if (relType === 'STORES_IN') {
      edgeReactType = 'storesIn';
      color = '#14B8A6';
    } else if (relType === 'RESOLVES_TO') {
      edgeReactType = 'resolvesTo';
      color = '#38BDF8';
    } else if (relType === 'ASSOCIATED_WITH') {
      edgeReactType = 'association';
      color = '#94A3B8';
    } else if (relType === 'REPLICATES_TO') {
      edgeReactType = 'replication';
      color = '#F59E0B';
    } else if (validation.networkScope === 'cross-cloud') {
      edgeReactType = 'crossCloud';
      color = '#F59E0B';
    }

    const label = validation.label || (validation.port ? `${validation.protocol || 'TCP'} / ${validation.port}` : undefined);

    const newEdges = addEdge(
      {
        ...connection,
        id: `edge-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        type: edgeReactType,
        label,
        animated: edgeReactType !== 'association',
        data: {
          relationshipType: relType,
          protocol: validation.protocol,
          port: validation.port,
          networkScope: validation.networkScope,
          validationStatus: 'valid',
        },
        style: { stroke: color, strokeWidth: edgeReactType === 'crossCloud' ? 2.5 : 2 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 14,
          height: 14,
        },
      },
      edges
    );

    pushHistory(nodes, edges);
    setEdges(newEdges);
    syncToStore(nodes, newEdges);
  }, [edges, nodes, getCanvasNodes, getCanvasEdges, setEdges, syncToStore, pushHistory]);

  // ── Container Detection Helper ───────────────────────────────────────────────
  const findContainerAtPosition = useCallback((pos: { x: number; y: number }, draggedType?: string) => {
    const containerNodes = nodes.filter((n) => {
      const def = getResourceDefinition(n.data.resourceType);
      const isBoundary = n.data.resourceType === 'cloud_provider_boundary' || n.data.resourceType === 'aws_cloud_boundary' || n.data.resourceType === 'azure_cloud_boundary';
      return def?.isContainer === true || isBoundary;
    });

    const checkAllowed = (container: Node, def?: ReturnType<typeof getResourceDefinition>) => {
      if (!draggedType) return true;
      const draggedDef = getResourceDefinition(draggedType);
      // Strict Cross-Cloud isolation: AWS resources never allowed in Azure containers, Azure never in AWS
      if (draggedDef && def) {
        if (def.provider !== draggedDef.provider) {
          return false;
        }
      }
      if (def?.allowedChildren) {
        return def.allowedChildren.includes(draggedType);
      }
      return true;
    };

    // 1. Check Subnets first (innermost containers)
    const subnets = containerNodes.filter(
      (n) => n.data.resourceType === 'aws_subnet' || n.data.resourceType === 'azure_subnet'
    );
    for (const sub of subnets) {
      const width = sub.data.width || 340;
      const height = sub.data.height || 220;
      if (
        pos.x >= sub.position.x &&
        pos.x <= sub.position.x + width &&
        pos.y >= sub.position.y &&
        pos.y <= sub.position.y + height
      ) {
        const subDef = getResourceDefinition(sub.data.resourceType);
        const isAllowed = checkAllowed(sub, subDef);
        return { container: sub, isAllowed };
      }
    }

    // 2. Check VPC / VNet / Resource Group (middle containers)
    const vpcs = containerNodes.filter(
      (n) =>
        n.data.resourceType === 'aws_vpc' ||
        n.data.resourceType === 'azure_vnet' ||
        n.data.resourceType === 'azure_resource_group'
    );
    for (const vpc of vpcs) {
      const width = vpc.data.width || 780;
      const height = vpc.data.height || 500;
      if (
        pos.x >= vpc.position.x &&
        pos.x <= vpc.position.x + width &&
        pos.y >= vpc.position.y &&
        pos.y <= vpc.position.y + height
      ) {
        const vpcDef = getResourceDefinition(vpc.data.resourceType);
        const isAllowed = checkAllowed(vpc, vpcDef);
        return { container: vpc, isAllowed };
      }
    }

    // 3. Check Cloud Boundaries (outermost containers)
    const boundaries = containerNodes.filter(
      (n) =>
        n.data.resourceType === 'cloud_provider_boundary' ||
        n.data.resourceType === 'aws_cloud_boundary' ||
        n.data.resourceType === 'azure_cloud_boundary'
    );
    for (const b of boundaries) {
      const width = b.data.width || 880;
      const height = b.data.height || 560;
      if (
        pos.x >= b.position.x &&
        pos.x <= b.position.x + width &&
        pos.y >= b.position.y &&
        pos.y <= b.position.y + height
      ) {
        const bDef = getResourceDefinition(b.data.resourceType);
        const isAllowed = checkAllowed(b, bDef);
        return { container: b, isAllowed };
      }
    }

    return null;
  }, [nodes]);

  // ── Drag Over with Placement Highlighting ────────────────────────────────────
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';

    if (!reactFlowInstance.current) return;
    const pos = reactFlowInstance.current.screenToFlowPosition({ x: event.clientX, y: event.clientY });

    // Retrieve dragged resource type reliably
    let resourceType: string | undefined = undefined;
    if (typeof window !== 'undefined' && (window as any).__cloudcraft_dragged_type) {
      resourceType = (window as any).__cloudcraft_dragged_type;
    } else {
      const mimeType = event.dataTransfer.types.find((t) => t.startsWith('application/cloudcraft-'));
      if (mimeType) {
        resourceType = mimeType.replace('application/cloudcraft-', '');
      }
    }

    const hit = findContainerAtPosition(pos, resourceType);
    if (hit) {
      setActiveDragTargetId(hit.container.id);
      setIsValidDropTarget(hit.isAllowed);
    } else {
      setActiveDragTargetId(null);
      setIsValidDropTarget(true);
    }
  }, [findContainerAtPosition]);

  // ── Drop with Intelligent Auto-Parenting ──────────────────────────────────────
  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setActiveDragTargetId(null);
    let resourceType = event.dataTransfer.getData('application/cloudcraft');
    if (!resourceType && typeof window !== 'undefined') {
      resourceType = (window as any).__cloudcraft_dragged_type;
    }
    if (!resourceType || !reactFlowInstance.current || !reactFlowWrapper.current) return;
    const def = getResourceDefinition(resourceType);
    if (!def) return;

    const pos = reactFlowInstance.current.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const id = `node-${Date.now()}`;

    // Determine container placement
    const hit = findContainerAtPosition(pos, resourceType);
    let groupId: string | undefined = undefined;
    const config = { ...def.defaultConfig };

    if (hit && hit.isAllowed) {
      groupId = hit.container.id;
      if (hit.container.data.resourceType.includes('subnet')) {
        config.subnetId = hit.container.id;
        config.subnetName = hit.container.data.label;
        if (hit.container.data.config?.availabilityZone) {
          config.availabilityZone = hit.container.data.config.availabilityZone;
        }
      } else if (hit.container.data.resourceType.includes('vpc') && resourceType.includes('subnet')) {
        config.vpcId = hit.container.id;
      }
    }

    const isContainer = def.isContainer === true;
    const width = isContainer ? def.defaultWidth || 340 : 180;
    const height = isContainer ? def.defaultHeight || 220 : 100;

    const newNode: Node = {
      id,
      type: isContainer ? 'containerNode' : 'cloudNode',
      position: pos,
      data: {
        label: def.label,
        resourceType,
        provider: def.provider,
        config,
        width,
        height,
        groupId,
      },
    };

    // If placed in container, expand container bounds if necessary to guarantee generous padding
    let adjustedNodes = [...nodes];
    if (hit && hit.isAllowed) {
      const containerNode = nodes.find((n) => n.id === hit.container.id);
      if (containerNode) {
        const pad = 35;
        const neededWidth = Math.max(containerNode.data.width || (hit.container.data.resourceType.includes('vpc') ? 780 : 340), (pos.x - containerNode.position.x) + width + pad);
        const neededHeight = Math.max(containerNode.data.height || (hit.container.data.resourceType.includes('vpc') ? 500 : 220), (pos.y - containerNode.position.y) + height + pad);
        adjustedNodes = adjustedNodes.map((n) =>
          n.id === containerNode.id
            ? { ...n, data: { ...n.data, width: neededWidth, height: neededHeight } }
            : n
        );
      }
    }

    const newNodes = [...adjustedNodes, newNode];
    pushHistory(nodes, edges);
    setNodes(newNodes);

    const cn: CanvasNode = {
      id,
      type: isContainer ? 'containerNode' : 'cloudNode',
      resourceType,
      provider: def.provider,
      label: def.label,
      position: pos,
      config,
      groupId,
      width,
      height,
    };

    const allCn = [...getCanvasNodes().filter((n) => n.id !== id), cn];
    dispatch({ type: 'UPDATE_CANVAS', nodes: allCn, edges: getCanvasEdges() });
    setSelectedNodeId(id);
  }, [nodes, edges, setNodes, reactFlowInstance, getCanvasNodes, getCanvasEdges, dispatch, pushHistory, findContainerAtPosition]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  // ── Recursive Descendants Helper ─────────────────────────────────────────────
  const getDescendantIds = useCallback((parentId: string, allNodes: Node[]): Set<string> => {
    const descendants = new Set<string>();
    const queue = [parentId];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const n of allNodes) {
        if (n.data.groupId === curr && !descendants.has(n.id)) {
          descendants.add(n.id);
          queue.push(n.id);
        }
      }
    }
    return descendants;
  }, []);

  // ── Drag Nodes & Move Child Nodes with Containers ────────────────────────────
  const onNodesChangeWrapped: typeof onNodesChange = useCallback((changes) => {
    onNodesChange(changes);

    // If container node position changes, shift ALL descendants (children & grandchildren)
    const positionChanges = changes.filter((c): c is NodePositionChange => c.type === 'position' && !!c.position);
    for (const change of positionChanges) {
      const targetNode = nodes.find((n) => n.id === change.id);
      if (targetNode?.type === 'containerNode' && change.position) {
        const deltaX = change.position.x - targetNode.position.x;
        const deltaY = change.position.y - targetNode.position.y;
        if (deltaX !== 0 || deltaY !== 0) {
          const descendants = getDescendantIds(change.id, nodes);
          if (descendants.size > 0) {
            setNodes((currentNodes) =>
              currentNodes.map((n) => {
                if (descendants.has(n.id)) {
                  return {
                    ...n,
                    position: {
                      x: n.position.x + deltaX,
                      y: n.position.y + deltaY,
                    },
                  };
                }
                return n;
              })
            );
          }
        }
      }
    }

    const isDragStop = changes.some((c) => c.type === 'position' && !c.dragging);
    if (isDragStop) {
      // Re-evaluate container hierarchy for moved leaf/subnet nodes
      const movedChanges = positionChanges.filter((c) => !c.dragging);
      setNodes((currentNodes) => {
        let updated = [...currentNodes];
        for (const change of movedChanges) {
          const movedNode = updated.find((n) => n.id === change.id);
          if (!movedNode) continue;
          const isVpc = movedNode.data.resourceType?.includes('vpc') || movedNode.data.resourceType?.includes('vnet');
          if (isVpc) continue;

          const hit = findContainerAtPosition(movedNode.position, movedNode.data.resourceType);
          if (hit && hit.isAllowed && hit.container.id !== movedNode.id) {
            if (movedNode.data.groupId !== hit.container.id) {
              updated = updated.map((n) =>
                n.id === movedNode.id ? { ...n, data: { ...n.data, groupId: hit.container.id } } : n
              );
            }
          } else if (!hit && movedNode.data.groupId) {
            // Dragged out into canvas
            updated = updated.map((n) =>
              n.id === movedNode.id ? { ...n, data: { ...n.data, groupId: undefined } } : n
            );
          }
        }
        return updated;
      });
      setTimeout(() => syncToStore(latestNodesRef.current), 0);
    }
  }, [onNodesChange, syncToStore, nodes, setNodes, getDescendantIds, findContainerAtPosition]);

  // ── Auto-layout (Logical Cloud Architecture) ─────────────────────────────────
  const handleAutoLayout = useCallback(() => {
    if (nodes.length === 0) return;
    pushHistory(nodes, edges);

    const canvasNodes = getCanvasNodes();
    const canvasEdges = getCanvasEdges();
    const laid = autoLayoutArchitecture(canvasNodes, canvasEdges);

    const rfNodes = toReactFlowNodes(laid.nodes);
    const rfEdges = toReactFlowEdges(laid.edges);

    setNodes(rfNodes);
    setEdges(rfEdges);
    syncToStore(rfNodes, rfEdges);
    setTimeout(() => reactFlowInstance.current?.fitView({ padding: 0.15 }), 60);
  }, [nodes, edges, setNodes, setEdges, syncToStore, pushHistory, getCanvasNodes, getCanvasEdges]);

  // ── Toolbar Controls ─────────────────────────────────────────────────────────
  const handleFitView = useCallback(() => {
    reactFlowInstance.current?.fitView({ padding: 0.15 });
  }, []);

  const handleZoomIn = useCallback(() => {
    reactFlowInstance.current?.zoomIn();
  }, []);

  const handleZoomOut = useCallback(() => {
    reactFlowInstance.current?.zoomOut();
  }, []);

  const handleUndo = useCallback(() => {
    if (undoStack.current.length === 0) return;
    const snap = undoStack.current.pop()!;
    redoStack.current.push({ nodes, edges });
    setNodes(snap.nodes);
    setEdges(snap.edges);
    syncToStore(snap.nodes, snap.edges);
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(true);
  }, [nodes, edges, setNodes, setEdges, syncToStore]);

  const handleRedo = useCallback(() => {
    if (redoStack.current.length === 0) return;
    const snap = redoStack.current.pop()!;
    undoStack.current.push({ nodes, edges });
    setNodes(snap.nodes);
    setEdges(snap.edges);
    syncToStore(snap.nodes, snap.edges);
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
  }, [nodes, edges, setNodes, setEdges, syncToStore]);

  const handleCopy = useCallback(() => {
    clipboardRef.current = nodes.filter((n) => n.selected);
  }, [nodes]);

  const handlePaste = useCallback(() => {
    if (clipboardRef.current.length === 0) return;
    const OFFSET = 30;
    const pasted: Node[] = clipboardRef.current.map((n) => ({
      ...n,
      id: `${n.id}-copy-${Date.now()}`,
      position: { x: n.position.x + OFFSET, y: n.position.y + OFFSET },
      selected: false,
    }));
    const newNodes = [...nodes, ...pasted];
    pushHistory(nodes, edges);
    setNodes(newNodes);
    syncToStore(newNodes, edges);
  }, [nodes, edges, setNodes, syncToStore, pushHistory]);

  const handleDeleteSelected = useCallback(() => {
    const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id);
    if (selectedNodeId && !selectedIds.includes(selectedNodeId)) selectedIds.push(selectedNodeId);
    if (selectedIds.length === 0) return;
    const newNodes = nodes.filter((n) => !selectedIds.includes(n.id));
    const newEdges = edges.filter((e) => !selectedIds.includes(e.source) && !selectedIds.includes(e.target));
    pushHistory(nodes, edges);
    setNodes(newNodes);
    setEdges(newEdges);
    setSelectedNodeId(null);
    syncToStore(newNodes, newEdges);
  }, [nodes, edges, setNodes, setEdges, selectedNodeId, syncToStore, pushHistory]);

  // ── Quick Add Resource ───────────────────────────────────────────────────────
  const handleQuickAdd = useCallback((resourceType: string) => {
    const def = getResourceDefinition(resourceType);
    if (!def) return;
    const id = `node-${Date.now()}`;
    const pos = reactFlowInstance.current?.screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    }) || { x: 300, y: 200 };

    const isContainer = def.isContainer === true;
    const width = isContainer ? def.defaultWidth || 340 : 180;
    const height = isContainer ? def.defaultHeight || 220 : 100;

    const newNode: Node = {
      id,
      type: isContainer ? 'containerNode' : 'cloudNode',
      position: pos,
      data: {
        label: def.label,
        resourceType,
        provider: def.provider,
        config: { ...def.defaultConfig },
        width,
        height,
      },
    };

    const newNodes = [...nodes, newNode];
    pushHistory(nodes, edges);
    setNodes(newNodes);

    const cn: CanvasNode = {
      id,
      type: isContainer ? 'containerNode' : 'cloudNode',
      resourceType,
      provider: def.provider,
      label: def.label,
      position: pos,
      config: { ...def.defaultConfig },
      width,
      height,
    };

    const allCn = [...getCanvasNodes().filter((n) => n.id !== id), cn];
    dispatch({ type: 'UPDATE_CANVAS', nodes: allCn, edges: getCanvasEdges() });
    setSelectedNodeId(id);
  }, [nodes, edges, setNodes, getCanvasNodes, getCanvasEdges, dispatch, pushHistory]);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); handleUndo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); handleRedo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') { e.preventDefault(); handleCopy(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') { e.preventDefault(); handlePaste(); }
      if (e.key === 'Delete' || e.key === 'Backspace') { handleDeleteSelected(); }
      if (e.key === 'Escape') { setSelectedNodeId(null); setIsAddModalOpen(false); }
      if (e.key === 'a' || e.key === 'A') { setIsAddModalOpen(true); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleUndo, handleRedo, handleCopy, handlePaste, handleDeleteSelected]);

  // ── Node update from properties panel ────────────────────────────────────────
  function handleNodeUpdate(nodeId: string, config: Record<string, unknown>, label: string) {
    if (!activeProject) return;
    setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, label, config } } : n)));
    dispatch({ type: 'UPDATE_NODE_CONFIG', nodeId, config, label });
  }

  // ── Multi-cloud filter ───────────────────────────────────────────────────────
  const visibleNodes = nodes.map((n) => {
    if (canvasFilter === 'all' || activeProject?.provider !== 'multi') return n;
    const existing = activeProject.nodes.find((cn) => cn.id === n.id);
    const nodeProvider = existing?.provider ?? 'aws';
    if (nodeProvider !== canvasFilter) {
      return { ...n, style: { ...n.style, opacity: 0.15, pointerEvents: 'none' as const } };
    }
    return n;
  });

  const selectedNode = activeProject?.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const hasSelected = nodes.some((n) => n.selected) || !!selectedNodeId;

  if (!activeProject) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-950 text-slate-500">
        <div className="text-center">
          <p className="text-lg font-medium text-slate-400">No project selected</p>
          <p className="text-sm mt-1">Select or create a project from the dashboard</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 relative overflow-hidden bg-slate-950">
      {/* Redesigned Cloud Service Catalog Palette */}
      <ResourcePalette
        provider={activeProject.provider}
        onAddResource={handleQuickAdd}
      />

      {/* Main Architecture Canvas */}
      <div ref={reactFlowWrapper} className="flex-1 relative bg-slate-950">
        {/* Floating Architecture Toolbar */}
        <CanvasToolbar
          canUndo={canUndo}
          canRedo={canRedo}
          hasSelected={hasSelected}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onAutoLayout={handleAutoLayout}
          onFitView={handleFitView}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onDeleteSelected={handleDeleteSelected}
          onCopy={handleCopy}
          onOpenAddModal={() => setIsAddModalOpen(true)}
          showFindings={showFindings}
          onToggleFindings={() => setShowFindings((v) => !v)}
        />

        {/* Multi-cloud filter bar */}
        {activeProject.provider === 'multi' && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 bg-slate-900/90 border border-slate-700/80 rounded-xl px-1.5 py-1 shadow-2xl backdrop-blur-md">
            {(['all', 'aws', 'azure'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setCanvasFilter(f)}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                  canvasFilter === f ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                {f === 'all' ? 'All Providers' : f.toUpperCase()}
              </button>
            ))}
          </div>
        )}

        {/* React Flow Core */}
        <ReactFlow
          nodes={visibleNodes}
          edges={edges}
          onNodesChange={onNodesChangeWrapped}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onInit={(instance) => {
            reactFlowInstance.current = instance;
          }}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
          maxZoom={2.0}
        >
          {/* Architecture Blueprint Grid Background */}
          <Background
            variant={BackgroundVariant.Dots}
            color="#334155"
            gap={24}
            size={1.2}
            className="opacity-60"
          />
          <Controls className="!bg-slate-900/90 !border-slate-700 !rounded-xl !shadow-2xl overflow-hidden" />
          <MiniMap
            nodeColor={(n) => {
              if (n.data.resourceType?.includes('vpc') || n.data.resourceType?.includes('vnet')) return '#8C4FFF';
              if (n.data.resourceType?.includes('subnet')) return '#059669';
              if (n.data.resourceType?.includes('ec2') || n.data.resourceType?.includes('vm')) return '#ED7100';
              if (n.data.resourceType?.includes('rds') || n.data.resourceType?.includes('sql')) return '#C925D1';
              return '#38BDF8';
            }}
            maskColor="rgba(2, 6, 23, 0.75)"
            className="!bg-slate-900 !border-slate-800 !rounded-xl !shadow-2xl overflow-hidden"
          />
        </ReactFlow>
      </div>

      {/* Properties Panel (Right) */}
      {selectedNode && (
        <PropertiesPanel
          node={selectedNode}
          onClose={() => setSelectedNodeId(null)}
          onUpdate={handleNodeUpdate}
        />
      )}

      {/* Quick Add Resource Modal */}
      <AddResourceModal
        isOpen={isAddModalOpen}
        provider={activeProject.provider}
        onClose={() => setIsAddModalOpen(false)}
        onSelectResource={handleQuickAdd}
      />

      {/* Invalid Connection Alert Modal */}
      {connectionError && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-200"
          id="invalid-connection-modal"
        >
          <div className="bg-slate-900 border border-rose-500/30 rounded-2xl p-6 max-w-lg w-full shadow-2xl shadow-rose-950/20 text-slate-100">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center shrink-0 text-rose-400">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-base font-semibold text-rose-300">
                  {connectionError.title}
                </h3>
                <div className="flex items-center gap-2 mt-1 text-xs font-mono text-slate-400">
                  <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">{connectionError.sourceLabel}</span>
                  <span>→</span>
                  <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">{connectionError.targetLabel}</span>
                </div>
              </div>
            </div>

            <p className="text-sm text-slate-300 mt-4 leading-relaxed font-medium">
              {connectionError.message}
            </p>

            <div className="mt-3 p-3 rounded-xl bg-slate-950/60 border border-slate-800 text-xs text-slate-400 leading-relaxed">
              <span className="font-semibold text-slate-300 block mb-1">Architectural Rationale:</span>
              {connectionError.reason}
            </div>

            {connectionError.alternatives.length > 0 && (
              <div className="mt-3">
                <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider block mb-1">
                  Valid Alternatives:
                </span>
                <ul className="text-xs text-slate-300 space-y-1 list-disc list-inside">
                  {connectionError.alternatives.map((alt, i) => (
                    <li key={i}>{alt}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                id="btn-dismiss-connection-error"
                onClick={() => setConnectionError(null)}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl transition-colors"
              >
                Understood
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
