/**
 * FindingReviewRepository — persisted human review decisions for findings
 * (accepted risk, false positive, not applicable).
 *
 * Reviews are an overlay: they are applied to findings for display and
 * reporting, but the engine's technical evaluation (FAIL/WARNING) and the
 * score are never changed by them.
 */
import { db } from '@/src/prisma/db';
import { randomUUID } from 'crypto';
import type { FindingReview } from '@/lib/engines/assessment/types';

export interface DbFindingReview {
  id: string;
  projectId: string;
  findingId: string;
  ruleId: string;
  status: string;
  reason: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  createdAt: string;
}

const COLUMNS = ['id', 'projectId', 'findingId', 'ruleId', 'status', 'reason', 'approvedBy', 'approvedAt', 'expiresAt', 'revokedAt', 'revokedBy', 'createdAt'] as const;

export function toFindingReview(r: DbFindingReview): FindingReview {
  return {
    findingId: r.findingId,
    status: r.status as FindingReview['status'],
    reason: r.reason,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt,
    ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
  };
}

class FindingReviewRepository {
  async listForProject(projectId: string, includeRevoked = false): Promise<DbFindingReview[]> {
    const rows = await db.orm.public.FindingReview.where({ projectId }).select(...COLUMNS).all() as DbFindingReview[];
    return rows
      .filter((r) => includeRevoked || !r.revokedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Active (non-revoked, non-expired) reviews, latest per finding. */
  async activeReviews(projectId: string, now = new Date().toISOString()): Promise<FindingReview[]> {
    const rows = await this.listForProject(projectId);
    const latest = new Map<string, DbFindingReview>();
    for (const r of rows) {
      if (r.expiresAt && r.expiresAt <= now) continue;
      if (!latest.has(r.findingId)) latest.set(r.findingId, r);
    }
    return [...latest.values()].map(toFindingReview);
  }

  async create(input: Omit<DbFindingReview, 'id' | 'createdAt' | 'revokedAt' | 'revokedBy'>): Promise<DbFindingReview> {
    const row: DbFindingReview = { ...input, id: randomUUID(), createdAt: new Date().toISOString(), revokedAt: null, revokedBy: null };
    await db.orm.public.FindingReview.create(row);
    return row;
  }

  async findById(projectId: string, id: string): Promise<DbFindingReview | null> {
    const row = await db.orm.public.FindingReview.where({ id, projectId }).select(...COLUMNS).first();
    return (row as DbFindingReview | null) ?? null;
  }

  async revoke(projectId: string, id: string, revokedBy: string): Promise<boolean> {
    const existing = await this.findById(projectId, id);
    if (!existing || existing.revokedAt) return false;
    await db.orm.public.FindingReview.where({ id, projectId }).update({ revokedAt: new Date().toISOString(), revokedBy });
    return true;
  }
}

export const findingReviewRepository = new FindingReviewRepository();
