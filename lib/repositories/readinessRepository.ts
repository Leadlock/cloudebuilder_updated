/**
 * ReadinessRepository: what the team recorded for the compliance readiness reports (lib/compliance). Control answers, evidence (the file is stored
 * encrypted), findings with management's response, sign-offs, report versions, and the scope chosen for a framework.
 *
 * Every read and write is scoped by projectId; the routes check that the project belongs to the caller's organization before they get here.
 */
import { randomUUID } from 'crypto';
import { db } from '@/src/prisma/db';
import { encrypt, decrypt } from '@/lib/crypto/credentials';
import { controlKey, evidenceControls } from '@/lib/compliance/evidenceInput';
import type { ControlRecord, ControlStatus, FindingRecord, FindingStatus, FrameworkId, Signoff } from '@/lib/compliance/types';

const now = () => new Date().toISOString();
const ctx = (projectId: string, id: string) => `readiness-evidence:${projectId}:${id}`;

interface ControlRow { id: string; projectId: string; framework: string; controlId: string; status: string | null; owner: string; note: string; naReason: string; reviewer: string; reviewedAt: string | null; updatedBy: string; updatedAt: string }
const CONTROL_COLS = ['id', 'projectId', 'framework', 'controlId', 'status', 'owner', 'note', 'naReason', 'reviewer', 'reviewedAt', 'updatedBy', 'updatedAt'] as const;

export interface EvidenceRow {
  id: string; projectId: string; title: string; description: string; kind: 'file' | 'link' | 'note'; origin: 'system' | 'manual';
  collectedAt: string; validUntil: string | null; url: string | null; fileName: string | null; mimeType: string | null; sizeBytes: number | null;
  sha256: string | null; controlsJson: string; uploadedBy: string; createdAt: string; deletedAt: string | null; deletedBy: string | null;
}
const EVIDENCE_COLS = ['id', 'projectId', 'title', 'description', 'kind', 'origin', 'collectedAt', 'validUntil', 'url', 'fileName', 'mimeType', 'sizeBytes', 'sha256', 'controlsJson', 'uploadedBy', 'createdAt', 'deletedAt', 'deletedBy'] as const;

export { controlKey, evidenceControls };

interface FindingRow { id: string; projectId: string; framework: string; controlId: string; owner: string; targetDate: string | null; status: string; managementResponse: string; acceptedBy: string; retestedBy: string; retestedAt: string | null; updatedBy: string; updatedAt: string }
const FINDING_COLS = ['id', 'projectId', 'framework', 'controlId', 'owner', 'targetDate', 'status', 'managementResponse', 'acceptedBy', 'retestedBy', 'retestedAt', 'updatedBy', 'updatedAt'] as const;

export interface ReportVersionRow { id: string; projectId: string; framework: string; version: number; reportId: string; readiness: string; asOf: string; generatedBy: string; generatedAt: string; summaryJson: string }
const REPORT_COLS = ['id', 'projectId', 'framework', 'version', 'reportId', 'readiness', 'asOf', 'generatedBy', 'generatedAt', 'summaryJson'] as const;

interface SignoffRow { id: string; projectId: string; framework: string; role: string; name: string; email: string; signedAt: string; reportHash: string | null }
const SIGNOFF_COLS = ['id', 'projectId', 'framework', 'role', 'name', 'email', 'signedAt', 'reportHash'] as const;

class ReadinessRepository {
  // ── control answers ───────────────────────────────────────────────────────
  async controls(projectId: string, framework: FrameworkId): Promise<Record<string, ControlRecord>> {
    const rows = await db.orm.public.ReadinessControl.where({ projectId, framework }).select(...CONTROL_COLS).all() as ControlRow[];
    const out: Record<string, ControlRecord> = {};
    for (const r of rows) {
      out[r.controlId] = { controlId: r.controlId, ...(r.status ? { status: r.status as ControlStatus } : {}), owner: r.owner, note: r.note, naReason: r.naReason, reviewer: r.reviewer, ...(r.reviewedAt ? { reviewedAt: r.reviewedAt } : {}), updatedAt: r.updatedAt };
    }
    return out;
  }

