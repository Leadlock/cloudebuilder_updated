'use client';
/**
 * What the team records for the SOC 2 report beyond control answers: significant changes, prior-period findings, walkthroughs, complementary controls, provider
 * reviews, limitation owners and remediation plans, plus the engagement settings. Every form is drawn from the same field list the server checks (lib/compliance/entries).
 * What is entered here is the team's own statement: the report shows it as recorded, never as verified, and it never changes a score.
 */
import { useMemo, useState } from 'react';
import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { apiReadinessService, type ReadinessView } from '@/lib/services/ApiReadinessService';
import { ENTRY_META, type Entry, type EntryKind, type FieldMeta } from '@/lib/compliance/entries';
import { CSOC_SEEDS, CUEC_SEEDS } from '@/lib/compliance/seeds';
import { theme } from './ui';

interface Props { view: ReadinessView; projectId: string; isLight: boolean; onChanged: () => Promise<void> }

type Section = { id: string; label: string; kinds: EntryKind[] };
const SECTIONS: Section[] = [
  { id: 'engagement', label: 'Engagement', kinds: [] },
  { id: 'changes', label: 'Changes', kinds: ['change'] },
  { id: 'prior', label: 'Prior findings', kinds: ['prior_finding'] },
  { id: 'walkthroughs', label: 'Walkthroughs', kinds: ['walkthrough'] },
  { id: 'complementary', label: 'Complementary controls', kinds: ['cuec', 'csoc'] },
  { id: 'providers', label: 'Providers', kinds: ['provider_review', 'review_conclusion'] },
  { id: 'limitations', label: 'Limitations', kinds: ['limitation_note'] },
  { id: 'plans', label: 'Remediation plans', kinds: ['finding_plan'] },
];

function listFor(view: ReadinessView, kind: EntryKind): Entry[] {
  const t = view.report.team;
  switch (kind) {
    case 'change': return t.changes; case 'prior_finding': return t.priorFindings;
    case 'walkthrough': return Object.values(t.walkthroughs); case 'cuec': return Object.values(t.cuecs); case 'csoc': return Object.values(t.csocs);
    case 'provider_review': return Object.values(t.providers); case 'review_conclusion': return t.conclusion ? [t.conclusion] : [];
    case 'limitation_note': return Object.values(t.limitationNotes); case 'finding_plan': return Object.values(t.findingPlans);
  }
}

/** The subjects a keyed record can be about, offered as choices (the report only draws what it knows about). */
function keyChoices(view: ReadinessView, kind: EntryKind): Array<{ value: string; label: string }> | null {
  const r = view.report;
  if (kind === 'walkthrough') return r.defs.map((d) => ({ value: d.id, label: `${d.id} ${d.title}` }));
  if (kind === 'finding_plan') return r.findings.map((f) => ({ value: f.controlId, label: `${f.controlId} ${f.title}` }));
  if (kind === 'limitation_note') return r.limitations.map((l) => ({ value: l.id, label: `${l.id} ${l.item}`.slice(0, 110) }));
  if (kind === 'cuec') return CUEC_SEEDS.map(([s], i) => ({ value: `CUEC-${i + 1}`, label: `CUEC-${i + 1} ${s}`.slice(0, 110) }));
  if (kind === 'csoc') {
    const provs = r.system.providers.map((x) => (x === 'aws' ? 'Amazon Web Services' : 'Microsoft Azure'));
    return provs.flatMap((p, i) => CSOC_SEEDS.map(([s], k) => ({ value: `CSOC-${i + 1}.${k + 1}`, label: `CSOC-${i + 1}.${k + 1} ${p}: ${s}`.slice(0, 110) })));
  }
  if (kind === 'provider_review') {
    const provs = r.system.providers.map((x) => (x === 'aws' ? 'Amazon Web Services' : 'Microsoft Azure'));
    return [...provs, ...r.system.thirdParties.map((x) => x.vendor)].map((n) => ({ value: n, label: n }));
  }
  return null;
}

