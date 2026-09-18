/**
 * DiscoveryRepository — database access for discovery runs.
 *
 * Security rules:
 * - resourcesJson contains sanitised resource data only — no credentials.
 * - Discovery run data is always org-scoped (via cloudAccountId → orgId join).
 * - Callers must verify org ownership of the cloud account before calling these methods.
 */
import { db } from '@/src/prisma/db';
import { randomUUID as uuidv4 } from 'crypto';
import type { DiscoveredResource, DiscoveryStatus } from '@/lib/cloud/types';
import type { CloudRelationship } from '@/lib/cloud/discovery/types';

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface DbDiscoveryRun {
  id: string;
  cloudAccountId: string;
  status: DiscoveryStatus;
  startedAt: string;
  completedAt: string | null;
  resources: DiscoveredResource[];
  relationships: CloudRelationship[];
  summary: Record<string, number>;
  error: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapRun(row: {
  id: string;
  cloudAccountId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  resourcesJson: string;
  relationshipsJson?: string;
  summaryJson: string;
  error: string | null;
}): DbDiscoveryRun {
  return {
    id: row.id,
    cloudAccountId: row.cloudAccountId,
    status: row.status as DiscoveryStatus,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? null,
    resources: parseJson<DiscoveredResource[]>(row.resourcesJson, []),
    relationships: parseJson<CloudRelationship[]>(row.relationshipsJson ?? '[]', []),
    summary: parseJson<Record<string, number>>(row.summaryJson, {}),
    error: row.error ?? null,
  };
}

// ─── Repository ───────────────────────────────────────────────────────────────

export const discoveryRepository = {

  async findByAccount(cloudAccountId: string): Promise<DbDiscoveryRun[]> {
    const rows = await db.orm.public.DiscoveryRun
      .where({ cloudAccountId })
      .select('id', 'cloudAccountId', 'status', 'startedAt', 'completedAt', 'resourcesJson', 'relationshipsJson', 'summaryJson', 'error')
      .all();
    // Sort by startedAt descending (most recent first)
    return rows
      .map(mapRun)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  },

  async findById(id: string): Promise<DbDiscoveryRun | null> {
    const row = await db.orm.public.DiscoveryRun
      .where({ id })
      .select('id', 'cloudAccountId', 'status', 'startedAt', 'completedAt', 'resourcesJson', 'relationshipsJson', 'summaryJson', 'error')
      .first();
    return row ? mapRun(row) : null;
  },

  async findLatest(cloudAccountId: string): Promise<DbDiscoveryRun | null> {
    const rows = await this.findByAccount(cloudAccountId);
    return rows[0] ?? null;
  },

  /**
   * Create a new discovery run in 'pending' state.
   */
  async create(cloudAccountId: string): Promise<DbDiscoveryRun> {
    const ts = now();
    const id = uuidv4();
    await db.orm.public.DiscoveryRun.create({
      id,
      cloudAccountId,
      status: 'pending',
      startedAt: ts,
      completedAt: null,
      resourcesJson: '[]',
      relationshipsJson: '[]',
      summaryJson: '{}',
      error: null,
    });
    return (await this.findById(id))!;
  },

  /**
   * Transition run to 'running'.
   */
  async markRunning(id: string): Promise<DbDiscoveryRun | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    await db.orm.public.DiscoveryRun.where({ id }).update({ status: 'running' });
    return this.findById(id);
  },

  /**
   * Persist completed discovery results.
   * resources must be sanitised (no credentials) before being passed here.
   */
  async markCompleted(
    id: string,
    resources: DiscoveredResource[],
    summary: Record<string, number>,
    relationships: CloudRelationship[] = [],
  ): Promise<DbDiscoveryRun | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    const ts = now();
    await db.orm.public.DiscoveryRun.where({ id }).update({
      status: 'completed',
      completedAt: ts,
      resourcesJson: JSON.stringify(resources),
      relationshipsJson: JSON.stringify(relationships),
      summaryJson: JSON.stringify(summary),
      error: null,
    });
    return this.findById(id);
  },

  /**
   * Persist failure information.
   * error message must NOT contain any credentials or secrets.
   */
  async markFailed(id: string, error: string): Promise<DbDiscoveryRun | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    const ts = now();
    await db.orm.public.DiscoveryRun.where({ id }).update({
      status: 'failed',
      completedAt: ts,
      error,
    });
    return this.findById(id);
  },
};