  async saveControl(projectId: string, framework: FrameworkId, rec: { controlId: string; status?: ControlStatus | null; owner: string; note: string; naReason: string; reviewer: string; reviewedAt?: string | null }, by: string): Promise<void> {
    const fields = { status: rec.status ?? null, owner: rec.owner, note: rec.note, naReason: rec.naReason, reviewer: rec.reviewer, reviewedAt: rec.reviewedAt ?? null, updatedBy: by, updatedAt: now() };
    const existing = await db.orm.public.ReadinessControl.where({ projectId, framework, controlId: rec.controlId }).select('id').first();
    if (existing) await db.orm.public.ReadinessControl.where({ projectId, framework, controlId: rec.controlId }).update(fields);
    else await db.orm.public.ReadinessControl.create({ id: randomUUID(), projectId, framework, controlId: rec.controlId, ...fields });
  }

  // ── evidence ──────────────────────────────────────────────────────────────
  async evidence(projectId: string, includeDeleted = false): Promise<EvidenceRow[]> {
    const rows = await db.orm.public.ReadinessEvidence.where({ projectId }).select(...EVIDENCE_COLS).all() as EvidenceRow[];
    return rows.filter((r) => includeDeleted || !r.deletedAt).sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
  }

  async evidenceById(projectId: string, id: string): Promise<EvidenceRow | null> {
    return ((await db.orm.public.ReadinessEvidence.where({ id, projectId }).select(...EVIDENCE_COLS).first()) as EvidenceRow | null) ?? null;
  }

  async addEvidence(projectId: string, e: Omit<EvidenceRow, 'id' | 'projectId' | 'createdAt' | 'deletedAt' | 'deletedBy' | 'controlsJson' | 'sizeBytes' | 'sha256'> & { controls: string[]; file?: { bytes: Buffer; sha256: string } }): Promise<EvidenceRow> {
    const id = randomUUID();
    const { controls, file, ...rest } = e;
    const row: EvidenceRow = { ...rest, id, projectId, sizeBytes: file ? file.bytes.length : null, sha256: file?.sha256 ?? null, controlsJson: JSON.stringify([...new Set(controls)]), createdAt: now(), deletedAt: null, deletedBy: null };
    await db.orm.public.ReadinessEvidence.create({ ...row, sealed: file ? encrypt(file.bytes.toString('base64'), ctx(projectId, id)) : null });
    return row;
  }

  async setEvidenceControls(projectId: string, id: string, controls: string[]): Promise<void> {
    await db.orm.public.ReadinessEvidence.where({ id, projectId }).update({ controlsJson: JSON.stringify([...new Set(controls)]) });
  }

  /** The stored file, decrypted. Returns null when there is none, or when it fails to open (tampered, or the key was lost). */
  async evidenceFile(projectId: string, id: string): Promise<Buffer | null> {
    const row = await db.orm.public.ReadinessEvidence.where({ id, projectId }).select('sealed', 'deletedAt').first() as { sealed: string | null; deletedAt: string | null } | null;
    if (!row?.sealed || row.deletedAt) return null;
    try { return Buffer.from(decrypt(row.sealed, ctx(projectId, id)), 'base64'); } catch { return null; }
  }

  /** Evidence is never really deleted: it is marked removed, so an earlier report can still be traced back to it. The stored file is dropped. */
  async removeEvidence(projectId: string, id: string, by: string): Promise<boolean> {
    const e = await this.evidenceById(projectId, id);
    if (!e || e.deletedAt) return false;
    await db.orm.public.ReadinessEvidence.where({ id, projectId }).update({ deletedAt: now(), deletedBy: by, sealed: null });
    return true;
  }

  // ── findings ──────────────────────────────────────────────────────────────
  async findings(projectId: string, framework: FrameworkId): Promise<Record<string, FindingRecord>> {
    const rows = await db.orm.public.ReadinessFinding.where({ projectId, framework }).select(...FINDING_COLS).all() as FindingRow[];
    const out: Record<string, FindingRecord> = {};
    for (const r of rows) {
      out[r.controlId] = { controlId: r.controlId, owner: r.owner, ...(r.targetDate ? { targetDate: r.targetDate } : {}), status: r.status as FindingStatus, managementResponse: r.managementResponse, acceptedBy: r.acceptedBy, retestedBy: r.retestedBy, ...(r.retestedAt ? { retestedAt: r.retestedAt } : {}), updatedAt: r.updatedAt };
    }
    return out;
  }

