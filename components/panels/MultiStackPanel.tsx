'use client';

import React, { useState, useEffect } from 'react';
import {
  Layers, GitFork, Play, CheckCircle2, Clock, AlertCircle, RefreshCw,
  ArrowRight, ShieldCheck, Database, Server, Globe, Key, Terminal, ChevronRight
} from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '@/context/AppContext';
import type { ProjectStackGraph, StackDefinition, MultiStackRunProgress } from '@/lib/stacks/types';

const LAYER_ICONS: Record<string, React.ElementType> = {
  network: Globe,
  data: Database,
  compute: Server,
  app: Globe,
  security: Key,
};

export default function MultiStackPanel() {
  const { state, dispatch } = useApp();
  const isLight = state.theme === 'light';

  const activeProject = state.projects.find((p) => p.id === state.activeProjectId) ?? state.draftProject;
  const nodes = activeProject.nodes ?? [];

  const [graph, setGraph] = useState<ProjectStackGraph | null>(null);
  const [selectedStackId, setSelectedStackId] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const [pipelineProgress, setPipelineProgress] = useState<MultiStackRunProgress | null>(null);

  // Load stack graph on mount
  useEffect(() => {
    async function loadStacks() {
      try {
        const res = await fetch(`/api/stacks?projectId=${activeProject.id}&environment=${state.activeEnvironment}`);
        if (res.ok) {
          const json = await res.json();
          const graphData = json.data ?? json;
          setGraph(graphData);
          const firstKey = Object.keys(graphData?.stacks || {})[0];
          if (firstKey) setSelectedStackId(firstKey);
        }
      } catch (err) {
        console.error('Failed to load stacks:', err);
      }
    }
    loadStacks();
  }, [activeProject.id, state.activeEnvironment]);

  // Auto-cluster from canvas
  const handleAutoCluster = async () => {
    try {
      const res = await fetch('/api/stacks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: activeProject.id,
          environment: state.activeEnvironment,
          action: 'auto_cluster',
          nodes,
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const graphData = json.data?.graph ?? json.data ?? json.graph ?? json;
        setGraph(graphData);
        const firstKey = Object.keys(graphData?.stacks || {})[0];
        if (firstKey) setSelectedStackId(firstKey);
      }
    } catch (err) {
      console.error('Auto cluster failed:', err);
    }
  };

  // Run multi-stack pipeline
  const handleExecute = async (action: 'plan' | 'apply') => {
    setExecuting(true);
    try {
      const res = await fetch('/api/stacks/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: activeProject.id,
          environment: state.activeEnvironment,
          action,
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const progress = json.data ?? json;
        setPipelineProgress(progress);
        // Refresh graph state
        const gRes = await fetch(`/api/stacks?projectId=${activeProject.id}&environment=${state.activeEnvironment}`);
        if (gRes.ok) {
          const gJson = await gRes.json();
          const gData = gJson.data ?? gJson;
          setGraph(gData);
        }
      }
    } catch (err) {
      console.error('Execution failed:', err);
    } finally {
      setExecuting(false);
    }
  };

  const selectedStack: StackDefinition | null = (graph?.stacks && selectedStackId && graph.stacks[selectedStackId]) ? graph.stacks[selectedStackId] : null;

  return (
    <div className={clsx('flex flex-col h-full overflow-y-auto p-6 transition-colors', isLight ? 'bg-slate-50 text-slate-900' : 'bg-slate-950 text-slate-100')}>
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight">Multi-Stack DAG Orchestration</h1>
            <span className={clsx('px-2.5 py-0.5 text-xs font-semibold rounded-full border', isLight ? 'bg-cyan-50 border-cyan-200 text-cyan-700' : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-300')}>
              Spacelift Stack-of-Stacks
            </span>
          </div>
          <p className={clsx('text-xs mt-1', isLight ? 'text-slate-500' : 'text-slate-400')}>
            Orchestrates decoupled infrastructure stacks in topological dependency order (Directed Acyclic Graph) with inter-stack output binding.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={handleAutoCluster}
            disabled={executing}
            className={clsx('px-3.5 py-2 rounded-xl text-xs font-semibold border transition-all', isLight ? 'bg-white border-slate-300 text-slate-700 hover:bg-slate-100' : 'bg-slate-900 border-slate-700 text-slate-200 hover:bg-slate-800')}
          >
            Auto-Cluster Canvas Stacks
          </button>
          <button
            onClick={() => handleExecute('plan')}
            disabled={executing}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 text-white shadow-md transition-all active:scale-95"
          >
            <Clock className="w-3.5 h-3.5" />
            Plan All Stacks (DAG)
          </button>
          <button
            onClick={() => handleExecute('apply')}
            disabled={executing}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-md transition-all active:scale-95"
          >
            <Play className="w-3.5 h-3.5" />
            Apply Pipeline
          </button>
          <button
            id="btn-stacks-next-deploy"
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'deploy' })}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-md transition-all active:scale-95"
            title="Proceed to logical next phase: Terraform & Cloud Deployment"
          >
            <span>Next: Terraform & Deploy →</span>
          </button>
        </div>
      </div>

      {/* DAG Tiers Progression Visualizer */}
      <div className={clsx('p-5 rounded-2xl border mb-6', isLight ? 'bg-white border-slate-200 shadow-xs' : 'bg-slate-900/60 border-slate-800')}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <GitFork className="w-4 h-4 text-cyan-500" />
            <h2 className="text-xs font-bold uppercase tracking-wider">Topological Execution Tiers (Kahn&apos;s Algorithm)</h2>
          </div>
          <span className={clsx('text-[11px] font-mono', isLight ? 'text-slate-500' : 'text-slate-400')}>
            {graph?.tiers?.length ?? 0} Sequential Stages · Parallel execution within tiers
          </span>
        </div>

        <div className="flex items-center gap-4 overflow-x-auto pb-2">
          {graph?.tiers && graph.tiers.length > 0 ? (
            graph.tiers.map((tier, idx) => (
              <React.Fragment key={tier.tierIndex}>
                <div className={clsx('p-3.5 rounded-xl border shrink-0 min-w-[220px]', isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800')}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-bold text-cyan-500 uppercase tracking-wider">Tier {tier.tierIndex}</span>
                    <span className="text-[10px] opacity-60">{tier.stackIds.length} stack(s)</span>
                  </div>

                  <div className="space-y-2">
                    {tier.stackIds.map((stackId) => {
                      const st = graph.stacks[stackId];
                      if (!st) return null;
                      const Icon = LAYER_ICONS[st.layer] || Layers;
                      const isSelected = selectedStackId === stackId;

                      return (
                        <button
                          key={stackId}
                          onClick={() => setSelectedStackId(stackId)}
                          className={clsx(
                            'w-full text-left p-2.5 rounded-lg border text-xs flex items-center justify-between transition-all',
                            isSelected
                              ? 'border-cyan-500 bg-cyan-500/10 text-cyan-300 font-semibold ring-1 ring-cyan-500'
                              : (isLight ? 'bg-white border-slate-200 hover:border-slate-300' : 'bg-slate-900 border-slate-800 hover:border-slate-700'),
                          )}
                        >
                          <div className="flex items-center gap-2 truncate">
                            <Icon className="w-3.5 h-3.5 shrink-0 text-cyan-500" />
                            <span className="truncate">{st.name}</span>
                          </div>

                          <span className={clsx(
                            'w-2 h-2 rounded-full shrink-0',
                            st.status === 'applied' && 'bg-emerald-500',
                            st.status === 'planned' && 'bg-cyan-500',
                            st.status === 'planning' || st.status === 'applying' ? 'bg-amber-500 animate-pulse' : '',
                            st.status === 'idle' && 'bg-slate-400',
                          )} />
                        </button>
                      );
                    })}
                  </div>
                </div>

                {idx < graph.tiers.length - 1 && (
                  <ArrowRight className="w-4 h-4 shrink-0 opacity-30 text-cyan-500" />
                )}
              </React.Fragment>
            ))
          ) : (
            <p className="text-xs text-slate-400">No stacks calculated yet. Click &quot;Auto-Cluster Canvas Stacks&quot; above.</p>
          )}
        </div>
      </div>

      {/* Main Split: Selected Stack Details & Inter-Stack Wiring */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1 min-h-0">
        {/* Left: Stack Inspector */}
        <div className={clsx('lg:col-span-6 rounded-2xl border p-5 flex flex-col', isLight ? 'bg-white border-slate-200' : 'bg-slate-900/60 border-slate-800')}>
          {selectedStack ? (
            <div className="flex flex-col h-full">
              <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800 mb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold">{selectedStack.name}</h3>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 uppercase">
                      {selectedStack.layer}
                    </span>
                  </div>
                  <p className={clsx('text-xs mt-0.5', isLight ? 'text-slate-500' : 'text-slate-400')}>{selectedStack.description}</p>
                </div>

                <span className={clsx(
                  'px-2.5 py-1 rounded-md text-xs font-semibold border uppercase tracking-wider',
                  selectedStack.status === 'applied' && 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
                  selectedStack.status === 'planned' && 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400',
                  selectedStack.status === 'idle' && 'bg-slate-500/10 border-slate-500/30 text-slate-400',
                )}>
                  {selectedStack.status}
                </span>
              </div>

              {/* Dependencies & Assigned Resources */}
              <div className="space-y-4 flex-1 overflow-y-auto">
                <div>
                  <p className={clsx('text-xs font-semibold uppercase tracking-wider mb-2', isLight ? 'text-slate-500' : 'text-slate-400')}>
                    Upstream Dependencies ({selectedStack.dependsOn.length})
                  </p>
                  {selectedStack.dependsOn.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {selectedStack.dependsOn.map((dep) => (
                        <span key={dep} className={clsx('px-2.5 py-1 rounded-lg border text-xs font-mono flex items-center gap-1.5', isLight ? 'bg-slate-100 border-slate-200' : 'bg-slate-900 border-slate-800')}>
                          <ArrowRight className="w-3 h-3 text-cyan-500" />
                          {graph?.stacks[dep]?.name || dep}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className={clsx('text-xs italic', isLight ? 'text-slate-400' : 'text-slate-500')}>Zero dependencies (Foundation stack)</p>
                  )}
                </div>

                {/* Variable Bindings (Inputs) */}
                <div>
                  <p className={clsx('text-xs font-semibold uppercase tracking-wider mb-2', isLight ? 'text-slate-500' : 'text-slate-400')}>
                    Input Variable Bindings ({selectedStack.inputs.length})
                  </p>
                  {selectedStack.inputs.length > 0 ? (
                    <div className="space-y-2">
                      {selectedStack.inputs.map((inp, idx) => (
                        <div key={idx} className={clsx('p-2.5 rounded-lg border text-xs flex items-center justify-between font-mono', isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800')}>
                          <span className="text-cyan-400 font-semibold">{inp.name}</span>
                          <span className="text-slate-400">← {inp.fromStackId}.{inp.fromOutput}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className={clsx('text-xs italic', isLight ? 'text-slate-400' : 'text-slate-500')}>No upstream variable bindings</p>
                  )}
                </div>

                {/* Exported Outputs */}
                <div>
                  <p className={clsx('text-xs font-semibold uppercase tracking-wider mb-2', isLight ? 'text-slate-500' : 'text-slate-400')}>
                    Exported Outputs ({selectedStack.outputs.length})
                  </p>
                  <div className="space-y-2">
                    {selectedStack.outputs.map((out, idx) => (
                      <div key={idx} className={clsx('p-2.5 rounded-lg border text-xs flex items-center justify-between font-mono', isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800')}>
                        <div>
                          <p className="text-emerald-400 font-semibold">{out.name}</p>
                          <p className="text-[10px] text-slate-400 font-sans">{out.description}</p>
                        </div>
                        <span className="text-slate-300 font-bold">{JSON.stringify(out.exportValue)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-400">Select a stack to view its configuration.</p>
          )}
        </div>

        {/* Right: Pipeline Execution Live Logs */}
        <div className={clsx('lg:col-span-6 rounded-2xl border p-5 flex flex-col', isLight ? 'bg-white border-slate-200' : 'bg-slate-900/60 border-slate-800')}>
          <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800 mb-3">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-emerald-500" />
              <h3 className="text-xs font-bold uppercase tracking-wider">Pipeline Execution Logs</h3>
            </div>
            {pipelineProgress && (
              <span className="text-xs font-mono text-emerald-400">{pipelineProgress.status.toUpperCase()}</span>
            )}
          </div>

          <div className="flex-1 bg-slate-950 rounded-xl p-4 font-mono text-xs text-emerald-400/90 overflow-y-auto space-y-1.5 border border-slate-800">
            {pipelineProgress?.logs && pipelineProgress.logs.length > 0 ? (
              pipelineProgress.logs.map((log, idx) => (
                <div key={idx} className="leading-relaxed">
                  <span className="text-slate-500 mr-2">&gt;</span>
                  {log}
                </div>
              ))
            ) : (
              <div className="text-slate-500 italic p-4 text-center">
                Pipeline execution logs will appear here when you click &quot;Plan All Stacks&quot; or &quot;Apply Pipeline&quot;.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
