/**
 * CloudCraft — Real Collaboration Service
 *
 * Provides authenticated, server-authoritative real-time collaboration on
 * architecture graphs using Socket.io.
 *
 * Architecture:
 *  - Server holds the authoritative graph state per architecture in memory
 *  - All structural operations (add/delete/move/update nodes, add/delete edges)
 *    are applied on the server, then broadcast to all room members
 *  - Presence/cursors are ephemeral (no DB write, broadcast only)
 *  - Every structural operation debounces a DB flush (2 seconds) to prevent spam
 *  - Reconnecting clients request a full state snapshot via 'request_state'
 *  - Connections are authenticated via JWT/session token
 *  - Each room is scoped to a single architectureId (project isolation)
 *
 * NO faux/fabricated users. Only authenticated users with real session IDs appear.
 */

import { Server as NetServer, type IncomingMessage, type ServerResponse } from 'http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { AuthService } from '@/lib/api/authService';
import type { CanvasNode } from '@/types';

// ─── Graph state types ────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  resourceType: string;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  parentId?: string | null;
  region?: string;
  provider?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface ArchitectureGraph {
  architectureId: string;
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  version: number;
  lastModifiedAt: string;
  lastModifiedBy: string;
}

// ─── Operation types (all mutations flow through these) ───────────────────────

export type GraphOperation =
  | { type: 'add_node';          node: GraphNode }
  | { type: 'delete_node';       nodeId: string }
  | { type: 'move_node';         nodeId: string; position: { x: number; y: number } }
  | { type: 'update_node_config'; nodeId: string; config: Record<string, unknown> }
  | { type: 'add_edge';          edge: GraphEdge }
  | { type: 'delete_edge';       edgeId: string };

export interface OperationEnvelope {
  op: GraphOperation;
  sequenceNumber: number;
  userId: string;
  timestamp: string;
}

export interface PresenceCursor {
  x: number;
  y: number;
  userId: string;
  userName: string;
  color: string;
}

// ─── RDE validation ───────────────────────────────────────────────────────────

const VALID_RESOURCE_TYPES = new Set<string>([
  // AWS
  'aws_vpc','aws_subnet','aws_igw','aws_sg','aws_route_table','aws_ec2','aws_rds',
  'aws_s3','aws_alb','aws_nat','aws_lambda','aws_cloudfront','aws_ebs','aws_dynamodb',
  'aws_eks','aws_iam','aws_kms','aws_internet',
  // Azure
  'azure_resource_group','azure_vnet','azure_subnet','azure_nsg','azure_vm',
  'azure_sql','azure_storage','azure_lb','azure_app_gateway','azure_functions',
  'azure_cosmos','azure_aks','azure_cdn','azure_dns','azure_app_service',
  'azure_key_vault','azure_service_bus',
  // GCP
  'gcp_project','gcp_region','gcp_zone','gcp_vpc','gcp_subnet','gcp_firewall',
  'gcp_compute_instance','gcp_mig','gcp_load_balancer','gcp_storage_bucket',
  'gcp_sql_instance','gcp_cloud_run','gcp_cloud_function','gcp_api_gateway',
  'gcp_cloud_cdn','gcp_cloud_dns','gcp_cloud_nat','gcp_iam',
]);

function isValidResourceType(type: string): boolean {
  return VALID_RESOURCE_TYPES.has(type);
}

// ─── Server-side graph state ──────────────────────────────────────────────────

const _graphs = new Map<string, ArchitectureGraph>();
const _dbFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function getOrCreateGraph(architectureId: string): ArchitectureGraph {
  if (!_graphs.has(architectureId)) {
    _graphs.set(architectureId, {
      architectureId,
      nodes: new Map(),
      edges: new Map(),
      version: 0,
      lastModifiedAt: new Date().toISOString(),
      lastModifiedBy: 'system',
    });
  }
  return _graphs.get(architectureId)!;
}

