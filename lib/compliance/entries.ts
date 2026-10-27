/**
 * What the team records for the SOC 2 readiness report beyond control answers. Each kind of record is described once, here: its fields (used to draw the form and to
 * check what arrives), how it is keyed, and the few rules that go beyond field checks. Statements entered here are the team's own: the report labels them as recorded,
 * not verified, and they never change a score.
 */
import { z } from 'zod';

export type EntryKind = 'change' | 'prior_finding' | 'walkthrough' | 'cuec' | 'csoc' | 'provider_review' | 'review_conclusion' | 'limitation_note' | 'finding_plan';
export const ENTRY_KINDS: readonly EntryKind[] = ['change', 'prior_finding', 'walkthrough', 'cuec', 'csoc', 'provider_review', 'review_conclusion', 'limitation_note', 'finding_plan'];
export const isEntryKind = (v: string): v is EntryKind => (ENTRY_KINDS as readonly string[]).includes(v);

export type FieldType = 'text' | 'textarea' | 'date' | 'select';
export interface FieldMeta { key: string; label: string; type: FieldType; options?: readonly string[]; max?: number; required?: boolean; help?: string }
export interface KindMeta {
  kind: EntryKind; title: string; blurb: string;
  /** true: one record per subject, found by its key (saving again replaces it). false: any number of records. */
  keyed: boolean;
  keyLabel?: string;
  fields: readonly FieldMeta[];
}

const yesNo = ['Yes', 'No', 'Not known'] as const;
const status = ['Confirmed', 'Gap', 'Not confirmed'] as const;

