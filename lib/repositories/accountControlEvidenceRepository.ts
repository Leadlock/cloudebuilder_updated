/**
 * AccountControlEvidenceRepository — dated readings of account-level controls (CloudTrail, GuardDuty, root MFA, AWS Config).
 *
 * One row per project and control. A new check replaces the old reading, so the table always holds the latest word on each control.
 * Callers authorise first; this only touches rows of the project it is given. Only plain sentences are stored.
 */
import { db } from '@/src/prisma/db';
import { randomUUID as uuidv4 } from 'crypto';
import type { AccountEvidenceMap, AccountEvidenceStatus } from '@/lib/engines/assessment/accountEvidence';
import type { AccountControlResult } from '@/lib/cloud/accountControls/readAwsAccountControls';

export interface StoredEvidenceRow {
  controlId: string;
  status: AccountEvidenceStatus;
  observation: string;
  observedAt: string;
  cloudAccountId: string;
  accountLabel: string;
  checkedBy: string;
}

export const accountControlEvidenceRepository = {
  async list(projectId: string): Promise<StoredEvidenceRow[]> {
    const rows = await db.orm.public.AccountControlEvidence.where({ projectId }).all();
    return rows.map((r) => ({
      controlId: r.controlId, status: r.status as AccountEvidenceStatus, observation: r.observation, observedAt: r.observedAt,
      cloudAccountId: r.cloudAccountId, accountLabel: r.accountLabel ?? '', checkedBy: r.checkedBy ?? '',
    }));
  },

  /** The readings in the shape the engine takes. */
  async evidenceFor(projectId: string): Promise<AccountEvidenceMap> {
    const out: AccountEvidenceMap = {};
    for (const r of await this.list(projectId)) {
      out[r.controlId] = { status: r.status, observation: r.observation, observedAt: r.observedAt, ...(r.accountLabel ? { accountLabel: r.accountLabel } : {}) };
    }
    return out;
  },

  /** When the account was last checked, or null if it never was. Lets a saved review be marked stale. */
  async lastCheckedAt(projectId: string): Promise<string | null> {
    const rows = await this.list(projectId);
    return rows.length === 0 ? null : rows.map((r) => r.observedAt).sort().at(-1)!;
  },

  /** Replace the project's readings with a new check. */
  async saveCheck(
    projectId: string,
    source: { cloudAccountId: string; accountLabel: string; userId: string },
    results: AccountControlResult[],
    observedAt = new Date().toISOString(),
  ): Promise<void> {
    for (const r of results) {
      const where = { projectId, controlId: r.controlId };
      const existing = await db.orm.public.AccountControlEvidence.where(where).first();
      const fields = {
        cloudAccountId: source.cloudAccountId, accountLabel: source.accountLabel, status: r.status, observation: r.observation,
        observedAt, checkedBy: source.userId,
      };
      if (existing) await db.orm.public.AccountControlEvidence.where(where).update(fields);
      else await db.orm.public.AccountControlEvidence.create({ id: uuidv4(), projectId, controlId: r.controlId, ...fields });
    }
  },

  /** Forget every reading (for example when the connected account is no longer the one the project is checked against). */
  async clear(projectId: string): Promise<void> {
    // .delete() removes a single row; every reading of the project has to go.
    await db.orm.public.AccountControlEvidence.where({ projectId }).deleteAndCount();
  },
};
