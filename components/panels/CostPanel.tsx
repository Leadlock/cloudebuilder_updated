'use client';
import { useState, useEffect, useMemo } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { apiCostService } from '@/lib/services/ApiCostService';
import { costService } from '@/lib/services/CostService';
import { CostItem } from '@/types';
import { DollarSign, TrendingDown, Zap, CheckCircle2, AlertTriangle, Globe, ArrowRightLeft, Info } from 'lucide-react';
import { getResourceDefinition } from '@/lib/resources';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';
import { cloudRegionService } from '@/lib/cloud/regions/CloudRegionService';
import { formatCurrency } from '@/lib/currency/formatter';
import { getCurrencyDefinition } from '@/lib/currency/types';
import clsx from 'clsx';
import { PRICING_TIER_LABEL, weakestTier, type PricingTier } from '@/lib/cloud/pricing/tiers';

const TIER_STYLE_DARK: Record<PricingTier, string> = {
  LIVE: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  CACHED_LIVE: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
  FALLBACK_ESTIMATE: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  UNAVAILABLE: 'bg-white/5 text-slate-400 border-white/10',
};

const TIER_STYLE_LIGHT: Record<PricingTier, string> = {
  LIVE: 'bg-emerald-50 text-emerald-800 border-emerald-300',
  CACHED_LIVE: 'bg-sky-50 text-sky-800 border-sky-300',
  FALLBACK_ESTIMATE: 'bg-amber-50 text-amber-800 border-amber-300',
  UNAVAILABLE: 'bg-slate-100 text-slate-700 border-slate-300',
};

const TIER_HELP: Record<PricingTier, string> = {
  LIVE: 'Official list price from the cloud provider for this estimate.',
  CACHED_LIVE: 'Official list price retrieved earlier from the provider API and served from cache.',
  FALLBACK_ESTIMATE: 'The provider API was not available or does not price this resource: CloudCraft static list-price estimate, not a live price.',
  UNAVAILABLE: 'No price could be determined for this resource. It is excluded from totals.',
};

function TierBadge({ tier, stale, isLight }: { tier: PricingTier; stale?: boolean; isLight?: boolean }) {
  const badgeClass = isLight ? TIER_STYLE_LIGHT[tier] : TIER_STYLE_DARK[tier];
  return (
    <span className={clsx('text-[10px] px-2 py-0.5 rounded-md border font-semibold tracking-tight shrink-0 shadow-xs', badgeClass)} title={TIER_HELP[tier]} data-testid="pricing-tier">
      {PRICING_TIER_LABEL[tier]}{stale ? ' (stale)' : ''}
    </span>
  );
}