function Field({ f, value, onChange, isLight }: { f: FieldMeta; value: string; onChange: (v: string) => void; isLight: boolean }) {
  const t = theme(isLight);
  const label = <span className={t.label}>{f.label}{f.required ? ' *' : ''}{f.help ? ` (${f.help})` : ''}</span>;
  if (f.type === 'textarea') return <label className="sm:col-span-2">{label}<textarea className={t.input} rows={2} maxLength={f.max} value={value} onChange={(e) => onChange(e.target.value)} /></label>;
  if (f.type === 'select') return <label>{label}<select className={t.input} value={value} onChange={(e) => onChange(e.target.value)}><option value="">Choose…</option>{f.options?.map((o) => <option key={o} value={o}>{o}</option>)}</select></label>;
  return <label>{label}<input type={f.type === 'date' ? 'date' : 'text'} className={t.input} maxLength={f.max} value={value} max={f.type === 'date' ? new Date().toISOString().slice(0, 10) : undefined} onChange={(e) => onChange(e.target.value)} /></label>;
}

function Records({ kind, view, projectId, isLight, onChanged, prefill }: Props & { kind: EntryKind; prefill?: Record<string, string> }) {
  const t = theme(isLight);
  const meta = ENTRY_META[kind];
  const choices = keyChoices(view, kind);
  const existing = listFor(view, kind);
  const [data, setData] = useState<Record<string, string>>(prefill ?? {});
  const [key, setKey] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyed = meta.keyed && kind !== 'review_conclusion';

  function load(e: Entry) { setEditing(e.id); setKey(e.key ?? ''); setData({ ...e.data }); setError(null); }
  function reset() { setEditing(null); setKey(''); setData({}); setError(null); }
  async function save() {
    setBusy(true); setError(null);
    try {
      if (editing) await apiReadinessService.updateEntry(projectId, editing, data);
      else await apiReadinessService.saveEntry(projectId, { kind, ...(meta.keyed ? { key: kind === 'review_conclusion' ? 'main' : key } : {}), data });
      reset(); await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (!window.confirm('Remove this record?')) return;
    setBusy(true); setError(null);
    try { await apiReadinessService.removeEntry(projectId, id); if (editing === id) reset(); await onChanged(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not remove.'); } finally { setBusy(false); }
  }
  const summary = (e: Entry) => Object.entries(e.data).filter(([, v]) => v).slice(0, 3).map(([k, v]) => `${meta.fields.find((f) => f.key === k)?.label ?? k}: ${v}`).join(' · ').slice(0, 220);

  return (
    <section className={t.inner}>
      <h3 className="text-xs font-bold">{meta.title}</h3>
      <p className={`text-[11px] mb-2 ${t.muted}`}>{meta.blurb}</p>
      <div className="grid sm:grid-cols-2 gap-2">
        {keyed && (
          <label className="sm:col-span-2"><span className={t.label}>{meta.keyLabel ?? 'Subject'} *</span>
            {choices ? (
              <select className={t.input} value={key} disabled={!!editing} onChange={(e) => setKey(e.target.value)}><option value="">Choose…</option>{choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
            ) : <input className={t.input} value={key} disabled={!!editing} maxLength={40} onChange={(e) => setKey(e.target.value)} />}
          </label>
        )}
        {meta.fields.map((f) => <Field key={f.key} f={f} value={data[f.key] ?? ''} onChange={(v) => setData({ ...data, [f.key]: v })} isLight={isLight} />)}
      </div>
      <div className="flex flex-wrap gap-2 mt-2">
        <button type="button" className={t.btn} disabled={busy || (keyed && !key)} onClick={() => void save()}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : editing ? 'Save changes' : 'Save record'}</button>
        {(editing || Object.keys(data).length > 0) && <button type="button" className={t.btnQuiet} disabled={busy} onClick={reset}>Clear</button>}
      </div>
      {error && <p className={`text-xs mt-2 ${t.error}`} role="alert">{error}</p>}
      <ul className="mt-3 space-y-1.5">
        {existing.length === 0 && <li className={`text-xs ${t.muted}`}>Nothing recorded yet.</li>}
        {existing.map((e) => (
          <li key={e.id} className="flex items-start gap-2 text-xs">
            <span className="flex-1 min-w-0"><b>{e.key ?? ''}</b> {summary(e)}<span className={`block text-[11px] ${t.muted}`}>{e.updatedBy} · {e.updatedAt.slice(0, 10)}</span></span>
            <button type="button" className={t.btnQuiet} disabled={busy} onClick={() => load(e)} aria-label="Edit"><Pencil className="w-3.5 h-3.5" /></button>
            <button type="button" className={t.btnQuiet} disabled={busy} onClick={() => void remove(e.id)} aria-label="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EngagementForm({ view, projectId, isLight, onChanged }: Props) {
  const t = theme(isLight);
  const cur = view.report.team.engagement;
  const [v, setV] = useState({ cpaFirm: cur.cpaFirm, scanProvider: cur.scanProvider, scanFrequency: cur.scanFrequency, assessmentDate: cur.assessmentDate ?? '' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true); setError(null);
    try { await apiReadinessService.saveEngagement(projectId, { ...v, assessmentDate: v.assessmentDate || undefined }); await onChanged(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  }
  return (
    <section className={t.inner}>
      <h3 className="text-xs font-bold">Engagement settings</h3>
      <p className={`text-[11px] mb-2 ${t.muted}`}>Facts that several parts of the report share: the CPA firm (named in the letters), the vulnerability scan and penetration-test provider and how often (so every mention agrees), and the date the report is about. Leave the date empty to use the day the report is made.{view.canAdminister ? '' : ' Only an owner or admin of the organization can change these.'}</p>
      <div className="grid sm:grid-cols-2 gap-2">
        <label><span className={t.label}>CPA firm</span><input className={t.input} maxLength={120} disabled={!view.canAdminister} value={v.cpaFirm} onChange={(e) => setV({ ...v, cpaFirm: e.target.value })} /></label>
        <label><span className={t.label}>Assessment date</span><input type="date" className={t.input} disabled={!view.canAdminister} max={new Date().toISOString().slice(0, 10)} value={v.assessmentDate} onChange={(e) => setV({ ...v, assessmentDate: e.target.value })} /></label>
        <label><span className={t.label}>Scan and penetration-test provider</span><input className={t.input} maxLength={120} disabled={!view.canAdminister} value={v.scanProvider} onChange={(e) => setV({ ...v, scanProvider: e.target.value })} /></label>
        <label><span className={t.label}>How often</span><input className={t.input} maxLength={60} disabled={!view.canAdminister} value={v.scanFrequency} onChange={(e) => setV({ ...v, scanFrequency: e.target.value })} placeholder="For example annually" /></label>
      </div>
      {view.canAdminister && <button type="button" className={`${t.btn} mt-2`} disabled={busy} onClick={() => void save()}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save settings'}</button>}
      {error && <p className={`text-xs mt-2 ${t.error}`} role="alert">{error}</p>}
    </section>
  );
}

export default function TeamRecords(props: Props) {
  const t = theme(props.isLight);
  const [section, setSection] = useState('engagement');
  const [adopt, setAdopt] = useState<Record<string, string> | null>(null);
  const sec = SECTIONS.find((s) => s.id === section)!;
  const suggestions = useMemo(() => props.view.report.architectureHistory.filter((h) => !props.view.report.team.changes.some((c) => c.data['date'] === h.date && (c.data['change'] ?? '').includes(h.label))), [props.view]);
  return (
    <div className="space-y-4">
      <p className={`text-xs ${t.muted}`}>These are the team&apos;s own statements. They appear in the report as recorded, not verified, and they never change a score. Saving anything clears the sign-offs on the report.</p>
      <div className="flex flex-wrap gap-2">{SECTIONS.map((s) => <button key={s.id} type="button" onClick={() => { setSection(s.id); setAdopt(null); }} className={section === s.id ? t.btn : t.btnQuiet}>{s.label}</button>)}</div>
      {section === 'engagement' && <EngagementForm {...props} />}
      {section === 'changes' && suggestions.length > 0 && (
        <section className={t.inner}>
          <h3 className="text-xs font-bold">From the architecture history (not yet reviewed)</h3>
          <p className={`text-[11px] mb-2 ${t.muted}`}>Saved versions in the year before the assessment date. They appear in the report as not reviewed. Press Review to turn one into a record you confirm.</p>
          <ul className="space-y-1">{suggestions.slice(0, 8).map((h) => <li key={h.date + h.label} className="flex items-start gap-2 text-xs"><span className="flex-1">{h.date} · {h.label}{h.summary ? `: ${h.summary}` : ''} <span className={t.muted}>({h.author})</span></span><button type="button" className={t.btnQuiet} onClick={() => setAdopt({ date: h.date, change: `${h.label}${h.summary ? `: ${h.summary}` : ''}` })}>Review</button></li>)}</ul>
        </section>
      )}
      {sec.kinds.map((k) => <Records key={`${k}-${adopt ? JSON.stringify(adopt) : ''}`} {...props} kind={k} prefill={k === 'change' && adopt ? adopt : undefined} />)}
    </div>
  );
}
