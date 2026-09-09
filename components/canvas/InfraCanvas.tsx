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
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useApp, useActiveProject } from '@/context/AppContext';
import { CanvasNode, CanvasEdge } from '@/types';
import { getResourceDefinition } from '@/lib/resources';
import CloudNode from './CloudNode';
import ContainerNode from './ContainerNode';
import { TrafficEdge, AssociationEdge } from './ArchitectureEdges';
import ResourcePalette from './ResourcePalette';
import PropertiesPanel from './PropertiesPanel';
import CanvasToolbar from './CanvasToolbar';
import AddResourceModal from './AddResourceModal';
import { autoLayoutArchitecture } from '@/lib/canvas/autoLayout';

const nodeTypes = {
  cloudNode: CloudNode,
  containerNode: ContainerNode,
};

const edgeTypes = {
  traffic: TrafficEdge,
  association: AssociationEdge,
};

function toReactFlowNodes(
  canvasNodes: CanvasNode[],
  activeDragTargetId: string | null = null,
  isValidDrop = true
): Node[] {
  // Count children per container
  const childCountMap = new Map<string, number>();
  for (const n of canvasNodes) {
    if (n.groupId) {
      childCountMap.set(n.groupId, (childCountMap.get(n.groupId) || 0) + 1);
    }
  }

  // Order: VPC/VNet (-2) -> Subnet (-1) -> Leaf nodes (1)
  const sorted = [...canvasNodes].sort((a, b) => {
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
    const isContainer = def?.isContainer === true;
    const isVpc = n.resourceType === 'aws_vpc' || n.resourceType === 'azure_vnet' || n.resourceType === 'azure_resource_group';
    const isSubnet = n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet';

    const width = n.width || def?.defaultWidth || (isVpc ? 780 : isSubnet ? 340 : 180);
    const height = n.height || def?.defaultHeight || (isVpc ? 500 : isSubnet ? 220 : 100);

    return {
      id: n.id,
      type: isContainer ? 'containerNode' : 'cloudNode',
      position: n.position,
      data: {
        label: n.label,
        resourceType: n.resourceType,
        provider: n.provider,
        config: n.config,
        width,
        height,
        groupId: n.groupId,
        isDragTarget: activeDragTargetId === n.id,
        isValidDrop,
        childCount: childCountMap.get(n.id) || 0,
      },
      selected: n.selected,
      zIndex: isVpc ? -2 : isSubnet ? -1 : 1,
    };
  });
}

