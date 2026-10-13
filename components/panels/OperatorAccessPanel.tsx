'use client';
/**
 * Operator page: which organizations asked to run Terraform on this server, the checks each one met, and approve / deny / revoke.
 * Only people named in CLOUDCRAFT_OPERATOR_EMAILS can open the data; everyone else gets a plain refusal from the server.
 */
import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { CheckCircle2, XCircle, Loader2, ShieldCheck } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import type { AccessRecord } from '@/lib/terraform/access/types';

type Entry = AccessRecord & { orgName: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? 'Could not reach the server');
  return body.data as T;
}

const BADGE: Record<string, string> = {
  requested: 'bg-amber-500/15 text-amber-600', approved: 'bg-emerald-500/15 text-emerald-600', denied: 'bg-slate-500/15 text-slate-500', revoked: 'bg-rose-500/15 text-rose-500',
};

export default function OperatorAccessPanel() {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [auto, setAuto] = useState(false);
  const [envListed, setEnvListed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<{ entries: Entry[]; autoApprove: boolean; envListed: string[] }>('/api/operator/terraform-access');
      setEntries(d.entries); setAuto(d.autoApprove); setEnvListed(d.envListed); setError(null);
    } catch (e) { setEntries([]); setError(e instanceof Error ? e.message : 'Could not load'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function decide(orgId: string, action: 'approve' | 'deny' | 'revoke') {
    setBusy(`${orgId}:${action}`);
    try { await api(`/api/operator/terraform-access/${orgId}`, { method: 'PUT', body: JSON.stringify({ action, note: notes[orgId] ?? '' }) }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save'); }
    finally { setBusy(null); }
  }

  const card = clsx('rounded-2xl border p-5', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/60 border-slate-800');
  const muted = isLight ? 'text-slate-500' : 'text-slate-400';
  const input = clsx('rounded-lg border px-3 py-1.5 text-xs', isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-slate-950 border-slate-700 text-slate-100');

  return (
    <div className={clsx('flex-1 overflow-y-auto px-4 sm:px-6 py-6 pb-36 custom-scrollbar', isLight ? 'bg-slate-50 text-slate-900' : 'bg-gray-950 text-slate-100')}>
      <div className="max-w-4xl mx-auto space-y-5">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-6 h-6 text-cyan-500" />
          <div>
            <h2 className={clsx('font-bold text-lg', isLight ? 'text-slate-900' : 'text-white')}>Deploy access</h2>
            <p className={clsx('text-sm', muted)}>Which organizations may run Terraform on this server. {auto ? 'Organizations that pass every check are approved automatically; you can still revoke any of them.' : 'Automatic approval is off: every request waits here.'}</p>
          </div>
        </div>
        {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
        {entries === null && <p className={clsx('flex items-center gap-2 text-sm', muted)}><Loader2 className="w-4 h-4 animate-spin" />Loading…</p>}
        {entries && entries.length === 0 && !error && <div className={card}><p className={clsx('text-sm', muted)}>No organization has asked yet.</p></div>}
        {entries?.map((e) => (
          <div key={e.orgId} className={card} data-testid="access-entry">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{e.orgName}</span>
              <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase', BADGE[e.status])}>{e.status}</span>
              {e.status === 'approved' && <span className={clsx('text-[11px]', muted)}>{e.source === 'auto' ? 'automatically' : `by ${e.decidedBy}`}</span>}
              {envListed.includes(e.orgId) && <span className={clsx('text-[11px]', muted)}>also on the server&apos;s list</span>}
            </div>
            <p className={clsx('text-[11px] mt-1', muted)}>{e.requestedBy ? `Asked by ${e.requestedBy}${e.requestedAt ? ` on ${e.requestedAt.slice(0, 10)}` : ''}.` : ''} {e.note ? `Note: ${e.note}` : ''}</p>
            {e.checks.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-[11px]">
                {e.checks.map((c) => (
                  <li key={c.id} className="flex gap-1.5">
                    {c.passed ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-500" /> : <XCircle className="w-3.5 h-3.5 shrink-0 text-rose-500" />}
                    <span>{c.label}: <span className={muted}>{c.detail}</span></span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input aria-label={`Note for ${e.orgName}`} placeholder="Note (shown to them)" maxLength={300} className={clsx(input, 'w-56')} value={notes[e.orgId] ?? ''} onChange={(ev) => setNotes((n) => ({ ...n, [e.orgId]: ev.target.value }))} />
              {e.status !== 'approved' && <button type="button" disabled={busy !== null} onClick={() => void decide(e.orgId, 'approve')} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 text-white disabled:opacity-50">Approve</button>}
              {e.status === 'requested' && <button type="button" disabled={busy !== null} onClick={() => void decide(e.orgId, 'deny')} className={clsx('px-3 py-1.5 rounded-lg border text-xs', isLight ? 'border-slate-300' : 'border-slate-600')}>Deny</button>}
              {e.status === 'approved' && <button type="button" disabled={busy !== null} onClick={() => void decide(e.orgId, 'revoke')} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-600 text-white disabled:opacity-50">Revoke</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
