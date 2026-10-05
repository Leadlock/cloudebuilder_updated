'use client';
/**
 * Approval for ONE plan or teardown, shown where the Apply / Destroy button is. A plan only runs once an owner/admin has
 * approved exactly this plan (the server enforces it; this shows where things stand and lets people act):
 *   no request yet  → "Request approval"
 *   pending         → another admin approves/rejects (or, where self-approval is allowed, you can)
 *   approved        → the button is enabled
 *   rejected / expired → request again
 * It reports whether the plan may run through `onReady`.
 *
 * Also exports TerraformApprovalInbox: requests from OTHER people waiting for your decision, shown above the plan section so an
 * approver does not need the same plan on screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert, ShieldX, Loader2, Clock, UserCheck } from 'lucide-react';
import { ApiTerraformExecutionService, type TerraformApproval, type TerraformApprovals } from '@/lib/services/ApiTerraformExecutionService';

type User = { id: string; role?: string };

function useApprovals(projectId: string, user: User | undefined, pollMs: number, active = true) {
  const [info, setInfo] = useState<TerraformApprovals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setInfo(await ApiTerraformExecutionService.listApprovals(projectId, user)); setError(null); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load approvals'); }
  }, [projectId, user?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!active) return;
    void reload();
    const t = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState === 'visible') void reload(); }, pollMs);
    return () => clearInterval(t);
  }, [reload, pollMs, active]);
  return { info, error, reload };
}

function ActionButton({ onClick, children, busy, tone = 'gray' }: { onClick: () => void; children: React.ReactNode; busy: boolean; tone?: 'green' | 'red' | 'gray' | 'amber' }) {
  const style = tone === 'green' ? 'bg-emerald-600 hover:bg-emerald-500 text-white font-semibold'
    : tone === 'red' ? 'bg-rose-900/60 hover:bg-rose-800 border border-rose-700/60 text-rose-200 font-semibold'
      : tone === 'amber' ? 'bg-amber-600 hover:bg-amber-500 text-white font-semibold'
        : 'bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 font-medium';
  return <button type="button" onClick={onClick} disabled={busy} className={`px-3 py-1 rounded-lg text-[11px] disabled:opacity-60 ${style}`}>{busy ? <Loader2 className="w-3 h-3 animate-spin inline" /> : children}</button>;
}

const minutesLeft = (iso: string) => Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
const who = (id: string, you?: string) => (id === you ? 'you' : 'another admin');

export default function TerraformApprovalBar({ projectId, action, planId, planHash, user, onReady }: {
  projectId: string; action: 'apply' | 'destroy'; planId: string; planHash: string; user?: User; onReady: (ready: boolean) => void;
}) {
  const [stopPolling, setStopPolling] = useState(false);
  const { info, error, reload } = useApprovals(projectId, user, 6_000, !stopPolling);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [password, setPassword] = useState('');

  const forPlan = (info?.approvals ?? []).filter((a) => a.action === action && a.planId === planId && a.planHash === planHash);
  const current: TerraformApproval | undefined = forPlan.find((a) => a.status === 'approved') ?? forPlan.find((a) => a.status === 'pending') ?? forPlan[0];
  const ready = info?.mode === 'off' || current?.status === 'approved';

  useEffect(() => { onReady(!!ready); }, [ready]);                       // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onReady(false), []);                             // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setStopPolling(current?.status === 'approved'); }, [current?.status]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setActionError(null);
    try { await fn(); await reload(); } catch (e) { setActionError(e instanceof Error ? e.message : 'That did not work'); } finally { setBusy(false); }
  }
  const request = () => run(() => ApiTerraformExecutionService.requestApproval(projectId, action, planId, planHash, user));
  // The password goes to the server once and is cleared from the page whether or not it was right.
  const confirmPassword = () => { const typed = password; setPassword(''); return run(() => ApiTerraformExecutionService.confirmWithPassword(projectId, action, planId, planHash, typed, user)); };
  const decide = (decision: 'approve' | 'reject') => run(() => ApiTerraformExecutionService.decideApproval(projectId, current!.id, decision, user));

  if (!info) return error ? <p className="text-[11px] text-amber-400">Could not check approval: {error}</p> : null;
  if (info.mode === 'off') return null;

  const noun = action === 'destroy' ? 'teardown' : 'plan';
  const mine = current?.requestedBy === info.you;
  const canApprove = !!current && current.status === 'pending' && (info.mode === 'self-ok' || !mine);
  let box: React.ReactNode;
  if (info.mode === 'password' && current?.status !== 'approved') {
    box = (
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (password) void confirmPassword(); }}>
        <div className="flex items-start gap-2 text-amber-300"><ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
          <span>Confirm this {noun} with your CloudCraft password before it runs.{current?.status === 'used' || current?.status === 'expired' ? ' The earlier confirmation is no longer valid.' : ''}</span></div>
        <div className="flex gap-2">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" autoComplete="current-password" aria-label="Your CloudCraft password"
            className="flex-1 min-w-0 bg-gray-800 border border-gray-600 rounded-lg px-3 py-1.5 text-white text-xs placeholder-gray-500 focus:outline-none focus:border-amber-500" />
          <button type="submit" disabled={busy || !password} className="px-3 py-1 rounded-lg text-[11px] disabled:opacity-60 bg-amber-600 hover:bg-amber-500 text-white font-semibold">{busy ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Confirm'}</button>
        </div>
      </form>
    );
  } else if (current?.status === 'approved') {
    box = (<div className="flex items-center gap-2 text-emerald-300"><ShieldCheck className="w-4 h-4 shrink-0 text-emerald-400" />
      <span>{info.mode === 'password' ? 'Confirmed with your password.' : `Approved by ${who(current.decidedBy ?? '', info.you)}.`} You can run this {noun} now — this is good for about {minutesLeft(current.expiresAt)} more minute(s) and works once.</span></div>);
  } else if (current?.status === 'pending') {
    box = (
      <div className="space-y-2">
        <div className="flex items-start gap-2 text-amber-300"><Clock className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
          <span>{canApprove ? `Waiting for a decision (requested by ${who(current.requestedBy, info.you)}).` : 'Waiting for another owner or admin to approve this. You cannot approve your own request.'}{current.summary ? ` — ${current.summary}` : ''}</span></div>
        <div className="flex gap-2">
          {canApprove && <ActionButton busy={busy} tone="green" onClick={() => decide('approve')}>Approve</ActionButton>}
          {canApprove && <ActionButton busy={busy} tone="red" onClick={() => decide('reject')}>Reject</ActionButton>}
          {!canApprove && mine && <ActionButton busy={busy} onClick={() => decide('reject')}>Withdraw request</ActionButton>}
        </div>
      </div>
    );
  } else {
    const label = current?.status === 'rejected' ? `The approval for this ${noun} was rejected${current.comment ? `: ${current.comment}` : '.'}`
      : current?.status === 'expired' ? 'The earlier approval expired.' : current?.status === 'used' ? 'The earlier approval was already used.' : `This ${noun} has to be approved before it can run.`;
    box = (
      <div className="space-y-2">
        <div className="flex items-start gap-2 text-amber-300">{current?.status === 'rejected' ? <ShieldX className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" /> : <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />}
          <span>{label}{info.mode === 'required' ? ' Another owner or admin will have to approve it.' : ''}</span></div>
        <ActionButton busy={busy} tone="amber" onClick={request}>{current ? 'Request approval again' : 'Request approval'}</ActionButton>
      </div>
    );
  }

  return (
    <div className="p-3 rounded-lg bg-gray-900/70 border border-gray-700/70 text-xs" data-testid="terraform-approval-bar">
      {box}
      {(actionError || error) && <p className="text-rose-400 text-[11px] mt-2">{actionError ?? error}</p>}
    </div>
  );
}

/** Requests from other people that are waiting for your decision. Renders nothing when there are none. */
export function TerraformApprovalInbox({ projectId, user }: { projectId: string; user?: User }) {
  const { info, reload } = useApprovals(projectId, user, 15_000);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waiting = (info?.approvals ?? []).filter((a) => a.status === 'pending' && a.requestedBy !== info?.you);
  if (!info || info.mode === 'off' || waiting.length === 0) return null;

  async function decide(a: TerraformApproval, decision: 'approve' | 'reject') {
    setBusyId(a.id); setError(null);
    try { await ApiTerraformExecutionService.decideApproval(projectId, a.id, decision, user); await reload(); } catch (e) { setError(e instanceof Error ? e.message : 'That did not work'); } finally { setBusyId(null); }
  }
  return (
    <div className="p-3 rounded-lg bg-indigo-950/40 border border-indigo-500/40 text-xs space-y-2" data-testid="terraform-approval-inbox">
      <p className="flex items-center gap-1.5 font-semibold text-indigo-200"><UserCheck className="w-4 h-4" /> Waiting for your approval</p>
      {waiting.map((a) => (
        <div key={a.id} className="flex items-center justify-between gap-3 bg-black/20 rounded-md px-2.5 py-2">
          <div className="min-w-0">
            <p className="text-gray-200"><span className="font-semibold">{a.action === 'destroy' ? 'Teardown' : 'Apply'}</span>{a.summary ? ` — ${a.summary}` : ''}</p>
            <p className="text-[11px] text-gray-500">Requested by another admin · plan {a.planHash.slice(0, 8)} · {minutesLeft(a.expiresAt)} min left</p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button type="button" disabled={busyId === a.id} onClick={() => decide(a, 'approve')} className="px-3 py-1 rounded-lg text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white">Approve</button>
            <button type="button" disabled={busyId === a.id} onClick={() => decide(a, 'reject')} className="px-3 py-1 rounded-lg text-[11px] font-semibold bg-rose-900/60 hover:bg-rose-800 border border-rose-700/60 disabled:opacity-60 text-rose-200">Reject</button>
          </div>
        </div>
      ))}
      {error && <p className="text-rose-400 text-[11px]">{error}</p>}
    </div>
  );
}
