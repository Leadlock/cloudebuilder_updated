'use client';
/**
 * The auditor's read-only view. The link carries a token after the # (so it never reaches a server log or a Referer header); this page reads it and sends it as a
 * header. It shows the report, every control with what supports its score, the evidence linked to this framework, and the findings. Nothing here can be changed.
 */
import { useEffect, useMemo, useState } from 'react';
import { Download, FileText, Loader2, ShieldAlert } from 'lucide-react';
import type { ReadinessReport } from '@/lib/compliance/report';

interface Evidence { id: string; title: string; description: string; kind: 'file' | 'link' | 'note'; origin: string; collectedAt: string; validUntil: string | null; url: string | null; fileName: string | null; sizeBytes: number | null; sha256: string | null; controls: string[] }
interface View { report: ReadinessReport; evidence: Evidence[]; access: { name: string; expiresAt: string; framework: string } }

const TONE: Record<string, string> = { Ready: 'bg-emerald-100 text-emerald-800', 'Ready with conditions': 'bg-amber-100 text-amber-800', 'Not ready': 'bg-rose-100 text-rose-800', Incomplete: 'bg-slate-200 text-slate-700' };
const SCORE = ['bg-rose-100 text-rose-800', 'bg-orange-100 text-orange-800', 'bg-amber-100 text-amber-800', 'bg-emerald-100 text-emerald-800', 'bg-teal-100 text-teal-800'];

