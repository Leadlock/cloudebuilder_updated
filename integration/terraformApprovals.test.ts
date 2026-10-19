/**
 * Terraform approvals against a REAL PostgreSQL: above all that an approval is single-use even when many requests try to spend it
 * at the same instant — the property an in-memory database cannot prove.
 *
 * Runs via:  node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.integration.mjs integration/terraformApprovals
 * Needs the table from migration 20261004T0747_add_terraform_approvals (`npm run db:update`); skips itself if it is missing.
 * Uses unique ids and removes its own rows.
 */
import * as dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '.env') });

import { Client } from 'pg';

const url = process.env['DATABASE_URL'];
const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const orgId = `it-${run}-org`;
let ready = false;
let admin: Client;

beforeAll(async () => {
  if (!url) return;
  process.env['CLOUDBUILDER_TERRAFORM_APPROVAL'] = 'required';
  admin = new Client({ connectionString: url });
  await admin.connect();
  const r = await admin.query(`SELECT to_regclass('"public"."terraformApproval"') IS NOT NULL AS ok`);
  ready = r.rows[0]?.ok === true;
  if (!ready) console.warn('[approvals integration] table not found — run `npm run db:update` first; skipping');
});

afterAll(async () => {
  if (admin) {
    if (ready) await admin.query(`DELETE FROM "terraformApproval" WHERE "orgId" = $1`, [orgId]);
    await admin.end();
  }
  const { sharedDb } = await import('@/lib/api/sharedStore');
  await (sharedDb() as unknown as { end(): Promise<void> }).end?.();
});

const maybe = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!ready) return; await fn(); });
const PLAN = (planId: string) => ({ orgId, projectId: `it-${run}-proj`, action: 'apply' as const, planId, planHash: 'h'.repeat(64) });

describe('terraform approvals on real Postgres', () => {
  maybe('request → second person approves → exactly one of many simultaneous runs gets the approval', async () => {
    const a = await import('@/lib/terraform/execution/approvals');
    const plan = PLAN(`it-${run}-p1`);
    const { approval } = await a.requestApproval({ ...plan, requestedBy: 'alice', summary: '3 to add' });
    expect(approval.status).toBe('pending');
    expect(await a.consumeApproval(plan)).toMatchObject({ ok: false, code: 'pending' });
    expect(await a.decideApproval({ id: approval.id, orgId, decidedBy: 'alice', decision: 'approve' })).toMatchObject({ ok: false, code: 'own_request' });
    expect((await a.decideApproval({ id: approval.id, orgId, decidedBy: 'bob', decision: 'approve' })).ok).toBe(true);

    const results = await Promise.all(Array.from({ length: 12 }, () => a.consumeApproval(plan)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);                         // one approval, one run
    expect(await a.consumeApproval(plan)).toMatchObject({ ok: false });
  });

  maybe('two people deciding at once: only one decision is recorded', async () => {
    const a = await import('@/lib/terraform/execution/approvals');
    const { approval } = await a.requestApproval({ ...PLAN(`it-${run}-p2`), requestedBy: 'alice' });
    const decisions = await Promise.all([
      a.decideApproval({ id: approval.id, orgId, decidedBy: 'bob', decision: 'approve' }),
      a.decideApproval({ id: approval.id, orgId, decidedBy: 'carol', decision: 'reject' }),
    ]);
    expect(decisions.filter((d) => d.ok)).toHaveLength(1);
    const final = await a.getApproval(approval.id, orgId);
    expect(['approved', 'rejected']).toContain(final?.status);
  });

  maybe('an approval is only visible inside its own organisation, and expiry uses the database clock', async () => {
    const a = await import('@/lib/terraform/execution/approvals');
    const { approval } = await a.requestApproval({ ...PLAN(`it-${run}-p3`), requestedBy: 'alice' });
    expect(await a.getApproval(approval.id, `${orgId}-other`)).toBeNull();
    await admin.query(`UPDATE "terraformApproval" SET "expiresAtMs" = "expiresAtMs" - 7200000 WHERE "id" = $1`, [approval.id]);
    expect((await a.getApproval(approval.id, orgId))?.status).toBe('expired');
    expect(await a.decideApproval({ id: approval.id, orgId, decidedBy: 'bob', decision: 'approve' })).toMatchObject({ ok: false, code: 'expired' });
  });
});