export const ENTRY_META: Record<EntryKind, KindMeta> = {
  change: {
    kind: 'change', title: 'Significant changes', keyed: false,
    blurb: 'Every change to the system, its services, providers, people or controls up to the assessment date, including ones the company did not treat as significant, so the CPA firm can judge that.',
    fields: [
      { key: 'date', label: 'Date', type: 'date', required: true }, { key: 'change', label: 'Change', type: 'textarea', required: true, max: 600 },
      { key: 'systems', label: 'Systems or processes affected', type: 'text', max: 300 }, { key: 'criteria', label: 'Criteria affected', type: 'text', max: 120, help: 'For example CC6.1, CC8.1' },
      { key: 'impact', label: 'Control impact', type: 'textarea', max: 600 }, { key: 'reviewedBy', label: 'Reviewed by', type: 'text', max: 120 },
    ],
  },
  prior_finding: {
    kind: 'prior_finding', title: 'Prior-period findings', keyed: false,
    blurb: 'Every finding from the previous internal or external report: whether it was fixed, with evidence, and whether it was retested in this period.',
    fields: [
      { key: 'priorId', label: 'Prior finding ID', type: 'text', required: true, max: 60 }, { key: 'report', label: 'Prior report and date', type: 'text', max: 200 },
      { key: 'condition', label: 'Original condition', type: 'textarea', required: true, max: 800 }, { key: 'remediation', label: 'Remediation action', type: 'textarea', max: 800 },
      { key: 'closureEvidence', label: 'Evidence of closure', type: 'text', max: 300, help: 'Evidence ID or description' },
      { key: 'statusNow', label: 'Status this period', type: 'select', options: ['Closed', 'Open', 'Recurs', 'Risk accepted'], required: true },
      { key: 'retestedBy', label: 'Retested by', type: 'text', max: 120 }, { key: 'retestedOn', label: 'Retested on', type: 'date' },
    ],
  },
  walkthrough: {
    kind: 'walkthrough', title: 'Walkthroughs', keyed: true, keyLabel: 'Control',
    blurb: 'One walkthrough per control: who was interviewed, what was observed, which documents were inspected, and where the control\'s population comes from. A design conclusion needs the walkthrough and at least one design document. It does not change the control\'s score.',
    fields: [
      { key: 'participant', label: 'Walkthrough participant', type: 'text', required: true, max: 200 }, { key: 'date', label: 'Date', type: 'date', required: true },
      { key: 'documents', label: 'Documents inspected', type: 'textarea', max: 800 }, { key: 'observed', label: 'What was observed', type: 'textarea', required: true, max: 1200 },
      { key: 'population', label: 'Population source and how it was reconciled', type: 'textarea', max: 600 }, { key: 'conclusion', label: 'Design conclusion', type: 'textarea', max: 800 },
      { key: 'preparer', label: 'Prepared by', type: 'text', max: 120 }, { key: 'reviewer', label: 'Reviewed by', type: 'text', max: 120, help: 'Cannot be the preparer' },
    ],
  },
  cuec: {
    kind: 'cuec', title: 'Complementary user entity controls (CUECs)', keyed: true, keyLabel: 'CUEC ID',
    blurb: 'Controls the system description assumes customers operate. Mark each one Confirmed or Gap; a gap needs a note and closes only with evidence.',
    fields: [
      { key: 'statement', label: 'CUEC as stated in the description', type: 'textarea', max: 600 }, { key: 'criteria', label: 'Criteria', type: 'text', max: 120 },
      { key: 'contracts', label: 'Where it appears in customer contracts', type: 'text', max: 300 }, { key: 'communicated', label: 'How it is communicated', type: 'text', max: 300 },
      { key: 'status', label: 'Status', type: 'select', options: status, required: true }, { key: 'note', label: 'Note', type: 'textarea', max: 600 },
    ],
  },
  csoc: {
    kind: 'csoc', title: 'Complementary subservice organisation controls (CSOCs)', keyed: true, keyLabel: 'CSOC ID',
    blurb: 'Controls a provider must operate for ours to work. Mark each one Confirmed or Gap; a gap needs a note.',
    fields: [
      { key: 'statement', label: 'Provider and CSOC', type: 'textarea', max: 600 }, { key: 'criteria', label: 'Criteria', type: 'text', max: 120 },
      { key: 'report', label: 'Provider report that covers it (period)', type: 'text', max: 300 }, { key: 'ourControl', label: 'Our complementary control', type: 'text', max: 400 },
      { key: 'status', label: 'Status', type: 'select', options: status, required: true }, { key: 'note', label: 'Note', type: 'textarea', max: 600 },
    ],
  },
  provider_review: {
    kind: 'provider_review', title: 'Subservice organisation review', keyed: true, keyLabel: 'Provider',
    blurb: 'The review of each provider that supports in-scope services (vendor risk, CC9.2), whether carved out or included.',
    fields: [
      { key: 'treatment', label: 'Carve-out or inclusive', type: 'select', options: ['Carve-out', 'Inclusive'], required: true },
      { key: 'reportType', label: 'Report type', type: 'text', max: 120, help: 'For example SOC 2 Type 2' }, { key: 'period', label: 'Report period', type: 'text', max: 120 },
      { key: 'coversPeriod', label: 'Report covers the audit period?', type: 'select', options: yesNo, required: true },
      { key: 'bridgeLetter', label: 'Bridge letter needed (dates)', type: 'text', max: 200, help: 'Needed when the report does not cover the whole period' },
      { key: 'opinion', label: 'Opinion and exceptions noted', type: 'textarea', max: 800 }, { key: 'controlsRelied', label: 'Controls relied on', type: 'textarea', max: 600 },
      { key: 'ourEvidence', label: 'Our evidence it operates', type: 'text', max: 300 }, { key: 'gap', label: 'Gap in the provider report', type: 'textarea', max: 600 }, { key: 'compensating', label: 'Compensating action', type: 'textarea', max: 600 },
      { key: 'reviewedBy', label: 'Reviewed by', type: 'text', max: 120 }, { key: 'reviewedOn', label: 'Reviewed on', type: 'date' },
    ],
  },
  review_conclusion: {
    kind: 'review_conclusion', title: 'Subservice review conclusion', keyed: true,
    blurb: 'Whether the providers\' controls are adequately covered for the criteria in scope, the gaps that remain, and who accepted the residual risk.',
    fields: [{ key: 'conclusion', label: 'Conclusion', type: 'textarea', required: true, max: 2000 }, { key: 'acceptedBy', label: 'Residual risk accepted by', type: 'text', max: 120 }],
  },
  limitation_note: {
    kind: 'limitation_note', title: 'Limitations register', keyed: true, keyLabel: 'Limitation',
    blurb: 'Assign an owner to each limitation and record when it was resolved. A limitation stays open until the evidence is provided or the conclusion is revised.',
    fields: [{ key: 'owner', label: 'Owner', type: 'text', max: 120 }, { key: 'resolvedOn', label: 'Resolved on', type: 'date' }, { key: 'note', label: 'Note', type: 'textarea', max: 600 }],
  },
  finding_plan: {
    kind: 'finding_plan', title: 'Remediation plans', keyed: true, keyLabel: 'Control',
    blurb: 'How management will fix a finding: the milestones, what will show it is fixed, and the evidence of closure.',
    fields: [{ key: 'milestones', label: 'Milestones', type: 'textarea', max: 800 }, { key: 'acceptance', label: 'Acceptance criteria', type: 'textarea', max: 600 }, { key: 'closureEvidence', label: 'Evidence of closure', type: 'text', max: 300 }],
  },
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);

