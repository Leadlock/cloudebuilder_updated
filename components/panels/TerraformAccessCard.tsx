'use client';
/**
 * Shown on the Deploy page when Terraform is not enabled for the organization: where it stands, what would let it qualify automatically, and a
 * button to ask. Everything it says comes from /api/terraform-access, so it always matches what the server will enforce.
 */
import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { CheckCircle2, XCircle, Loader2, ShieldQuestion } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import type { EligibilityCheck } from '@/lib/terraform/access/types';

interface Summary {
  status: 'none' | 'requested' | 'approved' | 'denied' | 'revoked';
  note: string | null;
  checks: EligibilityCheck[];
  autoApprove: boolean;
  canRequest: boolean;
  mayDeploy: boolean;
  reason: string | null;
  operator: boolean;
}

async function call<T>(init?: RequestInit): Promise<T> {
  const res = await fetch('/api/terraform-access', { credentials: 'include', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? 'Could not reach the server');
  return body.data as T;
}

const HEADLINE: Record<Summary['status'], string> = {
  none: 'Terraform is not enabled for this organization yet',
  requested: 'Waiting for an operator to approve your request',
  approved: 'Terraform is enabled for this organization',
  denied: 'An operator declined this request',
  revoked: 'An operator withdrew access for this organization',
};

export default function TerraformAccessCard({ onChanged }: { onChanged?: () => void }) {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const [s, setS] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setS(await call<Summary>()); setError(null); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function ask() {
    setBusy(true);
    try { await call({ method: 'POST' }); await load(); onChanged?.(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not send the request'); }
    finally { setBusy(false); }
  }

  if (error && !s) return <p role="alert" className="text-[11px] text-rose-500">{error}</p>;
  if (!s) return <p className="flex items-center gap-1.5 text-[11px] text-slate-500"><Loader2 className="w-3 h-3 animate-spin" />Checking access…</p>;
  if (s.status === 'approved') return null;
  const muted = isLight ? 'text-slate-600' : 'text-slate-400';
  return (
    <div className={clsx('mt-2 rounded-lg border p-3 text-[11px] space-y-2', isLight ? 'bg-white border-slate-200 text-slate-800' : 'bg-slate-950/60 border-slate-700 text-slate-200')} data-testid="terraform-access-card">
      <p className="flex items-center gap-1.5 font-semibold text-xs"><ShieldQuestion className="w-4 h-4 text-amber-500" />{HEADLINE[s.status]}</p>
      {s.note && <p className={muted}>Operator&apos;s note: {s.note}</p>}
      {s.status !== 'revoked' && (
        <>
          <p className={muted}>{s.operator ? 'You run this server, so you can enable it without these. They are what any other organization needs:' : s.autoApprove ? 'This server enables Terraform automatically when all of these are in place:' : 'An operator approves each request. These show whether the organization is ready:'}</p>
          <ul className="space-y-1">
            {s.checks.map((c) => (
              <li key={c.id} className="flex gap-1.5">
                {c.passed ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-500" /> : <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-rose-500" />}
                <span><span className="font-medium">{c.label}.</span> <span className={muted}>{c.passed ? c.detail : `${c.detail} ${c.fix}`}</span></span>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p role="alert" className="text-rose-500">{error}</p>}
      {s.canRequest && s.status !== 'requested' && (
        <button type="button" disabled={busy} onClick={() => void ask()} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-50">
          {busy ? 'Sending…' : s.operator || (s.autoApprove && s.checks.every((c) => c.passed)) ? 'Enable Terraform' : 'Ask for access'}
        </button>
      )}
      {!s.canRequest && s.status === 'none' && <p className={muted}>Ask an owner or admin of the organization to request it.</p>}
    </div>
  );
}
