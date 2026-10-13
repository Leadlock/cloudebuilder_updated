/**
 * TerraformAccessRepository: one row per organization saying whether it may run Terraform on this server. Callers authorise first.
 */
import { db } from '@/src/prisma/db';
import { randomUUID } from 'crypto';
import type { AccessRecord, EligibilityCheck } from '@/lib/terraform/access/types';

type Row = { id: string; orgId: string; status: string; source: string; requestedBy: string | null; requestedAt: string | null; decidedBy: string | null; decidedAt: string | null; note: string | null; checksJson: string; updatedAt: string };

const STATUSES = new Set(['approved', 'requested', 'denied', 'revoked']);

function parseChecks(json: string): EligibilityCheck[] {
  try { const v = JSON.parse(json) as unknown; return Array.isArray(v) ? (v as EligibilityCheck[]) : []; } catch { return []; }
}

function toRecord(r: Row): AccessRecord | null {
  if (!STATUSES.has(r.status)) return null;
  return {
    orgId: r.orgId, status: r.status as AccessRecord['status'], source: r.source === 'auto' ? 'auto' : 'operator',
    requestedBy: r.requestedBy, requestedAt: r.requestedAt, decidedBy: r.decidedBy, decidedAt: r.decidedAt, note: r.note, checks: parseChecks(r.checksJson), updatedAt: r.updatedAt,
  };
}

export type AccessWrite = Omit<AccessRecord, 'updatedAt'>;

export const terraformAccessRepository = {
  async get(orgId: string): Promise<AccessRecord | null> {
    const row = (await db.orm.public.TerraformAccess.where({ orgId }).first()) as Row | null;
    return row ? toRecord(row) : null;
  },
  /** Every row, requests first and then the most recently changed. */
  async list(): Promise<AccessRecord[]> {
    const rows = (await db.orm.public.TerraformAccess.select('id', 'orgId', 'status', 'source', 'requestedBy', 'requestedAt', 'decidedBy', 'decidedAt', 'note', 'checksJson', 'updatedAt').all()) as Row[];
    return rows.map(toRecord).filter((r): r is AccessRecord => r !== null)
      .sort((a, b) => Number(b.status === 'requested') - Number(a.status === 'requested') || b.updatedAt.localeCompare(a.updatedAt));
  },
  async save(rec: AccessWrite): Promise<AccessRecord> {
    const updatedAt = new Date().toISOString();
    const data = { status: rec.status, source: rec.source, requestedBy: rec.requestedBy, requestedAt: rec.requestedAt, decidedBy: rec.decidedBy, decidedAt: rec.decidedAt, note: rec.note, checksJson: JSON.stringify(rec.checks), updatedAt };
    const existing = await db.orm.public.TerraformAccess.where({ orgId: rec.orgId }).first();
    if (existing) await db.orm.public.TerraformAccess.where({ orgId: rec.orgId }).update(data);
    else await db.orm.public.TerraformAccess.create({ id: randomUUID(), orgId: rec.orgId, ...data });
    return { ...rec, updatedAt };
  },
};
