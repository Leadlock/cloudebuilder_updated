'use client';
import { useState, useEffect, useRef } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { apiCostService, CostComparisonResult, type SideQuality } from '@/lib/services/ApiCostService';
import type { CostItem } from '@/types';
import { costService } from '@/lib/services/CostService';
import { formatCurrency } from '@/lib/currency/formatter';
import { DollarSign, ArrowRightLeft, AlertTriangle, Cloud, Scale, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { getResourceDefinition } from '@/lib/resources';
import CostInsightsCard from './CostInsightsCard';

/** Plain-language reasons a service costs very different amounts on the two clouds, for the services present in this architecture. */
const PRICE_DIFFERENCE_NOTES: [RegExp, string][] = [
  [/load_?balancer|alb|elb|lb|app_?gateway/i, 'Load balancers: AWS charges a small hourly fee plus usage. Azure Application Gateway has a fixed monthly fee (about $146) plus usage, so it costs more even when idle.'],
  [/rds|sql|postgres|mysql|database/i, 'Databases: matched by vCPU (an AWS vCPU against an Azure vCore). Azure SQL Database includes the SQL Server license, which an AWS PostgreSQL instance does not, and zone redundancy is a separate Azure charge, so Azure is higher at the same size. Azure Database for PostgreSQL would be the closer engine match.'],
  [/redis|elasticache|cache/i, 'Caches: AWS prices each node. Azure Standard and Premium caches include a replica in one price, so the two are only close at the same size and tier.'],
  [/waf/i, 'Web firewall: AWS charges per rule and per request; Azure charges a base fee for the policy. Totals depend on how many rules you use.'],
  [/route53|dns/i, 'DNS: Route 53 is compared with Azure DNS. Both charge per hosted zone plus per million queries, so the totals are close; query volume is the main variable.'],
];

function priceDifferenceNotes(resourceTypes: string[]): string[] {
  const text = resourceTypes.join(' ');
  return PRICE_DIFFERENCE_NOTES.filter(([re]) => re.test(text)).map(([, note]) => note);
}

const QUALITY_LABEL = { verified: 'Official price', estimate: 'Built-in estimate', check: 'Check this price', unpriced: 'Not priced' } as const;
const QUALITY_TONE = {
  verified: 'bg-emerald-500/15 text-emerald-600 border-emerald-300',
  estimate: 'bg-amber-500/15 text-amber-600 border-amber-300',
  check: 'bg-rose-500/15 text-rose-600 border-rose-300',
  unpriced: 'bg-slate-500/15 text-slate-500 border-slate-300',
} as const;

/** How far one line can be trusted. Official prices get a small chip; anything else says why in plain words under the line. */
function QualityNote({ quality, item }: { quality?: SideQuality; item: CostItem }) {
  const q = quality?.lines[item.nodeId];
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  if (!q) return null;
  const send = () => {
    setSent('sending');
    apiCostService.reportPrice!({
      resourceId: item.nodeId, resourceType: item.resourceType, provider: item.provider, region: item.region ?? '', monthlyUsd: item.providerCostUsd ?? item.monthlyCost,
      pricingTier: item.pricingTier ?? null, assumptions: [...q.notes, ...q.excludes.map((e) => `Not included: ${e}`)], note,
    }).then(() => setSent('sent')).catch(() => setSent('failed'));
  };
  return (
    <>
      <span title={q.notes.join(' ')} data-quality={q.status} className={clsx('ml-2 align-middle px-1.5 py-0.5 rounded text-[10px] font-semibold border', QUALITY_TONE[q.status])}>{QUALITY_LABEL[q.status]}</span>
      {q.status !== 'verified' && q.notes.length > 0 && <span className="block text-[11px] text-amber-600 mt-0.5 font-normal">{q.notes[0]}</span>}
      {q.excludes.length > 0 && <span className="block text-[11px] text-slate-500 mt-0.5 font-normal" data-testid="price-excludes">Plus usage not counted: {q.excludes.join('; ')}</span>}
      {q.status !== 'unpriced' && sent !== 'sent' && !open && <button type="button" onClick={() => setOpen(true)} className="block text-[11px] text-slate-500 underline mt-0.5 font-normal">This price looks wrong</button>}
      {open && sent !== 'sent' && (
        <span className="block mt-1 font-normal">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} placeholder="What looks wrong? (optional)" className="w-full rounded border border-slate-300 bg-transparent px-2 py-1 text-[11px]" />
          <button type="button" disabled={sent === 'sending'} onClick={send} className="mr-2 rounded bg-slate-700 px-2 py-0.5 text-[11px] text-white">{sent === 'sending' ? 'Sending…' : 'Send'}</button>
          <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-slate-500 underline">Cancel</button>
          {sent === 'failed' && <span className="ml-2 text-[11px] text-rose-600">Could not send. Try again.</span>}
        </span>
      )}
      {sent === 'sent' && <span className="block text-[11px] text-emerald-600 mt-0.5 font-normal">Thanks, this price was reported.</span>}
    </>
  );
}

