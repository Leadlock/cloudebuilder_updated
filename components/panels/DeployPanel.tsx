'use client';
import { useState, useEffect } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { Rocket, ShieldCheck, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { apiWellArchitectedService } from '@/lib/services/ApiWellArchitectedService';
import type { WaAssessment } from '@/lib/engines/wellArchitected/types';
import TerraformExecutionPanel from './TerraformExecutionPanel';

export default function DeployPanel() {
  const { state, dispatch } = useApp();
  const isLight = state.theme === 'light';
  const activeProject = useActiveProject();
  const [waAssessment, setWaAssessment] = useState<WaAssessment | null>(null);

  useEffect(() => {
    if (!activeProject) return;
    let cancelled = false;
    apiWellArchitectedService.getAssessment().then((ass) => {
      if (!cancelled && ass) {
        setWaAssessment(ass);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeProject?.id]);

  if (!activeProject) return null;

  const criticalFindings = (waAssessment?.findings || []).filter((f) => f.severity === 'critical');

  return (
    <div
      className={clsx(
        'flex-1 overflow-y-auto px-4 sm:px-6 py-6 pb-36 custom-scrollbar transition-colors',
        isLight ? 'bg-slate-50 text-slate-900' : 'bg-gray-950 text-slate-100'
      )}
    >
      <div className="max-w-4xl mx-auto space-y-5">
        {/* Header */}
        <div
          className={clsx(
            'flex items-center justify-between pb-4 border-b',
            isLight ? 'border-slate-200' : 'border-gray-800'
          )}
        >
          <div className="flex items-center gap-3">
            <div
              className={clsx(
                'p-2.5 rounded-xl border',
                isLight
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  : 'bg-emerald-950/60 border-emerald-500/30 text-emerald-400'
              )}
            >
              <Rocket className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className={clsx('font-bold text-lg', isLight ? 'text-slate-900' : 'text-white')}>
                  Infrastructure Deployment
                </h2>
                <span
                  className={clsx(
                    'text-[10px] px-2 py-0.5 rounded-full font-medium border',
                    isLight
                      ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                      : 'bg-emerald-900/40 text-emerald-300 border-emerald-800'
                  )}
                >
                  Live Engine
                </span>
              </div>
              <p className={clsx('text-xs mt-0.5', isLight ? 'text-slate-500' : 'text-gray-400')}>
                Execute production Terraform deployments with remote state locking, safety gates, and background execution.
              </p>
            </div>
          </div>
          <button
            id="btn-deploy-next-drift"
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'drift' })}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-sm transition-all active:scale-95 shrink-0"
            title="Proceed to logical next phase: Live Drift & Reconcile"
          >
            <span>Next: Drift & Reconcile →</span>
          </button>
        </div>

        {/* Well-Architected Pre-flight gate */}
        {waAssessment && (
          <div
            className={clsx(
              'p-4 rounded-xl border backdrop-blur-md flex items-center justify-between',
              criticalFindings.length > 0
                ? isLight
                  ? 'bg-rose-50 border-rose-200 text-rose-800'
                  : 'bg-rose-950/30 border-rose-500/40 text-rose-300'
                : isLight
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-emerald-950/30 border-emerald-500/40 text-emerald-300'
            )}
          >
            <div className="flex items-center gap-3">
              <ShieldCheck
                className={clsx(
                  'w-5 h-5 shrink-0',
                  criticalFindings.length > 0
                    ? isLight
                      ? 'text-rose-600'
                      : 'text-rose-400'
                    : isLight
                    ? 'text-emerald-600'
                    : 'text-emerald-400'
                )}
              />
              <div>
                <p className={clsx('text-xs font-bold', isLight ? 'text-slate-900' : 'text-white')}>
                  Well-Architected Pre-Flight Gate: {waAssessment.overallScore}% Overall Score
                </p>
                <p className={clsx('text-[11px] mt-0.5', isLight ? 'text-slate-600' : 'text-slate-400')}>
                  {criticalFindings.length > 0
                    ? `Warning: ${criticalFindings.length} critical architectural issue(s) detected. Remediation recommended before deployment.`
                    : 'Architecture complies with core security and reliability baselines.'}
                </p>
              </div>
            </div>
          </div>
        )}

        {activeProject.nodes.length === 0 && (
          <div
            className={clsx(
              'border rounded-xl p-4 flex items-start gap-3',
              isLight ? 'bg-amber-50 border-amber-200' : 'bg-yellow-900/20 border-yellow-800'
            )}
          >
            <AlertTriangle
              className={clsx('w-4 h-4 shrink-0 mt-0.5', isLight ? 'text-amber-600' : 'text-yellow-400')}
            />
            <div>
              <p className={clsx('text-sm font-medium', isLight ? 'text-amber-900' : 'text-yellow-400')}>
                No resources on canvas
              </p>
              <p className={clsx('text-xs mt-0.5', isLight ? 'text-amber-700' : 'text-yellow-600')}>
                Add resources to the visual canvas before generating a deployment plan.
              </p>
            </div>
          </div>
        )}

        {/* Real Terraform Execution Engine */}
        <TerraformExecutionPanel />
      </div>
    </div>
  );
}
