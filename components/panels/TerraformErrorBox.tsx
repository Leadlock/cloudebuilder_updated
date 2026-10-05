'use client';
import { useMemo, useState } from 'react';
import { XCircle, Loader2, Lock, CheckCircle2 } from 'lucide-react';
import { explainTerraformError } from '@/lib/terraform/execution/errorHints';
import { ApiTerraformExecutionService, type TerraformLockInspection } from '@/lib/services/ApiTerraformExecutionService';
import type { TerraformStateBackendConfig } from '@/lib/terraform/execution/types';
import { useApp } from '@/context/AppContext';

interface LockContext {
  projectId: string;
  cloudAccountId: string;
  stateBackend: TerraformStateBackendConfig;
  user?: { id: string; role?: string };
}

/**
 * Shows a Terraform error the way a person can act on it: a short title and explanation, the next steps, and Terraform's
 * own message behind a "details" toggle (never hidden). For a state-lock error it also offers "Check lock", which asks
 * the server whether the lock is a stale leftover of this machine's own run and, only then, lets the user release it.
 */
export default function TerraformErrorBox({ message, fallbackTitle, onRetry, onDismiss, lock }: {
  message: string;
  fallbackTitle: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  lock?: LockContext;
}) {
  const { state: appState } = useApp();
  const isLight = appState.theme === 'light';

  const explained = useMemo(() => explainTerraformError(message), [message]);
  const [checking, setChecking] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [inspection, setInspection] = useState<TerraformLockInspection | null>(null);
  const [released, setReleased] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);

  async function checkLock() {
    if (!lock) return;
    setChecking(true); setLockError(null); setInspection(null); setConfirmRelease(false);
    try { setInspection(await ApiTerraformExecutionService.inspectLock(lock.projectId, lock.cloudAccountId, lock.stateBackend, lock.user)); }
    catch (err) { setLockError(err instanceof Error ? err.message : 'Could not check the lock'); }
    finally { setChecking(false); }
  }

  async function releaseLock() {
    if (!lock || !inspection?.lock) return;
    setReleasing(true); setLockError(null);
    try {
      await ApiTerraformExecutionService.releaseLock(lock.projectId, lock.cloudAccountId, lock.stateBackend, inspection.lock.id, lock.user);
      setReleased(true); setInspection(null); setConfirmRelease(false);
    } catch (err) { setLockError(err instanceof Error ? err.message : 'Could not release the lock'); }
    finally { setReleasing(false); }
  }

  return (
    <div className={`p-3.5 rounded-xl border text-xs shadow-lg space-y-2.5 ${
      isLight ? 'bg-rose-50 border-rose-200 text-rose-950' : 'bg-rose-950/60 border-rose-500/50 text-rose-300'
    }`} role="alert" data-testid="tf-error-box" data-kind={explained?.kind ?? 'unknown'}>
      <div className="flex items-center gap-2 font-semibold">
        <XCircle className={`w-4 h-4 shrink-0 ${isLight ? 'text-rose-600' : 'text-rose-400'}`} />
        <span className={isLight ? 'text-rose-900' : ''}>{explained?.title ?? fallbackTitle}</span>
      </div>

      {explained && (
        <div className="space-y-1.5">
          <p className={`text-[11px] leading-relaxed ${isLight ? 'text-rose-900' : 'text-rose-200/90'}`}>{explained.summary}</p>
          <ul className={`list-disc list-inside space-y-0.5 text-[11px] ${isLight ? 'text-rose-800' : 'text-rose-200/80'}`}>{explained.steps.map((s) => <li key={s}>{s}</li>)}</ul>
        </div>
      )}

      {explained?.kind === 'state-lock' && lock && (
        <div className={`rounded-lg border p-2.5 space-y-2 ${isLight ? 'bg-white border-rose-200' : 'border-rose-900/50 bg-black/30'}`} data-testid="tf-lock-panel">
          {released ? (
            <p className={`flex items-center gap-1.5 text-[11px] ${isLight ? 'text-emerald-800 font-semibold' : 'text-emerald-300'}`}><CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />Lock released. You can try again now.</p>
          ) : (
            <>
              <button onClick={checkLock} disabled={checking} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium disabled:opacity-50 ${
                isLight ? 'bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300' : 'bg-gray-800 hover:bg-gray-700 text-white'
              }`} data-testid="tf-check-lock">
                {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Lock className="w-3 h-3" />}Check lock
              </button>
              {inspection && !inspection.locked && <p className={`text-[11px] ${isLight ? 'text-emerald-800 font-semibold' : 'text-emerald-300'}`}>The state is not locked any more — try again.</p>}
              {inspection?.locked && inspection.lock && (
                <div className={`text-[11px] space-y-1.5 ${isLight ? 'text-slate-700' : 'text-gray-300'}`}>
                  <p>Held by <b className={isLight ? 'text-slate-900' : 'text-white'}>{inspection.lock.who ?? 'unknown'}</b>{inspection.lock.operation ? <> · {inspection.lock.operation}</> : null}{inspection.lock.ageMinutes !== undefined ? <> · {inspection.lock.ageMinutes} min ago</> : null}</p>
                  {inspection.releasable ? (
                    <>
                      <p className={isLight ? 'text-emerald-800' : 'text-emerald-300'}>This is a leftover from a run on this machine and nothing is running now, so it is safe to release.</p>
                      {confirmRelease ? (
                        <div className="flex items-center gap-2">
                          <button onClick={releaseLock} disabled={releasing} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-semibold disabled:opacity-50 shadow-sm" data-testid="tf-confirm-release">
                            {releasing && <Loader2 className="w-3 h-3 animate-spin" />}Yes, release this lock
                          </button>
                          <button onClick={() => setConfirmRelease(false)} className={`${isLight ? 'text-slate-600 hover:text-slate-900' : 'text-gray-400 hover:text-gray-200'} underline`}>Cancel</button>
                        </div>
                      ) : (
                        <button onClick={() => setConfirmRelease(true)} className="px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-semibold shadow-sm" data-testid="tf-release-lock">Release lock…</button>
                      )}
                    </>
                  ) : (
                    <p className={isLight ? 'text-amber-800 font-medium' : 'text-amber-300'} data-testid="tf-lock-refused">{inspection.reason ?? 'CloudCraft will not release this lock.'}</p>
                  )}
                </div>
              )}
              {lockError && <p className="text-rose-600 text-[11px]">{lockError}</p>}
            </>
          )}
        </div>
      )}

      <details className={`rounded border ${isLight ? 'bg-slate-100/80 border-slate-200' : 'bg-black/40 border-rose-900/30'}`}>
        <summary className={`cursor-pointer px-2 py-1 text-[11px] ${isLight ? 'text-rose-800 font-medium' : 'text-rose-300/90'}`}>{explained ? 'Show Terraform\'s own message' : 'Details'}</summary>
        <pre className={`text-[10px] font-mono whitespace-pre-wrap p-2 max-h-60 overflow-y-auto ${isLight ? 'text-rose-950' : 'text-rose-200/90'}`}>{message}</pre>
      </details>

      <div className="flex items-center gap-3">
        {onRetry && <button onClick={onRetry} className={`text-xs underline font-medium ${isLight ? 'text-rose-700 hover:text-rose-900' : 'text-rose-400 hover:text-rose-200'}`}>Try again</button>}
        {onDismiss && <button onClick={onDismiss} className={`text-xs underline font-medium ${isLight ? 'text-slate-600 hover:text-slate-900' : 'text-gray-400 hover:text-gray-200'}`}>Dismiss</button>}
      </div>
    </div>
  );
}
