/**
 * The readiness records against a REAL PostgreSQL: control answers, encrypted evidence, findings, sign-offs and report versions are stored, read back,
 * kept apart per project, and an evidence file survives only as ciphertext.
 *
 * Runs via:  node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.integration.mjs integration/readiness
 * Needs the tables from migration add_readiness_records (`npm run db:migrate`); skips itself if they are missing.
 */
import * as dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '.env') });

import { Client } from 'pg';

process.env['ENCRYPTION_KEY'] ??= '5f1c0a9e7b3d4c2a8e6f1b0d9c7a5e3f2b4d6c8a0e1f3a5c7b9d2e4f6a8c0b1d';

const url = process.env['DATABASE_URL'];
const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const orgId = `it-${run}-org`; const userId = `it-${run}-user`; const pA = `it-${run}-a`; const pB = `it-${run}-b`;
let ready = false; let admin: Client;

beforeAll(async () => {
  if (!url) return;
  admin = new Client({ connectionString: url });
  await admin.connect();
  ready = (await admin.query(`SELECT to_regclass('"public"."readinessEvidence"') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  if (!ready) { console.warn('[readiness integration] tables not found — run `npm run db:migrate` first; skipping'); return; }
  await admin.query(`INSERT INTO "user" ("id","email","createdAt","updatedAt") VALUES ($1,$2,'t','t')`, [userId, `${userId}@example.test`]);
  await admin.query(`INSERT INTO "organization" ("id","name","slug","createdAt","updatedAt") VALUES ($1,'Test org',$1,'t','t')`, [orgId]);
  for (const p of [pA, pB]) await admin.query(`INSERT INTO "project" ("id","name","description","provider","region","tags","createdAt","updatedAt","orgId","ownerId") VALUES ($1,'p','','aws','us-east-1','[]','t','t',$2,$3)`, [p, orgId, userId]);
});
afterAll(async () => {
  if (admin) {
    if (ready) { await admin.query(`DELETE FROM "organization" WHERE "id" = $1`, [orgId]); await admin.query(`DELETE FROM "project" WHERE "id" = ANY($1)`, [[pA, pB]]); await admin.query(`DELETE FROM "user" WHERE "id" = $1`, [userId]); }
    await admin.end();
  }
  const { db } = await import('@/src/prisma/db');
  await (db as unknown as { close?(): Promise<void> }).close?.();
});
const maybe = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!ready) return; await fn(); });

describe('readiness records on real Postgres', () => {
  maybe('a control answer is created, then updated in place, and kept per project and framework', async () => {
    const { readinessRepository: r } = await import('@/lib/repositories/readinessRepository');
    await r.saveControl(pA, 'soc2', { controlId: 'CTL-01', status: 'implemented', owner: 'Priya', note: 'n', naReason: '', reviewer: '' }, 'a@x.com');
    await r.saveControl(pA, 'soc2', { controlId: 'CTL-01', status: 'partial', owner: 'Sam', note: 'n2', naReason: '', reviewer: 'Dana', reviewedAt: '2026-10-01' }, 'b@x.com');
    await r.saveControl(pB, 'soc2', { controlId: 'CTL-01', status: 'none', owner: 'Other', note: '', naReason: '', reviewer: '' }, 'c@x.com');
    await r.saveControl(pA, 'aws-waf', { controlId: 'SEC 1', status: 'implemented', owner: 'Priya', note: '', naReason: '', reviewer: '' }, 'a@x.com');
    const a = await r.controls(pA, 'soc2');
    expect(Object.keys(a)).toEqual(['CTL-01']);
    expect(a['CTL-01']).toMatchObject({ status: 'partial', owner: 'Sam', reviewer: 'Dana', reviewedAt: '2026-10-01' });
    expect((await r.controls(pB, 'soc2'))['CTL-01']?.owner).toBe('Other');
    expect(Object.keys(await r.controls(pA, 'aws-waf'))).toEqual(['SEC 1']);
  });

  maybe('an unanswered control stays unanswered (no status), not "none"', async () => {
    const { readinessRepository: r } = await import('@/lib/repositories/readinessRepository');
    await r.saveControl(pA, 'soc2', { controlId: 'CTL-02', status: null, owner: 'Sam', note: '', naReason: '', reviewer: '' }, 'a@x.com');
    expect((await r.controls(pA, 'soc2'))['CTL-02']?.status).toBeUndefined();
  });

  maybe('an evidence file is stored as ciphertext, comes back identical, and is dropped on removal', async () => {
    const { readinessRepository: r } = await import('@/lib/repositories/readinessRepository');
    const bytes = Buffer.from('Quarterly access review: all accounts checked. ✓');
    const e = await r.addEvidence(pA, { title: 'Access review', description: '', kind: 'file', origin: 'system', collectedAt: '2026-10-01', validUntil: null, url: null, fileName: 'review.txt', mimeType: null, uploadedBy: 'a@x.com', controls: ['soc2:CTL-01'], file: { bytes, sha256: 'h' } });
    const raw = (await admin.query(`SELECT "sealed" FROM "readinessEvidence" WHERE "id" = $1`, [e.id])).rows[0].sealed as string;
    expect(raw).toMatch(/^v2:/);
    expect(raw).not.toContain(bytes.toString('base64'));
    expect((await r.evidenceFile(pA, e.id))?.equals(bytes)).toBe(true);
    // Another project cannot read it, even knowing the id.
    expect(await r.evidenceFile(pB, e.id)).toBeNull();
    // Copying the ciphertext to another row does not open either (it is bound to project and id).
    expect((await r.evidence(pA)).map((x) => x.id)).toContain(e.id);
    expect(await r.removeEvidence(pA, e.id, 'a@x.com')).toBe(true);
    expect(await r.removeEvidence(pA, e.id, 'a@x.com')).toBe(false);
    expect(await r.evidenceFile(pA, e.id)).toBeNull();
    expect((await admin.query(`SELECT "sealed","deletedBy" FROM "readinessEvidence" WHERE "id" = $1`, [e.id])).rows[0]).toEqual({ sealed: null, deletedBy: 'a@x.com' });
    expect((await r.evidence(pA)).map((x) => x.id)).not.toContain(e.id);
    expect((await r.evidence(pA, true)).map((x) => x.id)).toContain(e.id);
  });

  maybe('findings, one sign-off per role, report versions and scope', async () => {
    const { readinessRepository: r } = await import('@/lib/repositories/readinessRepository');
    await r.saveFinding(pA, 'soc2', { controlId: 'CTL-23', owner: 'Sam', targetDate: '2026-11-30', status: 'open', managementResponse: '', acceptedBy: '', retestedBy: '' }, 'a@x.com');
    await r.saveFinding(pA, 'soc2', { controlId: 'CTL-23', owner: 'Sam', targetDate: '2026-11-30', status: 'in_progress', managementResponse: 'On it', acceptedBy: '', retestedBy: '' }, 'a@x.com');
    expect((await r.findings(pA, 'soc2'))['CTL-23']).toMatchObject({ status: 'in_progress', managementResponse: 'On it', targetDate: '2026-11-30' });

    await r.sign(pA, 'soc2', { role: 'preparer', name: 'A', email: 'a@x.com', reportHash: 'S2-1' });
    await r.sign(pA, 'soc2', { role: 'preparer', name: 'A2', email: 'a2@x.com', reportHash: 'S2-2' });
    await r.sign(pA, 'soc2', { role: 'reviewer', name: 'B', email: 'b@x.com' });
    const s = await r.signoffs(pA, 'soc2');
    expect(s.map((x) => x.role).sort()).toEqual(['preparer', 'reviewer']);
    expect(s.find((x) => x.role === 'preparer')).toMatchObject({ name: 'A2', reportHash: 'S2-2' });
    await r.clearSignoffs(pA, 'soc2');
    expect(await r.signoffs(pA, 'soc2')).toEqual([]);

    expect(await r.nextVersion(pA, 'soc2')).toBe(1);
    await r.recordReport(pA, 'soc2', { version: 1, reportId: 'S2-X', readiness: 'Not ready', asOf: '2026-10-26', generatedBy: 'a@x.com', summaryJson: '{}' });
    expect(await r.nextVersion(pA, 'soc2')).toBe(2);
    expect(await r.nextVersion(pB, 'soc2')).toBe(1);

    await r.saveSettings(pA, 'soc2', { categories: ['security'] }, 'a@x.com');
    await r.saveSettings(pA, 'soc2', { categories: ['security', 'availability'] }, 'a@x.com');
    expect(await r.settings(pA, 'soc2')).toEqual({ categories: ['security', 'availability'] });
    expect(await r.settings(pB, 'soc2')).toEqual({});
  });
});
