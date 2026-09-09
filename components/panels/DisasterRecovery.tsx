'use client';
import { useState } from 'react';
import { useApp } from '@/context/AppContext';
import { architectureTemplates } from '@/lib/templates';
import { Shield, Clock, DollarSign, AlertCircle } from 'lucide-react';
import clsx from 'clsx';

const DR_STRATEGIES = [
  { id: 'backup', name: 'Backup & Restore', description: 'Periodic backups stored in S3/Azure Storage. Restore when disaster occurs.', rto: '24–72 hours', rpo: '1–24 hours', costMultiplier: 1.15, complexity: 'low' as const },
  { id: 'pilot-light', name: 'Pilot Light', description: 'Core infrastructure always running; scaled up during recovery.', rto: '4–8 hours', rpo: '1–4 hours', costMultiplier: 1.35, complexity: 'low' as const },
  { id: 'warm-standby', name: 'Warm Standby', description: 'Scaled-down secondary site runs continuously; promotes on failover.', rto: '30min–2hr', rpo: '15min–1hr', costMultiplier: 1.7, complexity: 'medium' as const },
  { id: 'hot-standby', name: 'Hot Standby (Active-Passive)', description: 'Full secondary site mirrors primary. Near-instant failover.', rto: '< 15 minutes', rpo: '< 5 minutes', costMultiplier: 2.0, complexity: 'high' as const },
  { id: 'multi-region', name: 'Multi-region Active-Active', description: 'Traffic served from multiple regions simultaneously.', rto: '< 1 minute', rpo: '~0', costMultiplier: 2.5, complexity: 'high' as const },
];

const BASE_COST = 280;

export default function DisasterRecovery() {
  const { dispatch } = useApp();
  const [selectedStrategy, setSelectedStrategy] = useState(DR_STRATEGIES[2]);
  const [primaryRegion, setPrimaryRegion] = useState('us-east-1');
  const [drRegion, setDrRegion] = useState('us-west-2');
  const [generating, setGenerating] = useState(false);

  const drCost = Math.round((selectedStrategy.costMultiplier - 1) * BASE_COST);
  const totalCost = Math.round(BASE_COST * selectedStrategy.costMultiplier);

  async function handleGenerate() {
    setGenerating(true);
    await new Promise((r) => setTimeout(r, 1200));
    const template = architectureTemplates.find((t) => t.id === 'disaster-recovery')!;
    const { nodes, edges } = template.generate({});
    dispatch({ type: 'CREATE_PROJECT', provider: 'multi', name: `DR — ${selectedStrategy.name}`, nodes, edges });
    setGenerating(false);
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-900 p-5">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Shield className="w-5 h-5 text-red-400" />
          <div>
            <h2 className="text-white font-bold text-lg">Disaster Recovery Designer</h2>
            <p className="text-gray-400 text-sm">Design a DR strategy for your architecture</p>
          </div>
        </div>

        {/* Strategy selector */}
        <div className="mb-5">
          <h3 className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-3">Recovery Strategy</h3>
          <div className="space-y-2">
            {DR_STRATEGIES.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedStrategy(s)}
                className={clsx(
                  'w-full text-left p-4 rounded-xl border-2 transition-colors',
                  selectedStrategy.id === s.id ? 'border-red-700 bg-red-900/10' : 'border-gray-700 hover:border-gray-600'
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <div className={clsx('w-3 h-3 rounded-full border-2', selectedStrategy.id === s.id ? 'border-red-500 bg-red-500' : 'border-gray-600')} />
                      <p className="text-white font-medium text-sm">{s.name}</p>
                      <span className={clsx('text-[10px] px-1.5 py-0.5 rounded font-medium', s.complexity === 'low' ? 'bg-emerald-900/40 text-emerald-400' : s.complexity === 'medium' ? 'bg-yellow-900/40 text-yellow-400' : 'bg-red-900/40 text-red-400')}>
                        {s.complexity}
                      </span>
                    </div>
                    <p className="text-gray-500 text-xs pl-5">{s.description}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-white text-xs font-medium">RTO: {s.rto}</p>
                    <p className="text-gray-400 text-xs">RPO: {s.rpo}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Region config */}
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 mb-5">
          <h3 className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-3">Region Configuration</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-gray-400 text-xs mb-1.5 block">Primary Region</label>
              <select value={primaryRegion} onChange={(e) => setPrimaryRegion(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-red-500">
                <option value="us-east-1">US East (N. Virginia)</option>
                <option value="us-west-2">US West (Oregon)</option>
                <option value="eu-west-1">EU (Ireland)</option>
                <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
              </select>
            </div>
            <div>
              <label className="text-gray-400 text-xs mb-1.5 block">DR Region</label>
              <select value={drRegion} onChange={(e) => setDrRegion(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-red-500">
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
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 mb-5">
          <h3 className="text-white font-semibold text-sm mb-4">Strategy Summary — {selectedStrategy.name}</h3>
          <div className="grid grid-cols-4 gap-3">
            <div className="text-center bg-gray-900 rounded-lg py-3">
              <Clock className="w-4 h-4 text-blue-400 mx-auto mb-1" />
              <p className="text-white font-bold text-sm">{selectedStrategy.rto}</p>
              <p className="text-gray-500 text-[10px]">RTO</p>
            </div>
            <div className="text-center bg-gray-900 rounded-lg py-3">
              <AlertCircle className="w-4 h-4 text-yellow-400 mx-auto mb-1" />
              <p className="text-white font-bold text-sm">{selectedStrategy.rpo}</p>
              <p className="text-gray-500 text-[10px]">RPO</p>
            </div>
            <div className="text-center bg-gray-900 rounded-lg py-3">
              <DollarSign className="w-4 h-4 text-orange-400 mx-auto mb-1" />
              <p className="text-orange-400 font-bold text-sm">+${drCost}/mo</p>
              <p className="text-gray-500 text-[10px]">Add. Cost</p>
            </div>
            <div className="text-center bg-gray-900 rounded-lg py-3">
              <DollarSign className="w-4 h-4 text-gray-400 mx-auto mb-1" />
              <p className="text-white font-bold text-sm">${totalCost}/mo</p>
              <p className="text-gray-500 text-[10px]">Total Est.</p>
            </div>
          </div>
        </div>

        {/* Generate */}
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="w-full py-3 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-xl font-medium text-sm transition-colors flex items-center justify-center gap-2"
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
