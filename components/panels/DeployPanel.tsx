'use client';
import { useState, useEffect } from 'react';
import { useActiveProject } from '@/context/AppContext';
import { Rocket, ShieldCheck, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { apiWellArchitectedService } from '@/lib/services/ApiWellArchitectedService';
import type { WaAssessment } from '@/lib/engines/wellArchitected/types';
import TerraformExecutionPanel from './TerraformExecutionPanel';

export default function DeployPanel() {
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
    <div className="flex-1 overflow-y-auto bg-gray-900 p-5">
      <div className="max-w-4xl mx-auto space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-emerald-950/60 border border-emerald-500/30 text-emerald-400">
              <Rocket className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-white font-bold text-lg">Infrastructure Deployment</h2>
                <span className="text-[10px] px-2 py-0.5 bg-emerald-900/40 text-emerald-300 border border-emerald-800 rounded-full font-medium">Live Engine</span>
              </div>
              <p className="text-gray-400 text-xs mt-0.5">
                Execute production Terraform deployments with remote state locking, safety gates, and background execution.
              </p>
            </div>
          </div>
        </div>

        {/* Well-Architected Pre-flight gate */}
        {waAssessment && (
          <div className={clsx(
            'p-4 rounded-xl border backdrop-blur-md flex items-center justify-between',
            criticalFindings.length > 0
              ? 'bg-rose-950/30 border-rose-500/40 text-rose-300'
              : 'bg-emerald-950/30 border-emerald-500/40 text-emerald-300'
          )}>
            <div className="flex items-center gap-3">
              <ShieldCheck className={clsx('w-5 h-5 shrink-0', criticalFindings.length > 0 ? 'text-rose-400' : 'text-emerald-400')} />
              <div>
                <p className="text-xs font-bold text-white">
                  Well-Architected Pre-Flight Gate: {waAssessment.overallScore}% Overall Score
                </p>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {criticalFindings.length > 0
                    ? `Warning: ${criticalFindings.length} critical architectural issue(s) detected. Remediation recommended before deployment.`
                    : 'Architecture complies with core security and reliability baselines.'}
                </p>
              </div>
            </div>
          </div>
        )}

        {activeProject.nodes.length === 0 && (
          <div className="bg-yellow-900/20 border border-yellow-800 rounded-xl p-4 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-yellow-400 text-sm font-medium">No resources on canvas</p>
              <p className="text-yellow-600 text-xs mt-0.5">Add resources to the visual canvas before generating a deployment plan.</p>
            </div>
          </div>
        )}

        {/* Real Terraform Execution Engine */}
        <TerraformExecutionPanel />
      </div>
    </div>
  );
}
