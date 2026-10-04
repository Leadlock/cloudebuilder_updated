'use client';
import { useState } from 'react';
import { Sparkles, Loader2, AlertTriangle, TrendingDown } from 'lucide-react';
import { apiCostService } from '@/lib/services/ApiCostService';
import type { CostInsights } from '@/lib/cost/ai/insights';
import type { CanvasNode } from '@/types';
import { formatCurrency } from '@/lib/currency/formatter';

/**
 * AI explanation and savings ideas for the cost comparison. A button, not automatic: each run is a paid model request.
 * The wording is AI-written; every figure shown was calculated by the server (savings come from re-pricing each idea).
 */
export default function CostInsightsCard({ nodes }: { nodes: CanvasNode[] }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [insights, setInsights] = useState<CostInsights | null>(null);
  const [error, setError] = useState('');

  async function run() {
    setState('loading');
    setError('');
    try {
      setInsights(await apiCostService.getInsights!(nodes));
      setState('done');
    } catch (e) {
      const m = e instanceof Error ? e.message : '';
      setError(/SERVICE_UNAVAILABLE/.test(m) ? 'AI insights are not available on this server (no AI model is configured).' : /RATE_LIMITED/.test(m) ? 'Too many requests. Try again in a minute.' : 'Could not generate insights right now. Try again in a moment.');
      setState('error');
    }
  }

  const f = insights?.facts;
  return (
    <div className="mb-8 rounded-2xl border border-fuchsia-500/20 bg-fuchsia-950/10 p-5" data-testid="cost-insights-card">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="flex items-center gap-2 text-white font-semibold"><Sparkles className="w-4 h-4 text-fuchsia-400" /> AI cost insights</p>
          <p className="text-slate-400 text-xs mt-0.5">Explains why the totals differ and suggests cheaper settings. Prices are never made up by the AI: each idea is re-priced from provider list prices.</p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={state === 'loading'}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-fuchsia-600/30 hover:bg-fuchsia-600/50 border border-fuchsia-500/50 text-fuchsia-100 disabled:opacity-50"
        >
          {state === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {state === 'loading' ? 'Analysing…' : state === 'done' ? 'Run again' : 'Explain & find savings'}
        </button>
      </div>

      {state === 'error' && <p className="mt-3 text-xs text-rose-300 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>}

      {state === 'done' && insights && f && (
        <div className="mt-4 space-y-4 text-sm">
          {insights.summary && <p className="text-slate-200 leading-relaxed">{insights.summary}</p>}

          {f.topDrivers.length > 0 && (
            <div>
              <p className="text-slate-400 text-xs uppercase tracking-wider font-semibold mb-1.5">Biggest costs on {f.currentProvider.toUpperCase()}</p>
              <ul className="space-y-1.5">
                {f.topDrivers.map((d) => (
                  <li key={d.resourceId} className="text-slate-300">
                    <span className="text-white font-medium">{d.label}</span>
                    <span className="text-slate-500"> — {formatCurrency(d.monthlyUsd, 'USD')}/mo, {d.sharePct.toFixed(0)}% of the total</span>
                    {d.why && <span className="block text-slate-400 text-xs mt-0.5">{d.why}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="text-slate-400 text-xs uppercase tracking-wider font-semibold mb-1.5">Ideas to spend less</p>
            {insights.suggestions.length === 0 ? (
              <p className="text-slate-500 text-xs">No cheaper setting was found that could be verified by re-pricing.</p>
            ) : (
              <ul className="space-y-2">
                {insights.suggestions.map((s) => (
                  <li key={`${s.resourceId}:${s.field}`} className="rounded-lg border border-slate-700/70 bg-slate-900/60 p-3">
                    <p className="text-slate-200">
                      <span className="font-medium text-white">{s.label}</span>: change <span className="text-slate-300">{s.fieldLabel}</span> from{' '}
                      <span className="font-mono text-slate-300">{s.from}</span> to <span className="font-mono text-emerald-300">{s.to}</span>
                    </p>
                    {s.rationale && <p className="text-slate-400 text-xs mt-0.5">{s.rationale}</p>}
                    <p className="text-emerald-300 text-xs mt-1 flex items-center gap-1.5">
                      <TrendingDown className="w-3.5 h-3.5" />
                      saves {formatCurrency(s.savingUsd, 'USD')}/mo ({formatCurrency(s.currentMonthlyUsd, 'USD')} → {formatCurrency(s.newMonthlyUsd, 'USD')}), re-priced by CloudCraft
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-slate-500 text-[11px] leading-relaxed">{insights.disclaimer} Amounts here are in USD.</p>
        </div>
      )}
    </div>
  );
}
