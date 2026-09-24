/**
 * ArchitectureRepository — database access for architecture canvas, resources, connections, and versions.
 */
import { db, rawTransaction } from '@/src/prisma/db';
import { randomUUID as uuidv4 } from 'crypto';
import type { CanvasNode, CanvasEdge } from '@/types';

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface DbArchitecture {
  id: string;
  environmentId: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  resources: DbArchitectureResource[];
  connections: DbArchitectureConnection[];
}

/** Thrown by saveCanvas when the caller's expectedRevision is stale relative to the DB. */
export class RevisionConflictError extends Error {
  constructor(public readonly serverRevision: number, public readonly clientRevision: number) {
    super(`Revision conflict: server is at revision ${serverRevision}, client submitted ${clientRevision}.`);
    this.name = 'RevisionConflictError';
  }
}

/**
 * Thrown by saveCanvas when node or edge IDs already belong to a different architecture.
 * Resource IDs are a global primary key; a graph copied without re-keying (e.g. a template
 * instantiated without instantiateTemplate) would otherwise fail with a raw constraint error.
 */
export class ResourceIdConflictError extends Error {
  constructor(public readonly conflictingIds: string[]) {
    super(`Resource IDs already used by another architecture: ${conflictingIds.slice(0, 5).join(', ')}${conflictingIds.length > 5 ? ', …' : ''}`);
    this.name = 'ResourceIdConflictError';
  }
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
// The pure mapper lives in lib/domain/canvasMapping (importable from client code
// and engines without pulling in the database client).
import { toCanvas } from '@/lib/domain/canvasMapping';
export { toCanvas };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now(): string { return new Date().toISOString(); }

// ─── Repository ───────────────────────────────────────────────────────────────

const environmentSaveLocks = new Map<string, Promise<DbArchitecture>>();

export const architectureRepository = {

  async findByEnvironment(environmentId: string): Promise<DbArchitecture | null> {
    const row = await db.orm.public.Architecture
      .where({ environmentId })
      .select('id', 'environmentId', 'createdAt', 'updatedAt', 'revision')
      .first();
    if (!row) return null;
    return this._loadFull(row.id, row.environmentId, row.createdAt, row.updatedAt, row.revision);
  },

  async _loadFull(id: string, environmentId: string, createdAt: string, updatedAt: string, revision: number): Promise<DbArchitecture> {
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
      id, environmentId, createdAt, updatedAt, revision,
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

  /**
   * Saves the canvas, optionally enforcing optimistic concurrency via
   * `expectedRevision`. The revision counter and row lock live in the DB
   * (the `architecture.revision` column, read with SELECT ... FOR UPDATE
   * inside the same transaction as the write), not in process memory — so
   * conflicts are detected correctly even when requests land on different
   * server instances. Throws RevisionConflictError if expectedRevision is
   * stale. The in-process per-environment lock below is an additional,
   * same-process fast-path serialization; the DB row lock is what makes
   * this correct across processes.
   */
  async saveCanvas(
    environmentId: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    expectedRevision?: number,
  ): Promise<DbArchitecture> {
    const prev = environmentSaveLocks.get(environmentId) ?? Promise.resolve(null as unknown as DbArchitecture);
    const current = prev.catch(() => null as unknown as DbArchitecture).then(() => this._executeSaveCanvas(environmentId, nodes, edges, expectedRevision));
    environmentSaveLocks.set(environmentId, current);
    return current;
  },

  async _executeSaveCanvas(
    environmentId: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    expectedRevision?: number,
  ): Promise<DbArchitecture> {
    const ts = now();

    let archId = '';
    let createdAt = ts;
    let newRevision = 1;

    // The entire read-lock + revision-check + delete-then-reinsert sequence
    // runs on ONE connection inside a single BEGIN/COMMIT transaction, so a
    // mid-save crash rolls back to the prior consistent state instead of
    // leaving orphaned/partial rows, AND the revision compare-and-increment
    // is race-free even against a concurrent save from another server
    // instance (the SELECT ... FOR UPDATE holds a row lock for the duration
    // of the transaction). The Prisma-Next ORM has no transaction primitive,
    // so this uses raw SQL for every statement in the sequence rather than
    // mixing it with ORM calls that would run on separate connections
    // outside the transaction.
    await rawTransaction(async (query) => {
      const existingResult = await query(
        'SELECT "id", "createdAt", "revision" FROM "architecture" WHERE "environmentId" = $1 FOR UPDATE',
        [environmentId],
      );
      const existing = existingResult.rows[0] as { id: string; createdAt: string; revision: number } | undefined;

      if (existing) {
        if (expectedRevision !== undefined && expectedRevision < existing.revision) {
          throw new RevisionConflictError(existing.revision, expectedRevision);
        }
        archId = existing.id;
        createdAt = existing.createdAt;
        newRevision = existing.revision + 1;
        await query('UPDATE "architecture" SET "updatedAt" = $1, "revision" = $2 WHERE "id" = $3', [ts, newRevision, archId]);
        // Delete connections first (FK: Connection→Resource), then resources.
        await query('DELETE FROM "architectureConnection" WHERE "architectureId" = $1', [archId]);
        await query('DELETE FROM "architectureResource" WHERE "architectureId" = $1', [archId]);
      } else {
        archId = uuidv4();
        createdAt = ts;
        newRevision = 1;
      }

      // Refuse IDs owned by another architecture (global PK) with a clear error.
      if (nodes.length > 0 || edges.length > 0) {
        const taken = await query(
          `SELECT "id" FROM "architectureResource" WHERE "id" = ANY($1::text[]) AND "architectureId" <> $2
           UNION ALL
           SELECT "id" FROM "architectureConnection" WHERE "id" = ANY($3::text[]) AND "architectureId" <> $2`,
          [nodes.map((n) => n.id), archId, edges.map((e) => e.id)],
        );
        if (taken.rows.length > 0) throw new ResourceIdConflictError((taken.rows as { id: string }[]).map((r) => r.id));
      }

      if (!existing) {
        await query(
          'INSERT INTO "architecture" ("id", "environmentId", "createdAt", "updatedAt", "revision") VALUES ($1, $2, $3, $4, $5)',
          [archId, environmentId, ts, ts, newRevision],
        );
      }

      for (const node of nodes) {
        const config = {
          ...node.config,
          ...(node.importState ? { importState: node.importState, imported: node.importState === 'imported' } : {}),
        };
        await query(
          `INSERT INTO "architectureResource"
             ("id", "resourceType", "provider", "label", "positionX", "positionY", "configJson", "region", "groupId", "locked", "architectureId")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            node.id,
            node.resourceType,
            node.provider,
            node.label,
            node.position.x,
            node.position.y,
            JSON.stringify(config),
            node.region ?? null,
            node.groupId ?? null,
            node.locked ?? false,
            archId,
          ],
        );
      }

      // Insert new connections (only after all resources exist to satisfy FK constraints)
      for (const edge of edges) {
        await query(
          `INSERT INTO "architectureConnection"
             ("id", "label", "edgeType", "architectureId", "sourceId", "targetId")
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [edge.id, edge.label ?? null, edge.edgeType ?? null, archId, edge.source, edge.target],
        );
      }
    });

    return this._loadFull(archId, environmentId, createdAt, ts, newRevision);
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