function serializeGraph(graph: ArchitectureGraph) {
  return {
    architectureId: graph.architectureId,
    nodes: Array.from(graph.nodes.values()),
    edges: Array.from(graph.edges.values()),
    version: graph.version,
    lastModifiedAt: graph.lastModifiedAt,
    lastModifiedBy: graph.lastModifiedBy,
  };
}

function applyOperation(
  graph: ArchitectureGraph,
  op: GraphOperation,
  userId: string
): { ok: boolean; error?: string } {
  switch (op.type) {
    case 'add_node': {
      if (!op.node?.id || !op.node?.resourceType) {
        return { ok: false, error: 'add_node requires node.id and node.resourceType' };
      }
      if (!isValidResourceType(op.node.resourceType)) {
        return { ok: false, error: `Unknown resource type: "${op.node.resourceType}". Use a supported RDE resource type.` };
      }
      if (graph.nodes.has(op.node.id)) {
        return { ok: false, error: `Node ${op.node.id} already exists` };
      }
      graph.nodes.set(op.node.id, op.node);
      break;
    }

    case 'delete_node': {
      if (!op.nodeId) return { ok: false, error: 'delete_node requires nodeId' };
      if (!graph.nodes.has(op.nodeId)) {
        return { ok: false, error: `Node ${op.nodeId} not found` };
      }
      graph.nodes.delete(op.nodeId);
      // Remove edges connected to this node
      for (const [edgeId, edge] of graph.edges) {
        if (edge.source === op.nodeId || edge.target === op.nodeId) {
          graph.edges.delete(edgeId);
        }
      }
      break;
    }

    case 'move_node': {
      const node = graph.nodes.get(op.nodeId);
      if (!node) return { ok: false, error: `Node ${op.nodeId} not found` };
      graph.nodes.set(op.nodeId, { ...node, position: op.position });
      break;
    }

    case 'update_node_config': {
      const node = graph.nodes.get(op.nodeId);
      if (!node) return { ok: false, error: `Node ${op.nodeId} not found` };
      graph.nodes.set(op.nodeId, { ...node, config: { ...node.config, ...op.config } });
      break;
    }

    case 'add_edge': {
      if (!op.edge?.id || !op.edge?.source || !op.edge?.target) {
        return { ok: false, error: 'add_edge requires edge.id, edge.source, edge.target' };
      }
      if (!graph.nodes.has(op.edge.source)) {
        return { ok: false, error: `Source node ${op.edge.source} not found` };
      }
      if (!graph.nodes.has(op.edge.target)) {
        return { ok: false, error: `Target node ${op.edge.target} not found` };
      }
      graph.edges.set(op.edge.id, op.edge);
      break;
    }

    case 'delete_edge': {
      if (!graph.edges.has(op.edgeId)) {
        return { ok: false, error: `Edge ${op.edgeId} not found` };
      }
      graph.edges.delete(op.edgeId);
      break;
    }

    default:
      return { ok: false, error: `Unknown operation type` };
  }

  graph.version += 1;
  graph.lastModifiedAt = new Date().toISOString();
  graph.lastModifiedBy = userId;
  return { ok: true };
}

// ─── Debounced DB flush ───────────────────────────────────────────────────────

