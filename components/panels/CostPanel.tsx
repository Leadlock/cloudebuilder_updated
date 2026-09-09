'use client';
import { useState, useEffect, useMemo } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { apiCostService } from '@/lib/services/ApiCostService';
import { CostItem } from '@/types';
import { DollarSign, TrendingDown, Zap, CheckCircle2, AlertTriangle } from 'lucide-react';
import { getResourceDefinition } from '@/lib/resources';
import clsx from 'clsx';

export default function CostPanel() {
  const { dispatch } = useApp();
  const activeProject = useActiveProject();
  const [appliedOpts, setAppliedOpts] = useState<Set<string>>(new Set());
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [costs, setCosts] = useState<CostItem[]>([]);

  const nodeCount = activeProject?.nodes.length ?? 0;
  const activeProjectId = activeProject?.id ?? null;

  // Run cost estimation via the API-backed service whenever the active project or nodes change.
  // apiCostService already has the project ID injected by AppContext.
  useEffect(() => {
    if (!activeProject || nodeCount === 0) {
      setCosts([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setCalculating(true);
    setError(null);
    apiCostService.calculateCosts(activeProject.nodes).then((result) => {
      if (!cancelled) {
        setCosts(result);
        setError(null);
        setCalculating(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setError('Cost estimation failed. Unable to retrieve estimate from server.');
        setCosts([]);
        setCalculating(false);
      }
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, nodeCount, retryCount]);

  const allOptimizations = useMemo(
    () => (activeProject ? apiCostService.generateOptimizations(activeProject.nodes) : []),
    [activeProject],
  );

  if (!activeProject) return null;

  const optimizations = allOptimizations.filter((o) => !appliedOpts.has(o.id));
  const total = costs.reduce((a, c) => a + c.monthlyCost, 0);
  const annual = total * 12;
  const potential = optimizations.reduce((a, o) => a + o.potentialSavings, 0);
  const awsCost = costs.filter((c) => c.provider === 'aws').reduce((a, c) => a + c.monthlyCost, 0);
  const azureCost = costs.filter((c) => c.provider === 'azure').reduce((a, c) => a + c.monthlyCost, 0);
  const sortedCosts = [...costs].sort((a, b) => b.monthlyCost - a.monthlyCost);

  function applyOpt(id: string, nodeId: string) {
    dispatch({ type: 'APPLY_COST_OPTIMIZATION', optimizationId: id, nodeId });
    setAppliedOpts((s) => new Set(s).add(id));
    const opt = allOptimizations.find((o) => o.id === id);
    setSuccessMsg(`✓ Applied: ${opt?.title ?? 'Optimization'} — saving ~$${opt?.potentialSavings?.toFixed(0) ?? '0'}/mo`);
    setTimeout(() => setSuccessMsg(null), 3000);
  }

  // Empty state
  if (nodeCount === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900">
        <div className="text-center px-8 py-12">
          <DollarSign className="w-12 h-12 text-gray-700 mx-auto mb-4" />
          <p className="text-gray-400 font-medium text-lg">No billable resources</p>
          <p className="text-gray-600 text-sm mt-1">Add resources to the canvas to see cost estimates</p>
        </div>
      </div>
    );
  }

  // Calculating state
  if (calculating) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900">
        <div className="text-center" role="status" aria-label="Calculating costs">
          <div className="w-12 h-12 border-4 border-orange-700 border-t-orange-400 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400 font-medium">Calculating costs…</p>
          <p className="text-gray-600 text-sm mt-1">Analysing {nodeCount} resource{nodeCount !== 1 ? 's' : ''}</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900 p-6">
        <div className="text-center max-w-md bg-gray-800 border border-red-800/60 rounded-xl p-8 shadow-xl">
          <AlertTriangle className="w-12 h-12 text-red-400 mx-auto mb-4" aria-hidden="true" />
          <h3 className="text-white font-semibold text-lg mb-2">Cost Estimation Failed</h3>
          <p className="text-gray-400 text-sm mb-6">{error}</p>
          <button
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-4 py-2 bg-red-800 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            Retry Estimation
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-900 p-5">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <DollarSign className="w-5 h-5 text-orange-400" />
          <h2 className="text-white font-bold text-lg">Cost Estimate</h2>
          <span className="text-xs px-2 py-0.5 bg-gray-800 text-gray-400 rounded-full">Live pricing</span>
        </div>

        {/* Success toast */}
        {successMsg && (
          <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-emerald-900/30 border border-emerald-800 rounded-xl text-emerald-300 text-sm">
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            {successMsg}
          </div>
        )}

        {/* Summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-3">
            <p className="text-gray-400 text-xs mb-1">Monthly</p>
            <p className="text-xl font-bold text-orange-400">${total.toFixed(2)}</p>
          </div>
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-3">
            <p className="text-gray-400 text-xs mb-1">Annual</p>
            <p className="text-xl font-bold text-white">${annual.toFixed(0)}</p>
          </div>
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-3">
            <p className="text-gray-400 text-xs mb-1">AWS</p>
            <p className="text-xl font-bold text-orange-300">${awsCost.toFixed(0)}</p>
          </div>
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-3">
            <p className="text-gray-400 text-xs mb-1">Azure</p>
            <p className="text-xl font-bold text-blue-300">${azureCost.toFixed(0)}</p>
          </div>
        </div>

        {/* Potential savings banner */}
        {potential > 0 && (
          <div className="bg-emerald-900/20 border border-emerald-800 rounded-xl p-3 mb-5 flex items-center gap-3">
            <TrendingDown className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
            <p className="text-emerald-300 text-sm">
              <span className="font-bold">${potential.toFixed(0)}/mo</span> in potential savings identified
            </p>
          </div>
        )}

        {/* Cost breakdown chart */}
        {costs.length > 0 && (
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 mb-5">
            <p className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-4">Cost by Resource</p>
            <div className="space-y-3">
              {sortedCosts.map((item) => {
                const def = getResourceDefinition(item.resourceType);
                const pct = total > 0 ? (item.monthlyCost / total) * 100 : 0;
                return (
                  <div key={item.nodeId}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 rounded flex items-center justify-center text-white text-[8px] font-bold" style={{ backgroundColor: def?.color ?? '#6B7280' }} aria-hidden="true">
                          {def?.icon}
                        </div>
                        <span className="text-gray-300 text-xs">{item.nodeLabel}</span>
                        <span className={clsx('text-[9px] px-1 py-0.5 rounded', item.provider === 'aws' ? 'bg-orange-900/40 text-orange-400' : 'bg-blue-900/40 text-blue-400')}>
                          {item.provider.toUpperCase()}
                        </span>
                      </div>
                      <span className="text-orange-400 text-xs font-medium">${item.monthlyCost.toFixed(2)}/mo</span>
                    </div>
                    <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct.toFixed(1)}%`, backgroundColor: def?.color ?? '#6B7280' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Optimizations */}
        {optimizations.length > 0 && (
          <div className="mb-5">
            <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">
              <Zap className="w-4 h-4 text-yellow-400" aria-hidden="true" />
              Cost Optimization Recommendations
            </h3>
            <div className="space-y-3">
              {optimizations.map((opt) => (
                <div key={opt.id} className="bg-gray-800 border border-gray-700 rounded-xl p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-medium text-sm">{opt.title}</p>
                      <p className="text-gray-500 text-xs mt-0.5 mb-2">{opt.description}</p>
                      <div className="flex items-center gap-3">
                        <span className="text-emerald-400 text-xs font-medium">Save ~${opt.potentialSavings.toFixed(0)}/mo</span>
                        <span className={clsx('text-xs px-1.5 py-0.5 rounded', opt.effort === 'low' ? 'bg-emerald-900/40 text-emerald-400' : opt.effort === 'medium' ? 'bg-yellow-900/40 text-yellow-400' : 'bg-red-900/40 text-red-400')}>
                          {opt.effort} effort
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => applyOpt(opt.id, opt.nodeId)}
                      aria-label={`Apply optimization: ${opt.title}`}
                      className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Detailed breakdown */}
        {costs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center bg-gray-800/50 rounded-xl border border-gray-700">
            <DollarSign className="w-12 h-12 text-gray-700 mb-3" aria-hidden="true" />
            <p className="text-gray-400 font-medium">No billable resources</p>
            <p className="text-gray-600 text-sm mt-1">Free resources (VPCs, Subnets, etc.) have no base cost</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sortedCosts.map((item) => {
              const def = getResourceDefinition(item.resourceType);
              return (
                <div key={item.nodeId} className="bg-gray-800 border border-gray-700 rounded-xl p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold" style={{ backgroundColor: def?.color ?? '#6B7280' }} aria-hidden="true">
                        {def?.icon}
                      </div>
                      <div>
                        <p className="text-white font-medium text-sm">{item.nodeLabel}</p>
                        <p className="text-gray-500 text-xs">{def?.label}</p>
                      </div>
                    </div>
                    <p className="text-orange-400 font-bold text-lg">${item.monthlyCost.toFixed(2)}</p>
                  </div>
                  {item.breakdown.length > 0 && (
                    <div className="border-t border-gray-700 pt-3 space-y-1.5">
                      {item.breakdown.map((b, i) => (
                        <div key={i} className="flex justify-between text-xs">
                          <span className="text-gray-500">{b.label}</span>
                          <span className="text-gray-400">${b.cost.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="text-gray-600 text-xs text-center mt-6">* Prices are estimates based on list pricing. Actual costs may vary.</p>
      </div>
    </div>
  );
}
