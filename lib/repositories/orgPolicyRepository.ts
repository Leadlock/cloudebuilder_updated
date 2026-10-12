/**
 * OrgPolicyRepository — the organization's policy (one row per organization).
 *
 * Callers authorise first; this only touches the row of the organization it is given. The rules are stored as JSON and re-validated on
 * every read (parseStoredRules), so a damaged row degrades to "no restriction" instead of breaking the canvas.
 */
import { db } from '@/src/prisma/db';
import { randomUUID } from 'crypto';
import { parseStoredRules } from '@/lib/engines/policy/schema';
import type { OrgPolicy, OrgPolicyRules } from '@/lib/engines/policy/types';

const now = () => new Date().toISOString();

export const orgPolicyRepository = {
  /** The organization's policy, or null when none has been saved. */
  async get(orgId: string): Promise<OrgPolicy | null> {
    const row = await db.orm.public.OrgPolicy.where({ orgId }).first();
    if (!row) return null;
    return { ...parseStoredRules(row.policyJson), version: row.version, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
  },

  /** Replace the organization's policy. The version goes up by one on every save. */
  async save(orgId: string, rules: OrgPolicyRules, userId: string): Promise<OrgPolicy> {
    const policyJson = JSON.stringify(rules);
    const updatedAt = now();
    const existing = await db.orm.public.OrgPolicy.where({ orgId }).first();
    if (existing) {
      const version = existing.version + 1;
      await db.orm.public.OrgPolicy.where({ orgId }).update({ policyJson, version, updatedAt, updatedBy: userId });
      return { ...rules, version, updatedAt, updatedBy: userId };
    }
    await db.orm.public.OrgPolicy.create({ id: randomUUID(), orgId, policyJson, version: 1, updatedAt, updatedBy: userId });
    return { ...rules, version: 1, updatedAt, updatedBy: userId };
  },
};
