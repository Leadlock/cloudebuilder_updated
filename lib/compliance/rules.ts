/**
 * The rules that keep the readiness records honest. Pure functions, so the routes stay thin and the rules are tested on their own.
 */
import { createHash } from 'crypto';
import { z } from 'zod';
import type { ControlStatus, FindingStatus, FrameworkId, Signoff } from './types';

export const FRAMEWORKS: readonly FrameworkId[] = ['soc2', 'aws-waf', 'azure-waf'];
export const isFramework = (v: string): v is FrameworkId => (FRAMEWORKS as readonly string[]).includes(v);

export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
/** Files that are documents or data. Anything a browser could run (html, svg, js) or a machine could execute is refused. */
export const EVIDENCE_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'txt', 'csv', 'json', 'md', 'log', 'docx', 'xlsx', 'pptx', 'zip']);

export const fileExtension = (name: string): string => (name.split('.').pop() ?? '').toLowerCase();
export const sha256Of = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
/** A file name safe to store and to send back in a header: no path, no control characters, bounded. */
export const safeFileName = (name: string): string => name.replace(/[\\/]/g, '_').replace(/[^\w.\- ()]/g, '_').trim().slice(0, 120) || 'evidence';

/** Whether the person acting is the control's owner. Owners are free text (a name or an email), so both are compared. */
export function isSamePerson(owner: string, actor: { email?: string; name?: string }): boolean {
  const o = owner.trim().toLowerCase();
  if (!o) return false;
  return [actor.email, actor.name, actor.email?.split('@')[0]].some((v) => !!v && v.trim().toLowerCase() === o);
}

const text = (max: number) => z.string().trim().max(max);

export const ControlUpdateSchema = z.object({
  status: z.enum(['implemented', 'partial', 'planned', 'none', 'not_applicable']).nullable().optional(),
  owner: text(120).optional(),
  note: text(2000).optional(),
  naReason: text(1000).optional(),
  /** "I have reviewed this control." Recorded under the caller's name, and refused if the caller is the owner. */
  markReviewed: z.boolean().optional(),
});
export type ControlUpdate = z.infer<typeof ControlUpdateSchema>;

export interface ControlCurrent { status?: ControlStatus | null; owner: string; note: string; naReason: string; reviewer: string; reviewedAt?: string }

export function applyControlUpdate(cur: ControlCurrent, u: ControlUpdate, actor: { email?: string; name?: string }, now: string): { ok: true; next: ControlCurrent } | { ok: false; message: string } {
  const next: ControlCurrent = {
    ...cur,
    ...(u.status !== undefined ? { status: u.status } : {}),
    owner: u.owner ?? cur.owner, note: u.note ?? cur.note, naReason: u.naReason ?? cur.naReason,
  };
  if (next.status === 'not_applicable' && next.naReason.length < 10) return { ok: false, message: 'Say why the control does not apply (at least 10 characters). "Not applicable" without a reason is not accepted.' };
  if (next.status !== 'not_applicable') next.naReason = u.naReason !== undefined ? next.naReason : '';
  if (u.markReviewed) {
    if (!next.owner) return { ok: false, message: 'Name the control owner first, so the review can be shown to be independent.' };
    if (isSamePerson(next.owner, actor)) return { ok: false, message: 'A control cannot be reviewed by its own owner. Ask someone else to review it.' };
    next.reviewer = actor.name || actor.email || 'reviewer';
    next.reviewedAt = now;
  }
  // Changing who owns the control or what it says ends an earlier review: the reviewer looked at something else.
  else if (cur.reviewer && (next.owner !== cur.owner || next.status !== cur.status)) { next.reviewer = ''; delete next.reviewedAt; }
  return { ok: true, next };
}

