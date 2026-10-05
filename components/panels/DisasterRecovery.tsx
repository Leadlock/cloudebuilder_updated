'use client';
import { useState } from 'react';
import { useApp } from '@/context/AppContext';
import { architectureTemplates } from '@/lib/templates';
import { Shield, Clock, DollarSign, AlertCircle } from 'lucide-react';
import clsx from 'clsx';
import { instantiateTemplate } from '@/lib/domain/instantiateTemplate';

const DR_STRATEGIES = [
  { id: 'backup', name: 'Backup & Restore', description: 'Periodic backups stored in S3/Azure Storage. Restore when disaster occurs.', rto: '24–72 hours', rpo: '1–24 hours', costMultiplier: 1.15, complexity: 'low' as const },
  { id: 'pilot-light', name: 'Pilot Light', description: 'Core infrastructure always running; scaled up during recovery.', rto: '4–8 hours', rpo: '1–4 hours', costMultiplier: 1.35, complexity: 'low' as const },
  { id: 'warm-standby', name: 'Warm Standby', description: 'Scaled-down secondary site runs continuously; promotes on failover.', rto: '30min–2hr', rpo: '15min–1hr', costMultiplier: 1.7, complexity: 'medium' as const },
  { id: 'hot-standby', name: 'Hot Standby (Active-Passive)', description: 'Full secondary site mirrors primary. Near-instant failover.', rto: '< 15 minutes', rpo: '< 5 minutes', costMultiplier: 2.0, complexity: 'high' as const },
  { id: 'multi-region', name: 'Multi-region Active-Active', description: 'Traffic served from multiple regions simultaneously.', rto: '< 1 minute', rpo: '~0', costMultiplier: 2.5, complexity: 'high' as const },
];

const BASE_COST = 280;

