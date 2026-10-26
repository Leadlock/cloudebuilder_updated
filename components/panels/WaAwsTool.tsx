'use client';
/**
 * AWS Well-Architected Tool: shows which Framework best practices CloudBuilder has evidence for, and (for owners and admins) sends them to a
 * workload in a connected AWS account's Well-Architected Tool. Nothing is sent until the button is pressed; practices a person already selected are
 * never removed, and practices without evidence are left for the team to answer.
 */
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { ExternalLink, Loader2, Send } from 'lucide-react';
import { apiWellArchitectedService, type ToolPreview, type ToolSyncResult } from '@/lib/services/ApiWellArchitectedService';

interface Props { isLight: boolean; defaultRegion?: string; disabledReason?: string }
interface Account { id: string; name: string; provider: string }

const STATE: Record<string, { label: string; light: string; dark: string }> = {
  met: { label: 'In place', light: 'text-emerald-700 bg-emerald-50 border-emerald-200', dark: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  not_met: { label: 'Not in place', light: 'text-rose-700 bg-rose-50 border-rose-200', dark: 'text-rose-300 bg-rose-500/10 border-rose-500/30' },
  unknown: { label: 'No evidence', light: 'text-slate-600 bg-slate-50 border-slate-200', dark: 'text-slate-300 bg-slate-500/10 border-slate-500/30' },
};

export default function WaAwsTool({ isLight, defaultRegion, disabledReason }: Props) {
  const [preview, setPreview] = useState<ToolPreview | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [region, setRegion] = useState(defaultRegion && /^[a-z]{2}(-[a-z]+)+-\d$/.test(defaultRegion) ? defaultRegion : 'us-east-1');
  const [milestone, setMilestone] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'send' | 'package' | null>(null);
  const [result, setResult] = useState<ToolSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (disabledReason) return;
    void fetch('/api/cloud-accounts?provider=aws', { credentials: 'include' })
      .then((r) => r.json())
      .then((j: { ok?: boolean; data?: Account[] }) => {
        if (!alive || !j?.ok) return;
        const list = (j.data ?? []).filter((a) => a.provider === 'aws');
        setAccounts(list);
        setAccountId((prev) => prev || list[0]?.id || '');
      })
      .catch(() => { /* the card says there is no account */ });
    return () => { alive = false; };
  }, [disabledReason]);

  async function show() {
    setError(null); setBusy('preview');
    try { setPreview(await apiWellArchitectedService.previewAwsTool()); }
    catch (e) { setError(e instanceof Error ? e.message : 'The evidence could not be read.'); }
    finally { setBusy(null); }
  }

  async function send() {
    setError(null); setBusy('send');
    try { setResult(await apiWellArchitectedService.syncAwsTool({ cloudAccountId: accountId, region, milestone })); }
    catch (e) { setError(e instanceof Error ? e.message : 'The workload could not be sent.'); }
    finally { setBusy(null); }
  }

  async function downloadPackage() {
    setError(null); setBusy('package');
    try {
      const { blob, filename } = await apiWellArchitectedService.downloadAgentPackage();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : 'The package could not be made.'); }
    finally { setBusy(null); }
  }

  const card = clsx('rounded-2xl border p-5', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/60 border-slate-800');
  const muted = isLight ? 'text-slate-500' : 'text-slate-400';
  const heading = isLight ? 'text-slate-900' : 'text-white';
  const input = clsx('text-xs rounded-lg border px-2 py-1.5', isLight ? 'bg-white border-slate-300 text-slate-800' : 'bg-slate-950 border-slate-700 text-slate-200');
  const btn = clsx('px-3 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-50', isLight ? 'bg-cyan-600 border-cyan-600 text-white' : 'bg-cyan-500/20 border-cyan-400 text-cyan-200');
  const title = <div className="flex items-center gap-2"><Send className="w-4 h-4 text-cyan-500" /><h2 className={clsx('text-base font-bold', heading)}>AWS Well-Architected Tool</h2></div>;

  if (disabledReason) return <div className={card}>{title}<p className={clsx('text-xs mt-2', muted)}>{disabledReason}</p></div>;

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {title}
        <button type="button" onClick={() => void show()} disabled={busy !== null} className={btn}>
          {busy === 'preview' ? <span className="flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Reading…</span> : preview ? 'Refresh' : 'Show what can be sent'}
        </button>
      </div>
      <p className={clsx('text-[11px] mt-2', muted)}>
        Creates a workload in the AWS Well-Architected Tool and pre-fills the Framework answers this design gives evidence for. It only adds selections: it never removes one a person made,
        and the questions about people and process stay for your team to answer. Each pre-filled answer carries a note saying it was read from the design.
      </p>
      {error && <p className={clsx('text-xs mt-2', isLight ? 'text-rose-700' : 'text-rose-300')} role="alert">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void downloadPackage()} disabled={busy !== null} className={btn}>
          {busy === 'package' ? <span className="flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Preparing…</span> : 'Download for the AWS Well-Architected Agent'}
        </button>
        <span className={clsx('text-[11px]', muted)}>The generated Terraform as a zip, to upload to the agent (in preview) yourself. Nothing is sent to AWS from here.</span>
      </div>

      {preview && (
        <>
          <ul className="mt-3 space-y-1.5">
            {preview.practices.map((p) => {
              const st = STATE[p.state] ?? STATE.unknown!;
              return (
                <li key={p.bp} className="flex flex-wrap items-start gap-2 text-xs">
                  <span className={clsx('text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-md border', isLight ? st.light : st.dark)}>{st.label}</span>
                  <span className={clsx('font-semibold', isLight ? 'text-slate-900' : 'text-slate-100')}>{p.bp}</span>
                  <span className={clsx('flex-1 min-w-[14rem]', muted)}>{p.title}{p.problems[0] ? ` — ${p.problems[0]}` : ''}</span>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {accounts.length > 0 && (
              <select aria-label="AWS account" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={input}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
            <input aria-label="Region of the Well-Architected Tool" value={region} onChange={(e) => setRegion(e.target.value.trim())} className={clsx(input, 'w-36')} placeholder="us-east-1" />
            <label className={clsx('flex items-center gap-1.5 text-xs', muted)}><input type="checkbox" checked={milestone} onChange={(e) => setMilestone(e.target.checked)} />Save a milestone</label>
            <button type="button" onClick={() => void send()} disabled={busy !== null || !accountId || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)} className={btn}>
              {busy === 'send' ? <span className="flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Sending…</span> : 'Send to AWS Well-Architected Tool'}
            </button>
          </div>
          {accounts.length === 0 && <p className={clsx('text-[11px] mt-2', muted)}>Connect an AWS account first to send this to the Tool.</p>}
        </>
      )}

      {result && (
        <div className={clsx('mt-4 rounded-xl border p-3 text-xs', isLight ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200')} role="status">
          <p className="font-semibold">{result.created ? 'Workload created' : 'Workload updated'}: {result.workloadName}</p>
          <p className="mt-1">{result.answered.length} question{result.answered.length === 1 ? '' : 's'} pre-filled, {result.notesOnly} with notes only{result.milestone ? `, milestone ${result.milestone} saved` : ''}.
            {result.unmatched.length > 0 && ` ${result.unmatched.length} best practice${result.unmatched.length === 1 ? '' : 's'} could not be matched to a question of the Tool's current Framework.`}</p>
          <a href={result.consoleUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 mt-2 underline">Open in the AWS console<ExternalLink className="w-3 h-3" /></a>
        </div>
      )}
    </div>
  );
}