export default function CostPanel() {
  const { state, dispatch } = useApp();
  const activeProject = useActiveProject();
  const activeRegion = activeProject?.environments[state.activeEnvironment]?.region ?? activeProject?.region ?? 'us-east-1';
  const displayCurrency = state.displayCurrency || 'USD';
  const currencyDef = getCurrencyDefinition(displayCurrency);

  const [appliedOpts, setAppliedOpts] = useState<Set<string>>(new Set());
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [costs, setCosts] = useState<CostItem[]>([]);
  const [expandedBreakdown, setExpandedBreakdown] = useState<Record<string, boolean>>({});

  const nodeCount = activeProject?.nodes.length ?? 0;
  const activeProjectId = activeProject?.id ?? null;
  const architectureVersion = state.architectureVersion;
  const updatedAt = activeProject?.updatedAt;

  // Run cost estimation via the API-backed service whenever project, nodes, or currency changes.
  useEffect(() => {
    if (!activeProject || nodeCount === 0) {
      setCosts([]);
      setCalculating(false);
      return;
    }
    let cancelled = false;
    setCalculating(true);
    apiCostService.calculateCosts(activeProject.nodes, displayCurrency).then((result) => {
      if (!cancelled) {
        setCosts(result);
        setError(null);
        setUsingFallback(false);
        setCalculating(false);

        // Synchronize accurate monthly USD cost to the project so Dashboard & canvas headers match CostPanel
        const totalUsd = result.reduce((a, c) => a + (c.providerCostUsd ?? c.monthlyCost), 0);
        if (Math.abs(activeProject.estimatedMonthlyCost - totalUsd) > 0.01) {
          dispatch({
            type: 'UPDATE_PROJECT_COST',
            projectId: activeProject.id,
            estimatedMonthlyCost: totalUsd,
          });
        }
      }
    }).catch(() => {
      if (!cancelled) {
        costService.calculateCosts(activeProject.nodes, displayCurrency).then((localCosts) => {
          if (!cancelled) {
            setCosts(localCosts);
            setError(null);
            setUsingFallback(true);
            setCalculating(false);

            const totalUsd = localCosts.reduce((a, c) => a + (c.providerCostUsd ?? c.monthlyCost), 0);
            if (Math.abs(activeProject.estimatedMonthlyCost - totalUsd) > 0.01) {
              dispatch({
                type: 'UPDATE_PROJECT_COST',
                projectId: activeProject.id,
                estimatedMonthlyCost: totalUsd,
              });
            }
          }
        }).catch(() => {
          if (!cancelled) {
            setError('Cost estimation failed. Unable to retrieve estimate from server.');
            setCosts([]);
            setUsingFallback(false);
            setCalculating(false);
          }
        });
      }
    });
    return () => { cancelled = true; };
  }, [activeProjectId, nodeCount, architectureVersion, updatedAt, retryCount, displayCurrency]);

  const allOptimizations = useMemo(
    () => (activeProject ? apiCostService.generateOptimizations(activeProject.nodes) : []),
    [activeProject],
  );

  if (!activeProject) return null;

  const isStale = state.architectureVersion > state.lastSavedVersion;

  const optimizations = allOptimizations.filter((o) => !appliedOpts.has(o.id));
  const total = costs.reduce((a, c) => a + c.monthlyCost, 0);
  const totalUsd = costs.reduce((a, c) => a + (c.providerCostUsd ?? c.monthlyCost), 0);
  const annual = total * 12;
  const annualUsd = totalUsd * 12;
  const potentialUsd = optimizations.reduce((a, o) => a + o.potentialSavings, 0);

  // Derive exchange rate info from cost items
  const firstConverted = costs.find((c) => c.exchangeRate !== undefined);
  const exchangeRate = firstConverted?.exchangeRate;
  const exchangeRateSource = firstConverted?.exchangeRateSource;
  const exchangeRateTime = firstConverted?.exchangeRateRetrievedAt;
  const isCachedRate = costs.some((c) => c.isCachedRate);
  const isStaleRate = costs.some((c) => c.isStaleRate);
  const pricedCosts = costs.filter((c) => c.pricingTier !== 'UNAVAILABLE');
  const unavailableCount = costs.length - pricedCosts.length;
  const overallTier = weakestTier(pricedCosts.map((c) => c.pricingTier ?? 'FALLBACK_ESTIMATE'));
  const rateTier: PricingTier | undefined = costs.find((c) => c.exchangeRateTier)?.exchangeRateTier;
  // Figures are only in the display currency when a real exchange rate was applied;
  // otherwise they are USD and must be labelled as USD.
  const valueCurrency = displayCurrency !== 'USD' && (!exchangeRate || rateTier === 'UNAVAILABLE') ? 'USD' : displayCurrency;
  const potential = exchangeRate ? potentialUsd * exchangeRate : potentialUsd;

  const awsCost = costs.filter((c) => c.provider === 'aws').reduce((a, c) => a + c.monthlyCost, 0);
  const azureCost = costs.filter((c) => c.provider === 'azure').reduce((a, c) => a + c.monthlyCost, 0);
  const sortedCosts = [...costs].sort((a, b) => b.monthlyCost - a.monthlyCost);

  // Group the detailed breakdown by resource category (compute/database/storage/etc.)
  // rather than a flat cost-sorted list, so a 20+ resource architecture reads as a
  // bill by service type instead of a wall of cards. Category order is by total
  // cost descending; resources within a category keep the cost-descending order too.
  const CATEGORY_LABELS: Record<string, string> = {
    compute: 'Compute', database: 'Database', storage: 'Storage', networking: 'Networking',
    loadbalancing: 'Load Balancing', security: 'Security', monitoring: 'Monitoring', messaging: 'Messaging',
  };
  const groupedByCategory = (() => {
    const groups = new Map<string, CostItem[]>();
    for (const item of sortedCosts) {
      const category = getResourceDefinition(item.resourceType)?.category ?? 'other';
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category)!.push(item);
    }
    return [...groups.entries()]
      .map(([category, items]) => ({ category, items, total: items.reduce((a, c) => a + c.monthlyCost, 0) }))
      .sort((a, b) => b.total - a.total);
  })();

  function toggleBreakdown(nodeId: string) {
    setExpandedBreakdown((prev) => ({ ...prev, [nodeId]: !prev[nodeId] }));
  }

  function applyOpt(id: string, nodeId: string) {
    dispatch({ type: 'APPLY_COST_OPTIMIZATION', optimizationId: id, nodeId });
    setAppliedOpts((s) => new Set(s).add(id));
    const opt = allOptimizations.find((o) => o.id === id);
    const savingsFormatted = formatCurrency(exchangeRate ? (opt?.potentialSavings ?? 0) * exchangeRate : (opt?.potentialSavings ?? 0), valueCurrency);
    setSuccessMsg(`✓ Applied: ${opt?.title ?? 'Optimization'} — saving ~${savingsFormatted}/mo`);
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
          <p className="text-gray-400 font-medium">Calculating costs in {displayCurrency}…</p>
          <p className="text-gray-600 text-sm mt-1">Querying cloud pricing & live exchange rates</p>
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

  const isLight = state.theme === 'light';

  return (
    <div className={clsx('flex-1 overflow-y-auto px-4 sm:px-6 py-6 pb-36 custom-scrollbar', isLight ? 'bg-slate-50 text-slate-900' : 'bg-gray-950 text-slate-100')}>
      <div className="max-w-4xl mx-auto">
        {isStale && (
          <div className={clsx('border rounded-xl p-4 flex items-center justify-between mb-6', isLight ? 'bg-amber-50 border-amber-200' : 'bg-amber-900/30 border-amber-800/50')}>
            <div className="flex items-center gap-3">
              <AlertTriangle className={clsx('w-5 h-5', isLight ? 'text-amber-600' : 'text-amber-400')} />
              <p className={clsx('text-sm', isLight ? 'text-amber-800' : 'text-amber-300')}>You have unsaved changes. Save your architecture to refresh this analysis.</p>
            </div>
            <button 
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'canvas' })}
              className={clsx('px-3 py-1.5 rounded-lg text-xs font-medium transition-colors', isLight ? 'bg-amber-600 hover:bg-amber-700 text-white' : 'bg-amber-800 hover:bg-amber-700 text-white')}
            >
              Return to Builder
            </button>
          </div>
        )}

        {usingFallback && (
          <div className={clsx('border rounded-xl p-4 flex items-center gap-3 mb-6', isLight ? 'bg-amber-50 border-amber-200' : 'bg-amber-900/30 border-amber-800/50')}>
            <AlertTriangle className={clsx('w-5 h-5 shrink-0', isLight ? 'text-amber-600' : 'text-amber-400')} />
            <p className={clsx('text-sm', isLight ? 'text-amber-800' : 'text-amber-300')}>
              The pricing service is unreachable — showing an <strong>offline fallback estimate</strong> from
              CloudCraft&apos;s static list-price tables. These are not live prices{displayCurrency !== 'USD' ? ', and no exchange rate is available, so figures are shown in USD' : ''}.
            </p>
          </div>
        )}

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <DollarSign className="w-5 h-5 text-orange-400" />
            <h2 className={clsx('font-bold text-lg', isLight ? 'text-slate-900' : 'text-white')}>Cost Estimate</h2>
            {overallTier && (
              <span
                className={clsx('text-xs px-2.5 py-0.5 border rounded-full font-medium shadow-xs', isLight ? TIER_STYLE_LIGHT[overallTier] : TIER_STYLE_DARK[overallTier])}
                title={`${TIER_HELP[overallTier]} On-demand list prices; negotiated discounts, Reserved Instances and Savings Plans are not reflected.`}
                data-testid="pricing-tier-overall"
              >
                {overallTier === 'LIVE' ? 'Live list prices' : overallTier === 'CACHED_LIVE' ? 'Live list prices (cached)' : 'Includes fallback estimates'}
              </span>
            )}
            {unavailableCount > 0 && (
              <span className={clsx('text-xs px-2.5 py-0.5 border rounded-full font-medium shadow-xs', isLight ? TIER_STYLE_LIGHT.UNAVAILABLE : TIER_STYLE_DARK.UNAVAILABLE)} title={TIER_HELP.UNAVAILABLE}>
                {unavailableCount} unpriced
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className={clsx('flex items-center gap-1.5 text-xs border rounded-lg px-2.5 py-1', isLight ? 'bg-white border-slate-200 text-slate-600 shadow-sm' : 'bg-gray-800/70 border-gray-700/60 text-gray-400')}>
              <Globe className={clsx('w-3.5 h-3.5 shrink-0', isLight ? 'text-blue-600' : 'text-blue-400')} />
              <span>Region: <strong className={isLight ? 'text-slate-900' : 'text-gray-200'}>{activeRegion}</strong></span>
            </div>
            <div className={clsx('flex items-center gap-1.5 text-xs border rounded-lg px-2.5 py-1 font-medium', isLight ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-emerald-950/50 border-emerald-800/60 text-emerald-400')}>
              <span>Display: <strong>{displayCurrency} ({currencyDef.symbol})</strong></span>
            </div>
          </div>
        </div>

        {/* Live Exchange Rate Status Bar */}
        {displayCurrency !== 'USD' && (
          <div className={clsx(
            'mb-5 p-3 rounded-xl border flex items-center justify-between gap-3 text-xs transition-all',
            exchangeRate
              ? (isLight ? 'bg-white border-slate-200 text-slate-700 shadow-sm' : 'bg-slate-800/90 border-slate-700 text-slate-300')
              : (isLight ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-amber-950/40 border-amber-800/60 text-amber-300')
          )}>
            <div className="flex items-center gap-2">
              <ArrowRightLeft className={clsx('w-4 h-4 shrink-0', exchangeRate ? (isLight ? 'text-cyan-600' : 'text-cyan-400') : (isLight ? 'text-amber-600' : 'text-amber-400'))} />
              {exchangeRate ? (
                <div>
                  <span className={clsx('font-semibold', isLight ? 'text-slate-900' : 'text-white')}>1 USD = {exchangeRate.toFixed(4)} {displayCurrency}</span>
                  <span className={clsx('ml-2', isLight ? 'text-slate-500' : 'text-slate-400')}>
                    via {exchangeRateSource}
                    {isCachedRate && exchangeRateTime && ` (cached: ${new Date(exchangeRateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`}
                    {isStaleRate && ' [stale fallback]'}
                  </span>
                </div>
              ) : (
                <div>
                  <span className={clsx('font-semibold', isLight ? 'text-amber-900' : 'text-amber-200')}>Exchange rate unavailable for {displayCurrency}.</span>
                  <span className={clsx('ml-1', isLight ? 'text-amber-700' : 'text-amber-300/80')}>Displaying original cloud provider price in USD.</span>
                </div>
              )}
            </div>
            <span className={clsx('text-[10px] uppercase tracking-wider', isLight ? 'text-slate-400' : 'text-slate-500')}>
              {rateTier === 'UNAVAILABLE' || !exchangeRate ? 'No Conversion' : rateTier === 'CACHED_LIVE' ? (isStaleRate ? 'Cached rate (stale)' : 'Cached rate') : 'Live rate'}
            </span>
          </div>
        )}

        {/* Success toast */}
        {successMsg && (
          <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-emerald-900/30 border border-emerald-800 rounded-xl text-emerald-300 text-sm">
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            {successMsg}
          </div>
        )}

        {/* Summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <div className={clsx('border rounded-2xl p-4 transition-all', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-gray-800 border-gray-700')}>
            <p className={clsx('text-xs mb-1', isLight ? 'text-slate-500' : 'text-gray-400')}>Monthly ({valueCurrency})</p>
            <p className="text-2xl font-bold text-orange-500">{formatCurrency(total, valueCurrency)}</p>
            {displayCurrency !== 'USD' && (
              <p className={clsx('text-[11px] mt-0.5', isLight ? 'text-slate-400' : 'text-gray-500')}>≈ {formatCurrency(totalUsd, 'USD')}</p>
            )}
          </div>
          <div className={clsx('border rounded-2xl p-4 transition-all', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-gray-800 border-gray-700')}>
            <p className={clsx('text-xs mb-1', isLight ? 'text-slate-500' : 'text-gray-400')}>Annual ({valueCurrency})</p>
            <p className={clsx('text-2xl font-bold', isLight ? 'text-slate-900' : 'text-white')}>{formatCurrency(annual, valueCurrency)}</p>
            {displayCurrency !== 'USD' && (
              <p className={clsx('text-[11px] mt-0.5', isLight ? 'text-slate-400' : 'text-gray-500')}>≈ {formatCurrency(annualUsd, 'USD')}</p>
            )}
          </div>
          <div className={clsx('border rounded-2xl p-4 transition-all', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-gray-800 border-gray-700')}>
            <p className={clsx('text-xs mb-1', isLight ? 'text-slate-500' : 'text-gray-400')}>AWS</p>
            <p className="text-2xl font-bold text-orange-500">{formatCurrency(awsCost, valueCurrency)}</p>
          </div>
          <div className={clsx('border rounded-2xl p-4 transition-all', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-gray-800 border-gray-700')}>
            <p className={clsx('text-xs mb-1', isLight ? 'text-slate-500' : 'text-gray-400')}>Azure</p>
            <p className="text-2xl font-bold text-blue-500">{formatCurrency(azureCost, valueCurrency)}</p>
          </div>
        </div>

        {/* Potential savings banner */}
        {potential > 0 && (
          <div className={clsx('border rounded-2xl p-3.5 mb-5 flex items-center gap-3', isLight ? 'bg-emerald-50 border-emerald-200' : 'bg-emerald-900/20 border-emerald-800')}>
            <TrendingDown className="w-5 h-5 text-emerald-500 shrink-0" aria-hidden="true" />
            <p className={clsx('text-sm', isLight ? 'text-emerald-900' : 'text-emerald-300')}>
              <span className="font-bold">{formatCurrency(potential, valueCurrency)}/mo</span> in potential savings identified
              {displayCurrency !== 'USD' && <span className={clsx('text-xs ml-1', isLight ? 'text-emerald-700' : 'text-emerald-400/70')}> (≈ {formatCurrency(potentialUsd, 'USD')}/mo)</span>}
            </p>
          </div>
        )}

        {/* Cost breakdown chart */}
        {costs.length > 0 && (
          <div className={clsx('border rounded-2xl p-5 mb-5 transition-all', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-gray-800 border-gray-700')}>
            <div className="flex items-center justify-between mb-4">
              <p className={clsx('text-xs font-medium uppercase tracking-wider', isLight ? 'text-slate-500' : 'text-gray-400')}>Cost by Resource ({valueCurrency})</p>
              {displayCurrency !== 'USD' && (
                <span className={clsx('text-[10px] font-mono', isLight ? 'text-slate-400' : 'text-gray-500')}>Original USD transparently retained</span>
              )}
            </div>
            <div className="space-y-3">
              {sortedCosts.map((item) => {
                const def = getResourceDefinition(item.resourceType);
                const pct = total > 0 ? (item.monthlyCost / total) * 100 : 0;
                const isAzure = item.provider === 'azure';
                return (
                  <div
                    key={item.nodeId}
                    className={clsx(
                      "p-3 rounded-xl border transition-all mb-2.5",
                      isLight
                        ? "bg-slate-50/70 border-slate-200/90 hover:border-slate-300 shadow-xs"
                        : "bg-[#1c1c1e] border-white/8 hover:border-white/15 shadow-xs"
                    )}
                  >
                    <div className="flex items-center justify-between mb-2 gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className={clsx(
                          "w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border shadow-xs p-1",
                          isLight ? "bg-white border-slate-200" : "bg-[#141416] border-white/10"
                        )}>
                          <CloudServiceIcon
                            provider={item.provider as any}
                            resourceType={item.resourceType}
                            size={18}
                          />
                        </div>
                        <span className={clsx('text-xs font-semibold truncate', isLight ? 'text-slate-900' : 'text-slate-100')}>
                          {item.nodeLabel}
                        </span>
                        <span className={clsx(
                          'text-[10px] px-2 py-0.5 rounded-md border font-semibold uppercase tracking-wider shrink-0 shadow-xs',
                          isAzure
                            ? 'bg-[#0078d4] text-white border-[#0078d4]'
                            : (isLight ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-amber-500/15 text-amber-300 border-amber-500/30')
                        )}>
                          {item.provider.toUpperCase()}
                        </span>
                        <TierBadge tier={item.pricingTier ?? 'FALLBACK_ESTIMATE'} stale={item.pricingIsStale} isLight={isLight} />
                      </div>
                      <div className="text-right shrink-0">
                        <span className="text-orange-500 text-xs font-bold block">
                          {item.pricingTier === 'UNAVAILABLE' ? 'Price unavailable' : `${formatCurrency(item.monthlyCost, valueCurrency)}/mo`}
                        </span>
                        {valueCurrency !== 'USD' && (
                          <span className={clsx('text-[10px] block', isLight ? 'text-slate-400' : 'text-slate-400')}>
                            ≈ {formatCurrency(item.providerCostUsd ?? item.monthlyCost, 'USD')}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className={clsx('h-1.5 rounded-full overflow-hidden', isLight ? 'bg-slate-200/80' : 'bg-white/10')}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${pct.toFixed(1)}%`,
                          backgroundColor: def?.color ?? (isAzure ? '#0078d4' : '#f59e0b')
                        }}
                      />
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
            <h3 className={clsx('font-semibold text-sm mb-3 flex items-center gap-2', isLight ? 'text-slate-900' : 'text-white')}>
              <Zap className="w-4 h-4 text-amber-500" aria-hidden="true" />
              Cost Optimization Recommendations
            </h3>
            <div className="space-y-3">
              {optimizations.map((opt) => {
                const optSavings = exchangeRate ? opt.potentialSavings * exchangeRate : opt.potentialSavings;
                return (
                  <div key={opt.id} className={clsx('border rounded-2xl p-4 transition-all', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-gray-800 border-gray-700')}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className={clsx('font-semibold text-sm', isLight ? 'text-slate-900' : 'text-white')}>{opt.title}</p>
                        <p className={clsx('text-xs mt-0.5 mb-2', isLight ? 'text-slate-500' : 'text-gray-500')}>{opt.description}</p>
                        <div className="flex items-center gap-3">
                          <span className={clsx('text-xs font-semibold', isLight ? 'text-emerald-700' : 'text-emerald-400')}>Save ~{formatCurrency(optSavings, valueCurrency)}/mo</span>
                          <span className={clsx('text-xs px-1.5 py-0.5 rounded font-medium border', opt.effort === 'low' ? (isLight ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-emerald-900/40 text-emerald-400 border-emerald-800/50') : opt.effort === 'medium' ? (isLight ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-yellow-900/40 text-yellow-400 border-yellow-800/50') : (isLight ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-red-900/40 text-red-400 border-red-800/50'))}>
                            {opt.effort} effort
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => applyOpt(opt.id, opt.nodeId)}
                        aria-label={`Apply optimization: ${opt.title}`}
                        className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Detailed breakdown list */}
        {costs.length === 0 ? (
          <div className={clsx('flex flex-col items-center justify-center py-16 text-center rounded-2xl border', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-gray-800/50 border-gray-700')}>
            <DollarSign className={clsx('w-12 h-12 mb-3', isLight ? 'text-slate-300' : 'text-gray-700')} aria-hidden="true" />
            <p className={clsx('font-medium', isLight ? 'text-slate-700' : 'text-gray-400')}>No billable resources</p>
            <p className={clsx('text-sm mt-1', isLight ? 'text-slate-500' : 'text-gray-600')}>Free resources (VPCs, Subnets, etc.) have no base cost</p>
          </div>
        ) : (
          <div className="space-y-6">
            {groupedByCategory.map(({ category, items, total: categoryTotal }) => (
              <div key={category}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className={clsx('text-xs font-semibold uppercase tracking-wider', isLight ? 'text-slate-500' : 'text-gray-400')}>
                    {CATEGORY_LABELS[category] ?? category}
                    <span className={clsx('font-normal ml-2 normal-case', isLight ? 'text-slate-400' : 'text-gray-600')}>({items.length} resource{items.length === 1 ? '' : 's'})</span>
                  </h3>
                  <span className={clsx('text-xs font-semibold', isLight ? 'text-slate-700' : 'text-gray-400')}>{formatCurrency(categoryTotal, valueCurrency)}/mo</span>
                </div>
                <div className="space-y-3">
            {items.map((item) => {
              const def = getResourceDefinition(item.resourceType);
              const isExpanded = expandedBreakdown[item.nodeId];
              const providerUsd = item.providerCostUsd ?? item.monthlyCost;
              const providerHourly = item.providerHourlyUsd ?? (item.hourlyCost ?? 0);

              return (
                <div key={item.nodeId} className={clsx('border rounded-xl p-4 transition-all mb-3', isLight ? 'bg-white border-slate-200 shadow-xs' : 'bg-[#1c1c1e] border-white/8 shadow-xs')}>
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <div className={clsx(
                        "w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border shadow-xs p-1.5",
                        isLight ? "bg-slate-50 border-slate-200" : "bg-[#141416] border-white/10"
                      )}>
                        <CloudServiceIcon
                          provider={item.provider as any}
                          resourceType={item.resourceType}
                          size={22}
                        />
                      </div>
                      <div>
                        <p className={clsx('font-semibold text-sm', isLight ? 'text-slate-900' : 'text-white')}>{item.nodeLabel}</p>
                        <p className={clsx('text-xs flex items-center gap-2 mt-0.5', isLight ? 'text-slate-500' : 'text-slate-400')}>
                          <span>{def?.label}</span>
                          <span>·</span>
                          <span className={clsx(
                            'text-[9px] px-1.5 py-0.5 rounded border font-semibold uppercase tracking-wider',
                            item.provider === 'azure'
                              ? (isLight ? 'bg-[#0078d4]/10 text-[#005a9e] border-[#0078d4]/30' : 'bg-[#0078d4]/20 text-[#50e6ff] border-[#0078d4]/40')
                              : (isLight ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-amber-500/15 text-amber-300 border-amber-500/30')
                          )}>
                            {item.provider.toUpperCase()}
                          </span>
                          <TierBadge tier={item.pricingTier ?? 'FALLBACK_ESTIMATE'} stale={item.pricingIsStale} isLight={isLight} />
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-orange-500 font-bold text-lg">{item.pricingTier === 'UNAVAILABLE' ? 'Unavailable' : formatCurrency(item.monthlyCost, valueCurrency)}</p>
                      {valueCurrency !== 'USD' && (
                        <p className={clsx('text-xs', isLight ? 'text-slate-400' : 'text-gray-500')}>≈ {formatCurrency(providerUsd, 'USD')}</p>
                      )}
                    </div>
                  </div>

                  {/* Calculation Details Toggle / Transparency Panel */}
                  <div className={clsx('mt-2 pt-2 border-t', isLight ? 'border-slate-100' : 'border-gray-700/60')}>
                    <button
                      onClick={() => toggleBreakdown(item.nodeId)}
                      className={clsx('text-[11px] flex items-center gap-1 font-medium transition-colors', isLight ? 'text-cyan-600 hover:text-cyan-700' : 'text-cyan-400 hover:text-cyan-300')}
                    >
                      <Info className="w-3 h-3" />
                      <span>{isExpanded ? 'Hide calculation details' : 'View pricing breakdown & exchange rate'}</span>
                    </button>

                    {isExpanded && (
                      <div className={clsx('mt-2.5 p-3 rounded-xl border text-xs space-y-1.5 font-mono', isLight ? 'bg-slate-50 border-slate-200 text-slate-700' : 'bg-gray-900/80 border-gray-700 text-gray-300')}>
                        <div className="flex justify-between">
                          <span className={isLight ? 'text-slate-400' : 'text-gray-500'}>Region:</span>
                          <span className={isLight ? 'text-slate-900' : 'text-white'}>{item.region || activeRegion}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className={isLight ? 'text-slate-400' : 'text-gray-500'}>Provider unit price:</span>
                          <span className={isLight ? 'text-slate-900' : 'text-white'}>{formatCurrency(providerHourly, 'USD')}/hour</span>
                        </div>
                        <div className="flex justify-between">
                          <span className={isLight ? 'text-slate-400' : 'text-gray-500'}>Estimated usage:</span>
                          <span className={isLight ? 'text-slate-900' : 'text-white'}>730 hours/month</span>
                        </div>
                        <div className="flex justify-between">
                          <span className={isLight ? 'text-slate-400' : 'text-gray-500'}>Provider monthly estimate:</span>
                          <span className={isLight ? 'text-orange-600 font-semibold' : 'text-orange-300'}>{formatCurrency(providerUsd, 'USD')}/month</span>
                        </div>
                        {displayCurrency !== 'USD' && (
                          <>
                            <div className={clsx('flex justify-between pt-1 border-t', isLight ? 'border-slate-200' : 'border-gray-800')}>
                              <span className={isLight ? 'text-slate-400' : 'text-gray-500'}>Real exchange rate:</span>
                              <span className={isLight ? 'text-cyan-700 font-semibold' : 'text-cyan-300'}>1 USD = {item.exchangeRate ? item.exchangeRate.toFixed(4) : exchangeRate ? exchangeRate.toFixed(4) : '1.00'} {displayCurrency}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className={isLight ? 'text-slate-400' : 'text-gray-500'}>Rate source:</span>
                              <span className={isLight ? 'text-slate-500' : 'text-slate-400'}>{item.exchangeRateSource || exchangeRateSource || 'live-api'}</span>
                            </div>
                            <div className={clsx('flex justify-between font-semibold pt-1 border-t', isLight ? 'border-slate-200' : 'border-gray-800')}>
                              <span className={isLight ? 'text-slate-600' : 'text-gray-400'}>Displayed estimate:</span>
                              <span className={isLight ? 'text-emerald-700' : 'text-emerald-400'}>{formatCurrency(item.monthlyCost, valueCurrency)}/month</span>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Sub-breakdown items */}
                  {item.breakdown.length > 0 && (
                    <div className={clsx('mt-2.5 pt-2.5 space-y-1.5 border-t', isLight ? 'border-slate-100' : 'border-gray-700/60')}>
                      {item.breakdown.map((b, i) => (
                        <div key={i} className="flex justify-between text-xs">
                          <span className={isLight ? 'text-slate-500' : 'text-gray-500'}>{b.label}</span>
                          <span className={isLight ? 'text-slate-700' : 'text-gray-400'}>
                            {formatCurrency(b.cost, valueCurrency)}
                            {displayCurrency !== 'USD' && b.originalCostUsd !== undefined && (
                              <span className={clsx('text-[10px] ml-1', isLight ? 'text-slate-400' : 'text-gray-600')}>({formatCurrency(b.originalCostUsd, 'USD')})</span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className={clsx('text-xs text-center mt-6', isLight ? 'text-slate-400' : 'text-gray-600')}>
          * Cloud list prices retrieved in USD from official APIs and converted using real live exchange rates. Actual invoices may vary based on data transfer and usage.
        </p>
      </div>
    </div>
  );
}