  async saveFinding(projectId: string, framework: FrameworkId, rec: Omit<FindingRecord, 'updatedAt'>, by: string): Promise<void> {
    const fields = { owner: rec.owner, targetDate: rec.targetDate ?? null, status: rec.status, managementResponse: rec.managementResponse, acceptedBy: rec.acceptedBy, retestedBy: rec.retestedBy, retestedAt: rec.retestedAt ?? null, updatedBy: by, updatedAt: now() };
    const existing = await db.orm.public.ReadinessFinding.where({ projectId, framework, controlId: rec.controlId }).select('id').first();
    if (existing) await db.orm.public.ReadinessFinding.where({ projectId, framework, controlId: rec.controlId }).update(fields);
    else await db.orm.public.ReadinessFinding.create({ id: randomUUID(), projectId, framework, controlId: rec.controlId, ...fields });
  }

  // ── sign-offs ─────────────────────────────────────────────────────────────
  async signoffs(projectId: string, framework: FrameworkId): Promise<Signoff[]> {
    const rows = await db.orm.public.ReadinessSignoff.where({ projectId, framework }).select(...SIGNOFF_COLS).all() as SignoffRow[];
    return rows.sort((a, b) => a.signedAt.localeCompare(b.signedAt)).map((r) => ({ role: r.role as Signoff['role'], name: r.name, email: r.email, signedAt: r.signedAt, ...(r.reportHash ? { reportHash: r.reportHash } : {}) }));
  }

  /** One sign-off per role: signing again replaces the earlier one for that role. */
  async sign(projectId: string, framework: FrameworkId, s: Omit<Signoff, 'signedAt'>): Promise<Signoff> {
    const signedAt = now();
    const existing = await db.orm.public.ReadinessSignoff.where({ projectId, framework, role: s.role }).select('id').first();
    const fields = { name: s.name, email: s.email, signedAt, reportHash: s.reportHash ?? null };
    if (existing) await db.orm.public.ReadinessSignoff.where({ projectId, framework, role: s.role }).update(fields);
    else await db.orm.public.ReadinessSignoff.create({ id: randomUUID(), projectId, framework, role: s.role, ...fields });
    return { ...s, signedAt };
  }

  /** A change to a control or finding after sign-off makes the sign-offs stale: they are cleared and have to be given again. */
  async clearSignoffs(projectId: string, framework: FrameworkId): Promise<void> {
    // .delete() removes one row; deleteAndCount() removes every match.
    await db.orm.public.ReadinessSignoff.where({ projectId, framework }).deleteAndCount();
  }

  // ── report versions ───────────────────────────────────────────────────────
  async reports(projectId: string, framework: FrameworkId): Promise<ReportVersionRow[]> {
    const rows = await db.orm.public.ReadinessReport.where({ projectId, framework }).select(...REPORT_COLS).all() as ReportVersionRow[];
    return rows.sort((a, b) => b.version - a.version);
  }

  async nextVersion(projectId: string, framework: FrameworkId): Promise<number> {
    const rows = await this.reports(projectId, framework);
    return (rows[0]?.version ?? 0) + 1;
  }

  async recordReport(projectId: string, framework: FrameworkId, r: Omit<ReportVersionRow, 'id' | 'projectId' | 'framework' | 'generatedAt'>): Promise<ReportVersionRow> {
    const row: ReportVersionRow = { id: randomUUID(), projectId, framework, generatedAt: now(), ...r };
    await db.orm.public.ReadinessReport.create(row);
    return row;
  }

  // ── scope ─────────────────────────────────────────────────────────────────
  async settings<T extends object>(projectId: string, framework: FrameworkId): Promise<Partial<T>> {
    const row = await db.orm.public.ReadinessSetting.where({ projectId, framework }).select('settingsJson').first() as { settingsJson: string } | null;
    if (!row) return {};
    try { const v = JSON.parse(row.settingsJson); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }

  async saveSettings(projectId: string, framework: FrameworkId, settings: object, by: string): Promise<void> {
    const fields = { settingsJson: JSON.stringify(settings), updatedBy: by, updatedAt: now() };
    const existing = await db.orm.public.ReadinessSetting.where({ projectId, framework }).select('id').first();
    if (existing) await db.orm.public.ReadinessSetting.where({ projectId, framework }).update(fields);
    else await db.orm.public.ReadinessSetting.create({ id: randomUUID(), projectId, framework, ...fields });
  }
}

export const readinessRepository = new ReadinessRepository();