function toReactFlowEdges(canvasEdges: CanvasEdge[]): Edge[] {
  return canvasEdges.map((e) => {
    const isAssociation = e.edgeType === 'security' || e.edgeType === 'management';
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      type: isAssociation ? 'association' : 'traffic',
      animated: !isAssociation,
      style: { stroke: isAssociation ? '#64748B' : '#38BDF8', strokeWidth: 2 },
      labelStyle: { fontSize: 10, fill: '#CBD5E1', fontFamily: 'monospace' },
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

  // Undo/Redo history stacks
  const undoStack = useRef<{ nodes: Node[]; edges: Edge[] }[]>([]);
  const redoStack = useRef<{ nodes: Node[]; edges: Edge[] }[]>([]);

  const initialNodes = activeProject ? toReactFlowNodes(activeProject.nodes) : [];
  const initialEdges = activeProject ? toReactFlowEdges(activeProject.edges) : [];

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  latestNodesRef.current = nodes;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Provider filter for multi-cloud canvas
  const [canvasFilter, setCanvasFilter] = useState<'all' | 'aws' | 'azure'>('all');

  // Track project/env/version changes
  const prevProjectRef = useRef<string | null>(null);
  const prevEnvRef = useRef<string | null>(null);
  const prevCanvasKey = useRef<number>(state.canvasKey);

  if (
    activeProject &&
    (activeProject.id !== prevProjectRef.current ||
      state.activeEnvironment !== prevEnvRef.current ||
      state.canvasKey !== prevCanvasKey.current)
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
  }

  // ── History helpers ──────────────────────────────────────────────────────────
  const pushHistory = useCallback((n: Node[], e: Edge[]) => {
    undoStack.current.push({ nodes: n, edges: e });
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
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
    return edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label as string | undefined,
      edgeType: (e.type as CanvasEdge['edgeType']) || 'network',
    }));
  }, [edges]);

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
    const ce = resolvedEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label as string | undefined,
      edgeType: (e.type as CanvasEdge['edgeType']) || 'network',
    }));
    dispatch({ type: 'UPDATE_CANVAS', nodes: cn, edges: ce });
  }, [activeProject, dispatch, nodes, edges]);

  // ── Smart Connect ────────────────────────────────────────────────────────────
  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const sourceNode = nodes.find((n) => n.id === connection.source);
    const targetNode = nodes.find((n) => n.id === connection.target);

    let edgeType = 'traffic';
    let label: string | undefined = undefined;

    if (sourceNode && targetNode) {
      const sType = sourceNode.data.resourceType;
      const tType = targetNode.data.resourceType;

      if (tType === 'aws_sg' || tType === 'azure_nsg' || tType === 'aws_iam') {
        edgeType = 'association';
      } else if (sType === 'aws_alb' && (tType === 'aws_ec2' || tType === 'aws_auto_scaling')) {
        edgeType = 'traffic';
        label = 'HTTP/80';
      } else if (sType === 'aws_ec2' && (tType === 'aws_rds' || tType === 'azure_sql')) {
        edgeType = 'traffic';
        label = 'Port 5432';
      }
    }

    const newEdges = addEdge(
      {
        ...connection,
        type: edgeType,
        label,
        animated: edgeType === 'traffic',
        style: { stroke: edgeType === 'association' ? '#64748B' : '#38BDF8', strokeWidth: 2 },
      },
      edges
    );
    pushHistory(nodes, edges);
    setEdges(newEdges);
    syncToStore(nodes, newEdges);
  }, [edges, nodes, setEdges, syncToStore, pushHistory]);

  // ── Container Detection Helper ───────────────────────────────────────────────
  const findContainerAtPosition = useCallback((pos: { x: number; y: number }, draggedType?: string) => {
    const containerNodes = nodes.filter((n) => {
      const def = getResourceDefinition(n.data.resourceType);
      return def?.isContainer === true;
    });

    // Check subnets first (inner containers)
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
        const isAllowed = draggedType ? subDef?.allowedChildren?.includes(draggedType) ?? true : true;
        return { container: sub, isAllowed };
      }
    }

    // Check VPC / VNet (outer containers)
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
        const isAllowed = draggedType ? vpcDef?.allowedChildren?.includes(draggedType) ?? true : true;
        return { container: vpc, isAllowed };
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
    const resourceType = event.dataTransfer.types.includes('application/cloudcraft')
      ? event.dataTransfer.getData('application/cloudcraft')
      : undefined;

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
    const resourceType = event.dataTransfer.getData('application/cloudcraft');
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

  // ── Drag Nodes & Move Child Nodes with Containers ────────────────────────────
  const onNodesChangeWrapped: typeof onNodesChange = useCallback((changes) => {
    onNodesChange(changes);

    // If container node position changes, shift its children
    const positionChanges = changes.filter((c): c is NodePositionChange => c.type === 'position' && !!c.position);
    for (const change of positionChanges) {
      const targetNode = nodes.find((n) => n.id === change.id);
      if (targetNode?.type === 'containerNode' && change.position) {
        const deltaX = change.position.x - targetNode.position.x;
        const deltaY = change.position.y - targetNode.position.y;
        if (deltaX !== 0 || deltaY !== 0) {
          // Shift children
          setNodes((currentNodes) =>
            currentNodes.map((n) => {
              if (n.data.groupId === change.id) {
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

    const isDragStop = changes.some((c) => c.type === 'position' && !c.dragging);
    if (isDragStop) {
      setTimeout(() => syncToStore(latestNodesRef.current), 0);
    }
  }, [onNodesChange, syncToStore, nodes, setNodes]);

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
  }, [nodes, edges, setNodes, setEdges, syncToStore]);

  const handleRedo = useCallback(() => {
    if (redoStack.current.length === 0) return;
    const snap = redoStack.current.pop()!;
    undoStack.current.push({ nodes, edges });
    setNodes(snap.nodes);
    setEdges(snap.edges);
    syncToStore(snap.nodes, snap.edges);
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
          canUndo={undoStack.current.length > 0}
          canRedo={redoStack.current.length > 0}
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
    </div>
  );
}
