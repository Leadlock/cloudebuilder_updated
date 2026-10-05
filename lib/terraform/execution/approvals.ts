/**
 * Approval before Terraform changes real infrastructure.
 *
 * A plan (apply) or a teardown preview (destroy) can only be run with an APPROVAL for exactly that plan: same planId and
 * same planHash, approved by an owner/admin of the organisation, not expired, and not already used. Approvals are single-use —
 * one approval, one run — and live in the database (the `terraformApproval` table), so they hold across restarts and across
 * server instances.
 *
 * Policy (CLOUDCRAFT_TERRAFORM_APPROVAL):
 *   password   the default. The person running it confirms with their own login password (see passwordConfirm.ts); that records
 *              a short-lived approval for exactly this plan. No second person is involved.
 *   required   a DIFFERENT owner/admin than the requester must approve (production default). The requester can still withdraw
 *              their own request.
 *   self-ok    the requester may approve their own request — it still takes an explicit approval step (development default,
 *              and the way to run an organisation that has only one admin).
 *   off        no approval needed (what existed before; not recommended).
 *
 * Times are the database clock's, so servers with drifting clocks agree on expiry. Nothing secret is stored: only ids, the plan
 * hash, a short summary and who decided.
 */
import { randomUUID } from 'crypto';
import { NOW_MS, sharedDb } from '@/lib/api/sharedStore';

export type ApprovalMode = 'password' | 'required' | 'self-ok' | 'off';
export type ApprovalAction = 'apply' | 'destroy';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'used' | 'expired';

/** How long a request waits for a decision, and how long an approval can be used once given. */
export const APPROVAL_TTL_MS = 30 * 60 * 1000;
/** A password confirmation is for doing it now: it expires sooner than a request that waits for another person. */
export const PASSWORD_CONFIRM_TTL_MS = 5 * 60 * 1000;

export function approvalMode(): ApprovalMode {
  const v = (process.env['CLOUDCRAFT_TERRAFORM_APPROVAL'] ?? '').trim().toLowerCase();
  if (v === 'password' || v === 'required' || v === 'self-ok' || v === 'off') return v;
  return 'password';      // a typo, or nothing set, never switches the gate off
}

export interface Approval {
  id: string;
  orgId: string;
  projectId: string;
  action: ApprovalAction;
  planId: string;
  planHash: string;
  summary: string | null;
  requestedBy: string;
  /** `expired` is derived: a pending or approved request whose time has run out. */
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  comment: string | null;
  createdAt: string;
  expiresAt: string;
}

const COLUMNS = '"id", "createdAt", "orgId", "projectId", "action", "planId", "planHash", "summary", "requestedBy", "status", "decidedBy", "decidedAt", "comment", "expiresAtMs", "usedAt"';