/** The schema for one kind, built from its field list. */
export function entrySchema(kind: EntryKind) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of ENTRY_META[kind].fields) {
    const max = f.max ?? (f.type === 'textarea' ? 1000 : 200);
    let s: z.ZodTypeAny;
    if (f.type === 'date') s = z.string().trim().refine((v) => v === '' || DATE.test(v), 'Use a date as YYYY-MM-DD').refine((v) => v === '' || v <= today(), 'The date cannot be in the future');
    else if (f.type === 'select') s = z.string().trim().refine((v) => v === '' || (f.options ?? []).includes(v), `Choose one of: ${(f.options ?? []).join(', ')}`);
    else s = z.string().trim().max(max, `At most ${max} characters`);
    if (f.required) s = (s as z.ZodString).refine((v: string) => v !== '', `${f.label} is required`);
    // A missing field counts as empty (and is then checked like any other), so "required" cannot be skipped by leaving the field out.
    shape[f.key] = z.preprocess((v) => (v === undefined || v === null ? '' : v), s);
  }
  return z.object(shape).strict();
}

export const EntryBodySchema = z.object({ kind: z.string().refine(isEntryKind, 'Unknown kind of record'), key: z.string().trim().max(80).optional(), data: z.record(z.string(), z.unknown()) });

/** The rules that go beyond a field: returns the message to show, or null when the record is acceptable. */
export function checkEntry(kind: EntryKind, d: Record<string, string>): string | null {
  switch (kind) {
    case 'walkthrough': return d['reviewer'] && d['preparer'] && d['reviewer'].toLowerCase() === d['preparer'].toLowerCase() ? 'The reviewer cannot be the person who prepared the walkthrough.' : null;
    case 'prior_finding': return d['statusNow'] === 'Closed' && (!d['closureEvidence'] || !d['retestedBy']) ? 'A closed finding needs the evidence of closure and who retested it.' : null;
    case 'provider_review': return d['coversPeriod'] === 'No' && !d['bridgeLetter'] ? 'The report does not cover the audit period, so say which dates a bridge letter must cover.' : null;
    case 'cuec': case 'csoc': return d['status'] === 'Gap' && !d['note'] ? 'A gap needs a note saying what is missing and how it will be closed.' : null;
    default: return null;
  }
}

export interface Entry { id: string; key: string | null; data: Record<string, string>; updatedBy: string; updatedAt: string }
export interface Engagement { cpaFirm: string; scanProvider: string; scanFrequency: string; assessmentDate?: string }
export interface TeamRecords {
  engagement: Engagement;
  changes: Entry[]; priorFindings: Entry[];
  walkthroughs: Record<string, Entry>; cuecs: Record<string, Entry>; csocs: Record<string, Entry>; providers: Record<string, Entry>;
  limitationNotes: Record<string, Entry>; findingPlans: Record<string, Entry>;
  conclusion?: Entry;
}
export const EMPTY_ENGAGEMENT: Engagement = { cpaFirm: '', scanProvider: '', scanFrequency: '' };
export const emptyTeam = (): TeamRecords => ({ engagement: { ...EMPTY_ENGAGEMENT }, changes: [], priorFindings: [], walkthroughs: {}, cuecs: {}, csocs: {}, providers: {}, limitationNotes: {}, findingPlans: {} });

export const EngagementSchema = z.object({
  cpaFirm: z.string().trim().max(120).default(''), scanProvider: z.string().trim().max(120).default(''), scanFrequency: z.string().trim().max(60).default(''),
  assessmentDate: z.string().trim().refine((v) => v === '' || (DATE.test(v) && v <= today()), 'The assessment date must be a date (YYYY-MM-DD) that is not in the future').optional(),
});

export interface EntryRow { id: string; kind: string; key: string | null; dataJson: string; updatedBy: string; updatedAt: string }

/** Rows from the database become the records the report reads. A damaged row is skipped, never fatal. */
export function groupEntries(rows: readonly EntryRow[], engagement: Engagement): TeamRecords {
  const team = emptyTeam(); team.engagement = engagement;
  const sorted = [...rows].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const r of sorted) {
    if (!isEntryKind(r.kind)) continue;
    let data: Record<string, string> = {};
    try { const v = JSON.parse(r.dataJson); if (v && typeof v === 'object') data = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? x : ''])); } catch { continue; }
    const e: Entry = { id: r.id, key: r.key, data, updatedBy: r.updatedBy, updatedAt: r.updatedAt };
    const k = r.key ?? '';
    switch (r.kind) {
      case 'change': team.changes.push(e); break;
      case 'prior_finding': team.priorFindings.push(e); break;
      case 'walkthrough': team.walkthroughs[k] = e; break;
      case 'cuec': team.cuecs[k] = e; break;
      case 'csoc': team.csocs[k] = e; break;
      case 'provider_review': team.providers[k] = e; break;
      case 'limitation_note': team.limitationNotes[k] = e; break;
      case 'finding_plan': team.findingPlans[k] = e; break;
      case 'review_conclusion': team.conclusion = e; break;
    }
  }
  team.changes.sort((a, b) => (a.data['date'] ?? '').localeCompare(b.data['date'] ?? ''));
  return team;
}
