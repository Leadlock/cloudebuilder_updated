/**
 * Audit trail for Terraform plan / apply / destroy.
 *
 * Every attempt is recorded — including refusals — with who asked, for which organisation and project, which plan
 * (by hash) and what happened. Rows go to the TerraformAuditEvent table (apply `npm run db:update` once to create it).
 *
 * Recording is best-effort by design: an audit failure must never block or crash an operation, and a missing table
 * must not silently lose the event, so every event is also written to the server log as one JSON line.
 * Nothing secret is ever recorded — only ids, hashes, outcomes and short reasons.
 */
import { randomUUID } from 'crypto';
import { db } from '@/src/prisma/db';

export type TerraformAuditAction = 'plan' | 'apply' | 'destroy';
export type TerraformAuditOutcome = 'requested' | 'allowed' | 'denied' | 'blocked' | 'succeeded' | 'failed';

export interface TerraformAuditEventInput {
  action: TerraformAuditAction;
  outcome: TerraformAuditOutcome;
  orgId?: string | null;
  projectId?: string | null;
  userId?: string | null;
  planId?: string | null;
  planHash?: string | null;
  /** Short human-readable reason; truncated. Never put credentials or full terraform output here. */
  detail?: string | null;
}

export async function recordTerraformAudit(event: TerraformAuditEventInput): Promise<void> {
  const row = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    orgId: event.orgId ?? null,
    projectId: event.projectId ?? null,
    userId: event.userId ?? null,
    action: event.action,
    outcome: event.outcome,
    planId: event.planId ?? null,
    planHash: event.planHash ?? null,
    detail: event.detail ? event.detail.slice(0, 500) : null,
  };
  // Always leave a log line, so the event survives a database problem.
  console.info(`[terraform-audit] ${JSON.stringify(row)}`);
  try {
    await db.orm.public.TerraformAuditEvent.create(row);
  } catch (err) {
    console.warn('[terraform-audit] could not store the event in the database:', err instanceof Error ? err.message : String(err));
  }
}
