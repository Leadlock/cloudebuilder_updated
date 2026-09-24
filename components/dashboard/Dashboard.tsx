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

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 80 ? 'text-emerald-400' : score >= 60 ? 'text-yellow-400' : 'text-red-400';
  return <span className={clsx('font-bold', color)}>{score}</span>;
}

function ProviderBadge({ provider }: { provider: CloudProvider }) {
  return (
    <span className={clsx('text-xs px-2 py-0.5 rounded-full font-medium',
      provider === 'aws' ? 'bg-orange-900/40 text-orange-300' :
      provider === 'azure' ? 'bg-blue-900/40 text-blue-300' :
      'bg-purple-900/40 text-purple-300'
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
    { icon: Wand2, label: 'Architecture Wizard', desc: 'Guided step-by-step setup', view: 'wizard' as const, color: 'bg-blue-900/30 border-blue-800 text-blue-400' },
    { icon: LayoutGrid, label: 'Template Gallery', desc: 'Start from a template', view: 'templates' as const, color: 'bg-purple-900/30 border-purple-800 text-purple-400' },
    { icon: Sparkles, label: 'AI Generator', desc: 'Describe your architecture', view: 'ai-generator' as const, color: 'bg-pink-900/30 border-pink-800 text-pink-400' },
    { icon: Upload, label: 'Import Infrastructure', desc: 'Import existing resources', view: 'import' as const, color: 'bg-orange-900/30 border-orange-800 text-orange-400' },
  ];

  return (
    <div className="flex-1 overflow-y-auto bg-gray-900 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-gray-400 text-sm mt-0.5">Design, scale, and manage cloud infrastructure</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            id="btn-open-visual-builder"
            onClick={() => {
              dispatch({ type: 'SET_ACTIVE_PROJECT', id: 'draft-project' });
              dispatch({ type: 'SET_VIEW', view: 'canvas' });
            }}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white rounded-xl text-sm font-semibold shadow-lg shadow-blue-500/25 transition-all transform active:scale-98"
          >
            <Box className="w-4 h-4" /> Open Visual Builder
          </button>
          <button
            id="btn-new-project"
            onClick={() => setShowNewProject(true)}
            className="flex items-center gap-2 px-3.5 py-2 bg-gray-800/90 hover:bg-gray-700 text-gray-200 border border-gray-700 rounded-xl text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" /> New Project
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total Projects', value: projects.length, icon: Box, color: 'text-blue-400', bg: 'bg-blue-900/30' },
          { label: 'Total Resources', value: totalResources, icon: Server, color: 'text-purple-400', bg: 'bg-purple-900/30' },
          { label: 'Avg Security Score', value: scoredProjects.length ? `${avgScore}/100` : 'Not assessed', icon: ShieldCheck, color: avgScore >= 80 ? 'text-emerald-400' : 'text-yellow-400', bg: avgScore >= 80 ? 'bg-emerald-900/30' : 'bg-yellow-900/30' },
          { label: `Est. Monthly Cost (${activeCurrency})`, value: formatCurrency(totalCost, activeCurrency), icon: DollarSign, color: 'text-orange-400', bg: 'bg-orange-900/30' },
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="bg-gray-800 rounded-xl p-4 border border-gray-700">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-gray-400 text-xs font-medium mb-1">{label}</p>
                <p className={clsx('text-2xl font-bold', color)}>{value}</p>
              </div>
              <div className={clsx('w-9 h-9 rounded-lg flex items-center justify-center', bg)}>
                <Icon className={clsx('w-5 h-5', color)} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Quick actions */}
      <div className="mb-6">
        <h2 className="text-white font-semibold text-sm mb-3">Quick Start</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {quickActions.map(({ icon: Icon, label, desc, view, color }) => (
            <button
              key={view}
              onClick={() => dispatch({ type: 'SET_VIEW', view })}
              className={clsx('text-left p-3 rounded-xl border transition-colors hover:opacity-90', color)}
            >
              <Icon className="w-5 h-5 mb-2" />
              <p className="text-white text-sm font-medium">{label}</p>
              <p className="text-gray-500 text-xs mt-0.5">{desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Projects */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h2 className="text-white font-semibold text-sm">Projects</h2>
          {/* Provider tabs */}
          <div className="flex gap-1 bg-gray-800 rounded-lg p-0.5">
            {(['all', 'aws', 'azure', 'multi'] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={clsx('px-2.5 py-1 rounded text-xs font-medium capitalize transition-colors',
                  tab === t ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
                )}>
                {t === 'multi' ? 'Multi' : t === 'all' ? 'All' : t.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <span className="text-gray-500 text-sm">{filteredProjects.length} project{filteredProjects.length !== 1 ? 's' : ''}</span>
      </div>

      {filteredProjects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Cloud className="w-12 h-12 text-gray-700 mb-4" />
          <p className="text-gray-400 font-medium mb-1">No projects yet</p>
          <p className="text-gray-600 text-sm mb-4">Create your first cloud infrastructure project</p>
          <button onClick={() => setShowNewProject(true)} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium">
            <Plus className="w-4 h-4" /> Create Project
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredProjects.map((project) => (
            <div
              key={project.id}
              className="bg-gray-800 border border-gray-700 rounded-xl p-5 hover:border-gray-600 transition-colors group cursor-pointer"
              onClick={() => {
                dispatch({ type: 'SET_ACTIVE_PROJECT', id: project.id });
                dispatch({ type: 'SET_VIEW', view: 'canvas' });
              }}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 className="text-white font-semibold text-sm truncate">{project.name}</h3>
                    <ProviderBadge provider={project.provider} />
                  </div>
                  {project.description && <p className="text-gray-500 text-xs line-clamp-2">{project.description}</p>}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); dispatch({ type: 'DELETE_PROJECT', id: project.id }); }}
                  className="opacity-0 group-hover:opacity-100 ml-2 p-1 text-gray-600 hover:text-red-400 rounded transition-all shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Tags */}
              {project.tags.length > 0 && (
                <div className="flex gap-1 flex-wrap mb-3">
                  {project.tags.slice(0, 3).map((t) => (
                    <span key={t} className="text-[10px] px-1.5 py-0.5 bg-gray-700 text-gray-400 rounded">{t}</span>
                  ))}
                </div>
              )}

              {/* Stats */}
              <div className="grid grid-cols-4 gap-2 mb-3">
                <div className="text-center">
                  <p className="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">Resources</p>
                  <p className="text-white font-semibold text-sm">{project.resourceCount}</p>
                </div>
                <div className="text-center border-x border-gray-700">
                  <p className="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">Security</p>
                  <p className="text-sm font-semibold" title={project.securityCoveragePct != null ? `Assessment coverage ${project.securityCoveragePct}%` : undefined}>
                    {project.securityScored === false ? <span className="text-gray-500">Not scored</span> : <><ScoreBadge score={project.securityScore} /><span className="text-gray-600">/100</span></>}
                  </p>
                </div>
                <div className="text-center border-r border-gray-700">
                  <p className="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">Arch.</p>
                  <p className="text-sm font-semibold"><ScoreBadge score={project.architectureScore} /><span className="text-gray-600">/100</span></p>
                </div>
                <div className="text-center">
                  <p className="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">Cost</p>
                  <p className="text-orange-400 font-semibold text-sm">{formatCurrency(project.estimatedMonthlyCost * exchangeRate, activeCurrency)}</p>
                </div>
              </div>

              {/* Security bar */}
              <div className="mb-3">
                <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div className={clsx('h-full rounded-full transition-all', project.securityScore >= 80 ? 'bg-emerald-500' : project.securityScore >= 60 ? 'bg-yellow-500' : 'bg-red-500')}
                    style={{ width: `${project.securityScored === false ? 0 : project.securityScore}%` }} />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-gray-600 text-xs flex items-center gap-1" suppressHydrationWarning>
                    <Clock className="w-3 h-3" /> {formatDate(project.updatedAt)}
                  </span>
                  <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full', project.environment === 'production' ? 'bg-emerald-900/40 text-emerald-500' : project.environment === 'staging' ? 'bg-yellow-900/40 text-yellow-500' : 'bg-gray-700 text-gray-500')}>
                    {project.environment}
                  </span>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); dispatch({ type: 'SET_ACTIVE_PROJECT', id: project.id }); dispatch({ type: 'SET_VIEW', view: 'canvas' }); }}
                  className="text-blue-400 hover:text-blue-300 text-xs font-medium transition-colors"
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
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 w-full max-w-md">
            <h2 className="text-white font-bold text-lg mb-4">Create New Project</h2>
            <div className="space-y-4">
              <div>
                <label className="text-gray-400 text-sm mb-1.5 block">Project Name</label>
                <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  placeholder="My Infrastructure Project" autoFocus
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-gray-400 text-sm mb-1.5 block">Cloud Provider</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['aws', 'azure', 'multi'] as CloudProvider[]).map((p) => (
                    <button key={p} onClick={() => { setNewProvider(p); setSelectedTemplateId('blank'); }}
                      className={clsx('flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-colors',
                        newProvider === p ? (p === 'aws' ? 'border-orange-500 bg-orange-900/20' : p === 'azure' ? 'border-blue-500 bg-blue-900/20' : 'border-purple-500 bg-purple-900/20') : 'border-gray-700 hover:border-gray-600'
                      )}
                    >
                      <div className={clsx('w-8 h-8 rounded flex items-center justify-center text-xs font-bold', p === 'aws' ? 'bg-orange-500/20 text-orange-400' : p === 'azure' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400')}>
                        {p === 'aws' ? 'AWS' : p === 'azure' ? 'AZ' : '☁'}
                      </div>
                      <p className="text-white text-xs font-medium">{p === 'aws' ? 'Amazon AWS' : p === 'azure' ? 'Microsoft Azure' : 'Multi-cloud'}</p>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-gray-400 text-sm mb-1.5 block">Starting Template</label>
                <select
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
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
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowNewProject(false)} className="flex-1 px-4 py-2 text-gray-400 hover:text-white border border-gray-700 rounded-lg text-sm transition-colors">Cancel</button>
              <button onClick={handleCreate} disabled={!newName.trim()} className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors">Create Project</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
