'use client';
import { useState, useEffect } from 'react';
import { useApp } from '@/context/AppContext';
import { architectureTemplates } from '@/lib/templates';
import { CloudProvider, ArchitectureTemplate } from '@/types';
import { LayoutGrid, DollarSign, Server, X, Sparkles, ArrowRight, Layers } from 'lucide-react';
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

/** Badge colour by the template's architecture pattern (falls back to its category). */
function architectureBadgeClass(t: { architecturePattern?: string; category: string }): string {
  const label = (t.architecturePattern ?? t.category).toLowerCase();
  if (label.includes('3-tier') || label.includes('three-tier')) return 'bg-blue-950/60 text-blue-300 border border-blue-800/40';
  if (label.includes('serverless')) return 'bg-amber-950/60 text-amber-300 border border-amber-800/40';
  if (label.includes('microservice')) return 'bg-purple-950/60 text-purple-300 border border-purple-800/40';
  if (label.includes('event')) return 'bg-cyan-950/60 text-cyan-300 border border-cyan-800/40';
  return 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/40';
}

export default function TemplateGallery() {
  const { state, dispatch } = useApp();
  const [filter, setFilter] = useState('All');
  const [providerFilter, setProviderFilter] = useState<'all' | 'aws' | 'azure' | 'multi'>('all');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Rename modal state
  const [selectedTemplate, setSelectedTemplate] = useState<ArchitectureTemplate | null>(null);
  const [customProjectName, setCustomProjectName] = useState('');

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

  function handleOpenTemplateModal(template: ArchitectureTemplate) {
    setSelectedTemplate(template);
    setCustomProjectName(template.name);
  }

  async function handleConfirmCreate(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!selectedTemplate) return;
    setLoading(true);
    await new Promise((r) => setTimeout(r, 400));
    const name = customProjectName.trim() || selectedTemplate.name;
    const { nodes, edges } = instantiateTemplate(selectedTemplate, {});
    dispatch({
      type: 'CREATE_PROJECT',
      provider: selectedTemplate.provider,
      name,
      nodes,
      edges,
    });
    setLoading(false);
    setSelectedTemplate(null);
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-950 p-6 custom-scrollbar">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 pb-6 border-b border-gray-800">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 bg-gradient-to-tr from-purple-600 to-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-purple-900/30">
              <LayoutGrid className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-white font-bold text-xl tracking-tight">Architecture Templates</h1>
              <p className="text-gray-400 text-xs mt-0.5">Production-grade cloud architecture blueprints & reference architectures</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(['all', 'aws', 'azure', 'multi'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setProviderFilter(p)}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all capitalize',
                  providerFilter === p
                    ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                    : 'bg-gray-900 text-gray-400 hover:text-white border border-gray-800 hover:bg-gray-800'
                )}
              >
                {p === 'multi' ? 'Multi-cloud' : p.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Category tabs */}
        <div className="flex gap-1.5 overflow-x-auto pb-3 mb-6 no-scrollbar">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className={clsx(
                'px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0',
                filter === c ? 'bg-gray-800 text-white border border-gray-700 font-semibold' : 'text-gray-400 hover:text-white hover:bg-gray-900'
              )}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Cards grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {filtered.map((t) => (
            <div
              key={t.id}
              onMouseEnter={() => setHoveredId(t.id)}
              onMouseLeave={() => setHoveredId(null)}
              className="bg-gray-900/90 border border-gray-800 rounded-2xl p-5 hover:border-blue-500/50 hover:bg-gray-900 transition-all flex flex-col justify-between group shadow-lg hover:shadow-blue-500/10"
            >
              <div>
                {/* Provider badge + category */}
                <div className="flex items-center justify-between mb-3">
                  <span className={clsx('text-[11px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider',
                    t.provider === 'aws' ? 'bg-orange-950/70 text-orange-300 border border-orange-700/60' :
                    t.provider === 'azure' ? 'bg-blue-950/70 text-blue-300 border border-blue-700/60' :
                    'bg-purple-950/70 text-purple-300 border border-purple-700/60'
                  )}>
                    {t.provider === 'multi' ? 'Multi-cloud' : t.provider.toUpperCase()}
                  </span>
                  <span className="text-gray-500 text-xs font-medium">{t.category}</span>
                </div>

                <h3 className="text-white font-bold text-base mb-1.5 group-hover:text-blue-300 transition-colors leading-snug">{t.name}</h3>
                <p className="text-gray-400 text-xs line-clamp-2 mb-4 leading-relaxed">{t.description}</p>

                {/* Architecture tags */}
                <div className="flex items-center gap-2 mb-3">
                  <span className={clsx('text-[10px] font-semibold px-2 py-0.5 rounded', architectureBadgeClass(t))}>
                    {t.architecturePattern ?? t.category}
                  </span>
                  <span className={clsx('text-[10px] px-2 py-0.5 rounded',
                    t.complexity === 'complex' ? 'bg-red-950/50 text-red-400 border border-red-900/40' :
                    t.complexity === 'moderate' ? 'bg-yellow-950/50 text-yellow-400 border border-yellow-900/40' :
                    'bg-emerald-950/50 text-emerald-400 border border-emerald-900/40'
                  )}>
                    {t.complexity}
                  </span>
                </div>

                {/* Features */}
                <div className="flex flex-wrap gap-1 mb-4">
                  {t.features.slice(0, 3).map((f) => (
                    <span key={f} className="text-[10px] bg-gray-800 text-gray-300 px-2 py-0.5 rounded border border-gray-700/60">{f}</span>
                  ))}
                  {t.features.length > 3 && <span className="text-[10px] text-gray-500 font-medium">+{t.features.length - 3}</span>}
                </div>
              </div>

              <div>
                {/* Stats */}
                <div className="flex items-center justify-between text-xs text-gray-400 mb-4 pt-3 border-t border-gray-800/80">
                  <span className="flex items-center gap-1.5"><Server className="w-3.5 h-3.5 text-gray-500" />{t.resourceCount} resources</span>
                  <span
                    className="flex items-center gap-1 font-medium text-emerald-400"
                    title="Estimated from static reference rates against this template's actual resource graph."
                  >
                    <DollarSign className="w-3.5 h-3.5 text-emerald-500" />
                    ~{formatCurrency(estimateTemplateCostUsd(t.id, () => t.generate({})) * (activeCurrency === 'USD' ? 1.0 : exchangeRate), activeCurrency)}/mo
                  </span>
                </div>

                {/* Action */}
                <button
                  type="button"
                  onClick={() => handleOpenTemplateModal(t)}
                  className="w-full py-2.5 rounded-xl text-xs font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-blue-600/20 transition-all flex items-center justify-center gap-1.5"
                >
                  <span>Use Template</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}

          {filtered.length === 0 && (
            <div className="col-span-3 flex flex-col items-center justify-center py-16 text-center">
              <LayoutGrid className="w-12 h-12 text-gray-700 mb-3" />
              <p className="text-gray-400 font-medium">No templates match your filter</p>
              <button onClick={() => { setFilter('All'); setProviderFilter('all'); }} className="mt-2 text-blue-400 hover:text-blue-300 text-sm font-semibold">
                Clear filters
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Rename / Use Template Modal */}
      {selectedTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/80 backdrop-blur-sm transition-opacity animate-in fade-in duration-150"
            onClick={() => setSelectedTemplate(null)}
          />

          {/* Modal Container */}
          <div className="relative w-full max-w-lg bg-gradient-to-b from-gray-900 to-gray-950 border border-blue-500/30 rounded-2xl shadow-2xl shadow-blue-950/40 p-6 z-10 animate-in zoom-in-95 duration-200">
            {/* Close Button */}
            <button
              type="button"
              onClick={() => setSelectedTemplate(null)}
              className="absolute top-4 right-4 text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800 transition-colors"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>

            {/* Modal Header */}
            <div className="flex items-start gap-3.5 mb-5">
              <div className="w-11 h-11 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center shrink-0 text-blue-400 shadow-inner">
                <Sparkles className="w-6 h-6" />
              </div>
              <div className="min-w-0 pr-6">
                <div className="flex items-center gap-2">
                  <h3 className="text-white font-bold text-lg leading-tight">Use Template</h3>
                  <span className={clsx(
                    'text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider',
                    selectedTemplate.provider === 'aws' ? 'bg-orange-950/70 text-orange-300 border border-orange-700/60' :
                    selectedTemplate.provider === 'azure' ? 'bg-blue-950/70 text-blue-300 border border-blue-700/60' :
                    'bg-purple-950/70 text-purple-300 border border-purple-700/60'
                  )}>
                    {selectedTemplate.provider.toUpperCase()}
                  </span>
                </div>
                <p className="text-gray-400 text-xs mt-0.5 line-clamp-1">
                  {selectedTemplate.description}
                </p>
              </div>
            </div>

            {/* Form Form */}
            <form onSubmit={handleConfirmCreate}>
              <div className="space-y-4">
                {/* Project Name Input */}
                <div>
                  <label className="text-gray-300 text-xs font-semibold block mb-1.5">
                    Project Name
                  </label>
                  <input
                    type="text"
                    autoFocus
                    required
                    value={customProjectName}
                    onChange={(e) => setCustomProjectName(e.target.value)}
                    placeholder="Enter project name..."
                    className="w-full bg-gray-950 border border-gray-700 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-gray-500 outline-none transition-all font-medium"
                  />
                  <p className="text-gray-500 text-[11px] mt-1">
                    You can customize the project name before launching the canvas.
                  </p>
                </div>

                {/* Template Summary Card */}
                <div className="p-3.5 bg-gray-950/90 border border-gray-800 rounded-xl space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400 flex items-center gap-1.5"><Layers className="w-3.5 h-3.5 text-gray-500" /> Base Template:</span>
                    <span className="text-gray-200 font-semibold">{selectedTemplate.name}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400 flex items-center gap-1.5"><Server className="w-3.5 h-3.5 text-gray-500" /> Initial Resources:</span>
                    <span className="text-blue-300 font-medium">{selectedTemplate.resourceCount} components</span>
                  </div>
                  <div className="flex items-center justify-between text-xs pt-1.5 border-t border-gray-800/80">
                    <span className="text-gray-400 flex items-center gap-1.5"><DollarSign className="w-3.5 h-3.5 text-emerald-500" /> Estimated Cost:</span>
                    <span className="text-emerald-400 font-bold">
                      ~{formatCurrency(estimateTemplateCostUsd(selectedTemplate.id, () => selectedTemplate.generate({})) * (activeCurrency === 'USD' ? 1.0 : exchangeRate), activeCurrency)}/mo
                    </span>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setSelectedTemplate(null)}
                  className="px-4 py-2 text-xs font-medium text-gray-300 hover:text-white bg-gray-800/80 hover:bg-gray-800 border border-gray-700/80 rounded-xl transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading || !customProjectName.trim()}
                  className="px-4 py-2 text-xs font-semibold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl shadow-lg shadow-blue-600/30 transition-all flex items-center gap-2"
                >
                  {loading ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>Instantiating...</span>
                    </>
                  ) : (
                    <>
                      <span>Create Project & Open Canvas</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
