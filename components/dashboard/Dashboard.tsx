'use client';
import { useState, useEffect } from 'react';
import { useApp } from '@/context/AppContext';
import {
  Plus, Box, Server, ShieldCheck, DollarSign, Clock, Trash2,
  Cloud, LayoutGrid, Wand2, Sparkles, Upload
} from 'lucide-react';
import clsx from 'clsx';
import { CloudProvider, CanvasNode, CanvasEdge } from '@/types';
import { formatCurrency } from '@/lib/currency/formatter';
import { formatDate } from '@/lib/date';
import { architectureTemplates } from '@/lib/templates';
import { instantiateTemplate } from '@/lib/domain/instantiateTemplate';
import DeleteProjectModal from '@/components/modals/DeleteProjectModal';

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 80 ? 'text-emerald-400' : score >= 60 ? 'text-yellow-400' : 'text-red-400';
  return <span className={clsx('font-bold', color)}>{score}</span>;
}

function ProviderBadge({ provider }: { provider: CloudProvider }) {
  return (
    <span className={clsx('text-xs px-2 py-0.5 rounded-full font-medium',
      provider === 'aws' ? 'bg-orange-900/40 text-orange-300 border border-orange-800/50' :
      provider === 'azure' ? 'bg-blue-900/40 text-blue-300 border border-blue-800/50' :
      'bg-purple-900/40 text-purple-300 border border-purple-800/50'
    )}>
      {provider === 'aws' ? 'AWS' : provider === 'azure' ? 'Azure' : 'Multi-cloud'}
    </span>
  );
}

type Tab = 'all' | 'aws' | 'azure' | 'multi';