function ageText(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (!Number.isFinite(mins)) return null;
  if (mins < 2) return 'just now';
  if (mins < 120) return `${mins} minutes ago`;
  return `${Math.round(mins / 60)} hours ago`;
}

export default function CostComparisonPanel() {
  const { state } = useApp();
  const activeProject = useActiveProject();
  const displayCurrency = state.displayCurrency || 'USD';
  const isLight = state.theme === 'light';

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const [data, setData] = useState<CostComparisonResult | null>(null);
  // Refresh prices: ask the server to discard its saved prices and fetch every one from the official list again.
  const [refreshKey, setRefreshKey] = useState(0);
  const refreshNext = useRef(false);

  const nodeCount = activeProject?.nodes.length ?? 0;
  const activeProjectId = activeProject?.id ?? null;
  // Scaling the architecture (e.g. changing "Expected Users") changes each
  // resource's config, not the number of resources — nodeCount alone never
  // changes, so without these two the panel silently kept showing the
  // pre-scale comparison forever. Mirrors CostPanel's dependency list.
  const architectureVersion = state.architectureVersion;
  const updatedAt = activeProject?.updatedAt;

  useEffect(() => {
    if (!activeProject || nodeCount === 0) return;
    let cancelled = false;

    setLoading(true);
    const refresh = refreshNext.current;
    refreshNext.current = false;
    apiCostService.compareCosts!(activeProject.nodes, displayCurrency, { refresh })
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
  }, [activeProjectId, nodeCount, architectureVersion, updatedAt, displayCurrency, refreshKey]);

  if (!activeProject) return null;

  if (nodeCount === 0) {
    return (
      <div className={clsx('flex-1 flex items-center justify-center', isLight ? 'bg-slate-50 text-slate-500' : 'bg-slate-950 text-slate-400')}>
        <div className="text-center px-8 py-12">
          <Scale className={clsx('w-12 h-12 mx-auto mb-4', isLight ? 'text-slate-300' : 'text-slate-700')} />
          <p className={clsx('font-medium text-lg', isLight ? 'text-slate-700' : 'text-slate-400')}>No resources to compare</p>
          <p className={clsx('text-sm mt-1', isLight ? 'text-slate-500' : 'text-slate-600')}>Add resources to the canvas to see cost comparisons</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={clsx('flex-1 flex items-center justify-center', isLight ? 'bg-slate-50' : 'bg-slate-950')}>
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-900 border-t-blue-500 rounded-full animate-spin mx-auto mb-4" />
          <p className={clsx('font-medium', isLight ? 'text-slate-700' : 'text-slate-400')}>Translating Architecture & Calculating Dual Costs...</p>
          <p className={clsx('text-sm mt-1', isLight ? 'text-slate-500' : 'text-slate-600')}>Fetching live prices from AWS and Azure APIs</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={clsx('flex-1 flex items-center justify-center p-6', isLight ? 'bg-slate-50' : 'bg-slate-950')}>
        <div className={clsx('text-center max-w-md border rounded-2xl p-8', isLight ? 'bg-white border-rose-200 shadow-sm' : 'bg-slate-900 border-red-900/50')}>
          <AlertTriangle className="w-12 h-12 text-rose-500 mx-auto mb-4" />
          <h3 className={clsx('font-semibold mb-2', isLight ? 'text-slate-900' : 'text-white')}>Comparison Failed</h3>
          <p className={clsx('text-sm', isLight ? 'text-slate-600' : 'text-slate-400')}>{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  // Always compare in the display currency — totalMonthlyConverted equals
  // totalMonthlyUsd when the display currency is USD, and is the properly
  // exchange-rate-converted figure otherwise. Comparing/formatting the raw
  // USD totals under a non-USD currency label was the panel's own display
  // bug (numbers never actually converted when switching currency).
  const curMonthly = data.current.totalMonthlyConverted;
  const tgtMonthly = data.translated.totalMonthlyConverted;

  const diff = tgtMonthly - curMonthly;
  const isTargetCheaper = diff < 0;
  const diffPct = curMonthly > 0 ? (Math.abs(diff) / curMonthly) * 100 : 0;

  // Guardrail: don't declare a confident "winner" when too much of either
  // side's pricing is unsupported (resource types the translation/pricing
  // layer couldn't price at all) — a precise-looking percentage over
  // mostly-missing data is misleading.
  const combinedCoveragePct = data.current.totalResourceCount + data.translated.totalResourceCount > 0
    ? ((data.current.totalResourceCount - data.current.unsupportedCount) + (data.translated.totalResourceCount - data.translated.unsupportedCount))
      / (data.current.totalResourceCount + data.translated.totalResourceCount) * 100
    : 100;
  const comparisonUnreliable = combinedCoveragePct < 75;
  const anomalies = [...(data.anomalies?.current ?? []), ...(data.anomalies?.translated ?? [])];
  const aiMatchById = new Map((data.aiMatches ?? []).map((m) => [m.resourceId, m]));

  return (
    <div className={clsx('flex-1 overflow-y-auto px-4 sm:px-6 py-6 pb-36 custom-scrollbar', isLight ? 'bg-slate-50 text-slate-900' : 'bg-slate-950 text-slate-100')}>
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Scale className={clsx('w-6 h-6', isLight ? 'text-blue-600' : 'text-blue-400')} />
          <h2 className={clsx('text-2xl font-bold', isLight ? 'text-slate-900' : 'text-white')}>Multi-Cloud Cost Comparison</h2>
          <button
            type="button"
            onClick={() => { refreshNext.current = true; setRefreshKey((k) => k + 1); }}
            className={clsx('ml-auto inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium', isLight ? 'border-slate-300 text-slate-700 hover:bg-slate-100' : 'border-slate-700 text-slate-300 hover:bg-slate-800')}
            title="Fetch every price from the official AWS and Azure price lists again"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh prices
          </button>
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

        {comparisonUnreliable && (
          <div className="bg-rose-900/30 border border-rose-800/50 rounded-xl p-4 flex items-center gap-3 mb-6">
            <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
            <p className="text-rose-300 text-sm">
              <strong>Comparison confidence is low</strong> — only {combinedCoveragePct.toFixed(0)}% of resources across
              both architectures could be priced. Totals below only reflect what was priceable; treat any
              &quot;cheaper&quot; conclusion cautiously until pricing coverage improves.
            </p>
          </div>
        )}

        {anomalies.length > 0 && (
          <div className="bg-rose-900/30 border border-rose-800/50 rounded-xl p-4 mb-6" data-testid="cost-anomalies">
            <p className="flex items-center gap-2 text-rose-200 text-sm font-semibold mb-1">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" /> {anomalies.length === 1 ? 'One price looks wrong' : `${anomalies.length} prices look wrong`}
            </p>
            <ul className="text-rose-300 text-xs space-y-1 list-disc pl-5">
              {anomalies.map((a) => <li key={a.resourceId}><strong>{a.label}</strong> ({formatCurrency(a.monthlyUsd, 'USD')}/mo): {a.reason}</li>)}
            </ul>
            <p className="text-rose-300/80 text-xs mt-2">The totals and the &quot;cheaper / more expensive&quot; result below include these lines, so do not rely on them yet.</p>
          </div>
        )}

        {/* Top Summary Banner */}
        <div className={clsx('border rounded-2xl p-6 mb-8 flex flex-col md:flex-row items-center justify-between gap-6 shadow-xl transition-all', isLight ? 'bg-white border-slate-200 text-slate-900 shadow-slate-100' : 'bg-gradient-to-r from-slate-900 to-slate-800 border-slate-700 text-white')}>
          <div className="flex-1 text-center md:text-left">
            <p className={clsx('text-xs mb-1 uppercase tracking-wider font-semibold', isLight ? 'text-slate-500' : 'text-slate-400')}>Current Provider</p>
            <div className="flex items-center gap-2 justify-center md:justify-start">
              <Cloud className={clsx("w-6 h-6", data.currentProvider === 'aws' ? 'text-orange-500' : 'text-blue-500')} />
              <span className={clsx("text-3xl font-black uppercase", isLight ? 'text-slate-900' : 'text-white')}>{data.currentProvider}</span>
            </div>
            <p className={clsx("text-2xl mt-2 font-mono font-bold", isLight ? 'text-slate-800' : 'text-slate-200')}>{formatCurrency(curMonthly, data.targetCurrency)}<span className={clsx("text-sm", isLight ? 'text-slate-400' : 'text-slate-500')}>/mo</span></p>
            <p className={clsx("text-xs mt-1", isLight ? 'text-slate-500' : 'text-slate-500')}>{data.current.pricingCoveragePct.toFixed(0)}% pricing coverage{data.current.unsupportedCount > 0 && ` · ${data.current.unsupportedCount} unpriced`}</p>
          </div>

          <div className="shrink-0 text-center">
            <div className={clsx("w-12 h-12 rounded-full border flex items-center justify-center mx-auto mb-2", isLight ? 'bg-slate-100 border-slate-200 text-slate-600' : 'bg-slate-800 border-slate-700 text-slate-400')}>
              <ArrowRightLeft className="w-6 h-6" />
            </div>
            {Math.abs(diff) > 0.01 && !comparisonUnreliable && (
              <div className={clsx(
                "px-3 py-1 rounded-full text-xs font-bold border",
                isTargetCheaper
                  ? (isLight ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20")
                  : (isLight ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-rose-500/10 text-rose-400 border-rose-500/20")
              )}>
                {isTargetCheaper ? '-' : '+'}{diffPct.toFixed(1)}% {isTargetCheaper ? 'Cheaper' : 'More Expensive'}
              </div>
            )}
            {comparisonUnreliable && (
              <div className={clsx("px-3 py-1 rounded-full text-xs font-bold border", isLight ? "bg-slate-100 text-slate-600 border-slate-200" : "bg-slate-800 text-slate-400 border-slate-700")}>
                Coverage too low to call
              </div>
            )}
          </div>

          <div className="flex-1 text-center md:text-right">
            <p className={clsx('text-xs mb-1 uppercase tracking-wider font-semibold', isLight ? 'text-slate-500' : 'text-slate-400')}>Alternative Provider</p>
            <div className="flex items-center gap-2 justify-center md:justify-end">
              <span className={clsx("text-3xl font-black uppercase", isLight ? 'text-slate-900' : 'text-white')}>{data.targetProvider}</span>
              <Cloud className={clsx("w-6 h-6", data.targetProvider === 'aws' ? 'text-orange-500' : 'text-blue-500')} />
            </div>
            <p className={clsx("text-2xl mt-2 font-mono font-bold", isLight ? 'text-slate-800' : 'text-slate-200')}>{formatCurrency(tgtMonthly, data.targetCurrency)}<span className={clsx("text-sm", isLight ? 'text-slate-400' : 'text-slate-500')}>/mo</span></p>
            <p className={clsx("text-xs mt-1", isLight ? 'text-slate-500' : 'text-slate-500')}>{data.translated.pricingCoveragePct.toFixed(0)}% pricing coverage{data.translated.unsupportedCount > 0 && ` · ${data.translated.unsupportedCount} unpriced`}</p>
          </div>
        </div>

        {data.quality && (() => {
          const sides = [
            { name: data.currentProvider, q: data.quality.current },
            { name: data.targetProvider, q: data.quality.translated },
          ];
          const age = ageText([data.quality.current.oldestPriceAt, data.quality.translated.oldestPriceAt].filter((t): t is string => !!t).sort()[0]);
          return (
            <div data-testid="price-quality" className={clsx('mb-8 rounded-2xl border p-4 text-sm', isLight ? 'bg-white border-slate-200 text-slate-700' : 'bg-slate-900 border-slate-800 text-slate-300')}>
              <p className="font-semibold mb-2">How far these totals can be trusted</p>
              {(data.notices ?? []).map((n) => <p key={n} className="mb-2 rounded-lg border border-amber-300 bg-amber-500/10 px-3 py-2 text-xs text-amber-700" data-testid="price-notice">{n}</p>)}
              <ul className="space-y-1">
                {sides.map(({ name, q }) => (
                  <li key={name}>
                    <strong className="uppercase">{name}</strong>: {q.summary.verified} from the official price list
                    {q.summary.estimates > 0 && <>, <span className="text-amber-600">{q.summary.estimates} built-in estimate{q.summary.estimates === 1 ? '' : 's'} ({formatCurrency(q.summary.estimateUsd, 'USD')}/mo)</span></>}
                    {q.summary.check > 0 && <>, <span className="text-rose-600">{q.summary.check} to check ({formatCurrency(q.summary.checkUsd, 'USD')}/mo)</span></>}
                    {q.summary.unpriced > 0 && <>, {q.summary.unpriced} not priced (left out of the total)</>}
                  </li>
                ))}
              </ul>
              <p className={clsx('text-xs mt-2', isLight ? 'text-slate-500' : 'text-slate-500')}>
                Lines marked as estimates or to check are included in the totals above, so read the totals with that in mind.
                {age && <> Oldest price fetched {age}.</>}
              </p>
            </div>
          );
        })()}

        {activeProject && <CostInsightsCard nodes={activeProject.nodes} />}

        {/* Detailed Breakdown */}
        <h3 className={clsx("text-lg font-bold mb-4", isLight ? 'text-slate-900' : 'text-white')}>Resource Breakdown</h3>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* Current Provider Column */}
          <div className="space-y-3">
            <div className={clsx("p-3 rounded-t-xl border-b-2 font-bold uppercase tracking-wider text-sm", data.currentProvider === 'aws' ? (isLight ? "bg-orange-50 border-orange-400 text-orange-700" : "bg-orange-500/10 border-orange-500 text-orange-400") : (isLight ? "bg-blue-50 border-blue-400 text-blue-700" : "bg-blue-500/10 border-blue-500 text-blue-400"))}>
              {data.currentProvider} Architecture
            </div>
            {data.current.items.map((item) => {
              const def = getResourceDefinition(item.resourceType);
              return (
                <div key={item.nodeId} className={clsx('border rounded-2xl p-4 flex items-center justify-between transition-all', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900 border-slate-800')}>
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold" style={{ backgroundColor: def?.color ?? '#475569' }}>
                      {def?.icon}
                    </div>
                    <div>
                      <p className={clsx("font-medium text-sm", isLight ? 'text-slate-900' : 'text-white')}>{item.nodeLabel}
                        {aiMatchById.has(item.nodeId) && (
                          <span title={`Matched by AI: ${aiMatchById.get(item.nodeId)!.from.replace(/^(aws|azure)_/, '')} → ${aiMatchById.get(item.nodeId)!.to.replace(/^(aws|azure)_/, '')}. ${aiMatchById.get(item.nodeId)!.reason} Priced at default size, so check it.`} className="ml-2 align-middle px-1.5 py-0.5 rounded text-[10px] font-semibold bg-fuchsia-500/15 text-fuchsia-600 border border-fuchsia-300">AI match</span>
                        )}
                        <QualityNote quality={data.quality?.current} item={item} />
                      </p>
                      <p className={clsx("text-xs", isLight ? 'text-slate-500' : 'text-slate-500')}>{def?.label || item.resourceType.replace(/^(aws|azure)_/, '').replace(/_/g, ' ')}{item.region ? ` · ${item.region}` : ''}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={clsx("font-mono font-semibold", isLight ? 'text-slate-800' : 'text-slate-200')}>{formatCurrency(item.monthlyCost, data.targetCurrency)}</p>
                  </div>
                </div>
              );
            })}
            {data.current.unsupportedCount > 0 && (
              <p className={clsx("text-xs px-1", isLight ? 'text-slate-500' : 'text-slate-600')}>
                + {data.current.unsupportedCount} resource{data.current.unsupportedCount === 1 ? '' : 's'} without a usable price (excluded from the total above)
              </p>
            )}
          </div>

          {/* Target Provider Column */}
          <div className="space-y-3">
            <div className={clsx("p-3 rounded-t-xl border-b-2 font-bold uppercase tracking-wider text-sm", data.targetProvider === 'aws' ? (isLight ? "bg-orange-50 border-orange-400 text-orange-700" : "bg-orange-500/10 border-orange-500 text-orange-400") : (isLight ? "bg-blue-50 border-blue-400 text-blue-700" : "bg-blue-500/10 border-blue-500 text-blue-400"))}>
              {data.targetProvider} Architecture
            </div>
            {data.translated.items.map((item) => {
              const def = getResourceDefinition(item.resourceType);
              return (
                <div key={item.nodeId} className={clsx('border rounded-2xl p-4 flex items-center justify-between transition-all', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900 border-slate-800')}>
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold" style={{ backgroundColor: def?.color ?? '#475569' }}>
                      {def?.icon}
                    </div>
                    <div>
                      <p className={clsx("font-medium text-sm", isLight ? 'text-slate-900' : 'text-white')}>{item.nodeLabel}
                        {aiMatchById.has(item.nodeId) && (
                          <span title={`Matched by AI: ${aiMatchById.get(item.nodeId)!.from.replace(/^(aws|azure)_/, '')} → ${aiMatchById.get(item.nodeId)!.to.replace(/^(aws|azure)_/, '')}. ${aiMatchById.get(item.nodeId)!.reason} Priced at default size, so check it.`} className="ml-2 align-middle px-1.5 py-0.5 rounded text-[10px] font-semibold bg-fuchsia-500/15 text-fuchsia-600 border border-fuchsia-300">AI match</span>
                        )}
                        <QualityNote quality={data.quality?.translated} item={item} />
                      </p>
                      <p className={clsx("text-xs", isLight ? 'text-slate-500' : 'text-slate-500')}>{def?.label || item.resourceType.replace(/^(aws|azure)_/, '').replace(/_/g, ' ')}{item.region ? ` · ${item.region}` : ''}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={clsx("font-mono font-semibold", isLight ? 'text-slate-800' : 'text-slate-200')}>{formatCurrency(item.monthlyCost, data.targetCurrency)}</p>
                  </div>
                </div>
              );
            })}
            {data.translated.unsupportedCount > 0 && (
              <p className={clsx("text-xs px-1", isLight ? 'text-slate-500' : 'text-slate-600')}>
                + {data.translated.unsupportedCount} resource{data.translated.unsupportedCount === 1 ? '' : 's'} without a usable price (excluded from the total above)
              </p>
            )}
          </div>

        </div>

        {priceDifferenceNotes(data.current.items.map((i) => i.resourceType)).length > 0 && (
          <div className={clsx('mt-8 p-4 rounded-2xl border text-sm', isLight ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-amber-900/20 border-amber-900/50 text-amber-200/90')}>
            <p className="font-semibold mb-2">Why these prices can differ so much</p>
            <ul className="list-disc pl-5 space-y-1">
              {priceDifferenceNotes(data.current.items.map((i) => i.resourceType)).map((n) => <li key={n}>{n}</li>)}
            </ul>
          </div>
        )}

        <div className={clsx("mt-8 p-4 rounded-2xl border text-sm text-center", isLight ? 'bg-blue-50 border-blue-200 text-blue-900' : 'bg-blue-900/20 border-blue-900/50 text-blue-300/80')}>
          <p>This comparison translates each resource to its nearest capacity-equivalent SKU in the alternative cloud (e.g. by vCPU/RAM for compute, by allocated storage for databases/object storage) — not just a relabeled resource type. Pricing uses 730 hours/month standard usage where applicable.</p>
        </div>
      </div>
    </div>
  );
}
