'use client';
/**
 * Azure Well-Architected review sheet: Microsoft's design review checklists (59 recommendations), pre-filled from the design and the team's answers.
 * Shows where the design has gaps, and downloads the sheet as a Markdown file for the review meeting. Read-only: nothing is sent anywhere.
 */
import { useState } from 'react';
import clsx from 'clsx';
import { ClipboardCheck, Loader2 } from 'lucide-react';
import { apiWellArchitectedService, type AzureReviewData } from '@/lib/services/ApiWellArchitectedService';

interface Props { isLight: boolean; disabledReason?: string }

const STATE: Record<string, { label: string; light: string; dark: string }> = {
  gap: { label: 'Gap', light: 'text-rose-700 bg-rose-50 border-rose-200', dark: 'text-rose-300 bg-rose-500/10 border-rose-500/30' },
  met: { label: 'Met', light: 'text-emerald-700 bg-emerald-50 border-emerald-200', dark: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  answer_needed: { label: 'Answer needed', light: 'text-amber-700 bg-amber-50 border-amber-200', dark: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  not_assessed: { label: 'For the team', light: 'text-slate-600 bg-slate-50 border-slate-200', dark: 'text-slate-300 bg-slate-500/10 border-slate-500/30' },
};

export default function WaAzureReview({ isLight, disabledReason }: Props) {
  const [data, setData] = useState<AzureReviewData | null>(null);
  const [busy, setBusy] = useState<'show' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  async function show() {
    setError(null); setBusy('show');
    try { setData(await apiWellArchitectedService.getAzureReview()); } catch (e) { setError(e instanceof Error ? e.message : 'The review sheet could not be made.'); } finally { setBusy(null); }
  }
  async function download() {
    setError(null); setBusy('download');
    try {
      const { blob, filename } = await apiWellArchitectedService.downloadAzureReview();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : 'The review sheet could not be downloaded.'); } finally { setBusy(null); }
  }

  const card = clsx('rounded-2xl border p-5', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/60 border-slate-800');
  const muted = isLight ? 'text-slate-500' : 'text-slate-400';
  const btn = clsx('px-3 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-50', isLight ? 'bg-cyan-600 border-cyan-600 text-white' : 'bg-cyan-500/20 border-cyan-400 text-cyan-200');
  const title = <div className="flex items-center gap-2"><ClipboardCheck className="w-4 h-4 text-cyan-500" /><h2 className={clsx('text-base font-bold', isLight ? 'text-slate-900' : 'text-white')}>Azure Well-Architected review sheet</h2></div>;
  if (disabledReason) return <div className={card}>{title}<p className={clsx('text-xs mt-2', muted)}>{disabledReason}</p></div>;

  const rows = data ? data.rows.filter((r) => showAll || r.state === 'gap') : [];
  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {title}
        <div className="flex gap-2">
          <button type="button" onClick={() => void show()} disabled={busy !== null} className={btn}>
            {busy === 'show' ? <span className="flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Reading…</span> : data ? 'Refresh' : 'Show the sheet'}
          </button>
          <button type="button" onClick={() => void download()} disabled={busy !== null} className={btn}>
            {busy === 'download' ? <span className="flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Preparing…</span> : 'Download (.md)'}
          </button>
        </div>
      </div>
      <p className={clsx('text-[11px] mt-2', muted)}>
        Microsoft&apos;s design review checklists for the five pillars (59 recommendations), pre-filled from your design and your answers. It is a starting point for a review meeting, not a Microsoft
        review or a certification. Recommendations about people and process are left for your team.
      </p>
      {error && <p className={clsx('text-xs mt-2', isLight ? 'text-rose-700' : 'text-rose-300')} role="alert">{error}</p>}
      {data && (
        <>
          <p className={clsx('text-xs mt-3', isLight ? 'text-slate-800' : 'text-slate-200')}>
            <b>{data.counts.gap + data.counts.met} of {data.total}</b> recommendations have evidence: {data.counts.gap} gap{data.counts.gap === 1 ? '' : 's'}, {data.counts.met} met.
            {' '}{data.counts.answer_needed} need an answer, {data.counts.not_assessed} are for your team.
          </p>
          <ul className="mt-2 space-y-1.5">
            {rows.map((r) => {
              const st = STATE[r.state] ?? STATE.not_assessed!;
              return (
                <li key={r.code} className="flex flex-wrap items-start gap-2 text-xs">
                  <span className={clsx('text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-md border', isLight ? st.light : st.dark)}>{st.label}</span>
                  <span className={clsx('font-semibold', isLight ? 'text-slate-900' : 'text-slate-100')}>{r.code}</span>
                  <span className={clsx('flex-1 min-w-[14rem]', muted)}>{r.title}{r.state === 'gap' && r.basis[0] ? ` — ${r.basis[0]}` : ''}</span>
                </li>
              );
            })}
          </ul>
          <button type="button" className={clsx('mt-2 text-[11px] underline', muted)} onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show only the gaps' : 'Show all 59'}</button>
        </>
      )}
    </div>
  );
}