async function call(token: string, path: string): Promise<Response> {
  return fetch(path, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', referrerPolicy: 'no-referrer' });
}
function save(blob: Blob, name: string) { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(u); }

export default function AuditorPage() {
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const t = window.location.hash.replace(/^#/, '');
    if (!t) { setError('This page needs the link the company sent you. Open that link again.'); return; }
    setToken(t);
    void (async () => {
      try {
        const res = await call(t, '/api/auditor/view');
        const body = await res.json().catch(() => null) as { ok?: boolean; data?: View; error?: { message?: string } } | null;
        if (!res.ok || !body?.data) throw new Error(body?.error?.message ?? 'The report could not be loaded.');
        setView(body.data);
      } catch (e) { setError(e instanceof Error ? e.message : 'The report could not be loaded.'); }
    })();
  }, []);

  const byControl = useMemo(() => {
    const m = new Map<string, Evidence[]>();
    for (const e of view?.evidence ?? []) for (const c of e.controls) m.set(c, [...(m.get(c) ?? []), e]);
    return m;
  }, [view]);

  async function download(path: string, fallback: string, key: string) {
    if (!token) return;
    setBusy(key);
    try {
      const res = await call(token, path);
      if (!res.ok) throw new Error('The download failed.');
      save(await res.blob(), /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallback);
    } catch (e) { setError(e instanceof Error ? e.message : 'The download failed.'); } finally { setBusy(null); }
  }

  if (error && !view) return <main className="min-h-screen bg-slate-50 text-slate-900 grid place-items-center p-6"><div className="max-w-md text-center"><ShieldAlert className="w-8 h-8 mx-auto text-rose-600" /><p className="mt-3 text-sm" role="alert">{error}</p></div></main>;
  if (!view) return <main className="min-h-screen bg-slate-50 text-slate-900 grid place-items-center"><Loader2 className="w-6 h-6 animate-spin text-slate-500" /></main>;

  const r = view.report;
  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <header>
          <p className="text-xs uppercase tracking-widest text-teal-700 font-semibold">Read-only view for {view.access.name}</p>
          <h1 className="text-2xl font-bold text-slate-900 mt-1">{r.title}: {r.company}</h1>
          <p className="text-sm text-slate-600">{r.system.name}, control status as of {r.asOf}. Report {r.reportId}. Access ends {view.access.expiresAt.slice(0, 10)}.</p>
          <p className="text-xs text-slate-500 mt-2 max-w-3xl">This is a readiness report that the company prepared with CloudBuilder. It is not a SOC 2 report, an audit or an opinion. You cannot change anything here.</p>
        </header>

        <section className="rounded-2xl bg-white border border-slate-200 p-5 flex flex-wrap items-center gap-4">
          <span className={`px-3 py-1 rounded-lg text-sm font-semibold ${TONE[r.readiness] ?? ''}`}>{r.readiness}</span>
          <p className="text-sm text-slate-600">{r.summary.total - r.summary.notApplicable} controls in scope, {r.summary.coveragePct}% assessed, average {r.summary.average ?? 'n/a'} of 4, {r.findings.length} findings.</p>
          <button type="button" className="ml-auto px-3 py-2 rounded-lg bg-teal-700 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2" disabled={busy !== null} onClick={() => void download('/api/auditor/package', 'auditor-package.zip', 'package')}>
            {busy === 'package' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}Download the full package (.zip)
          </button>
        </section>
        {error && <p className="text-sm text-rose-700" role="alert">{error}</p>}

        <section>
          <h2 className="text-lg font-bold mb-2">Controls</h2>
          {[...new Set(r.results.map((x) => x.group))].map((g) => (
            <div key={g} className="mb-4">
              <h3 className="text-sm font-bold text-slate-700 mb-1">{g}</h3>
              <ul className="space-y-1.5">
                {r.results.filter((x) => x.group === g).map((c) => {
                  const ev = byControl.get(c.id) ?? [];
                  const isOpen = open === c.id;
                  return (
                    <li key={c.id} className="rounded-xl bg-white border border-slate-200">
                      <button type="button" className="w-full text-left p-3 flex items-start gap-3" onClick={() => setOpen(isOpen ? null : c.id)} aria-expanded={isOpen}>
                        <span className="flex-1 min-w-0"><span className="text-sm font-semibold">{c.id}</span> <span className="text-sm">{c.title}</span><span className="block text-xs text-slate-500">Owner: {c.owner || 'none named'} · {ev.length} evidence {ev.length === 1 ? 'item' : 'items'} · confidence {c.confidence}</span></span>
                        <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold whitespace-nowrap ${c.score === null ? 'bg-slate-200 text-slate-700' : SCORE[c.score]}`}>{c.score === null ? c.scoreLabel : `${c.score} ${c.scoreLabel}`}</span>
                      </button>
                      {isOpen && (
                        <div className="px-4 pb-4 text-sm space-y-2 border-t border-slate-100 pt-3">
                          <p className="text-slate-600">{r.defs.find((d) => d.id === c.id)?.activity}</p>
                          <ul className="list-disc pl-5 text-slate-600 text-xs">{c.reasons.map((x, i) => <li key={i}>{x}</li>)}{c.signals.map((s, i) => <li key={`s${i}`}>{s.result === 'pass' ? 'Passed' : s.result === 'fail' ? 'Failed' : 'Unclear'} ({s.basis}): {s.text}</li>)}</ul>
                          {c.note && <p className="text-xs text-slate-600"><b>Note:</b> {c.note}</p>}
                          {c.reviewer && <p className="text-xs text-slate-600">Reviewed by {c.reviewer}{c.reviewedAt ? ` on ${c.reviewedAt.slice(0, 10)}` : ''}</p>}
                          {ev.map((e) => (
                            <div key={e.id} className="rounded-lg bg-slate-50 border border-slate-200 p-2 text-xs">
                              <div className="flex flex-wrap items-center gap-2"><FileText className="w-3.5 h-3.5 text-slate-500" /><b>{e.title}</b><span className="text-slate-500">dated {e.collectedAt}{e.validUntil ? `, valid until ${e.validUntil}` : ''} · {e.origin === 'system' ? 'exported from a system' : 'collected by hand'}</span></div>
                              {e.description && <p className="text-slate-600 mt-1">{e.description}</p>}
                              {e.sha256 && <p className="text-slate-500 mt-1 break-all">SHA-256 {e.sha256}</p>}
                              {e.url && <a className="text-teal-700 underline break-all" href={e.url} target="_blank" rel="noopener noreferrer">{e.url}</a>}
                              {e.kind === 'file' && <button type="button" className="mt-1 px-2 py-1 rounded-md border border-slate-300 text-slate-700 bg-white" disabled={busy !== null} onClick={() => void download(`/api/auditor/evidence/${e.id}`, e.fileName ?? 'evidence', e.id)}>{busy === e.id ? 'Preparing…' : `Download ${e.fileName ?? 'file'}`}</button>}
                            </div>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>

        <section>
          <h2 className="text-lg font-bold mb-2">Findings and management&apos;s response</h2>
          {r.findings.length === 0 ? <p className="text-sm text-slate-600">No findings.</p> : (
            <ul className="space-y-2">{r.findings.map((f) => (
              <li key={f.id} className="rounded-xl bg-white border border-slate-200 p-3 text-sm">
                <p className="font-semibold">{f.id} · {f.severity} · {f.title}</p>
                <p className="text-slate-600 text-xs mt-1">{f.condition}</p>
                <p className="text-xs mt-1"><b>Status:</b> {f.status.replace('_', ' ')} · <b>Owner:</b> {f.owner || 'none'} · <b>Target:</b> {f.targetDate ?? 'none'}</p>
                <p className="text-xs mt-1"><b>Management&apos;s response:</b> {f.managementResponse || 'not yet written'}</p>
              </li>
            ))}</ul>
          )}
        </section>

        <section>
          <h2 className="text-lg font-bold mb-2">Limitations</h2>
          <ul className="text-sm text-slate-600 space-y-1">{r.limitations.map((l) => <li key={l.id}><b className="text-slate-800">{l.item}.</b> {l.effect}</li>)}</ul>
        </section>
      </div>
    </main>
  );
}
