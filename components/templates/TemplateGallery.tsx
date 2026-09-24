'use client';
import { useState, useEffect } from 'react';
import { useApp } from '@/context/AppContext';
import { architectureTemplates } from '@/lib/templates';
import { CloudProvider } from '@/types';
import { LayoutGrid, DollarSign, Server } from 'lucide-react';
import { formatCurrency } from '@/lib/currency/formatter';
import { calculateCosts } from '@/lib/analysis';
import clsx from 'clsx';
import { instantiateTemplate } from '@/lib/domain/instantiateTemplate';

// Estimated monthly cost per template, computed from the SAME resource graph
// the template actually generates (via the shared static-rate-table cost
// calculator used elsewhere as the offline estimate) — never a hand-typed
// number. Memoized once per template id since `generate()` is a pure function
// of the template definition.
const templateCostCache = new Map<string, number>();
function estimateTemplateCostUsd(templateId: string, generate: () => { nodes: { resourceType: string }[] }): number {
  const cached = templateCostCache.get(templateId);
  if (cached !== undefined) return cached;
  const { nodes } = generate();
  const total = calculateCosts(nodes as Parameters<typeof calculateCosts>[0]).reduce((sum, item) => sum + item.monthlyCost, 0);
  templateCostCache.set(templateId, total);
  return total;
}

const categories = ['All', 'Web Applications', 'High Availability', 'SaaS', 'E-Commerce', 'Microservices', 'Serverless', 'Containers / Kubernetes', 'Data & Analytics', 'Disaster Recovery', 'Multi-cloud'];