export const FindingUpdateSchema = z.object({
  owner: text(120).optional(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  status: z.enum(['open', 'in_progress', 'closed', 'risk_accepted']).optional(),
  managementResponse: text(4000).optional(),
});
export type FindingUpdate = z.infer<typeof FindingUpdateSchema>;

export interface FindingCurrent { owner: string; targetDate?: string; status: FindingStatus; managementResponse: string; acceptedBy: string; retestedBy: string; retestedAt?: string }

export function applyFindingUpdate(cur: FindingCurrent, u: FindingUpdate, actor: { email?: string; name?: string; isAdmin: boolean }, now: string): { ok: true; next: FindingCurrent } | { ok: false; message: string } {
  const next: FindingCurrent = { ...cur, ...(u.owner !== undefined ? { owner: u.owner } : {}), ...(u.managementResponse !== undefined ? { managementResponse: u.managementResponse } : {}), ...(u.status ? { status: u.status } : {}) };
  if (u.targetDate !== undefined) { if (u.targetDate === null) delete next.targetDate; else next.targetDate = u.targetDate; }
  const who = actor.name || actor.email || 'user';
  if (u.status && u.status !== cur.status) {
    if ((u.status === 'closed' || u.status === 'risk_accepted') && next.managementResponse.length < 10) return { ok: false, message: 'Write management\'s response first (what was done, or why the risk is accepted).' };
    if (u.status === 'risk_accepted') {
      if (!actor.isAdmin) return { ok: false, message: 'Only an owner or admin of the organization can accept a risk.' };
      next.acceptedBy = who;
    }
    if (u.status === 'closed') {
      if (isSamePerson(next.owner, actor)) return { ok: false, message: 'A finding cannot be closed by its own owner. Ask someone else to re-test and close it.' };
      next.retestedBy = who; next.retestedAt = now;
    }
    if (u.status === 'open' || u.status === 'in_progress') { next.acceptedBy = ''; next.retestedBy = ''; delete next.retestedAt; }
  }
  return { ok: true, next };
}

export const SignoffSchema = z.object({ role: z.enum(['preparer', 'reviewer', 'management']) });

/** Preparer: any member. Reviewer and management: owner or admin, and the reviewer cannot be the person who prepared the report. */
export function checkSignoff(role: Signoff['role'], existing: Signoff[], actor: { email: string; isAdmin: boolean }): { ok: true } | { ok: false; message: string } {
  if (role !== 'preparer' && !actor.isAdmin) return { ok: false, message: `Only an owner or admin of the organization can sign as ${role}.` };
  const same = (s?: Signoff) => !!s && s.email.toLowerCase() === actor.email.toLowerCase();
  const preparer = existing.find((s) => s.role === 'preparer');
  if (role === 'reviewer') {
    if (!preparer) return { ok: false, message: 'The report has to be signed by its preparer before it can be reviewed.' };
    if (same(preparer)) return { ok: false, message: 'The reviewer cannot be the person who prepared the report.' };
  }
  if (role === 'management' && !existing.find((s) => s.role === 'reviewer')) return { ok: false, message: 'Management signs after the review.' };
  return { ok: true };
}

export const ScopeSchema = z.object({
  categories: z.array(z.enum(['security', 'availability', 'confidentiality'])).min(1),
  exclusions: z.object({ availability: text(600).optional(), confidentiality: text(600).optional() }).default({}),
});

export function checkScope(s: z.infer<typeof ScopeSchema>): { ok: true; categories: Array<'security' | 'availability' | 'confidentiality'>; exclusions: Record<string, string> } | { ok: false; message: string } {
  const categories = [...new Set(['security' as const, ...s.categories])];
  const exclusions: Record<string, string> = {};
  for (const c of ['availability', 'confidentiality'] as const) {
    if (categories.includes(c)) continue;
    const why = s.exclusions[c]?.trim() ?? '';
    if (why.length < 10) return { ok: false, message: `Say why ${c} is out of scope (at least 10 characters). A category left out without a reason is not accepted.` };
    exclusions[c] = why;
  }
  return { ok: true, categories, exclusions };
}
