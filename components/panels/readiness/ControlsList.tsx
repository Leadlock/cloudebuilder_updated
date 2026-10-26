'use client';
/** Every control of a framework, grouped, with what supports its score, and the owner's answer, note and review. */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { apiReadinessService, type ReadinessView, type EvidenceItem } from '@/lib/services/ApiReadinessService';
import type { ControlResult, ControlStatus, FrameworkId } from '@/lib/compliance/types';
import { pill, scoreTone, STATUS_LABEL, theme } from './ui';

interface Props { view: ReadinessView; projectId: string; framework: FrameworkId; isLight: boolean; evidence: EvidenceItem[]; onChanged: () => Promise<void>; onAttach: (controlKey: string) => void }

const BASIS: Record<string, string> = { design: 'Design check', discovered: 'Read from the account', live: 'Verified live', answer: 'Team answer', platform: 'CloudBuilder record' };

function Row({ r, view, projectId, framework, isLight, evidence, onChanged, onAttach }: Props & { r: ControlResult }) {
  const t = theme(isLight);
  const def = view.report.defs.find((d) => d.id === r.id);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ControlStatus | ''>(r.status ?? '');
  const [owner, setOwner] = useState(r.owner);
  const [note, setNote] = useState(r.note);
  const [naReason, setNaReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attached = evidence.filter((e) => e.controls.includes(`${framework}:${r.id}`));

  async function save(extra: { markReviewed?: boolean } = {}) {
    setBusy(true); setError(null);
    try {
      await apiReadinessService.saveControl(projectId, framework, r.id, { status: status === '' ? null : status, owner, note, ...(status === 'not_applicable' ? { naReason } : {}), ...extra });
      await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  }

  return (
    <li className={t.inner}>
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-start gap-2 text-left" aria-expanded={open}>
        {open ? <ChevronDown className="w-4 h-4 mt-0.5 shrink-0" /> : <ChevronRight className="w-4 h-4 mt-0.5 shrink-0" />}
        <span className="flex-1 min-w-0">
          <span className={`text-xs font-semibold ${t.strong}`}>{r.id}</span> <span className={`text-xs ${t.strong}`}>{r.title}</span>
          <span className={`block text-[11px] ${t.muted}`}>{r.owner ? `Owner: ${r.owner}` : 'No owner named'}{r.status ? ` · ${STATUS_LABEL[r.status]}` : ' · not answered yet'}</span>
        </span>
        <span className={pill(scoreTone(r.score), isLight)}>{r.score === null ? r.scoreLabel : `${r.score} ${r.scoreLabel}`}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3 pl-6">
          {def?.activity && <p className={`text-xs ${t.muted}`}>{def.activity}{def.frequency ? ` (${def.frequency})` : ''}</p>}
          <div>
            <p className={`text-[11px] font-semibold ${t.strong}`}>Why this score</p>
            <ul className={`text-xs list-disc pl-4 ${t.muted}`}>{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
            {r.signals.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {r.signals.map((s, i) => (
                  <li key={i} className="text-[11px] flex flex-wrap gap-1.5 items-start">
                    <span className={pill(s.result === 'pass' ? 'green' : s.result === 'fail' ? 'red' : 'grey', isLight)}>{s.result === 'pass' ? 'Passed' : s.result === 'fail' ? 'Failed' : 'Unclear'}</span>
                    <span className={t.muted}>{BASIS[s.basis] ?? s.basis}: {s.text}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className={`text-[11px] mt-1.5 ${t.strong}`}><b>To raise it:</b> {r.nextStep}</p>
          </div>

          <div className="grid sm:grid-cols-2 gap-2">
            <label><span className={t.label}>Is it in place?</span>
              <select className={t.input} value={status} onChange={(e) => setStatus(e.target.value as ControlStatus | '')}>
                <option value="">Not answered yet</option>
                {(Object.keys(STATUS_LABEL) as ControlStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </label>
            <label><span className={t.label}>Owner{def ? ` (${def.ownerRole})` : ''}</span>
              <input className={t.input} value={owner} maxLength={120} onChange={(e) => setOwner(e.target.value)} placeholder="Name or email" />
            </label>
            {status === 'not_applicable' && (
              <label className="sm:col-span-2"><span className={t.label}>Why it does not apply (required)</span>
                <input className={t.input} value={naReason} maxLength={1000} onChange={(e) => setNaReason(e.target.value)} placeholder="For example: the company has no office; the cloud provider holds the hardware." />
              </label>
            )}
            <label className="sm:col-span-2"><span className={t.label}>Note</span>
              <textarea className={t.input} rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>

          <div>
            <p className={`text-[11px] font-semibold ${t.strong}`}>Evidence ({attached.length})</p>
            {def && def.evidence.length > 0 && <p className={`text-[11px] ${t.muted}`}>Expected: {def.evidence.join('; ')}.</p>}
            <ul className={`text-xs ${t.muted}`}>{attached.map((e) => <li key={e.id}>{e.title} <span className="opacity-70">({e.collectedAt}{e.origin === 'system' ? ', from a system' : ''})</span></li>)}</ul>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={t.btn} disabled={busy} onClick={() => void save()}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save'}</button>
            <button type="button" className={t.btnQuiet} disabled={busy} onClick={() => onAttach(`${framework}:${r.id}`)}>Attach evidence</button>
            <button type="button" className={t.btnQuiet} disabled={busy || !r.owner} title={r.owner ? 'Record that you, as someone other than the owner, reviewed this control' : 'Name an owner first'} onClick={() => void save({ markReviewed: true })}>I reviewed this</button>
            {r.reviewer && <span className={`text-[11px] ${t.muted}`}>Reviewed by {r.reviewer}{r.reviewedAt ? ` on ${r.reviewedAt.slice(0, 10)}` : ''}</span>}
          </div>
          {error && <p className={`text-xs ${t.error}`} role="alert">{error}</p>}
        </div>
      )}
    </li>
  );
}

export default function ControlsList(props: Props) {
  const t = theme(props.isLight);
  const [filter, setFilter] = useState<'all' | 'attention' | 'unassessed'>('all');
  const groups = useMemo(() => {
    const m = new Map<string, ControlResult[]>();
    for (const r of props.view.report.results) {
      if (filter === 'attention' && !(r.score !== null && r.score < 3)) continue;
      if (filter === 'unassessed' && !(r.score === null && r.scoreLabel !== 'Not applicable')) continue;
      m.set(r.group, [...(m.get(r.group) ?? []), r]);
    }
    return [...m.entries()];
  }, [props.view, filter]);
  return (
    <div className="space-y-4">
      <div className="flex gap-2 text-xs">
        {([['all', 'All controls'], ['attention', 'Below 3 (needs work)'], ['unassessed', 'Not assessed yet']] as const).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setFilter(k)} className={filter === k ? t.btn : t.btnQuiet}>{l}</button>
        ))}
      </div>
      {groups.length === 0 && <p className={`text-xs ${t.muted}`}>Nothing matches this filter.</p>}
      {groups.map(([group, rows]) => (
        <section key={group}>
          <h3 className={`text-xs font-bold mb-1.5 ${t.strong}`}>{group}</h3>
          <ul className="space-y-1.5">{rows.map((r) => <Row key={r.id} {...props} r={r} />)}</ul>
        </section>
      ))}
    </div>
  );
}
