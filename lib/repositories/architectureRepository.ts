/**
 * ArchitectureRepository — database access for architecture canvas, resources, connections, and versions.
 */
import { db, rawExec } from '@/src/prisma/db';
import { randomUUID as uuidv4 } from 'crypto';
import type { CanvasNode, CanvasEdge, Region } from '@/types';

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface DbArchitecture {
  id: string;
  environmentId: string;
  createdAt: string;
  updatedAt: string;
  resources: DbArchitectureResource[];
  connections: DbArchitectureConnection[];
}

export interface DbArchitectureResource {
  id: string;
  resourceType: string;
  provider: string;
  label: string;
  positionX: number;
  positionY: number;
  configJson: string;
  region: string | null;
  groupId: string | null;
  locked: boolean;
  architectureId: string;
}

export interface DbArchitectureConnection {
  id: string;
  label: string | null;
  edgeType: string | null;
  architectureId: string;
  sourceId: string;
  targetId: string;
}

export interface DbArchitectureVersion {
  id: string;
  versionNumber: number;
  label: string;
  summary: string;
  author: string;
  snapshotJson: string;
  createdAt: string;
  projectId: string;
  architectureId: string;
}

// ─── Canvas ↔ DB mappers ──────────────────────────────────────────────────────

export function toCanvas(
  resources: DbArchitectureResource[],
  connections: DbArchitectureConnection[],
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes: CanvasNode[] = resources.map((r) => ({
    id: r.id,
    type: 'cloudNode',
    resourceType: r.resourceType,
    provider: r.provider as 'aws' | 'azure',
    label: r.label,
    position: { x: r.positionX, y: r.positionY },
    config: (() => {
      try { return JSON.parse(r.configJson) as Record<string, unknown>; } catch { return {}; }
    })(),
    ...(r.region ? { region: r.region as Region } : {}),
    ...(r.groupId ? { groupId: r.groupId } : {}),
    importState: (() => {
      try {
        const c = JSON.parse(r.configJson);
        return ((c.importState as string) ?? (c.imported ? 'imported' : undefined)) as CanvasNode['importState'];
      } catch { return undefined; }
    })(),
    locked: r.locked,
  }));

  const edges: CanvasEdge[] = connections.map((c) => ({
    id: c.id,
    source: c.sourceId,
    target: c.targetId,
    ...(c.label ? { label: c.label } : {}),
    ...(c.edgeType ? { edgeType: c.edgeType as CanvasEdge['edgeType'] } : {}),
  }));

  return { nodes, edges };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now(): string { return new Date().toISOString(); }

// ─── Repository ───────────────────────────────────────────────────────────────

const environmentSaveLocks = new Map<string, Promise<DbArchitecture>>();

export const architectureRepository = {

  async findByEnvironment(environmentId: string): Promise<DbArchitecture | null> {
    const row = await db.orm.public.Architecture
      .where({ environmentId })
      .select('id', 'environmentId', 'createdAt', 'updatedAt')
      .first();
    if (!row) return null;
    return this._loadFull(row.id, row.environmentId, row.createdAt, row.updatedAt);
  },

  async _loadFull(id: string, environmentId: string, createdAt: string, updatedAt: string): Promise<DbArchitecture> {
    const [resources, connections] = await Promise.all([
      db.orm.public.ArchitectureResource
        .where({ architectureId: id })
        .select('id', 'resourceType', 'provider', 'label', 'positionX', 'positionY', 'configJson', 'region', 'groupId', 'locked', 'architectureId')
        .all(),
      db.orm.public.ArchitectureConnection
        .where({ architectureId: id })
        .select('id', 'label', 'edgeType', 'architectureId', 'sourceId', 'targetId')
        .all(),
    ]);
    return {
      id, environmentId, createdAt, updatedAt,
      resources: resources.map((r) => ({
        ...r,
        region: r.region ?? null,
        groupId: r.groupId ?? null,
      })),
      connections: connections.map((c) => ({
        ...c,
        label: c.label ?? null,
        edgeType: c.edgeType ?? null,
      })),
    };
  },

  async saveCanvas(
    environmentId: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[],
  ): Promise<DbArchitecture> {
    const prev = environmentSaveLocks.get(environmentId) ?? Promise.resolve(null as unknown as DbArchitecture);
    const current = prev.catch(() => null as unknown as DbArchitecture).then(() => this._executeSaveCanvas(environmentId, nodes, edges));
    environmentSaveLocks.set(environmentId, current);
    return current;
  },

  async _executeSaveCanvas(
    environmentId: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[],
  ): Promise<DbArchitecture> {
    const ts = now();

    // Determine whether an architecture record already exists for this environment.
    // If it does, preserve its id and createdAt so external references (versions) remain valid.
    const existing = await db.orm.public.Architecture
      .where({ environmentId })
      .select('id', 'createdAt')
      .first();

    let archId: string;
    let createdAt: string;

    if (existing) {
      archId = existing.id;
      createdAt = existing.createdAt;
      // Update the timestamp
      await db.orm.public.Architecture.where({ id: archId }).update({ updatedAt: ts });
      // Use raw SQL DELETE to guarantee all children are removed atomically.
      // The Prisma ORM's .where().delete() performs per-row deletes in some
      // configurations and can silently skip rows when FK cascade triggers
      // run concurrently. A raw parameterised DELETE is always atomic.
      // Delete connections first (FK: Connection→Resource), then resources.
      await rawExec(
        'DELETE FROM "architectureConnection" WHERE "architectureId" = $1',
        [archId],
      );
      await rawExec(
        'DELETE FROM "architectureResource" WHERE "architectureId" = $1',
        [archId],
      );
    } else {
      archId = uuidv4();
      createdAt = ts;
      await db.orm.public.Architecture.create({
        id: archId,
        environmentId,
        createdAt: ts,
        updatedAt: ts,
      });
    }

    // Insert new resources
    for (const node of nodes) {
      const config = {
        ...node.config,
        ...(node.importState ? { importState: node.importState, imported: node.importState === 'imported' } : {}),
      };
      await db.orm.public.ArchitectureResource.create({
        id: node.id,
        resourceType: node.resourceType,
        provider: node.provider,
        label: node.label,
        positionX: node.position.x,
        positionY: node.position.y,
        configJson: JSON.stringify(config),
        region: node.region ?? null,
        groupId: node.groupId ?? null,
        locked: node.locked ?? false,
        architectureId: archId,
      });
    }

    // Insert new connections (only after all resources exist to satisfy FK constraints)
    for (const edge of edges) {
      await db.orm.public.ArchitectureConnection.create({
        id: edge.id,
        label: edge.label ?? null,
        edgeType: edge.edgeType ?? null,
        architectureId: archId,
        sourceId: edge.source,
        targetId: edge.target,
      });
    }

    return this._loadFull(archId, environmentId, createdAt, ts);
  },

  // ── Versions ───────────────────────────────────────────────────────────────

  async listVersions(projectId: string, architectureId: string): Promise<DbArchitectureVersion[]> {
    const rows = await db.orm.public.ArchitectureVersion
      .where({ projectId, architectureId })
      .select('id', 'versionNumber', 'label', 'summary', 'author', 'snapshotJson', 'createdAt', 'projectId', 'architectureId')
      .all();
    return [...rows].sort((a, b) => a.versionNumber - b.versionNumber);
  },

  async createVersion(input: {
    projectId: string;
    architectureId: string;
    label: string;
    summary: string;
    author: string;
    nodes: CanvasNode[];
    edges: CanvasEdge[];
  }): Promise<DbArchitectureVersion> {
    const existingVersions = await this.listVersions(input.projectId, input.architectureId);
    const versionNumber = existingVersions.length + 1;
    const id = uuidv4();
    const ts = now();
    const snapshotJson = JSON.stringify({ nodes: input.nodes, edges: input.edges });

    await db.orm.public.ArchitectureVersion.create({
      id, versionNumber, label: input.label, summary: input.summary,
      author: input.author, snapshotJson, createdAt: ts,
      projectId: input.projectId, architectureId: input.architectureId,
    });
    return {
      id, versionNumber, label: input.label, summary: input.summary,
      author: input.author, snapshotJson, createdAt: ts,
      projectId: input.projectId, architectureId: input.architectureId,
    };
  },

  async findVersion(id: string, projectId: string): Promise<DbArchitectureVersion | null> {
    const row = await db.orm.public.ArchitectureVersion
      .where({ id, projectId })
      .select('id', 'versionNumber', 'label', 'summary', 'author', 'snapshotJson', 'createdAt', 'projectId', 'architectureId')
      .first();
    return row ?? null;
  },

  async restoreVersion(
    versionId: string,
    projectId: string,
    environmentId: string,
  ): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[] } | null> {
    const version = await this.findVersion(versionId, projectId);
    if (!version) return null;
    const snapshot = JSON.parse(version.snapshotJson) as { nodes: CanvasNode[]; edges: CanvasEdge[] };
    await this.saveCanvas(environmentId, snapshot.nodes, snapshot.edges);
    return snapshot;
  },

  /**
   * Clone/copy the architecture from a source environment into a destination environment.
   * Every resource receives a fresh, globally unique ID.
   * All connection sourceId and targetId references are remapped to the newly generated IDs.
   * The source architecture remains completely unchanged.
   */
  async copyArchitecture(
    srcEnvironmentId: string,
    dstEnvironmentId: string,
  ): Promise<DbArchitecture> {
    const srcArch = await this.findByEnvironment(srcEnvironmentId);
    if (!srcArch || srcArch.resources.length === 0) {
      return this.saveCanvas(dstEnvironmentId, [], []);
    }

    // Generate fresh, globally unique IDs for all destination resources
    const idMap = new Map<string, string>();
    for (const r of srcArch.resources) {
      idMap.set(r.id, uuidv4());
    }

    const { nodes: srcNodes, edges: srcEdges } = toCanvas(srcArch.resources, srcArch.connections);

    // Deep-copy nodes with new IDs, preserved configs, positions, and remapped groupIds
    const clonedNodes: CanvasNode[] = srcNodes.map((n) => ({
      ...n,
      id: idMap.get(n.id)!,
      ...(n.groupId && idMap.has(n.groupId) ? { groupId: idMap.get(n.groupId) } : n.groupId ? { groupId: n.groupId } : {}),
      config: JSON.parse(JSON.stringify(n.config)) as Record<string, unknown>,
      position: { ...n.position },
    }));

    // Deep-copy edges with new IDs and remapped sourceId / targetId
    const clonedEdges: CanvasEdge[] = srcEdges
      .filter((e) => idMap.has(e.source) && idMap.has(e.target))
      .map((e) => ({
        ...e,
        id: uuidv4(),
        source: idMap.get(e.source)!,
        target: idMap.get(e.target)!,
      }));

    return this.saveCanvas(dstEnvironmentId, clonedNodes, clonedEdges);
  },
};
