'use client';
/**
 * Account checks: reads CloudTrail, GuardDuty, root-account MFA and AWS Config from a connected AWS account (read-only), so the
 * review can say whether those controls are on. Each reading is dated and counts for a week. A control that cannot be read is shown
 * as unavailable, with the permission to add, and is never counted as a pass.
 */
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Loader2, ShieldCheck } from 'lucide-react';
import { apiWellArchitectedService, type AccountControlsData } from '@/lib/services/ApiWellArchitectedService';

interface Props {
  isLight: boolean;
  /** Called after a check completes so the review can be re-run with the new readings. */
  onChecked: () => void;
  disabledReason?: string;
}

interface Account { id: string; name: string; provider: string; identity?: { authMethod?: string } }

const CONTROL_LABEL: Record<string, string> = {
  'AWS-ACCT-001': 'CloudTrail',
  'AWS-ACCT-002': 'GuardDuty',
  'AWS-ACCT-003': 'Root account MFA',
  'AWS-ACCT-004': 'AWS Config',
};

const STATUS_STYLE: Record<string, { label: string; light: string; dark: string }> = {
  PASS: { label: 'Pass', light: 'text-emerald-700 bg-emerald-50 border-emerald-200', dark: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  WARNING: { label: 'Warning', light: 'text-amber-700 bg-amber-50 border-amber-200', dark: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  FAIL: { label: 'Fail', light: 'text-rose-700 bg-rose-50 border-rose-200', dark: 'text-rose-300 bg-rose-500/10 border-rose-500/30' },
  UNAVAILABLE: { label: 'Unavailable', light: 'text-slate-600 bg-slate-50 border-slate-200', dark: 'text-slate-300 bg-slate-500/10 border-slate-500/30' },
};

export default function WaAccountChecks({ isLight, onChecked, disabledReason }: Props) {
  const [data, setData] = useState<AccountControlsData | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (disabledReason) return;
    void apiWellArchitectedService.getAccountControls().then((d) => { if (alive) setData(d); });
    void fetch('/api/cloud-accounts?provider=aws', { credentials: 'include' })
      .then((r) => r.json())
      .then((j: { ok?: boolean; data?: Account[] }) => {
        if (!alive || !j?.ok) return;
        const list = (j.data ?? []).filter((a) => a.provider === 'aws');
        setAccounts(list);
        setAccountId((prev) => prev || list[0]?.id || '');
      })
      .catch(() => { /* the card says there is no account to check */ });
    return () => { alive = false; };
  }, [disabledReason]);

  async function check() {
    setError(null);
    setBusy(true);
    try {
      setData(await apiWellArchitectedService.checkAccountControls(accountId));
      onChecked();
    } catch (e) {
      setError(e instanceof Error ? `The account could not be checked: ${e.message}` : 'The account could not be checked.');
    } finally {
      setBusy(false);
    }
  }

  const card = clsx('rounded-2xl border p-5', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/60 border-slate-800');
  const muted = isLight ? 'text-slate-500' : 'text-slate-400';
  const title = (
    <div className="flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-cyan-500" /><h2 className={clsx('text-base font-bold', isLight ? 'text-slate-900' : 'text-white')}>Account checks</h2></div>
  );

  if (disabledReason) return <div className={card}>{title}<p className={clsx('text-xs mt-2', muted)}>{disabledReason}</p></div>;

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {title}
        <div className="flex items-center gap-2">
          {accounts.length > 1 && (
            <select aria-label="AWS account to check" value={accountId} onChange={(e) => setAccountId(e.target.value)}
              className={clsx('text-xs rounded-lg border px-2 py-1.5', isLight ? 'bg-white border-slate-300 text-slate-800' : 'bg-slate-950 border-slate-700 text-slate-200')}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          <button type="button" onClick={() => void check()} disabled={busy || !accountId}
            className={clsx('px-3 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-50', isLight ? 'bg-cyan-600 border-cyan-600 text-white' : 'bg-cyan-500/20 border-cyan-400 text-cyan-200')}>
            {busy ? <span className="flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Checking…</span> : data && data.controls.length > 0 ? 'Check again' : 'Check account'}
          </button>
        </div>
      </div>
      <p className={clsx('text-[11px] mt-2', muted)}>
        Reads whether CloudTrail, GuardDuty, root-account MFA and AWS Config are on in your connected AWS account, using read-only calls. Each result is dated and counts for 7 days. Anything that cannot be read stays &quot;not evaluated&quot;; it is never counted as a pass.
        {accounts.length === 0 && ' Connect an AWS account first to run this check.'}
      </p>
      {error && <p className={clsx('text-xs mt-2', isLight ? 'text-rose-700' : 'text-rose-300')} role="alert">{error}</p>}
      {data && data.controls.length > 0 && (
        <ul className="mt-3 space-y-2">
          {data.controls.map((c) => {
            const st = STATUS_STYLE[c.status] ?? STATUS_STYLE.UNAVAILABLE!;
            return (
              <li key={c.controlId} className="flex flex-wrap items-start gap-2 text-xs">
                <span className={clsx('text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-md border', isLight ? st.light : st.dark)}>{st.label}</span>
                <span className={clsx('font-semibold', isLight ? 'text-slate-900' : 'text-slate-100')}>{CONTROL_LABEL[c.controlId] ?? c.controlId}</span>
                <span className={clsx('flex-1 min-w-[14rem]', muted)}>{c.observation} <span className="opacity-70">(checked {new Date(c.observedAt).toLocaleDateString()}{c.accountLabel ? `, ${c.accountLabel}` : ''})</span></span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