export default function Dashboard() {
  const { state, dispatch } = useApp();
  const { projects, displayCurrency } = state;
  const activeCurrency = displayCurrency || 'USD';
  const [exchangeRate, setExchangeRate] = useState<number>(1.0);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newName, setNewName] = useState('');
  const [newProvider, setNewProvider] = useState<CloudProvider>('aws');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('blank');
  const [tab, setTab] = useState<Tab>('all');
  const [projectToDelete, setProjectToDelete] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (activeCurrency === 'USD') return;
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

  const effectiveRate = activeCurrency === 'USD' ? 1.0 : exchangeRate;
  const totalResources = projects.reduce((a, p) => a + p.resourceCount, 0);
  // Only projects with an evaluated (scored) security assessment contribute; an
  // unscored project must not be averaged in as 0 or 100.
  const scoredProjects = projects.filter((p) => p.securityScored !== false);
  const avgScore = scoredProjects.length ? Math.round(scoredProjects.reduce((a, p) => a + p.securityScore, 0) / scoredProjects.length) : 0;
  const totalCostUsd = projects.reduce((a, p) => a + p.estimatedMonthlyCost, 0);
  const totalCost = totalCostUsd * effectiveRate;

  const filteredProjects = projects.filter((p) => tab === 'all' || p.provider === tab);

  function handleCreate() {
    if (!newName.trim()) return;
    let initialNodes: CanvasNode[] | undefined = undefined;
    let initialEdges: CanvasEdge[] | undefined = undefined;
    if (selectedTemplateId && selectedTemplateId !== 'blank') {
      const template = architectureTemplates.find((t) => t.id === selectedTemplateId);
      if (template) {
        const gen = instantiateTemplate(template, {});
        initialNodes = gen.nodes;
        initialEdges = gen.edges;
      }
    }
    dispatch({
      type: 'CREATE_PROJECT',
      provider: newProvider,
      name: newName.trim(),
      nodes: initialNodes,
      edges: initialEdges,
    });
    setShowNewProject(false);
    setNewName('');
    setSelectedTemplateId('blank');
  }

  const quickActions = [
    { icon: Wand2, label: 'Architecture Wizard', desc: 'Guided step-by-step setup', view: 'wizard' as const, color: 'bg-blue-900/30 border-blue-800/80 text-blue-400' },
    { icon: LayoutGrid, label: 'Template Gallery', desc: 'Start from a template', view: 'templates' as const, color: 'bg-purple-900/30 border-purple-800/80 text-purple-400' },
    { icon: Sparkles, label: 'AI Generator', desc: 'Describe your architecture', view: 'ai-generator' as const, color: 'bg-pink-900/30 border-pink-800/80 text-pink-400' },
    { icon: Upload, label: 'Import Infrastructure', desc: 'Import existing resources', view: 'import' as const, color: 'bg-orange-900/30 border-orange-800/80 text-orange-400' },
  ];

  const isLight = state.theme === 'light';

  return (
    <div className={clsx(
      "flex-1 overflow-y-auto p-4 sm:p-6 pb-32 custom-scrollbar transition-colors",
      isLight ? "bg-slate-50 text-slate-900" : "bg-gray-950 text-white"
    )}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className={clsx("text-xl sm:text-2xl font-bold", isLight ? "text-slate-900" : "text-white")}>Dashboard</h1>
          <p className={clsx("text-xs sm:text-sm mt-0.5 font-medium", isLight ? "text-slate-500" : "text-gray-400")}>Design, scale, deploy, and manage cloud infrastructure</p>
        </div>
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 sm:gap-3">
          <button
            id="btn-open-visual-builder"
            onClick={() => {
              dispatch({ type: 'SET_ACTIVE_PROJECT', id: 'draft-project' });
              dispatch({ type: 'SET_VIEW', view: 'canvas' });
            }}
            className="flex items-center gap-2 px-3.5 sm:px-4 py-2 bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 !text-white rounded-xl text-xs sm:text-sm font-semibold shadow-lg shadow-blue-500/25 transition-all transform active:scale-98"
          >
            <Box className="w-4 h-4 !text-white" /> <span className="!text-white font-bold">Open Visual Builder</span>
          </button>
          <button
            id="btn-new-project"
            onClick={() => setShowNewProject(true)}
            className={clsx(
              "flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all border shadow-sm active:scale-[0.98]",
              isLight
                ? "bg-white hover:bg-slate-100 text-slate-800 border-slate-300 hover:border-slate-400"
                : "bg-gray-800/90 hover:bg-gray-700 text-gray-200 border-gray-700"
            )}
          >
            <Plus className="w-4 h-4" /> New Project
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        {[
          { label: 'Total Projects', value: projects.length, icon: Box, color: isLight ? 'text-blue-600' : 'text-blue-400', bg: isLight ? 'bg-blue-50 border border-blue-200/80' : 'bg-blue-900/30' },
          { label: 'Total Resources', value: totalResources, icon: Server, color: isLight ? 'text-purple-600' : 'text-purple-400', bg: isLight ? 'bg-purple-50 border border-purple-200/80' : 'bg-purple-900/30' },
          { label: 'Avg Security Score', value: scoredProjects.length ? `${avgScore}/100` : 'Not assessed', icon: ShieldCheck, color: avgScore >= 80 ? (isLight ? 'text-emerald-600' : 'text-emerald-400') : (isLight ? 'text-amber-600' : 'text-yellow-400'), bg: avgScore >= 80 ? (isLight ? 'bg-emerald-50 border border-emerald-200/80' : 'bg-emerald-900/30') : (isLight ? 'bg-amber-50 border border-amber-200/80' : 'bg-yellow-900/30') },
          { label: `Est. Monthly Cost (${activeCurrency})`, value: formatCurrency(totalCost, activeCurrency), icon: DollarSign, color: isLight ? 'text-orange-600' : 'text-orange-400', bg: isLight ? 'bg-orange-50 border border-orange-200/80' : 'bg-orange-900/30' },
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className={clsx(
            "rounded-xl p-4 border transition-all shadow-xs",
            isLight ? "bg-white border-slate-200" : "bg-gray-900/90 border-gray-800"
          )}>
            <div className="flex items-start justify-between">
              <div>
                <p className={clsx("text-xs font-medium mb-1", isLight ? "text-slate-500" : "text-gray-400")}>{label}</p>
                <p className={clsx('text-xl sm:text-2xl font-bold', color)}>{value}</p>
              </div>
              <div className={clsx('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', bg)}>
                <Icon className={clsx('w-5 h-5', color)} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Quick actions */}
      <div className="mb-6">
        <h2 className={clsx("font-semibold text-xs sm:text-sm mb-3 uppercase tracking-wider", isLight ? "text-slate-500" : "text-gray-400")}>Quick Start</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {quickActions.map(({ icon: Icon, label, desc, view, color }) => (
            <button
              key={view}
              onClick={() => dispatch({ type: 'SET_VIEW', view })}
              className={clsx(
                'text-left p-3.5 rounded-xl border transition-all hover:scale-[1.01] active:scale-[0.99] shadow-xs',
                isLight ? 'bg-white border-slate-200 hover:border-blue-400 hover:shadow-md' : color
              )}
            >
              <Icon className={clsx("w-5 h-5 mb-2", isLight ? "text-blue-600" : "text-inherit")} />
              <p className={clsx("text-sm font-semibold", isLight ? "text-slate-900" : "text-white")}>{label}</p>
              <p className={clsx("text-xs mt-0.5", isLight ? "text-slate-500" : "text-gray-400")}>{desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Projects */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <h2 className={clsx("font-semibold text-xs sm:text-sm uppercase tracking-wider", isLight ? "text-slate-500" : "text-gray-400")}>Projects</h2>
          {/* Provider tabs */}
          <div className={clsx(
            "flex gap-1 rounded-lg p-0.5 border transition-colors",
            isLight ? "bg-slate-100 border-slate-300 shadow-sm" : "bg-gray-900 border-gray-800"
          )}>
            {(['all', 'aws', 'azure', 'multi'] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={clsx('px-2.5 py-1 rounded-md text-xs font-semibold capitalize transition-all',
                  tab === t
                    ? isLight ? 'bg-white text-slate-900 shadow-sm border border-slate-200/80 font-bold' : 'bg-gray-800 text-white shadow-sm'
                    : isLight ? 'text-slate-600 hover:text-slate-900' : 'text-gray-400 hover:text-gray-200'
                )}>
                {t === 'multi' ? 'Multi' : t === 'all' ? 'All' : t.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <span className={clsx("text-xs sm:text-sm font-medium", isLight ? "text-slate-500" : "text-gray-500")}>
          {filteredProjects.length} project{filteredProjects.length !== 1 ? 's' : ''}
        </span>
      </div>

      {filteredProjects.length === 0 && state.currentUser && !state.apiLoaded ? (
        // The projects are still being fetched (a second or more on a remote database). Saying "No projects found" and offering to create one in
        // the meantime was wrong, so say what is happening instead.
        <div role="status" aria-live="polite" className={clsx(
          "flex flex-col items-center justify-center py-16 sm:py-20 text-center rounded-2xl border",
          isLight ? "bg-white border-slate-200 shadow-xs" : "bg-gray-900/40 border-gray-800/80"
        )}>
          <div className="w-8 h-8 mb-4 border-4 border-blue-900 border-t-blue-500 rounded-full animate-spin" />
          <p className={clsx("font-semibold text-sm", isLight ? "text-slate-800" : "text-gray-300")}>Loading your projects…</p>
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className={clsx(
          "flex flex-col items-center justify-center py-16 sm:py-20 text-center rounded-2xl border",
          isLight ? "bg-white border-slate-200 shadow-xs" : "bg-gray-900/40 border-gray-800/80"
        )}>
          <Cloud className={clsx("w-12 h-12 mb-4", isLight ? "text-slate-300" : "text-gray-700")} />
          <p className={clsx("font-semibold mb-1 text-sm", isLight ? "text-slate-800" : "text-gray-300")}>No projects found</p>
          <p className={clsx("text-xs mb-4", isLight ? "text-slate-500" : "text-gray-500")}>Create your first cloud infrastructure project or open visual builder</p>
          <button onClick={() => setShowNewProject(true)} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 !text-white rounded-xl text-xs font-semibold shadow-md shadow-blue-600/20 transition-all">
            <Plus className="w-4 h-4 !text-white" /> <span className="!text-white font-bold">Create Project</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredProjects.map((project) => (
            <div
              key={project.id}
              className={clsx(
                "rounded-xl p-4 sm:p-5 transition-all group cursor-pointer shadow-xs hover:shadow-md border",
                isLight
                  ? "bg-white border-slate-200 hover:border-blue-400"
                  : "bg-gray-900 border-gray-800 hover:border-gray-700"
              )}
              onClick={() => {
                dispatch({ type: 'SET_ACTIVE_PROJECT', id: project.id });
                dispatch({ type: 'SET_VIEW', view: 'canvas' });
              }}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 className={clsx("font-bold text-sm truncate", isLight ? "text-slate-900" : "text-white")}>{project.name}</h3>
                    <ProviderBadge provider={project.provider} />
                  </div>
                  {project.description && (
                    <p className={clsx("text-xs line-clamp-2", isLight ? "text-slate-500" : "text-gray-400")}>
                      {project.description}
                    </p>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setProjectToDelete({ id: project.id, name: project.name });
                  }}
                  className={clsx(
                    "opacity-0 group-hover:opacity-100 ml-2 p-1 rounded transition-all shrink-0",
                    isLight ? "text-slate-400 hover:text-red-600 hover:bg-red-50" : "text-gray-500 hover:text-red-400 hover:bg-red-500/10"
                  )}
                  title="Delete project"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Tags */}
              {project.tags.length > 0 && (
                <div className="flex gap-1 flex-wrap mb-3">
                  {project.tags.slice(0, 3).map((t) => (
                    <span
                      key={t}
                      className={clsx(
                        "text-[10px] px-1.5 py-0.5 rounded font-medium",
                        isLight ? "bg-slate-100 text-slate-600 border border-slate-200" : "bg-gray-800 text-gray-400"
                      )}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}

              {/* Stats */}
              <div className={clsx(
                "grid grid-cols-4 gap-2 mb-3 p-2.5 rounded-lg border transition-colors",
                isLight ? "bg-slate-50/80 border-slate-200" : "bg-gray-950/60 border-gray-800/80"
              )}>
                <div className="text-center">
                  <p className={clsx("text-[10px] uppercase tracking-wide mb-0.5 font-bold", isLight ? "text-slate-500" : "text-gray-500")}>Nodes</p>
                  <p className={clsx("font-bold text-xs sm:text-sm", isLight ? "text-slate-900" : "text-white")}>{project.resourceCount}</p>
                </div>
                <div className={clsx("text-center border-x", isLight ? "border-slate-200" : "border-gray-800")}>
                  <p className={clsx("text-[10px] uppercase tracking-wide mb-0.5 font-bold", isLight ? "text-slate-500" : "text-gray-500")}>Security</p>
                  <p className="text-xs sm:text-sm font-semibold" title={project.securityCoveragePct != null ? `Assessment coverage ${project.securityCoveragePct}%` : undefined}>
                    {project.securityScored === false ? <span className="text-gray-500">N/A</span> : <><ScoreBadge score={project.securityScore} /></>}
                  </p>
                </div>
                <div className={clsx("text-center border-r", isLight ? "border-slate-200" : "border-gray-800")}>
                  <p className={clsx("text-[10px] uppercase tracking-wide mb-0.5 font-bold", isLight ? "text-slate-500" : "text-gray-500")}>Arch.</p>
                  <p className="text-xs sm:text-sm font-semibold"><ScoreBadge score={project.architectureScore} /></p>
                </div>
                <div className="text-center">
                  <p className={clsx("text-[10px] uppercase tracking-wide mb-0.5 font-bold", isLight ? "text-slate-500" : "text-gray-500")}>Cost</p>
                  <p className="text-orange-500 font-bold text-xs sm:text-sm truncate">{formatCurrency(project.estimatedMonthlyCost * exchangeRate, activeCurrency)}</p>
                </div>
              </div>

              {/* Security bar */}
              <div className="mb-3">
                <div className={clsx("h-1.5 rounded-full overflow-hidden", isLight ? "bg-slate-200" : "bg-gray-800")}>
                  <div className={clsx('h-full rounded-full transition-all', project.securityScore >= 80 ? 'bg-emerald-500' : project.securityScore >= 60 ? 'bg-yellow-500' : 'bg-red-500')}
                    style={{ width: `${project.securityScored === false ? 0 : project.securityScore}%` }} />
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                <div className="flex items-center gap-2">
                  <span className={clsx("text-xs flex items-center gap-1", isLight ? "text-slate-500" : "text-gray-500")} suppressHydrationWarning>
                    <Clock className="w-3 h-3" /> {formatDate(project.updatedAt)}
                  </span>
                  <span className={clsx(
                    'text-[10px] px-1.5 py-0.5 rounded-full capitalize font-medium',
                    project.environment === 'production'
                      ? isLight ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-emerald-900/40 text-emerald-400 border border-emerald-800/40'
                      : project.environment === 'staging'
                      ? isLight ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-yellow-900/40 text-yellow-400 border border-yellow-800/40'
                      : isLight ? 'bg-slate-100 text-slate-600 border border-slate-200' : 'bg-gray-800 text-gray-400'
                  )}>
                    {project.environment}
                  </span>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); dispatch({ type: 'SET_ACTIVE_PROJECT', id: project.id }); dispatch({ type: 'SET_VIEW', view: 'canvas' }); }}
                  className="text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300 text-xs font-semibold transition-colors"
                >
                  Open →
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* New project modal */}
      {showNewProject && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Create new project"
          onKeyDown={(e) => e.key === 'Escape' && setShowNewProject(false)}
        >
          <div className={clsx(
            "rounded-2xl p-5 sm:p-6 w-full max-w-md shadow-2xl animate-in fade-in zoom-in-95 duration-150 border",
            isLight ? "bg-white border-slate-200 text-slate-900" : "bg-gray-900 border-gray-800 text-white"
          )}>
            <h2 className={clsx("font-bold text-lg mb-4", isLight ? "text-slate-900" : "text-white")}>Create New Project</h2>
            <div className="space-y-4">
              <div>
                <label className={clsx("text-xs font-semibold mb-1.5 block", isLight ? "text-slate-700" : "text-gray-300")}>Project Name</label>
                <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  placeholder="e.g. Production E-Commerce Platform" autoFocus
                  className={clsx(
                    "w-full rounded-xl px-3 py-2 text-xs outline-none transition-all border",
                    isLight
                      ? "bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      : "bg-gray-950 border-gray-800 text-white placeholder-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  )}
                />
              </div>
              <div>
                <label className={clsx("text-xs font-semibold mb-1.5 block", isLight ? "text-slate-700" : "text-gray-300")}>Cloud Provider</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['aws', 'azure', 'multi'] as CloudProvider[]).map((p) => (
                    <button key={p} onClick={() => { setNewProvider(p); setSelectedTemplateId('blank'); }}
                      className={clsx('flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all',
                        newProvider === p
                          ? (p === 'aws' ? 'border-orange-500 bg-orange-50 dark:bg-orange-950/30 shadow-md shadow-orange-500/10' : p === 'azure' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 shadow-md shadow-blue-500/10' : 'border-purple-500 bg-purple-50 dark:bg-purple-950/30 shadow-md shadow-purple-500/10')
                          : isLight ? 'border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-600' : 'border-gray-800 bg-gray-950 text-gray-400 hover:border-gray-700'
                      )}
                    >
                      <div className={clsx('w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold', p === 'aws' ? 'bg-orange-500/20 text-orange-600 dark:text-orange-400' : p === 'azure' ? 'bg-blue-500/20 text-blue-600 dark:text-blue-400' : 'bg-purple-500/20 text-purple-600 dark:text-purple-400')}>
                        {p === 'aws' ? 'AWS' : p === 'azure' ? 'AZ' : '☁'}
                      </div>
                      <p className={clsx("text-xs font-semibold", isLight ? "text-slate-800" : "text-white")}>{p === 'aws' ? 'Amazon AWS' : p === 'azure' ? 'Microsoft Azure' : 'Multi-cloud'}</p>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className={clsx("text-xs font-semibold mb-1.5 block", isLight ? "text-slate-700" : "text-gray-300")}>Starting Template</label>
                <select
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                  className={clsx(
                    "w-full rounded-xl px-3 py-2 text-xs outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 border",
                    isLight ? "bg-slate-50 border-slate-300 text-slate-900" : "bg-gray-950 border-gray-800 text-white"
                  )}
                >
                  <option value="blank">Blank Architecture (Empty Canvas)</option>
                  {architectureTemplates
                    .filter((t) => newProvider === 'multi' ? true : t.provider === newProvider || t.provider === 'multi')
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.resourceCount} resources, ~${t.estimatedCost}/mo)
                      </option>
                    ))}
                </select>
                {selectedTemplateId !== 'blank' && (
                  <p className="text-xs text-blue-400 mt-1.5 leading-relaxed">
                    {architectureTemplates.find((t) => t.id === selectedTemplateId)?.description}
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-2 mt-6">
              <button
                onClick={() => setShowNewProject(false)}
                className={clsx(
                  "flex-1 px-4 py-2 rounded-xl text-xs font-semibold transition-colors border",
                  isLight ? "text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-100 border-slate-200" : "text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 border-gray-700"
                )}
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!newName.trim()}
                className="flex-1 px-4 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed !text-white rounded-xl text-xs font-semibold shadow-lg shadow-blue-600/20 transition-all"
              >
                <span className="!text-white font-bold">Create Project</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {projectToDelete && (
        <DeleteProjectModal
          isOpen={true}
          projectId={projectToDelete.id}
          projectName={projectToDelete.name}
          onConfirm={(id) => {
            dispatch({ type: 'DELETE_PROJECT', id });
            setProjectToDelete(null);
          }}
          onCancel={() => setProjectToDelete(null)}
        />
      )}
    </div>
  );
}