function scheduleDbFlush(architectureId: string, io: SocketIOServer): void {
  // Clear any existing timer
  const existing = _dbFlushTimers.get(architectureId);
  if (existing) clearTimeout(existing);

  // Debounce: flush 2 seconds after the last operation
  const timer = setTimeout(async () => {
    _dbFlushTimers.delete(architectureId);
    const graph = _graphs.get(architectureId);
    if (!graph) return;

    try {
      // Lazy imports to avoid circular deps
      const { db } = await import('../../src/prisma/db');
      const { architectureRepository } = await import('../repositories/architectureRepository');

      // The Architecture model stores its graph as normalized resource/
      // connection rows, not a JSON blob — resolve this architecture's
      // environment so we can go through the same sync path the REST API uses.
      const architecture = await db.orm.public.Architecture
        .where({ id: architectureId })
        .select('environmentId')
        .first();

      if (!architecture) {
        console.warn(`[Collaboration] DB flush skipped — architecture ${architectureId} no longer exists.`);
        return;
      }

      const nodes = Array.from(graph.nodes.values()).map((n) => ({
        id: n.id,
        type: 'cloudNode',
        resourceType: n.resourceType,
        provider: (n.provider ?? 'aws') as CanvasNode['provider'],
        label: n.label,
        position: n.position,
        config: n.config,
        parentId: n.parentId ?? undefined,
        region: n.region,
      }));
      const edges = Array.from(graph.edges.values()).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
      }));

      await architectureRepository.saveCanvas(architecture.environmentId, nodes, edges).catch(() => {
        // DB may be unavailable — log but do not crash collaboration
        console.warn(`[Collaboration] DB flush failed for ${architectureId} — DB may be offline.`);
      });
    } catch (err) {
      console.warn(`[Collaboration] DB flush error for ${architectureId}:`, err);
    } finally {
      // The room may have emptied out while this flush was in flight —
      // now that its state is persisted, it's safe to release the in-memory graph.
      evictGraphIfEmpty(architectureId, io);
    }
  }, 2000);

  _dbFlushTimers.set(architectureId, timer);
}

/**
 * Releases the in-memory graph for an architecture once its room has no
 * remaining collaborators, so `_graphs` doesn't grow unbounded over the life
 * of the server. Deferred while a DB flush is still pending so state is
 * never dropped before it's persisted.
 */
function evictGraphIfEmpty(architectureId: string, io: SocketIOServer): void {
  const room = io.sockets.adapter.rooms.get(architectureId);
  if (room && room.size > 0) return;
  if (_dbFlushTimers.has(architectureId)) return;
  _graphs.delete(architectureId);
}

// ─── Session validation ───────────────────────────────────────────────────────

interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  color: string; // Deterministic from userId
}

function sessionColor(userId: string): string {
  // Deterministic color from user ID — never random
  const palette = [
    '#E53935', '#8E24AA', '#1E88E5', '#00897B', '#43A047',
    '#FB8C00', '#6D4C41', '#00ACC1', '#3949AB', '#D81B60',
  ];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) & 0xffffffff;
  }
  return palette[Math.abs(hash) % palette.length]!;
}

function authenticateSocket(token: string | undefined): AuthenticatedUser | null {
  if (!token) return null;
  try {
    const session = AuthService.getSession(token);
    if (!session?.user?.id) return null;
    return {
      id: session.user.id,
      name: session.user.name ?? session.user.email ?? 'Unknown',
      email: session.user.email ?? '',
      color: sessionColor(session.user.id),
    };
  } catch {
    return null;
  }
}

// ─── Socket.io server ─────────────────────────────────────────────────────────

export class CollaborationService {
  private static io: SocketIOServer | null = null;

