'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import AzBoundaryNode from './AzBoundaryNode';
import CloudProviderBoundary from './CloudProviderBoundary';
import {
  TrafficEdge,
  NetworkFlowEdge,
  DataFlowEdge,
  LoadBalancesEdge,
  ConnectsToEdge,
  DatabaseConnectionEdge,
  StoresInEdge,
  ResolvesToEdge,
  AssociationEdge,
  AssociatedWithEdge,
  DependencyEdge,
  ReplicationEdge,
  CrossCloudEdge,
  UnknownRelationshipEdge,
} from './ArchitectureEdges';
import ResourcePalette from './ResourcePalette';
import PropertiesPanel from './PropertiesPanel';
import ConnectionInspector from './ConnectionInspector';
import CanvasToolbar from './CanvasToolbar';
import AddResourceModal from './AddResourceModal';
import CanvasStartModal from './CanvasStartModal';
import AiPromptPanel from '../panels/AiPromptPanel';
import CompliancePanel from '../panels/CompliancePanel';
import GitOpsPanel from '../panels/GitOpsPanel';
import { autoLayoutArchitecture } from '@/lib/canvas/autoLayout';
import { apiWellArchitectedService } from '@/lib/services/ApiWellArchitectedService';
import { architectureAutoFixEngine } from '@/lib/engines/autofix/ArchitectureAutoFixEngine';
import { scaleAdvisorEngine } from '@/lib/engines/ai/ScaleAdvisorEngine';
import { toCanonicalGraph, validateCanonicalArchitecture } from '@/lib/domain/canonicalArchitecture';
import { CloudProvider, ProviderMode, ScaleProfile, Region, providerModeToCloudProvider, cloudProviderToProviderMode, isNodeCompatibleWithProviderMode, inferNodeProvider } from '@/types';
import { AlertTriangle, Check, X, Sparkles, Bot, ShieldCheck, GitMerge, Download, Loader2, Wrench, Search, Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';

const nodeTypes = {
  cloudNode: CloudNode,
  containerNode: ContainerNode,
  cloudProviderNode: CloudProviderBoundary,
  azBoundaryNode: AzBoundaryNode,
};

const edgeTypes = {
  traffic: TrafficEdge,
  networkFlow: NetworkFlowEdge,
  dataFlow: DataFlowEdge,
  loadBalances: LoadBalancesEdge,
  connectsTo: ConnectsToEdge,
  databaseConnection: DatabaseConnectionEdge,
  storesIn: StoresInEdge,
  resolvesTo: ResolvesToEdge,
  association: AssociationEdge,
  associatedWith: AssociatedWithEdge,
  dependency: DependencyEdge,
  replication: ReplicationEdge,
  crossCloud: CrossCloudEdge,
  unknownRelationship: UnknownRelationshipEdge,
};

function toReactFlowNodes(
  canvasNodes: CanvasNode[],
  activeDragTargetId: string | null = null,
  isValidDrop = true,
  findingsMap?: Map<string, { critical: number; high: number; medium: number; total: number }>,
  showFindings = false
): Node[] {
  let workingNodes = [...canvasNodes];

  // 1. Auto-inject Cloud Provider Boundary if missing so every VPC is always inside a Cloud Box
  const hasAwsBoundary = workingNodes.some(
    (n) => n.resourceType === 'aws_cloud_boundary' || (n.resourceType === 'cloud_provider_boundary' && (n.provider === 'aws' || !n.provider))
  );
  const hasAwsNodes = workingNodes.some(
    (n) => n.provider === 'aws' || n.resourceType.startsWith('aws_')
  );

  if (hasAwsNodes && !hasAwsBoundary) {
    const region = (workingNodes.find((n) => n.provider === 'aws')?.config?.region as string) || 'us-east-1';
    const awsBoundaryNode: CanvasNode = {
      id: 'aws-cloud',
      type: 'containerNode',
      resourceType: 'aws_cloud_boundary',
      provider: 'aws',
      label: `Amazon Web Services (${region})`,
      position: { x: 30, y: 20 },
      config: { region },
      width: 1240,
      height: 940,
    };
    workingNodes.unshift(awsBoundaryNode);
    workingNodes = workingNodes.map((n) => {
      if (n.id !== 'aws-cloud' && (n.provider === 'aws' || n.resourceType.startsWith('aws_')) && !n.groupId) {
        return { ...n, groupId: 'aws-cloud' };
      }
      return n;
    });
  }

  const hasAzBoundary = workingNodes.some(
    (n) => n.resourceType === 'azure_cloud_boundary' || (n.resourceType === 'cloud_provider_boundary' && n.provider === 'azure')
  );
  const hasAzNodes = workingNodes.some(
    (n) => n.provider === 'azure' || n.resourceType.startsWith('azure_')
  );

  if (hasAzNodes && !hasAzBoundary) {
    const region = (workingNodes.find((n) => n.provider === 'azure')?.config?.region as string) || 'eastus';
    const azBoundaryNode: CanvasNode = {
      id: 'az-cloud',
      type: 'containerNode',
      resourceType: 'azure_cloud_boundary',
      provider: 'azure',
      label: `Microsoft Azure (${region})`,
      position: { x: hasAwsNodes ? 1300 : 30, y: 20 },
      config: { region },
      width: 1200,
      height: 900,
    };
    workingNodes.unshift(azBoundaryNode);
    workingNodes = workingNodes.map((n) => {
      if (n.id !== 'az-cloud' && (n.provider === 'azure' || n.resourceType.startsWith('azure_')) && !n.groupId) {
        return { ...n, groupId: 'az-cloud' };
      }
      return n;
    });
  }

  // Count children per container
  const childCountMap = new Map<string, number>();
  for (const n of workingNodes) {
    if (n.groupId) {
      childCountMap.set(n.groupId, (childCountMap.get(n.groupId) || 0) + 1);
    }
  }

  // Order: Boundary (-3) -> VPC/VNet (-2) -> Subnet (-1) -> Leaf nodes (1)
  const sorted = [...workingNodes].sort((a, b) => {
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

  const initialReactFlowNodes: Node[] = sorted.map((n) => {
    const def = getResourceDefinition(n.resourceType);
    const isBoundary = n.resourceType === 'cloud_provider_boundary' || n.resourceType === 'aws_cloud_boundary' || n.resourceType === 'azure_cloud_boundary';
    const isContainer = def?.isContainer === true || isBoundary;
    const isVpc = n.resourceType === 'aws_vpc' || n.resourceType === 'azure_vnet' || n.resourceType === 'azure_resource_group';
    const isSubnet = n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet';

    const width = n.width || def?.defaultWidth || (isBoundary ? 980 : isVpc ? 840 : isSubnet ? 380 : 180);
    const height = n.height || def?.defaultHeight || (isBoundary ? 620 : isVpc ? 520 : isSubnet ? 200 : 100);

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

  // Automatically compute and expand container bounds around child elements on initial load
  return recalculateContainerBounds(initialReactFlowNodes);
}

function recalculateContainerBounds(allNodes: Node[]): Node[] {
  let updated = [...allNodes];

  // 1. Subnets around leaf children
  const subnets = updated.filter(
    (n) => n.data.resourceType === 'aws_subnet' || n.data.resourceType === 'azure_subnet'
  );

  for (const subnet of subnets) {
    const children = updated.filter((n) => n.data.groupId === subnet.id);
    if (children.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of children) {
        const cw = c.data.width || 180;
        const ch = c.data.height || 100;
        minX = Math.min(minX, c.position.x);
        minY = Math.min(minY, c.position.y);
        maxX = Math.max(maxX, c.position.x + cw);
        maxY = Math.max(maxY, c.position.y + ch);
      }
      const padX = 35;
      const padTop = 65; // Guarantees 65px clear margin below subnet header and badges
      const padBottom = 35;

      const newX = Math.min(subnet.position.x, minX - padX);
      const newY = Math.min(subnet.position.y, minY - padTop);
      const finalW = Math.max(subnet.data.width || 380, (maxX - newX) + padX);
      const finalH = Math.max(subnet.data.height || 200, (maxY - newY) + padBottom);

      updated = updated.map((n) =>
        n.id === subnet.id
          ? {
              ...n,
              position: { x: newX, y: newY },
              data: { ...n.data, width: finalW, height: finalH, childCount: children.length },
            }
          : n
      );
    }
  }

  // 2. VPC / VNets around subnets and direct children
  const vpcs = updated.filter(
    (n) =>
      n.data.resourceType === 'aws_vpc' ||
      n.data.resourceType === 'azure_vnet' ||
      n.data.resourceType === 'azure_resource_group'
  );

  for (const vpc of vpcs) {
    const contained = updated.filter(
      (n) =>
        n.data.groupId === vpc.id ||
        (n.data.groupId && updated.some((sub) => sub.id === n.data.groupId && sub.data.groupId === vpc.id))
    );

    if (contained.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of contained) {
        const cw = c.data.width || 180;
        const ch = c.data.height || 100;
        minX = Math.min(minX, c.position.x);
        minY = Math.min(minY, c.position.y);
        maxX = Math.max(maxX, c.position.x + cw);
        maxY = Math.max(maxY, c.position.y + ch);
      }
      const padX = 45;
      const padTop = 75; // Guarantees 75px clear margin below VPC header
      const padBottom = 45;

      const newX = Math.min(vpc.position.x, minX - padX);
      const newY = Math.min(vpc.position.y, minY - padTop);
      const finalW = Math.max(vpc.data.width || 840, (maxX - newX) + padX);
      const finalH = Math.max(vpc.data.height || 520, (maxY - newY) + padBottom);

      updated = updated.map((n) =>
        n.id === vpc.id
          ? {
              ...n,
              position: { x: newX, y: newY },
              data: { ...n.data, width: finalW, height: finalH, childCount: contained.length },
            }
          : n
      );
    }
  }

  // 3. Cloud Provider Boundaries around VPCs and Regional Services
  const boundaries = updated.filter(
    (n) =>
      n.data.resourceType === 'cloud_provider_boundary' ||
      n.data.resourceType === 'aws_cloud_boundary' ||
      n.data.resourceType === 'azure_cloud_boundary'
  );

  for (const b of boundaries) {
    const bProvider = b.data.provider ?? (b.data.resourceType.includes('azure') ? 'azure' : 'aws');
    const contained = updated.filter((n) => {
      if (n.id === b.id) return false;
      const nProvider = n.data.provider ?? (n.data.resourceType?.startsWith('azure_') ? 'azure' : 'aws');
      return nProvider === bProvider || n.data.groupId === b.id;
    });

    if (contained.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of contained) {
        const cw = c.data.width || 180;
        const ch = c.data.height || 100;
        minX = Math.min(minX, c.position.x);
        minY = Math.min(minY, c.position.y);
        maxX = Math.max(maxX, c.position.x + cw);
        maxY = Math.max(maxY, c.position.y + ch);
      }
      const padX = 50;
      const padTop = 85; // Guarantees 85px clear margin below Cloud Provider header
      const padBottom = 55;

      const newX = Math.min(b.position.x, minX - padX);
      const newY = Math.min(b.position.y, minY - padTop);
      const finalW = Math.max(b.data.width || 1050, (maxX - newX) + padX);
      const finalH = Math.max(b.data.height || 650, (maxY - newY) + padBottom);

      updated = updated.map((n) =>
        n.id === b.id
          ? {
              ...n,
              position: { x: newX, y: newY },
              data: {
                ...n.data,
                width: finalW,
                height: finalH,
                resourceCount: contained.length,
              },
            }
          : n
      );
    }
  }

  return updated;
}

function toReactFlowEdges(canvasEdges: CanvasEdge[], canvasNodes?: CanvasNode[]): Edge[] {
  const nodeMap = canvasNodes ? new Map(canvasNodes.map((n) => [n.id, n])) : null;
  const seenEdgeKeys = new Set<string>();
  const result: Edge[] = [];

  for (const e of canvasEdges) {
    // Exclude orphaned edges if canvasNodes is known
    if (nodeMap && (!nodeMap.has(e.source) || !nodeMap.has(e.target))) {
      continue;
    }

    const relType = e.relationshipType || (e.edgeType as string) || 'NETWORK_FLOW';
    // Containment is purely visual container nesting, not drawn as a network arrow
    if (relType === 'CONTAINS') {
      continue;
    }

    // Deduplication check
    const dedupKey = `${e.source}:${relType}:${e.target}`;
    if (seenEdgeKeys.has(dedupKey)) {
      continue;
    }
    seenEdgeKeys.add(dedupKey);

    let type = 'traffic';
    let color = '#38BDF8';

    if (e.validationStatus === 'invalid' || relType === 'UNKNOWN') {
      type = 'unknownRelationship';
      color = '#F43F5E';
    } else if (relType === 'LOAD_BALANCES') {
      type = 'loadBalances';
      color = '#818CF8';
    } else if (relType === 'CONNECTS_TO' || relType === 'DATABASE_CONNECTION') {
      type = 'connectsTo';
      color = '#10B981';
    } else if (relType === 'STORES_IN') {
      type = 'storesIn';
      color = '#14B8A6';
    } else if (relType === 'DATA_FLOW') {
      type = 'dataFlow';
      color = '#06B6D4';
    } else if (relType === 'RESOLVES_TO') {
      type = 'resolvesTo';
      color = '#38BDF8';
    } else if (
      relType === 'ASSOCIATED_WITH' ||
      relType === 'DEPENDS_ON' ||
      relType === 'LOGICAL_DEPENDENCY' ||
      relType === 'security' ||
      relType === 'management'
    ) {
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

    // Smart Handle selection to avoid looping lines
    let sourceHandle: string | undefined = undefined;
    let targetHandle: string | undefined = undefined;
    if (nodeMap) {
      const srcNode = nodeMap.get(e.source);
      const tgtNode = nodeMap.get(e.target);
      if (srcNode && tgtNode) {
        const dx = tgtNode.position.x - srcNode.position.x;
        const dy = tgtNode.position.y - srcNode.position.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
          sourceHandle = dx >= 0 ? 'source-right' : 'source-bottom';
          targetHandle = dx >= 0 ? 'target-left' : 'target-top';
        } else {
          sourceHandle = dy >= 0 ? 'source-bottom' : 'source-right';
          targetHandle = dy >= 0 ? 'target-top' : 'target-left';
        }
      }
    }

    const deterministicId = e.id && e.id.includes(':') ? e.id : dedupKey;

    result.push({
      id: deterministicId,
      source: e.source,
      target: e.target,
      sourceHandle,
      targetHandle,
      label: e.label,
      type,
      animated: !isAssociation && type !== 'unknownRelationship',
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
    });
  }

  return result;
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

  // AI Prompt / Compliance / GitOps overlay panels
  const [showAiPrompt, setShowAiPrompt] = useState(false);
  const [showCompliance, setShowCompliance] = useState(false);
  const [showGitOps, setShowGitOps] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [exporting, setExporting] = useState(false);
  const toolsMenuRef = useRef<HTMLDivElement>(null);

  // Close the tools menu on an outside click
  useEffect(() => {
    if (!showToolsMenu) return;
    function handleClickOutside(event: MouseEvent) {
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(event.target as globalThis.Node)) {
        setShowToolsMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showToolsMenu]);

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
  const initialEdges = activeProject ? toReactFlowEdges(activeProject.edges, activeProject.nodes) : [];

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Provider filter for multi-cloud canvas
  const [canvasFilter, setCanvasFilter] = useState<'all' | 'aws' | 'azure'>('all');
  const [canvasSearchQuery, setCanvasSearchQuery] = useState('');

  // Well-Architected findings overlay state
  const [showFindings, setShowFindings] = useState(false);
  const [findingsMap, setFindingsMap] = useState<Map<string, { critical: number; high: number; medium: number; total: number }>>(new Map());

  // Canvas Start Modal for initial blank architecture setup
  const isFreshDraft = !activeProject || (activeProject.isDraft && activeProject.nodes.length === 0);
  const [showStartModal, setShowStartModal] = useState<boolean>(false);
  const [hasDismissedStartModal, setHasDismissedStartModal] = useState(false);

  useEffect(() => {
    if (isFreshDraft && !hasDismissedStartModal) {
      const timer = setTimeout(() => setShowStartModal(true), 0);
      return () => clearTimeout(timer);
    }
  }, [isFreshDraft, hasDismissedStartModal]);

  // Provider Mode Change Confirmation Modal
  const [pendingProviderChange, setPendingProviderChange] = useState<{
    newMode: ProviderMode;
    incompatibleCount: number;
    incompatibleNodeLabels: string[];
  } | null>(null);

  // Auto-Fix execution state & banner notification
  const [isFixing, setIsFixing] = useState(false);
  const [bannerMessage, setBannerMessage] = useState<{ text: string; type: 'success' | 'info' | 'error' } | null>(null);

  // ── History helpers ──────────────────────────────────────────────────────────
  const pushHistory = useCallback((n: Node[], e: Edge[]) => {
    undoStack.current.push({ nodes: n, edges: e });
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  // ── Canvas sync helpers ──────────────────────────────────────────────────────
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

  // Save as Project Modal & Discard Modal States
  const [showSaveProjectModal, setShowSaveProjectModal] = useState(false);
  const [saveProjectName, setSaveProjectName] = useState('');
  const [saveProjectProvider, setSaveProjectProvider] = useState<CloudProvider>('aws');
  const [showDiscardModal, setShowDiscardModal] = useState(false);

  const handleSaveClick = useCallback(() => {
    const isDraft = !state.activeProjectId || state.activeProjectId === 'draft-project';
    if (isDraft) {
      const currentProvider = activeProject?.provider || 'aws';
      setSaveProjectProvider(currentProvider);
      setSaveProjectName(
        activeProject?.name && activeProject.name !== 'Untitled Draft' && activeProject.name !== 'Draft Architecture'
          ? activeProject.name
          : 'My Cloud Infrastructure'
      );
      setShowSaveProjectModal(true);
    } else {
      dispatch({ type: 'SAVE_NOW' });
      setBannerMessage({
        text: `Saved all changes to "${activeProject?.name || 'Project'}"!`,
        type: 'success',
      });
      setTimeout(() => setBannerMessage(null), 3000);
    }
  }, [state.activeProjectId, activeProject, dispatch]);

  const handleConfirmSaveProject = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const name = saveProjectName.trim() || 'My Cloud Infrastructure';
    const provider = saveProjectProvider;
    const currentCanvasNodes = getCanvasNodes();
    const currentCanvasEdges = getCanvasEdges();

    dispatch({
      type: 'CREATE_PROJECT',
      name,
      provider,
      nodes: currentCanvasNodes,
      edges: currentCanvasEdges,
    });

    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem('cloudcraft_draft_project');
        localStorage.removeItem('cloudcraft_draft_timestamp');
      } catch {}
    }

    setShowSaveProjectModal(false);
    setBannerMessage({
      text: `Project "${name}" saved to your CloudCraft account!`,
      type: 'success',
    });
    setTimeout(() => setBannerMessage(null), 3500);
  }, [saveProjectName, saveProjectProvider, getCanvasNodes, getCanvasEdges, dispatch]);

  const handleConfirmDiscard = useCallback(() => {
    const isDraft = !state.activeProjectId || state.activeProjectId === 'draft-project';
    pushHistory(nodes, edges);
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);

    if (isDraft) {
      if (typeof window !== 'undefined') {
        try {
          localStorage.removeItem('cloudcraft_draft_project');
          localStorage.removeItem('cloudcraft_draft_timestamp');
        } catch {}
      }
      dispatch({ type: 'INIT_BLANK_ARCHITECTURE', provider: 'aws', nodes: [], edges: [] });
    } else {
      dispatch({ type: 'UPDATE_CANVAS', nodes: [], edges: [] });
      dispatch({ type: 'SAVE_NOW' });
    }

    setShowDiscardModal(false);
    setBannerMessage({
      text: 'Visual builder architecture discarded and canvas reset.',
      type: 'info',
    });
    setTimeout(() => setBannerMessage(null), 3000);
  }, [state.activeProjectId, nodes, edges, pushHistory, setNodes, setEdges, dispatch]);

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
    const projectChanged = activeProject.id !== prevProjectRef.current;
    const envChanged = state.activeEnvironment !== prevEnvRef.current;
    const keyChanged = state.canvasKey !== prevCanvasKey.current;
    const nodesCountMismatch = activeProject.nodes.length > 0 && nodes.length === 0;

    if (projectChanged || envChanged || keyChanged || nodesCountMismatch) {
      prevProjectRef.current = activeProject.id;
      prevEnvRef.current = state.activeEnvironment;
      prevCanvasKey.current = state.canvasKey;
      const envNodes = toReactFlowNodes(activeProject.nodes);
      const envEdges = toReactFlowEdges(activeProject.edges, activeProject.nodes);
      setNodes(envNodes);
      setEdges(envEdges);
      setSelectedNodeId(null);
      undoStack.current = [];
      redoStack.current = [];
      setCanUndo(false);
      setCanRedo(false);

      if (reactFlowInstance.current && envNodes.length > 0) {
        setTimeout(() => {
          reactFlowInstance.current?.fitView({ padding: 0.15, duration: 300 });
        }, 80);
      }
    }
  }, [activeProject, state.activeEnvironment, state.canvasKey, setNodes, setEdges, nodes.length]);

  // ── Canvas Start Modal Callback ─────────────────────────────────────────────
  const handleStartModalComplete = useCallback((options: {
    providerMode: ProviderMode;
    scaleProfile: ScaleProfile;
    mode: 'manual' | 'ai';
    aiPrompt?: string;
    region?: Region;
  }) => {
    setShowStartModal(false);
    setHasDismissedStartModal(true);

    if (options.mode === 'ai' && options.aiPrompt) {
      const rec = scaleAdvisorEngine.interpretRequirements(
        options.aiPrompt,
        providerModeToCloudProvider(options.providerMode)
      );
      dispatch({
        type: 'INIT_BLANK_ARCHITECTURE',
        providerMode: options.providerMode,
        scaleProfile: options.scaleProfile,
        nodes: rec.nodes,
        edges: rec.edges,
      });
      setBannerMessage({
        text: `✓ AI Architecture generated for ${options.scaleProfile.expectedUsers.toLocaleString()} users — Deterministically validated`,
        type: 'success',
      });
      setTimeout(() => setBannerMessage(null), 4000);
    } else {
      dispatch({
        type: 'INIT_BLANK_ARCHITECTURE',
        providerMode: options.providerMode,
        scaleProfile: options.scaleProfile,
      });
      setBannerMessage({
        text: `✓ Canvas ready (${options.providerMode} mode) — Drag & drop resources from palette`,
        type: 'info',
      });
      setTimeout(() => setBannerMessage(null), 3000);
    }
  }, [dispatch]);

  // ── Provider Mode Change with Destructive Confirmation ───────────────────────
  const handleRequestProviderModeChange = useCallback((newMode: ProviderMode) => {
    if (!activeProject) return;
    const currentMode = activeProject.providerMode || cloudProviderToProviderMode(activeProject.provider);
    if (newMode === currentMode) return;

    // Check for incompatible nodes
    const currentNodes = activeProject.nodes;
    const incompatibleNodes = currentNodes.filter((n) => !isNodeCompatibleWithProviderMode(n, newMode));

    if (incompatibleNodes.length > 0) {
      setPendingProviderChange({
        newMode,
        incompatibleCount: incompatibleNodes.length,
        incompatibleNodeLabels: incompatibleNodes.slice(0, 5).map((n) => n.label),
      });
    } else {
      dispatch({ type: 'SET_PROVIDER_MODE', mode: newMode });
    }
  }, [activeProject, dispatch]);

  const confirmProviderChange = useCallback(() => {
    if (!pendingProviderChange) return;
    dispatch({ type: 'CONFIRM_PROVIDER_MODE_CHANGE', mode: pendingProviderChange.newMode });
    setPendingProviderChange(null);
    setBannerMessage({
      text: `✓ Architecture converted to ${pendingProviderChange.newMode} mode`,
      type: 'info',
    });
    setTimeout(() => setBannerMessage(null), 3000);
  }, [pendingProviderChange, dispatch]);

  // ── Auto-Fix Engine Interaction ─────────────────────────────────────────────
  const handleAutoFix = useCallback(() => {
    if (!activeProject) return;
    setIsFixing(true);

    try {
      const canonical = toCanonicalGraph({
        id: activeProject.id,
        name: activeProject.name,
        provider: activeProject.provider,
        providerMode: activeProject.providerMode,
        nodes: activeProject.nodes,
        edges: activeProject.edges,
        scaleProfile: activeProject.scaleProfile,
      });

      const fixResult = architectureAutoFixEngine.fixArchitecture(
        activeProject.nodes,
        activeProject.edges,
        canonical
      );

      const laidOut = autoLayoutArchitecture(fixResult.nodes, fixResult.edges);

      const rfNodes = toReactFlowNodes(laidOut.nodes);
      const rfEdges = toReactFlowEdges(laidOut.edges, laidOut.nodes);
      setNodes(rfNodes);
      setEdges(rfEdges);

      dispatch({
        type: 'UPDATE_CANVAS',
        nodes: laidOut.nodes,
        edges: laidOut.edges,
      });

      const fixCount = fixResult.changesApplied.length;
      setBannerMessage({
        text: `✓ Architecture fixed (${fixCount} repair${fixCount === 1 ? '' : 's'} applied) — Changes saved`,
        type: 'success',
      });
      setTimeout(() => setBannerMessage(null), 4000);
    } catch (err) {
      console.error('AutoFix failed:', err);
      setBannerMessage({
        text: 'Auto-Fix encountered an unexpected issue.',
        type: 'error',
      });
      setTimeout(() => setBannerMessage(null), 4000);
    } finally {
      setIsFixing(false);
    }
  }, [activeProject, dispatch, setNodes, setEdges]);

  // ── AI Prompt Panel: merge generated graph into the canvas ──────────────────
  const handleApplyAiGraph = useCallback((newNodes: CanvasNode[], newEdges: CanvasEdge[]) => {
    if (!activeProject) return;
    const mergedNodes = [...activeProject.nodes, ...newNodes];
    const mergedEdges = [...activeProject.edges, ...newEdges];
    const laidOut = autoLayoutArchitecture(mergedNodes, mergedEdges);

    setNodes(toReactFlowNodes(laidOut.nodes));
    setEdges(toReactFlowEdges(laidOut.edges, laidOut.nodes));
    dispatch({ type: 'UPDATE_CANVAS', nodes: laidOut.nodes, edges: laidOut.edges });

    setBannerMessage({
      text: `✓ AI added ${newNodes.length} resource${newNodes.length === 1 ? '' : 's'} to the architecture`,
      type: 'success',
    });
    setTimeout(() => setBannerMessage(null), 3500);
  }, [activeProject, dispatch, setNodes, setEdges]);

  // ── Export: download a real SVG/PNG/PDF of the architecture ─────────────────
  const handleExport = useCallback(async (format: 'svg' | 'png' | 'pdf') => {
    if (!activeProject) return;
    setExporting(true);
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          format,
          title: activeProject.name,
          theme: 'dark',
          nodes: activeProject.nodes,
          edges: activeProject.edges,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${activeProject.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBannerMessage({ text: `✓ Exported ${format.toUpperCase()}`, type: 'success' });
      setTimeout(() => setBannerMessage(null), 3000);
    } catch (err: any) {
      setBannerMessage({ text: err.message || 'Export failed', type: 'error' });
      setTimeout(() => setBannerMessage(null), 4000);
    } finally {
      setExporting(false);
    }
  }, [activeProject]);

  // ── Workload Scale Adaptation ───────────────────────────────────────────────
  const handleScaleChange = useCallback((newUsers: number) => {
    if (!activeProject) return;
    const currentProfile: ScaleProfile = activeProject.scaleProfile || {
      expectedUsers: 10000,
      requestsPerSecond: 50,
      peakRequestsPerSecond: 150,
      availabilityTarget: 99.9,
      trafficPattern: 'steady',
    };

    const updatedProfile: ScaleProfile = {
      ...currentProfile,
      expectedUsers: newUsers,
      requestsPerSecond: Math.max(1, Math.round(newUsers * 0.005)),
      peakRequestsPerSecond: Math.round(Math.max(1, Math.round(newUsers * 0.005)) * 3),
      geographicDistribution: newUsers >= 100000 ? 'multi-region' : 'single-region',
    };

    dispatch({
      type: 'SET_SCALE_PROFILE',
      scaleProfile: updatedProfile,
      adaptScale: true,
    });

    setBannerMessage({
      text: `✓ Scale updated to ${newUsers.toLocaleString()} users — Capacity, cost, and analysis refreshed`,
      type: 'info',
    });
    setTimeout(() => setBannerMessage(null), 3500);
  }, [activeProject, dispatch]);

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
    const validNodeIdSet = new Set(cn.map((n) => n.id));
    const seenEdgeKeys = new Set<string>();
    const ce: CanvasEdge[] = [];

    for (const e of resolvedEdges) {
      if (!validNodeIdSet.has(e.source) || !validNodeIdSet.has(e.target)) {
        continue;
      }
      const existing = activeProject?.edges.find((item) => item.id === e.id);
      const data = (e.data || {}) as Record<string, unknown>;
      const relType = (data.relationshipType as RelationshipType) || existing?.relationshipType || 'NETWORK_FLOW';
      if (relType === 'CONTAINS') {
        continue;
      }
      const key = `${e.source}:${relType}:${e.target}`;
      if (seenEdgeKeys.has(key)) {
        continue;
      }
      seenEdgeKeys.add(key);

      ce.push({
        id: e.id && e.id.includes(':') ? e.id : key,
        source: e.source,
        target: e.target,
        label: e.label as string | undefined,
        edgeType: (e.type as CanvasEdge['edgeType']) || existing?.edgeType || 'network',
        relationshipType: relType,
        protocol: (data.protocol as string) || existing?.protocol,
        port: (data.port as string | number) || existing?.port,
        networkScope: (data.networkScope as any) || existing?.networkScope,
        direction: (data.direction as any) || existing?.direction || 'unidirectional',
        inferred: (data.inferred as boolean) ?? existing?.inferred ?? false,
        validationStatus: (data.validationStatus as any) || existing?.validationStatus || 'valid',
        reason: (data.reason as string) || existing?.reason,
      });
    }
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
    } else if (relType === 'CONNECTS_TO' || relType === 'DATABASE_CONNECTION') {
      edgeReactType = 'connectsTo';
      color = '#10B981';
    } else if (relType === 'STORES_IN') {
      edgeReactType = 'storesIn';
      color = '#14B8A6';
    } else if (relType === 'DATA_FLOW') {
      edgeReactType = 'dataFlow';
      color = '#06B6D4';
    } else if (relType === 'RESOLVES_TO') {
      edgeReactType = 'resolvesTo';
      color = '#38BDF8';
    } else if (
      relType === 'ASSOCIATED_WITH' ||
      relType === 'DEPENDS_ON' ||
      relType === 'LOGICAL_DEPENDENCY'
    ) {
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
    const deterministicEdgeId = `${connection.source}:${relType}:${connection.target}`;

    // Prevent duplicate edges
    if (edges.some((e) => e.id === deterministicEdgeId || (e.source === connection.source && e.target === connection.target && e.data?.relationshipType === relType))) {
      return;
    }

    const dx = targetNode.position.x - sourceNode.position.x;
    const dy = targetNode.position.y - sourceNode.position.y;
    let sourceHandle = connection.sourceHandle;
    let targetHandle = connection.targetHandle;
    if (!sourceHandle || !targetHandle) {
      if (Math.abs(dx) >= Math.abs(dy)) {
        sourceHandle = dx >= 0 ? 'source-right' : 'source-bottom';
        targetHandle = dx >= 0 ? 'target-left' : 'target-top';
      } else {
        sourceHandle = dy >= 0 ? 'source-bottom' : 'source-right';
        targetHandle = dy >= 0 ? 'target-top' : 'target-left';
      }
    }

    const newEdges = addEdge(
      {
        ...connection,
        id: deterministicEdgeId,
        sourceHandle,
        targetHandle,
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
    setSelectedEdgeId(null);
  }, []);

  const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setSelectedEdgeId(edge.id);
    setSelectedNodeId(null);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
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
    const changingNodeIds = new Set(positionChanges.map((c) => c.id));
    for (const change of positionChanges) {
      const targetNode = nodes.find((n) => n.id === change.id);
      const isContainer =
        targetNode?.type === 'containerNode' ||
        targetNode?.type === 'cloudProviderNode' ||
        targetNode?.data.resourceType?.includes('vpc') ||
        targetNode?.data.resourceType?.includes('vnet') ||
        targetNode?.data.resourceType?.includes('boundary');

      if (targetNode && isContainer && change.position) {
        const deltaX = change.position.x - targetNode.position.x;
        const deltaY = change.position.y - targetNode.position.y;
        if (deltaX !== 0 || deltaY !== 0) {
          const descendants = getDescendantIds(change.id, nodes);
          const toShift = Array.from(descendants).filter((id) => !changingNodeIds.has(id));
          if (toShift.length > 0) {
            const shiftSet = new Set(toShift);
            setNodes((currentNodes) =>
              currentNodes.map((n) => {
                if (shiftSet.has(n.id)) {
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
          const isVpcOrBoundary =
            movedNode.data.resourceType?.includes('vpc') ||
            movedNode.data.resourceType?.includes('vnet') ||
            movedNode.data.resourceType?.includes('boundary');
          if (isVpcOrBoundary) continue;

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
        // Recalculate container bounds so containers dynamically expand/shrink safely
        updated = recalculateContainerBounds(updated);
        return updated;
      });
      setTimeout(() => syncToStore(latestNodesRef.current), 0);
    }
  }, [onNodesChange, syncToStore, nodes, setNodes, getDescendantIds, findContainerAtPosition]);

  // ── Wrapped Edges Change to capture edge deletions/disconnections ───────────
  const onEdgesChangeWrapped: typeof onEdgesChange = useCallback((changes) => {
    onEdgesChange(changes);
    const hasRemoval = changes.some((c) => c.type === 'remove');
    if (hasRemoval) {
      const removedIds = new Set(changes.filter((c) => c.type === 'remove').map((c) => (c as any).id));
      const remainingEdges = edges.filter((e) => !removedIds.has(e.id));
      pushHistory(nodes, edges);
      setTimeout(() => syncToStore(nodes, remainingEdges), 0);
    }
  }, [onEdgesChange, edges, nodes, pushHistory, syncToStore]);

  // ── Auto-layout (Logical Cloud Architecture) ─────────────────────────────────
  const handleAutoLayout = useCallback(() => {
    if (nodes.length === 0) return;
    pushHistory(nodes, edges);

    const canvasNodes = getCanvasNodes();
    const canvasEdges = getCanvasEdges();
    const laid = autoLayoutArchitecture(canvasNodes, canvasEdges);

    const rfNodes = toReactFlowNodes(laid.nodes);
    const rfEdges = toReactFlowEdges(laid.edges, laid.nodes);

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
    const selectedEdgeIds = edges.filter((e) => e.selected).map((e) => e.id);
    if (selectedEdgeId && !selectedEdgeIds.includes(selectedEdgeId)) selectedEdgeIds.push(selectedEdgeId);

    if (selectedIds.length === 0 && selectedEdgeIds.length === 0) return;

    const newNodes = selectedIds.length > 0 ? nodes.filter((n) => !selectedIds.includes(n.id)) : nodes;
    const newEdges = edges.filter(
      (e) => !selectedEdgeIds.includes(e.id) && !selectedIds.includes(e.source) && !selectedIds.includes(e.target)
    );

    pushHistory(nodes, edges);
    setNodes(newNodes);
    setEdges(newEdges);
    if (selectedNodeId && selectedIds.includes(selectedNodeId)) {
      setSelectedNodeId(null);
    }
    if (selectedEdgeId && selectedEdgeIds.includes(selectedEdgeId)) {
      setSelectedEdgeId(null);
    }
    syncToStore(newNodes, newEdges);
  }, [nodes, edges, setNodes, setEdges, selectedNodeId, selectedEdgeId, syncToStore, pushHistory]);

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
      if (e.key === 'Escape') { setSelectedNodeId(null); setSelectedEdgeId(null); setIsAddModalOpen(false); }
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

  // ── Multi-cloud filter + search ─────────────────────────────────────────────
  const normalizedSearch = canvasSearchQuery.trim().toLowerCase();
  const searchMatchCount = normalizedSearch
    ? nodes.filter((n) => {
        const label = (n.data?.label as string | undefined)?.toLowerCase() ?? '';
        const resourceType = (n.data?.resourceType as string | undefined)?.toLowerCase() ?? '';
        return label.includes(normalizedSearch) || resourceType.includes(normalizedSearch);
      }).length
    : 0;

  const visibleNodes = nodes.map((n) => {
    let dim = false;

    if (canvasFilter !== 'all' && activeProject?.provider === 'multi') {
      const existing = activeProject.nodes.find((cn) => cn.id === n.id);
      const nodeProvider = existing ? inferNodeProvider(existing) : 'aws';
      if (nodeProvider !== canvasFilter) dim = true;
    }

    if (!dim && normalizedSearch) {
      const label = (n.data?.label as string | undefined)?.toLowerCase() ?? '';
      const resourceType = (n.data?.resourceType as string | undefined)?.toLowerCase() ?? '';
      if (!label.includes(normalizedSearch) && !resourceType.includes(normalizedSearch)) dim = true;
    }

    if (dim) {
      return { ...n, style: { ...n.style, opacity: 0.15, pointerEvents: 'none' as const } };
    }
    return n;
  });

  // ── Availability Zone visual grouping ───────────────────────────────────────
  // Purely a rendering overlay computed from each subnet's existing
  // config.availabilityZone field — not a canonical resource, never
  // persisted, never affects Terraform/validation/containment. Only drawn
  // when 2+ subnets under the same VPC/VNet share an AZ, since that's the
  // case (multi-AZ HA layouts) where the grouping is actually informative.
  const azBoundaryNodes: Node[] = useMemo(() => {
    const subnetNodes = nodes.filter(
      (n) => n.data.resourceType === 'aws_subnet' || n.data.resourceType === 'azure_subnet'
    );
    const groups = new Map<string, Node[]>();
    for (const s of subnetNodes) {
      const az = (s.data.config?.availabilityZone as string | undefined)?.trim();
      const parentId = s.data.groupId as string | undefined;
      if (!az || !parentId) continue;
      const key = `${parentId}::${az}`;
      const arr = groups.get(key) ?? [];
      arr.push(s);
      groups.set(key, arr);
    }

    const boundaries: Node[] = [];
    const PADDING = 24;
    const HEADER_PADDING = 30;
    for (const [key, members] of groups) {
      if (members.length < 2) continue;
      const az = key.split('::')[1];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const m of members) {
        const w = (m.data.width as number) || 340;
        const h = (m.data.height as number) || 220;
        minX = Math.min(minX, m.position.x);
        minY = Math.min(minY, m.position.y);
        maxX = Math.max(maxX, m.position.x + w);
        maxY = Math.max(maxY, m.position.y + h);
      }
      const boxWidth = (maxX - minX) + PADDING * 2;
      const boxHeight = (maxY - minY) + HEADER_PADDING + PADDING;
      boundaries.push({
        id: `az-boundary::${key}`,
        type: 'azBoundaryNode',
        position: { x: minX - PADDING, y: minY - HEADER_PADDING },
        // Top-level width/height (not just data.width/height) are required
        // so React Flow's onlyRenderVisibleElements viewport culling can
        // compute this node's bounds — without them it defensively hides
        // the node (visibility: hidden) since it can't tell if it's on screen.
        width: boxWidth,
        height: boxHeight,
        draggable: false,
        selectable: false,
        focusable: false,
        zIndex: -2,
        data: {
          label: `Availability Zone: ${az}`,
          width: boxWidth,
          height: boxHeight,
        },
      });
    }
    return boundaries;
  }, [nodes]);

  const selectedNode = activeProject?.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedEdge = activeProject?.edges.find((e) => e.id === selectedEdgeId) ?? null;
  const selectedEdgeSourceNode = selectedEdge ? (activeProject?.nodes.find((n) => n.id === selectedEdge.source) ?? null) : null;
  const selectedEdgeTargetNode = selectedEdge ? (activeProject?.nodes.find((n) => n.id === selectedEdge.target) ?? null) : null;
  const hasSelected = nodes.some((n) => n.selected) || !!selectedNodeId;

  if (!activeProject) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-950 text-slate-400 px-4">
        <p className="text-sm font-medium text-white mb-2">No active architecture</p>
        <p className="text-xs text-slate-500 mb-6 text-center max-w-xs">
          Start building by creating a new architecture, opening an existing one, or importing from your cloud provider.
        </p>
        <div className="flex flex-col gap-2 w-full max-w-xs">
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'wizard' })}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium transition-colors"
          >
            Create Architecture
          </button>
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'dashboard' })}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white rounded-lg text-xs font-medium transition-colors"
          >
            Open Existing Architecture
          </button>
          <button
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'import' })}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white rounded-lg text-xs font-medium transition-colors"
          >
            Import Cloud Infrastructure
          </button>
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
          onAutoFix={handleAutoFix}
          isFixing={isFixing}
          onFitView={handleFitView}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onDeleteSelected={handleDeleteSelected}
          onCopy={handleCopy}
          onOpenAddModal={() => setIsAddModalOpen(true)}
          onDiscard={() => setShowDiscardModal(true)}
          providerMode={activeProject?.providerMode || (activeProject ? cloudProviderToProviderMode(activeProject.provider) : 'AWS')}
          onSelectProviderMode={handleRequestProviderModeChange}
          expectedUsers={activeProject?.scaleProfile?.expectedUsers || 10000}
          onSelectExpectedUsers={handleScaleChange}
          autoSaveStatus={state.autoSaveStatus}
          lastSavedTime={state.lastSavedTime}
          onSaveNow={handleSaveClick}
          isDraft={!state.activeProjectId || state.activeProjectId === 'draft-project'}
        />

        {/* Resource search — filters/dims canvas nodes by label or resource type,
            useful once an architecture grows past what's visible at a glance.
            Positioned below the main toolbar row (not top-4) to avoid
            overlapping the Add Resource / Auto Layout / Auto-Fix buttons. */}
        <div className="absolute top-16 left-4 z-20 flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={canvasSearchQuery}
              onChange={(e) => setCanvasSearchQuery(e.target.value)}
              placeholder="Search resources…"
              className="w-48 pl-8 pr-2.5 py-1.5 bg-slate-900/90 border border-slate-700/80 rounded-xl text-xs text-white placeholder:text-slate-500 shadow-2xl backdrop-blur-md focus:outline-none focus:ring-1 focus:ring-cyan-500 transition-all"
            />
          </div>
          {normalizedSearch && (
            <span className="px-2 py-1 rounded-lg text-[11px] font-medium bg-slate-900/90 border border-slate-700/80 text-slate-300 shadow-2xl backdrop-blur-md">
              {searchMatchCount} match{searchMatchCount === 1 ? '' : 'es'}
            </span>
          )}
        </div>

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

        {/* Tools menu — a single compact button instead of a permanently-expanded
            bar, so it doesn't sit on top of (and block clicks on) canvas nodes
            that happen to be positioned in the top-right corner. */}
        <div className="absolute top-4 right-4 z-20" ref={toolsMenuRef}>
          <button
            type="button"
            id="btn-toggle-tools-menu"
            onClick={() => setShowToolsMenu((v) => !v)}
            title="Architecture Tools"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium shadow-2xl backdrop-blur-md border transition-colors ${
              showToolsMenu || showAiPrompt || showCompliance || showGitOps
                ? 'bg-slate-800 text-white border-slate-600'
                : 'bg-slate-900/90 text-slate-300 border-slate-700/80 hover:text-white hover:bg-slate-800'
            }`}
          >
            <Wrench className="w-3.5 h-3.5" />
            <span>Tools</span>
          </button>

          {showToolsMenu && (
            <div className="absolute right-0 top-full mt-1 w-52 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden py-1">
              <button
                type="button"
                id="btn-toggle-ai-prompt"
                onClick={() => { setShowAiPrompt((v) => !v); setShowToolsMenu(false); }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium transition-colors ${
                  showAiPrompt ? 'text-fuchsia-300 bg-fuchsia-500/10' : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Bot className="w-3.5 h-3.5" />
                <span>AI Architect</span>
              </button>
              <button
                type="button"
                id="btn-toggle-compliance"
                onClick={() => { setShowCompliance((v) => !v); setShowToolsMenu(false); }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium transition-colors ${
                  showCompliance ? 'text-emerald-300 bg-emerald-500/10' : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Compliance</span>
              </button>
              <button
                type="button"
                id="btn-toggle-gitops"
                onClick={() => { setShowGitOps((v) => !v); setShowToolsMenu(false); }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium transition-colors ${
                  showGitOps ? 'text-blue-300 bg-blue-500/10' : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <GitMerge className="w-3.5 h-3.5" />
                <span>GitOps</span>
              </button>
              <div className="h-px bg-slate-800 my-1" />
              {(['svg', 'png', 'pdf'] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => { handleExport(fmt); setShowToolsMenu(false); }}
                  disabled={exporting}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50"
                >
                  {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                  <span>Export as {fmt.toUpperCase()}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {showAiPrompt && (
          <AiPromptPanel
            projectId={activeProject.id}
            environmentId={state.activeEnvironment}
            provider={activeProject.provider}
            onClose={() => setShowAiPrompt(false)}
            onApplyGraph={handleApplyAiGraph}
          />
        )}

        {showCompliance && (
          <CompliancePanel
            projectId={activeProject.id}
            architectureId={activeProject.id}
            resources={activeProject.nodes}
            edges={activeProject.edges}
            environment={state.activeEnvironment}
            onClose={() => setShowCompliance(false)}
          />
        )}

        {showGitOps && (
          <GitOpsPanel
            projectId={activeProject.id}
            architectureId={activeProject.id}
            nodes={activeProject.nodes}
            edges={activeProject.edges}
            onClose={() => setShowGitOps(false)}
          />
        )}

        {/* React Flow Core */}
        <ReactFlow
          nodes={[...visibleNodes, ...azBoundaryNodes]}
          edges={edges}
          onNodesChange={onNodesChangeWrapped}
          onEdgesChange={onEdgesChangeWrapped}
          onConnect={onConnect}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
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
          onlyRenderVisibleElements
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

      {/* Connection Inspector (Right) */}
      {selectedEdge && (
        <ConnectionInspector
          edge={selectedEdge}
          sourceNode={selectedEdgeSourceNode}
          targetNode={selectedEdgeTargetNode}
          onClose={() => setSelectedEdgeId(null)}
          onDelete={() => {
            const newEdges = edges.filter((e) => e.id !== selectedEdge.id);
            pushHistory(nodes, edges);
            setEdges(newEdges);
            setSelectedEdgeId(null);
            syncToStore(nodes, newEdges);
          }}
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

      {/* Blank Canvas Start Modal */}
      <CanvasStartModal
        isOpen={showStartModal}
        onClose={() => {
          setShowStartModal(false);
          setHasDismissedStartModal(true);
        }}
        onStart={handleStartModalComplete}
      />

      {/* Provider Change Warning Confirmation Modal */}
      {pendingProviderChange && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-slate-900 border border-amber-500/60 rounded-2xl p-6 max-w-md w-full shadow-2xl">
            <div className="flex items-center gap-3 mb-3 text-amber-400">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h3 className="text-lg font-bold text-white">Change Cloud Mode</h3>
            </div>
            <p className="text-sm text-slate-300 mb-3 leading-relaxed">
              Changing this architecture to <strong className="text-amber-400">{pendingProviderChange.newMode}</strong>-only will remove{' '}
              <strong className="text-white">{pendingProviderChange.incompatibleCount} incompatible resource{pendingProviderChange.incompatibleCount === 1 ? '' : 's'}</strong>:
            </p>
            <ul className="text-xs bg-slate-950/80 rounded-lg p-3 border border-slate-800 text-slate-400 mb-4 list-disc list-inside space-y-1">
              {pendingProviderChange.incompatibleNodeLabels.map((lbl, i) => (
                <li key={i}>{lbl}</li>
              ))}
              {pendingProviderChange.incompatibleCount > pendingProviderChange.incompatibleNodeLabels.length && (
                <li>...and {pendingProviderChange.incompatibleCount - pendingProviderChange.incompatibleNodeLabels.length} more</li>
              )}
            </ul>
            <p className="text-xs text-slate-400 mb-5">
              CloudCraft never silently deletes resources. Do you want to continue?
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                id="btn-cancel-provider-change"
                onClick={() => setPendingProviderChange(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                id="btn-confirm-provider-change"
                onClick={confirmProviderChange}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-xl text-xs font-semibold transition-colors shadow-md shadow-amber-600/20"
              >
                Continue & Remove Incompatible
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save Architecture as Project Modal */}
      {showSaveProjectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-md w-full shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-600 flex items-center justify-center text-white shadow-lg shadow-cyan-500/20">
                <Plus className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Save as Project</h3>
                <p className="text-xs text-slate-400">Save this visual architecture into your CloudCraft account</p>
              </div>
            </div>

            <form onSubmit={handleConfirmSaveProject} className="space-y-4">
              <div>
                <label className="text-xs text-slate-300 font-medium block mb-1">Project Name</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={saveProjectName}
                  onChange={(e) => setSaveProjectName(e.target.value)}
                  placeholder="e.g. Production E-Commerce Platform"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
                />
              </div>

              <div>
                <label className="text-xs text-slate-300 font-medium block mb-1">Primary Cloud Provider</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['aws', 'azure', 'multi'] as const).map((p) => (
                    <button
                      type="button"
                      key={p}
                      onClick={() => setSaveProjectProvider(p)}
                      className={clsx(
                        'py-2 px-3 rounded-xl border text-xs font-semibold transition-all text-center',
                        saveProjectProvider === p
                          ? 'bg-cyan-600/20 border-cyan-500 text-cyan-300 shadow-md shadow-cyan-500/10'
                          : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                      )}
                    >
                      {p === 'aws' ? 'AWS' : p === 'azure' ? 'Azure' : 'Multi-Cloud'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 text-slate-400 text-xs flex items-center justify-between">
                <span>Total Canvas Resources:</span>
                <span className="font-semibold text-white">{nodes.length} nodes</span>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowSaveProjectModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-xl text-xs font-semibold transition-all shadow-lg shadow-cyan-600/20"
                >
                  Save Project
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Discard Confirmation Modal */}
      {showDiscardModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-slate-900 border border-rose-500/50 rounded-2xl p-6 max-w-md w-full shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-3 mb-3 text-rose-400">
              <div className="w-10 h-10 rounded-xl bg-rose-950/80 border border-rose-500/40 flex items-center justify-center text-rose-400">
                <Trash2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Discard Architecture?</h3>
                <p className="text-xs text-rose-300/80">This action will clear the entire visual builder canvas</p>
              </div>
            </div>

            <p className="text-xs text-slate-300 mb-5 leading-relaxed">
              Are you sure you want to discard your changes? All <strong className="text-white">{nodes.length} cloud resources</strong> and their connections will be removed.
            </p>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowDiscardModal(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition-colors"
              >
                Keep Editing
              </button>
              <button
                type="button"
                onClick={handleConfirmDiscard}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-semibold transition-colors shadow-lg shadow-rose-600/20"
              >
                Yes, Discard All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Status Notification Banner */}
      {bannerMessage && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-slate-900/95 border border-slate-700 text-white text-xs font-semibold shadow-2xl backdrop-blur-md animate-fade-in">
          {bannerMessage.type === 'success' && <Check className="w-4 h-4 text-emerald-400 shrink-0" />}
          {bannerMessage.type === 'info' && <Sparkles className="w-4 h-4 text-cyan-400 shrink-0" />}
          {bannerMessage.type === 'error' && <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />}
          <span>{bannerMessage.text}</span>
        </div>
      )}
    </div>
  );
}
