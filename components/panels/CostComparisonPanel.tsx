'use client';
import { useState, useEffect } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { apiCostService, CostComparisonResult } from '@/lib/services/ApiCostService';
import { costService } from '@/lib/services/CostService';
import { formatCurrency } from '@/lib/currency/formatter';
import { DollarSign, ArrowRightLeft, AlertTriangle, Cloud, Scale } from 'lucide-react';
import clsx from 'clsx';
import { getResourceDefinition } from '@/lib/resources';

export default function CostComparisonPanel() {
  const { state } = useApp();
  const activeProject = useActiveProject();
  const displayCurrency = state.displayCurrency || 'USD';

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const [data, setData] = useState<CostComparisonResult | null>(null);

  const nodeCount = activeProject?.nodes.length ?? 0;
  const activeProjectId = activeProject?.id ?? null;

  useEffect(() => {
    if (!activeProject || nodeCount === 0) return;
    let cancelled = false;

    setLoading(true);
    apiCostService.compareCosts!(activeProject.nodes, displayCurrency)
      .then(res => {
        if (!cancelled) {
          setData(res);
          setError(null);
          setUsingFallback(false);
          setLoading(false);
        }
      })
      .catch(() => {
        // No persisted project (e.g. an unsaved draft) or the API is unreachable —
        // fall back to a fully local comparison, same pattern CostPanel uses.
        // This is a deterministic-fixture estimate, not live pricing, so it is
        // flagged to the user rather than presented as equivalent to the API result.
        costService.compareCosts!(activeProject.nodes, displayCurrency)
          .then(res => {
            if (!cancelled) {
              setData(res);
              setError(null);
              setUsingFallback(true);
              setLoading(false);
            }
          })
          .catch((err: unknown) => {
            if (!cancelled) {
              setError(err instanceof Error ? err.message : 'Failed to compare costs.');
              setLoading(false);
            }
          });
      });

    return () => { cancelled = true; };
  }, [activeProjectId, nodeCount, displayCurrency]);

  if (!activeProject) return null;

  if (nodeCount === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-950">
        <div className="text-center px-8 py-12">
          <Scale className="w-12 h-12 text-slate-700 mx-auto mb-4" />
          <p className="text-slate-400 font-medium text-lg">No resources to compare</p>
          <p className="text-slate-600 text-sm mt-1">Add resources to the canvas to see cost comparisons</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-950">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-900 border-t-blue-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-400 font-medium">Translating Architecture & Calculating Dual Costs...</p>
          <p className="text-slate-600 text-sm mt-1">Fetching live prices from AWS and Azure APIs</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-950 p-6">
        <div className="text-center max-w-md bg-slate-900 border border-red-900/50 rounded-2xl p-8">
          <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <h3 className="text-white font-semibold mb-2">Comparison Failed</h3>
          <p className="text-slate-400 text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const curMonthly = data.current.totalMonthlyUsd;
  const tgtMonthly = data.translated.totalMonthlyUsd;
  
  const diff = tgtMonthly - curMonthly;
  const isTargetCheaper = diff < 0;
  const diffPct = curMonthly > 0 ? (Math.abs(diff) / curMonthly) * 100 : 0;

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 p-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Scale className="w-6 h-6 text-blue-400" />
          <h2 className="text-2xl font-bold text-white">Multi-Cloud Cost Comparison</h2>
        </div>

        {usingFallback && (
          <div className="bg-amber-900/30 border border-amber-800/50 rounded-xl p-4 flex items-center gap-3 mb-6">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
            <p className="text-amber-300 text-sm">
              The live pricing service is unreachable — showing an <strong>offline estimate</strong> from cached
              reference rates. Figures below may not reflect current pricing.
            </p>
          </div>
        )}

        {/* Top Summary Banner */}
        <div className="bg-gradient-to-r from-slate-900 to-slate-800 border border-slate-700 rounded-2xl p-6 mb-8 flex flex-col md:flex-row items-center justify-between gap-6 shadow-xl">
          <div className="flex-1 text-center md:text-left">
            <p className="text-slate-400 text-sm mb-1 uppercase tracking-wider font-semibold">Current Provider</p>
            <div className="flex items-center gap-2 justify-center md:justify-start">
              <Cloud className={clsx("w-6 h-6", data.currentProvider === 'aws' ? 'text-orange-400' : 'text-blue-400')} />
              <span className="text-3xl font-bold text-white uppercase">{data.currentProvider}</span>
            </div>
            <p className="text-2xl text-slate-300 mt-2 font-mono">{formatCurrency(curMonthly, data.targetCurrency)}<span className="text-sm text-slate-500">/mo</span></p>
          </div>

          <div className="shrink-0 text-center">
            <div className="w-12 h-12 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center mx-auto mb-2">
              <ArrowRightLeft className="w-6 h-6 text-slate-400" />
            </div>
            {Math.abs(diff) > 0.01 && (
              <div className={clsx(
                "px-3 py-1 rounded-full text-xs font-bold border",
                isTargetCheaper 
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" 
                  : "bg-rose-500/10 text-rose-400 border-rose-500/20"
              )}>
                {isTargetCheaper ? '-' : '+'}{diffPct.toFixed(1)}% {isTargetCheaper ? 'Cheaper' : 'More Expensive'}
              </div>
            )}
          </div>

          <div className="flex-1 text-center md:text-right">
            <p className="text-slate-400 text-sm mb-1 uppercase tracking-wider font-semibold">Alternative Provider</p>
            <div className="flex items-center gap-2 justify-center md:justify-end">
              <span className="text-3xl font-bold text-white uppercase">{data.targetProvider}</span>
              <Cloud className={clsx("w-6 h-6", data.targetProvider === 'aws' ? 'text-orange-400' : 'text-blue-400')} />
            </div>
            <p className="text-2xl text-slate-300 mt-2 font-mono">{formatCurrency(tgtMonthly, data.targetCurrency)}<span className="text-sm text-slate-500">/mo</span></p>
          </div>
        </div>

        {/* Detailed Breakdown */}
        <h3 className="text-lg font-bold text-white mb-4">Resource Breakdown</h3>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          
          {/* Current Provider Column */}
          <div className="space-y-3">
            <div className={clsx("p-3 rounded-t-xl border-b-2 font-bold uppercase tracking-wider text-sm", data.currentProvider === 'aws' ? "bg-orange-500/10 border-orange-500 text-orange-400" : "bg-blue-500/10 border-blue-500 text-blue-400")}>
              {data.currentProvider} Architecture
            </div>
            {data.current.items.map((item) => {
              const def = getResourceDefinition(item.resourceType);
              return (
                <div key={item.resourceId} className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold" style={{ backgroundColor: def?.color ?? '#475569' }}>
                      {def?.icon}
                    </div>
                    <div>
                      <p className="text-white font-medium text-sm">{item.resourceLabel}</p>
                      <p className="text-slate-500 text-xs">{def?.label || item.resourceType}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-slate-200 font-mono font-medium">{formatCurrency(item.monthlyUsd, data.targetCurrency)}</p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Target Provider Column */}
          <div className="space-y-3">
            <div className={clsx("p-3 rounded-t-xl border-b-2 font-bold uppercase tracking-wider text-sm", data.targetProvider === 'aws' ? "bg-orange-500/10 border-orange-500 text-orange-400" : "bg-blue-500/10 border-blue-500 text-blue-400")}>
              {data.targetProvider} Architecture
            </div>
            {data.translated.items.map((item) => {
              const def = getResourceDefinition(item.resourceType);
              return (
                <div key={item.resourceId} className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold" style={{ backgroundColor: def?.color ?? '#475569' }}>
                      {def?.icon}
                    </div>
                    <div>
                      <p className="text-white font-medium text-sm">{item.resourceLabel}</p>
                      <p className="text-slate-500 text-xs">{def?.label || item.resourceType}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-slate-200 font-mono font-medium">{formatCurrency(item.monthlyUsd, data.targetCurrency)}</p>
                  </div>
                </div>
              );
            })}
          </div>

        </div>
        
        <div className="mt-8 p-4 bg-blue-900/20 border border-blue-900/50 rounded-xl text-sm text-blue-300/80 text-center">
          <p>This comparison translates resources to their closest generic equivalents in the alternative cloud. Pricing uses 730 hours/month standard usage where applicable.</p>
        </div>
      </div>
    </div>
  );
}