  static init(server: NetServer<typeof IncomingMessage, typeof ServerResponse>): SocketIOServer {
    if (CollaborationService.io) return CollaborationService.io;

    const io = new SocketIOServer(server, {
      path: '/api/socket/collaboration',
      addTrailingSlash: false,
      cors: {
        origin: process.env['NEXT_PUBLIC_APP_URL'] ?? '*',
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });

    io.on('connection', (socket: Socket) => {
      let currentRoom: string | null = null;
      let authenticatedUser: AuthenticatedUser | null = null;

      // ── Authentication ───────────────────────────────────────────────────────
      const token =
        (socket.handshake.auth as Record<string, string>)?.token ??
        socket.handshake.headers?.cookie?.match(/cloudcraft_session=([^;]+)/)?.[1];

      authenticatedUser = authenticateSocket(token);

      if (!authenticatedUser) {
        socket.emit('error', { code: 'UNAUTHORIZED', message: 'Invalid or missing session token.' });
        socket.disconnect(true);
        return;
      }

      const user = authenticatedUser;

      // ── Join architecture room ────────────────────────────────────────────────
      socket.on('join_architecture', (payload: { architectureId: string }) => {
        if (!payload?.architectureId) {
          socket.emit('error', { code: 'BAD_REQUEST', message: 'architectureId required.' });
          return;
        }

        // Leave previous room
        if (currentRoom) {
          const previousRoom = currentRoom;
          socket.leave(previousRoom);
          socket.to(previousRoom).emit('user_left', { userId: user.id, userName: user.name });
          evictGraphIfEmpty(previousRoom, io);
        }

        currentRoom = payload.architectureId;
        socket.join(currentRoom);

        // Send current authoritative state to the joining client
        const graph = getOrCreateGraph(currentRoom);
        socket.emit('state_snapshot', {
          graph: serializeGraph(graph),
          userId: user.id,
          userName: user.name,
          userColor: user.color,
        });

        // Notify others
        socket.to(currentRoom).emit('user_joined', {
          userId: user.id,
          userName: user.name,
          userColor: user.color,
        });
      });

      // ── Reconnect: client requests full state ─────────────────────────────────
      socket.on('request_state', () => {
        if (!currentRoom) return;
        const graph = getOrCreateGraph(currentRoom);
        socket.emit('state_snapshot', {
          graph: serializeGraph(graph),
          userId: user.id,
          userName: user.name,
          userColor: user.color,
        });
      });

      // ── Graph operations ─────────────────────────────────────────────────────
      socket.on('graph_operation', (payload: { op: GraphOperation }) => {
        if (!currentRoom) {
          socket.emit('op_rejected', { error: 'Not in a room. Call join_architecture first.' });
          return;
        }

        const graph = getOrCreateGraph(currentRoom);
        const result = applyOperation(graph, payload.op, user.id);

        if (!result.ok) {
          socket.emit('op_rejected', { op: payload.op, error: result.error });
          return;
        }

        // Acknowledge success to sender
        const envelope: OperationEnvelope = {
          op: payload.op,
          sequenceNumber: graph.version,
          userId: user.id,
          timestamp: graph.lastModifiedAt,
        };

        socket.emit('op_ack', { sequenceNumber: graph.version });
        socket.to(currentRoom).emit('op_applied', envelope);

        // Debounce DB flush — only on structural ops, not cursor moves
        scheduleDbFlush(currentRoom, io);
      });

      // ── Ephemeral cursor/presence (no DB write, never identifies fake users) ──
      socket.on('cursor_move', (cursor: { x: number; y: number }) => {
        if (!currentRoom) return;
        const presence: PresenceCursor = {
          x: cursor.x,
          y: cursor.y,
          userId: user.id,
          userName: user.name,
          color: user.color,
        };
        socket.to(currentRoom).emit('cursor_updated', presence);
      });

      // ── Disconnect ────────────────────────────────────────────────────────────
      socket.on('disconnect', () => {
        if (currentRoom) {
          socket.to(currentRoom).emit('user_left', {
            userId: user.id,
            userName: user.name,
          });
          evictGraphIfEmpty(currentRoom, io);
        }
      });
    });

    CollaborationService.io = io;
    return io;
  }

  /**
   * Load graph state from DB on server startup (called from server init).
   * Allows resuming state after server restart.
   */
  static async loadGraphFromDb(architectureId: string, canvasJson: string): Promise<void> {
    try {
      const parsed = JSON.parse(canvasJson);
      const graph = getOrCreateGraph(architectureId);
      graph.nodes.clear();
      graph.edges.clear();

      for (const node of parsed.nodes ?? []) {
        graph.nodes.set(node.id, node);
      }
      for (const edge of parsed.edges ?? []) {
        graph.edges.set(edge.id, edge);
      }
      graph.version = parsed.version ?? 0;
    } catch {
      // Invalid JSON — start with empty graph
    }
  }

  static getIo(): SocketIOServer | null {
    return CollaborationService.io;
  }
}
