'use client';
import { useCallback, useEffect, useState } from 'react';
import { Timer, Lock, Loader2, ShieldOff } from 'lucide-react';
import clsx from 'clsx';
import { ApiTerraformExecutionService, type TerraformExecutionStatus } from '@/lib/services/ApiTerraformExecutionService';
import { useApp } from '@/context/AppContext';
import TerraformAccessCard from './TerraformAccessCard';

const mmss = (totalSeconds: number) => `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;

/**
 * Shows, next to the Terraform buttons, how many plans the user has left in the current window with a live countdown to
 * renewal, and whether an apply is already running for this project (only one can run at a time).
 * Looking at it never uses any of the budget.
 */
export default function TerraformLimitsBar({ projectId, environment, user, refreshKey }: {
  projectId: string;
  environment: string;
  user?: { id: string; role?: string };
  /** Changes whenever something that affects the numbers happened (a plan or apply started or finished). */
  refreshKey: string;
}) {
  const { state: appState } = useApp();
  const isLight = appState.theme === 'light';

  const [status, setStatus] = useState<TerraformExecutionStatus | null>(null);
  const [resetAt, setResetAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);

  // Primitives, not the user object: the parent may build a fresh object every render, which would refetch in a loop.
  const userId = user?.id;
  const userRole = user?.role;
  const load = useCallback(async () => {
    try {
      const s = await ApiTerraformExecutionService.getStatus(projectId, environment, userId ? { id: userId, role: userRole } : undefined);
      setStatus(s);
      setResetAt(s.plans.resetsInSeconds > 0 ? Date.now() + s.plans.resetsInSeconds * 1000 : null);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [projectId, environment, userId, userRole]);

  // Reload when a plan or apply starts / finishes, and every 20s so an apply started elsewhere shows up.
  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => { const t = setInterval(() => void load(), 20_000); return () => clearInterval(t); }, [load]);

  // One-second tick for the countdown.
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const secondsLeft = resetAt === null ? 0 : Math.max(0, Math.ceil((resetAt - now) / 1000));
  // The moment the window ends the budget is full again — refresh so the numbers are the server's, not a guess.
  useEffect(() => { if (resetAt !== null && secondsLeft === 0) void load(); }, [resetAt, secondsLeft, load]);

  if (failed && !status) return null;
  if (!status) {
    return <div className={`flex items-center gap-2 text-[11px] ${isLight ? 'text-slate-500' : 'text-gray-500'}`} data-testid="tf-limits"><Loader2 className="w-3 h-3 animate-spin" />Checking limits…</div>;
  }
  if (!status.enabled) {
    return (
      <>
      <div className={`flex items-start gap-2 text-[11px] rounded-lg px-3 py-2 border ${
        isLight ? 'text-amber-900 bg-amber-50 border-amber-200' : 'text-amber-300 bg-amber-900/20 border-amber-800/40'
      }`} data-testid="tf-limits">
        <ShieldOff className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${isLight ? 'text-amber-600' : ''}`} /><span>{status.reason ?? 'Terraform execution is not available for you.'}</span>
      </div>
      {/^Terraform execution is not enabled for this organization/.test(status.reason ?? '') && <TerraformAccessCard onChanged={() => void load()} />}
      </>
    );
  }

  const { plans } = status;
  // While the countdown is running the window is still open, so show the server's remaining; once it hits zero the budget is full.
  const remaining = resetAt !== null && secondsLeft === 0 ? plans.limit : plans.remaining;
  const out = remaining === 0;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]" data-testid="tf-limits">
      <span className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-lg border',
        out
          ? isLight ? 'text-rose-800 bg-rose-50 border-rose-200' : 'text-rose-300 bg-rose-900/20 border-rose-800/40'
          : isLight ? 'text-slate-700 bg-slate-100 border-slate-200 shadow-sm' : 'text-gray-300 bg-gray-800/60 border-gray-700'
      )} data-testid="tf-plans-left">
        <Timer className="w-3 h-3" />
        Plans left: <b className={isLight ? 'text-slate-900' : 'text-white'}>{remaining}</b> of {plans.limit}
        {secondsLeft > 0
          ? <span className={out ? (isLight ? 'text-rose-700 font-medium' : 'text-rose-300') : (isLight ? 'text-slate-500' : 'text-gray-400')}> · {out ? 'next plan in' : 'renews in'} <span className="font-mono" data-testid="tf-countdown">{mmss(secondsLeft)}</span></span>
          : <span className={isLight ? 'text-slate-500' : 'text-gray-500'}> · every {plans.windowMinutes} min</span>}
      </span>
      {status.applyRunning && (
        <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border ${
          isLight ? 'text-amber-900 bg-amber-50 border-amber-200' : 'text-amber-300 bg-amber-900/20 border-amber-800/40'
        }`} data-testid="tf-apply-running">
          <Lock className={`w-3 h-3 ${isLight ? 'text-amber-600' : ''}`} />An apply is already running for this project — a new one can start when it finishes.
        </span>
      )}
    </div>
  );
}
