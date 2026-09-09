'use client';
import { useApp, useActiveProject } from '@/context/AppContext';
import { Environment, REGION_LABELS } from '@/types';
import { apiArchitectureService } from '@/lib/services/ApiArchitectureService';
import { GitBranch, Copy, ArrowUpRight, Check, Loader2, AlertTriangle, X } from 'lucide-react';
import clsx from 'clsx';
import { useState } from 'react';

const ENV_CONFIG: Record<Environment, { label: string; color: string; bg: string; border: string }> = {
  development: { label: 'Development', color: 'text-blue-400', bg: 'bg-blue-900/20', border: 'border-blue-800' },
  staging:     { label: 'Staging',     color: 'text-yellow-400', bg: 'bg-yellow-900/20', border: 'border-yellow-800' },
  production:  { label: 'Production',  color: 'text-emerald-400', bg: 'bg-emerald-900/20', border: 'border-emerald-800' },
};

export default function EnvironmentsPanel() {
  const { state, dispatch } = useApp();
  const activeProject = useActiveProject();
  const { activeEnvironment } = state;

  const [promoted, setPromoted] = useState<string | null>(null);
  const [cloning, setCloning] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!activeProject) return null;

  const environments: Environment[] = ['development', 'staging', 'production'];

  async function handlePromote(from: Environment, to: Environment) {
    if (!activeProject || promoting || cloning) return;
    const key = `${from}-${to}`;
    setPromoting(key);
    setError(null);

    try {
      // If active environment is source, save any latest local edits first
      if (activeEnvironment === from) {
        await apiArchitectureService.saveCanvas(
          activeProject.id,
          activeProject.nodes,
          activeProject.edges,
          from,
        );
      }

      // Call backend promote endpoint
      await apiArchitectureService.promoteEnvironment(activeProject.id, from, to);

      // Reload destination environment canvas from backend
      const canvas = await apiArchitectureService.loadCanvas(activeProject.id, to);

      // Reconcile AppContext state with backend canonical data
      dispatch({
        type: 'SET_ENVIRONMENT_CANVAS',
        env: to,
        nodes: canvas.nodes,
        edges: canvas.edges,
      });

      setPromoted(key);
      setTimeout(() => setPromoted(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to promote environment ${from} to ${to}`);
    } finally {
      setPromoting(null);
    }
  }

  async function handleClone(from: Environment, to: Environment) {
    if (!activeProject || cloning || promoting) return;
    const key = `${from}-${to}`;
    setCloning(key);
    setError(null);

    try {
      // If active environment is source, save any latest local edits first
      if (activeEnvironment === from) {
        await apiArchitectureService.saveCanvas(
          activeProject.id,
          activeProject.nodes,
          activeProject.edges,
          from,
        );
      }

      // Call backend clone endpoint
      await apiArchitectureService.cloneEnvironment(activeProject.id, from, to);

      // Reload destination environment canvas from backend
      const canvas = await apiArchitectureService.loadCanvas(activeProject.id, to);

      // Reconcile AppContext state with backend canonical data
      dispatch({
        type: 'SET_ENVIRONMENT_CANVAS',
        env: to,
        nodes: canvas.nodes,
        edges: canvas.edges,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to clone environment ${from} to ${to}`);
    } finally {
      setCloning(null);
    }
  }

  function handleSwitch(env: Environment) {
    dispatch({ type: 'SET_ENVIRONMENT', env });
    dispatch({ type: 'SET_VIEW', view: 'canvas' });
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-900 p-5">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <GitBranch className="w-5 h-5 text-blue-400" />
          <h2 className="text-white font-bold text-lg">Environments</h2>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="bg-red-900/30 border border-red-700/80 rounded-xl p-3 mb-5 flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 text-red-300 text-xs">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{error}</span>
            </div>
            <button
              onClick={() => setError(null)}
              className="text-red-400 hover:text-red-200 text-xs p-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Current environment indicator */}
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 mb-6 flex items-center gap-3">
          <div className={clsx('w-2 h-2 rounded-full', ENV_CONFIG[activeEnvironment].color.replace('text-', 'bg-'))} />
          <p className="text-white text-sm">
            Currently viewing: <span className={clsx('font-semibold', ENV_CONFIG[activeEnvironment].color)}>{ENV_CONFIG[activeEnvironment].label}</span>
          </p>
        </div>

        {/* Environment cards */}
        <div className="space-y-4">
          {environments.map((env) => {
            const cfg = ENV_CONFIG[env];
            const envState = activeProject.environments[env];
            const isActive = env === activeEnvironment;
            const isCloningThis = cloning === `production-${env}`;
            return (
              <div key={env} className={clsx('bg-gray-800 border rounded-xl p-5', isActive ? cfg.border : 'border-gray-700')}>
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className={clsx('w-2.5 h-2.5 rounded-full', cfg.color.replace('text-', 'bg-'))} />
                    <div>
                      <h3 className={clsx('font-semibold text-sm', cfg.color)}>{cfg.label}</h3>
                      <p className="text-gray-500 text-xs">{REGION_LABELS[envState.region] ?? envState.region}</p>
                    </div>
                    {isActive && (
                      <span className="text-xs px-2 py-0.5 bg-gray-700 text-gray-400 rounded-full">Active</span>
                    )}
                  </div>
                  <button
                    onClick={() => handleSwitch(env)}
                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    Switch & Edit →
                  </button>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div className="text-center bg-gray-900 rounded-lg py-2">
                    <p className="text-white font-bold text-sm">{envState.nodes.length}</p>
                    <p className="text-gray-500 text-xs">Resources</p>
                  </div>
                  <div className="text-center bg-gray-900 rounded-lg py-2">
                    <p className="text-gray-400 text-sm">{envState.region}</p>
                    <p className="text-gray-500 text-xs">Region</p>
                  </div>
                  <div className="text-center bg-gray-900 rounded-lg py-2">
                    <p className="text-emerald-400 font-bold text-sm">{envState.nodes.length > 0 ? 'Active' : 'Empty'}</p>
                    <p className="text-gray-500 text-xs">Status</p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  {env !== 'production' && (
                    <button
                      onClick={() => handleClone('production', env)}
                      disabled={isCloningThis || !!promoting}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-300 hover:text-white rounded-lg text-xs font-medium transition-colors"
                    >
                      {isCloningThis ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Cloning...
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          Clone from Prod
                        </>
                      )}
                    </button>
                  )}
                  {env === 'staging' && (
                    <button
                      onClick={() => handlePromote('staging', 'production')}
                      disabled={promoting === 'staging-production' || !!cloning}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors"
                    >
                      {promoting === 'staging-production' ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Promoting...
                        </>
                      ) : promoted === 'staging-production' ? (
                        <>
                          <Check className="w-3 h-3" />
                          Promoted!
                        </>
                      ) : (
                        <>
                          <ArrowUpRight className="w-3 h-3" />
                          Promote to Prod
                        </>
                      )}
                    </button>
                  )}
                  {env === 'development' && (
                    <button
                      onClick={() => handlePromote('development', 'staging')}
                      disabled={promoting === 'development-staging' || !!cloning}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-700 hover:bg-yellow-600 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors"
                    >
                      {promoting === 'development-staging' ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Promoting...
                        </>
                      ) : promoted === 'development-staging' ? (
                        <>
                          <Check className="w-3 h-3" />
                          Promoted!
                        </>
                      ) : (
                        <>
                          <ArrowUpRight className="w-3 h-3" />
                          Promote to Staging
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Compare section */}
        <div className="mt-6 bg-gray-800 border border-gray-700 rounded-xl p-5">
          <h3 className="text-white font-semibold text-sm mb-4">Environment Comparison</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-700">
                  <th className="text-left py-2 font-medium">Metric</th>
                  {environments.map((e) => (
                    <th key={e} className={clsx('text-center py-2 font-medium', ENV_CONFIG[e].color)}>
                      {ENV_CONFIG[e].label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                <tr>
                  <td className="py-2 text-gray-400">Resources</td>
                  {environments.map((e) => (
                    <td key={e} className="py-2 text-center text-white">
                      {activeProject.environments[e].nodes.length}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="py-2 text-gray-400">Region</td>
                  {environments.map((e) => (
                    <td key={e} className="py-2 text-center text-gray-300">
                      {activeProject.environments[e].region}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="py-2 text-gray-400">Status</td>
                  {environments.map((e) => (
                    <td key={e} className={clsx('py-2 text-center', activeProject.environments[e].nodes.length > 0 ? 'text-emerald-400' : 'text-gray-600')}>
                      {activeProject.environments[e].nodes.length > 0 ? 'Configured' : 'Empty'}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