export default function DisasterRecovery() {
  const { state, dispatch } = useApp();
  const isLight = state.theme === 'light';
  const [selectedStrategy, setSelectedStrategy] = useState(DR_STRATEGIES[2]);
  const [primaryRegion, setPrimaryRegion] = useState('us-east-1');
  const [drRegion, setDrRegion] = useState('us-west-2');
  const [generating, setGenerating] = useState(false);

  const drCost = Math.round((selectedStrategy.costMultiplier - 1) * BASE_COST);
  const totalCost = Math.round(BASE_COST * selectedStrategy.costMultiplier);

  async function handleGenerate() {
    setGenerating(true);
    await new Promise((r) => setTimeout(r, 1200));
    const template =
      architectureTemplates.find((t) => t.id === 'ref-aws-dr-warm-standby') ?? architectureTemplates[0];
    const { nodes, edges } = instantiateTemplate(template, {});
    dispatch({ type: 'CREATE_PROJECT', provider: 'multi', name: `DR — ${selectedStrategy.name}`, nodes, edges });
    setGenerating(false);
  }

  return (
    <div className={clsx("flex-1 overflow-y-auto px-4 sm:px-6 py-6 pb-36 custom-scrollbar", isLight ? "bg-slate-50 text-slate-900" : "bg-gray-950 text-slate-100")}>
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Shield className={clsx("w-6 h-6", isLight ? "text-rose-600" : "text-red-400")} />
          <div>
            <h2 className={clsx("font-bold text-lg", isLight ? "text-slate-900" : "text-white")}>Disaster Recovery Designer</h2>
            <p className={clsx("text-sm", isLight ? "text-slate-500" : "text-gray-400")}>Design a DR strategy for your architecture</p>
          </div>
        </div>

        {/* Strategy selector */}
        <div className="mb-5">
          <h3 className={clsx("text-xs font-semibold uppercase tracking-wider mb-3", isLight ? "text-slate-500" : "text-gray-400")}>Recovery Strategy</h3>
          <div className="space-y-2">
            {DR_STRATEGIES.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedStrategy(s)}
                className={clsx(
                  'w-full text-left p-4 rounded-xl border-2 transition-all',
                  selectedStrategy.id === s.id 
                    ? (isLight ? 'border-rose-500 bg-rose-50/70 shadow-sm' : 'border-red-700 bg-red-900/10')
                    : (isLight ? 'border-slate-200 bg-white hover:border-slate-300' : 'border-gray-800 bg-slate-900/50 hover:border-gray-700')
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <div className={clsx('w-3 h-3 rounded-full border-2', selectedStrategy.id === s.id ? 'border-rose-500 bg-rose-500' : isLight ? 'border-slate-300' : 'border-gray-600')} />
                      <p className={clsx("font-semibold text-sm", isLight ? "text-slate-900" : "text-white")}>{s.name}</p>
                      <span className={clsx(
                        'text-[10px] px-1.5 py-0.5 rounded font-medium',
                        isLight 
                          ? (s.complexity === 'low' ? 'bg-emerald-100 text-emerald-800' : s.complexity === 'medium' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800')
                          : (s.complexity === 'low' ? 'bg-emerald-900/40 text-emerald-400' : s.complexity === 'medium' ? 'bg-yellow-900/40 text-yellow-400' : 'bg-red-900/40 text-red-400')
                      )}>
                        {s.complexity}
                      </span>
                    </div>
                    <p className={clsx("text-xs pl-5", isLight ? "text-slate-600" : "text-gray-400")}>{s.description}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={clsx("text-xs font-semibold", isLight ? "text-slate-900" : "text-white")}>RTO: {s.rto}</p>
                    <p className={clsx("text-xs", isLight ? "text-slate-500" : "text-gray-400")}>RPO: {s.rpo}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Region config */}
        <div className={clsx("border rounded-xl p-4 mb-5", isLight ? "bg-white border-slate-200 shadow-sm" : "bg-gray-800/80 border-gray-700")}>
          <h3 className={clsx("text-xs font-semibold uppercase tracking-wider mb-3", isLight ? "text-slate-500" : "text-gray-400")}>Region Configuration</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={clsx("text-xs mb-1.5 block font-medium", isLight ? "text-slate-700" : "text-gray-400")}>Primary Region</label>
              <select 
                value={primaryRegion} 
                onChange={(e) => setPrimaryRegion(e.target.value)}
                className={clsx(
                  "w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 border",
                  isLight ? "bg-slate-50 border-slate-300 text-slate-900" : "bg-gray-900 border-gray-700 text-white"
                )}
              >
                <option value="us-east-1">US East (N. Virginia)</option>
                <option value="us-west-2">US West (Oregon)</option>
                <option value="eu-west-1">EU (Ireland)</option>
                <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
              </select>
            </div>
            <div>
              <label className={clsx("text-xs mb-1.5 block font-medium", isLight ? "text-slate-700" : "text-gray-400")}>DR Region</label>
              <select 
                value={drRegion} 
                onChange={(e) => setDrRegion(e.target.value)}
                className={clsx(
                  "w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 border",
                  isLight ? "bg-slate-50 border-slate-300 text-slate-900" : "bg-gray-900 border-gray-700 text-white"
                )}
              >
                <option value="us-west-2">US West (Oregon)</option>
                <option value="us-east-2">US East (Ohio)</option>
                <option value="eu-central-1">EU (Frankfurt)</option>
                <option value="ap-northeast-1">Asia Pacific (Tokyo)</option>
                <option value="eastus">Azure East US</option>
                <option value="westeurope">Azure West Europe</option>
              </select>
            </div>
          </div>
        </div>

        {/* Summary card */}
        <div className={clsx("border rounded-xl p-4 mb-5", isLight ? "bg-white border-slate-200 shadow-sm" : "bg-gray-800/80 border-gray-700")}>
          <h3 className={clsx("font-semibold text-sm mb-4", isLight ? "text-slate-900" : "text-white")}>Strategy Summary — {selectedStrategy.name}</h3>
          <div className="grid grid-cols-4 gap-3">
            <div className={clsx("text-center rounded-lg py-3", isLight ? "bg-slate-50 border border-slate-200" : "bg-gray-900")}>
              <Clock className="w-4 h-4 text-blue-500 mx-auto mb-1" />
              <p className={clsx("font-bold text-sm", isLight ? "text-slate-900" : "text-white")}>{selectedStrategy.rto}</p>
              <p className={clsx("text-[10px]", isLight ? "text-slate-500" : "text-gray-500")}>RTO</p>
            </div>
            <div className={clsx("text-center rounded-lg py-3", isLight ? "bg-slate-50 border border-slate-200" : "bg-gray-900")}>
              <AlertCircle className="w-4 h-4 text-amber-500 mx-auto mb-1" />
              <p className={clsx("font-bold text-sm", isLight ? "text-slate-900" : "text-white")}>{selectedStrategy.rpo}</p>
              <p className={clsx("text-[10px]", isLight ? "text-slate-500" : "text-gray-500")}>RPO</p>
            </div>
            <div className={clsx("text-center rounded-lg py-3", isLight ? "bg-slate-50 border border-slate-200" : "bg-gray-900")}>
              <DollarSign className="w-4 h-4 text-orange-500 mx-auto mb-1" />
              <p className={clsx("font-bold text-sm", isLight ? "text-orange-600" : "text-orange-400")}>+${drCost}/mo</p>
              <p className={clsx("text-[10px]", isLight ? "text-slate-500" : "text-gray-500")}>Add. Cost</p>
            </div>
            <div className={clsx("text-center rounded-lg py-3", isLight ? "bg-slate-50 border border-slate-200" : "bg-gray-900")}>
              <DollarSign className={clsx("w-4 h-4 mx-auto mb-1", isLight ? "text-slate-400" : "text-gray-400")} />
              <p className={clsx("font-bold text-sm", isLight ? "text-slate-900" : "text-white")}>${totalCost}/mo</p>
              <p className={clsx("text-[10px]", isLight ? "text-slate-500" : "text-gray-500")}>Total Est.</p>
            </div>
          </div>
        </div>

        {/* Generate */}
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="w-full py-3 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 shadow-sm"
        >
          {generating ? (
            <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Generating DR Architecture...</>
          ) : (
            <><Shield className="w-4 h-4" /> Generate DR Architecture on Canvas</>
          )}
        </button>
      </div>
    </div>
  );
}