type Row = Record<string, unknown>;
function toApproval(r: Row, nowMs: number): Approval {
  const expiresAtMs = Number(r['expiresAtMs']);
  let status = String(r['status']) as ApprovalStatus;
  if ((status === 'pending' || status === 'approved') && expiresAtMs <= nowMs) status = 'expired';
  return {
    id: String(r['id']), orgId: String(r['orgId']), projectId: String(r['projectId']), action: String(r['action']) as ApprovalAction,
    planId: String(r['planId']), planHash: String(r['planHash']), summary: (r['summary'] as string | null) ?? null,
    requestedBy: String(r['requestedBy']), status, decidedBy: (r['decidedBy'] as string | null) ?? null,
    decidedAt: (r['decidedAt'] as string | null) ?? null, comment: (r['comment'] as string | null) ?? null,
    createdAt: String(r['createdAt']), expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

async function dbNow(): Promise<number> {
  const { rows } = await sharedDb().query(`SELECT ${NOW_MS} AS "nowMs"`);
  return Number(rows[0]!['nowMs']);
}

export interface RequestApprovalInput {
  orgId: string; projectId: string; action: ApprovalAction; planId: string; planHash: string; requestedBy: string; summary?: string;
}

/** Asks for approval of a plan. Asking again for the same plan returns the request that is already open (or already approved). */
export async function requestApproval(input: RequestApprovalInput): Promise<{ approval: Approval; created: boolean }> {
  const open = await sharedDb().query(
    `SELECT ${COLUMNS} FROM "terraformApproval"
     WHERE "orgId" = $1 AND "projectId" = $2 AND "action" = $3 AND "planId" = $4 AND "planHash" = $5
       AND "status" IN ('pending', 'approved') AND "expiresAtMs" > ${NOW_MS}
     ORDER BY "createdAt" DESC LIMIT 1`,
    [input.orgId, input.projectId, input.action, input.planId, input.planHash],
  );
  const now = await dbNow();
  if (open.rows[0]) return { approval: toApproval(open.rows[0], now), created: false };
  const inserted = await sharedDb().query(
    `INSERT INTO "terraformApproval" ("id", "createdAt", "orgId", "projectId", "action", "planId", "planHash", "summary", "requestedBy", "status", "expiresAtMs")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', ${NOW_MS} + $10::double precision)
     RETURNING ${COLUMNS}`,
    [randomUUID(), new Date().toISOString(), input.orgId, input.projectId, input.action, input.planId, input.planHash, input.summary ? input.summary.slice(0, 300) : null, input.requestedBy, APPROVAL_TTL_MS],
  );
  return { approval: toApproval(inserted.rows[0]!, now), created: true };
}

export type DecisionResult =
  | { ok: true; approval: Approval }
  | { ok: false; code: 'not_found' | 'not_pending' | 'expired' | 'own_request'; reason: string };

/**
 * Approves or rejects a pending request. Approving needs a different person than the requester when the mode is `required`;
 * anyone who may decide can reject. Deciding is one atomic statement, so two people deciding at once cannot both win.
 */
export async function decideApproval(input: { id: string; orgId: string; decidedBy: string; decision: 'approve' | 'reject'; comment?: string; ttlMs?: number }): Promise<DecisionResult> {
  const found = await sharedDb().query(`SELECT ${COLUMNS} FROM "terraformApproval" WHERE "id" = $1 AND "orgId" = $2`, [input.id, input.orgId]);
  const row = found.rows[0];
  if (!row) return { ok: false, code: 'not_found', reason: 'That approval request does not exist.' };
  const now = await dbNow();
  const current = toApproval(row, now);
  if (current.status === 'expired') return { ok: false, code: 'expired', reason: 'That request has expired. Ask for approval again.' };
  if (current.status !== 'pending') return { ok: false, code: 'not_pending', reason: `That request was already ${current.status}.` };
  if (input.decision === 'approve' && approvalMode() === 'required' && current.requestedBy === input.decidedBy) {
    return { ok: false, code: 'own_request', reason: 'A different owner or admin has to approve this — you cannot approve your own request.' };
  }
  const approve = input.decision === 'approve';
  const updated = await sharedDb().query(
    `UPDATE "terraformApproval"
     SET "status" = $3, "decidedBy" = $4, "decidedAt" = $5, "comment" = $6,
         "expiresAtMs" = CASE WHEN $7::boolean THEN ${NOW_MS} + $8::double precision ELSE "expiresAtMs" END
     WHERE "id" = $1 AND "orgId" = $2 AND "status" = 'pending' AND "expiresAtMs" > ${NOW_MS}
     RETURNING ${COLUMNS}`,
    [input.id, input.orgId, approve ? 'approved' : 'rejected', input.decidedBy, new Date().toISOString(), input.comment ? input.comment.slice(0, 500) : null, approve, input.ttlMs ?? APPROVAL_TTL_MS],
  );
  if (!updated.rows[0]) return { ok: false, code: 'not_pending', reason: 'That request was just decided by someone else.' };
  return { ok: true, approval: toApproval(updated.rows[0], now) };
}

export type ConsumeResult =
  | { ok: true; approval: Approval | null }          // approval is null when the mode is `off`
  | { ok: false; code: 'needs_approval' | 'pending' | 'rejected'; reason: string };

/**
 * Spends the approval for this exact plan: marks it used, atomically, so it can start one run and no more. Fails if there is
 * none that is approved, unexpired and unused.
 */
export async function consumeApproval(input: { orgId: string; projectId: string; action: ApprovalAction; planId: string; planHash: string; /** Who is running it. In password mode only the person who confirmed with their password may use that confirmation. */ userId?: string }): Promise<ConsumeResult> {
  if (approvalMode() === 'off') return { ok: true, approval: null };
  const key = [input.orgId, input.projectId, input.action, input.planId, input.planHash];
  const ownConfirmationOnly = approvalMode() === 'password';
  const candidate = await sharedDb().query(
    `SELECT "id" FROM "terraformApproval"
     WHERE "orgId" = $1 AND "projectId" = $2 AND "action" = $3 AND "planId" = $4 AND "planHash" = $5
       AND "status" = 'approved' AND "expiresAtMs" > ${NOW_MS}
       ${ownConfirmationOnly ? 'AND "decidedBy" = $6' : ''}
     ORDER BY "createdAt" ASC LIMIT 1`,
    ownConfirmationOnly ? [...key, input.userId ?? ''] : key,
  );
  const id = candidate.rows[0]?.['id'];
  if (typeof id === 'string') {
    // The status guard makes this race-safe: if another request spent it first, this updates nothing.
    const spent = await sharedDb().query(
      `UPDATE "terraformApproval" SET "status" = 'used', "usedAt" = $2
       WHERE "id" = $1 AND "status" = 'approved' AND "expiresAtMs" > ${NOW_MS}
       RETURNING ${COLUMNS}`,
      [id, new Date().toISOString()],
    );
    if (spent.rows[0]) return { ok: true, approval: toApproval(spent.rows[0], await dbNow()) };
  }
  // Why not: say what is actually going on, so the user knows what to do next.
  const latest = await sharedDb().query(
    `SELECT ${COLUMNS} FROM "terraformApproval"
     WHERE "orgId" = $1 AND "projectId" = $2 AND "action" = $3 AND "planId" = $4 AND "planHash" = $5
     ORDER BY "createdAt" DESC LIMIT 1`,
    key,
  );
  const last = latest.rows[0] ? toApproval(latest.rows[0], await dbNow()) : null;
  const what = input.action === 'destroy' ? 'teardown' : 'plan';
  if (last?.status === 'pending') return { ok: false, code: 'pending', reason: `This ${what} is waiting for approval. Another owner or admin has to approve it first.` };
  if (ownConfirmationOnly && last?.status === 'approved' && last.decidedBy !== input.userId) {
    return { ok: false, code: 'needs_approval', reason: `This ${what} was confirmed with someone else's password. Confirm it yourself with your own password first.` };
  }
  if (last?.status === 'rejected') return { ok: false, code: 'rejected', reason: `The approval for this ${what} was rejected. Change it and request approval again.` };
  return { ok: false, code: 'needs_approval', reason: `This ${what} has to be approved before it can run. Request approval first (an earlier approval may have expired or already been used).` };
}

/** Gives an approval back if the run it was spent on could not start (so the approver is not asked twice for nothing). */
export async function returnApproval(id: string): Promise<void> {
  await sharedDb().query(`UPDATE "terraformApproval" SET "status" = 'approved', "usedAt" = NULL WHERE "id" = $1 AND "status" = 'used'`, [id]);
}

export async function getApproval(id: string, orgId: string): Promise<Approval | null> {
  const { rows } = await sharedDb().query(`SELECT ${COLUMNS} FROM "terraformApproval" WHERE "id" = $1 AND "orgId" = $2`, [id, orgId]);
  return rows[0] ? toApproval(rows[0], await dbNow()) : null;
}

/** Recent requests for a project, newest first, with expiry already worked out. */
export async function listApprovals(projectId: string, orgId: string, limit = 20): Promise<Approval[]> {
  const { rows } = await sharedDb().query(
    `SELECT ${COLUMNS} FROM "terraformApproval" WHERE "projectId" = $1 AND "orgId" = $2 ORDER BY "createdAt" DESC LIMIT $3`,
    [projectId, orgId, Math.max(1, Math.min(100, limit))],
  );
  const now = await dbNow();
  return rows.map((r) => toApproval(r, now));
}