export default function TemplateGallery() {
  const { state, dispatch } = useApp();
  const [filter, setFilter] = useState('All');
  const [providerFilter, setProviderFilter] = useState<'all' | 'aws' | 'azure' | 'multi'>('all');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  const activeCurrency = state.displayCurrency || 'USD';
  const [exchangeRate, setExchangeRate] = useState<number>(1.0);

  useEffect(() => {
    if (activeCurrency === 'USD') {
      setExchangeRate(1.0);
      return;
    }
    let cancelled = false;
    fetch(`/api/currency/rates?from=USD&to=${activeCurrency}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.ok && data.data?.rate?.rate) {
          setExchangeRate(data.data.rate.rate);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeCurrency]);

  const filtered = architectureTemplates.filter((t) => {
    const catMatch = filter === 'All' || t.category === filter;
    const pvMatch = providerFilter === 'all' || t.provider === providerFilter;
    return catMatch && pvMatch;
  });

  async function handleUseTemplate(templateId: string, provider: CloudProvider) {
    setLoading(templateId);
    await new Promise((r) => setTimeout(r, 800));
    const template = architectureTemplates.find((t) => t.id === templateId)!;
    const { nodes, edges } = instantiateTemplate(template, {});
    dispatch({ type: 'CREATE_PROJECT', provider, name: template.name, nodes, edges });
    setLoading(null);
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-900 p-6">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <LayoutGrid className="w-5 h-5 text-blue-400" />
            <div>
              <h1 className="text-white font-bold text-xl">Architecture Templates</h1>
              <p className="text-gray-400 text-sm">Production-ready cloud architecture templates</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(['all', 'aws', 'azure', 'multi'] as const).map((p) => (
              <button key={p} onClick={() => setProviderFilter(p)}
                className={clsx('px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize',
                  providerFilter === p ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white border border-gray-700'
                )}>
                {p === 'multi' ? 'Multi-cloud' : p.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Category tabs */}
        <div className="flex gap-1.5 overflow-x-auto pb-2 mb-6 no-scrollbar">
          {categories.map((c) => (
            <button key={c} onClick={() => setFilter(c)}
              className={clsx('px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0',
                filter === c ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-white hover:bg-gray-800'
              )}>
              {c}
            </button>
          ))}
        </div>

        {/* Cards grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((t) => (
            <div
              key={t.id}
              onMouseEnter={() => setHoveredId(t.id)}
              onMouseLeave={() => setHoveredId(null)}
              className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden hover:border-gray-600 transition-colors group"
            >
              {/* Card header band */}
              <div className={clsx('h-1.5 w-full', t.provider === 'aws' ? 'bg-orange-500' : t.provider === 'azure' ? 'bg-blue-500' : 'bg-purple-500')} />

              <div className="p-4">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1 min-w-0 pr-2">
                    <div className="flex items-center gap-1.5">
                      <h3 className="text-white font-semibold text-sm">{t.name}</h3>
                      {t.isReferenceArchitecture && (
                        <span
                          className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-900/50 text-indigo-300 border border-indigo-800 font-medium shrink-0"
                          title={t.sourceReferences?.length ? `Based on: ${t.sourceReferences.map((r) => r.label).join(', ')}` : 'Hand-modeled reference architecture'}
                        >
                          Reference Architecture
                        </span>
                      )}
                    </div>
                    <p className="text-gray-500 text-xs mt-0.5 line-clamp-2">{t.description}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className={clsx('text-[10px] px-1.5 py-0.5 rounded font-medium',
                      t.provider === 'aws' ? 'bg-orange-900/40 text-orange-300' :
                      t.provider === 'azure' ? 'bg-blue-900/40 text-blue-300' :
                      'bg-purple-900/40 text-purple-300'
                    )}>
                      {t.provider === 'multi' ? 'Multi' : t.provider.toUpperCase()}
                    </span>
                    <span className={clsx('text-[10px] px-1.5 py-0.5 rounded',
                      t.complexity === 'simple' ? 'bg-emerald-900/40 text-emerald-400' :
                      t.complexity === 'moderate' ? 'bg-yellow-900/40 text-yellow-400' :
                      'bg-red-900/40 text-red-400'
                    )}>
                      {t.complexity}
                    </span>
                  </div>
                </div>

                {/* Features */}
                <div className="flex flex-wrap gap-1 mb-3">
                  {t.features.slice(0, 3).map((f) => (
                    <span key={f} className="text-[10px] bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded">{f}</span>
                  ))}
                  {t.features.length > 3 && <span className="text-[10px] text-gray-600">+{t.features.length - 3}</span>}
                </div>

                {/* Stats */}
                <div className="flex items-center gap-4 text-xs text-gray-500 mb-4">
                  <span className="flex items-center gap-1"><Server className="w-3 h-3" />{t.resourceCount} resources</span>
                  <span
                    className="flex items-center gap-1"
                    title="Estimated from static reference rates against this template's actual resource graph — not a live price quote."
                  >
                    <DollarSign className="w-3 h-3" />
                    ~{formatCurrency(estimateTemplateCostUsd(t.id, () => t.generate({})) * (activeCurrency === 'USD' ? 1.0 : exchangeRate), activeCurrency)}/mo (est.)
                  </span>
                </div>

                {/* Action */}
                <button
                  onClick={() => handleUseTemplate(t.id, t.provider)}
                  disabled={loading === t.id}
                  className={clsx(
                    'w-full py-2 rounded-lg text-xs font-medium transition-colors',
                    loading === t.id
                      ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                      : 'bg-blue-600 hover:bg-blue-500 text-white'
                  )}
                >
                  {loading === t.id ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Generating...
                    </span>
                  ) : (
                    'Use Template →'
                  )}
                </button>
              </div>
            </div>
          ))}

          {filtered.length === 0 && (
            <div className="col-span-3 flex flex-col items-center justify-center py-16 text-center">
              <LayoutGrid className="w-12 h-12 text-gray-700 mb-3" />
              <p className="text-gray-400 font-medium">No templates match your filter</p>
              <button onClick={() => { setFilter('All'); setProviderFilter('all'); }} className="mt-2 text-blue-400 hover:text-blue-300 text-sm">
                Clear filters
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
