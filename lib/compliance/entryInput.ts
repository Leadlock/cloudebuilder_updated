/** Checks a record arriving at the entries API: its kind, its key, its fields and the rules beyond the fields. Returns the clean record, or the message to show. */
import { ENTRY_META, EntryBodySchema, checkEntry, entrySchema, type EntryKind } from './entries';
import { defsFor } from './frameworks';
import type { FrameworkId } from './types';

export type CheckedEntry = { ok: true; kind: EntryKind; key: string | null; data: Record<string, string> } | { ok: false; message: string };

const KEY_RULES: Partial<Record<EntryKind, RegExp>> = { cuec: /^CUEC-[\w.-]{1,30}$/, csoc: /^CSOC-[\w.-]{1,30}$/, limitation_note: /^[\w.-]{1,40}$/ };

export function checkEntryInput(framework: FrameworkId, body: unknown): CheckedEntry {
  const head = EntryBodySchema.safeParse(body);
  if (!head.success) return { ok: false, message: head.error.issues[0]?.message ?? 'The request is not valid.' };
  const kind = head.data.kind as EntryKind;
  const meta = ENTRY_META[kind];
  const fields = entrySchema(kind).safeParse(head.data.data);
  if (!fields.success) return { ok: false, message: fields.error.issues[0]?.message ?? 'A field is not valid.' };
  const data = fields.data as Record<string, string>;

  let key: string | null = null;
  if (meta.keyed) {
    key = kind === 'review_conclusion' ? 'main' : (head.data.key ?? '').trim();
    if (!key) return { ok: false, message: `${meta.keyLabel ?? 'A key'} is required.` };
    if ((kind === 'walkthrough' || kind === 'finding_plan') && !defsFor(framework).some((d) => d.id === key)) return { ok: false, message: `${key} is not a control of this framework.` };
    const rule = KEY_RULES[kind];
    if (rule && !rule.test(key)) return { ok: false, message: `${meta.keyLabel ?? 'The key'} "${key}" is not in the expected form.` };
    if (kind === 'provider_review' && key.length > 80) return { ok: false, message: 'The provider name is too long.' };
  }
  const bad = checkEntry(kind, data);
  return bad ? { ok: false, message: bad } : { ok: true, kind, key, data };
}
