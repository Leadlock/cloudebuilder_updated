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
  const isLight = state.theme === 'light';

  const [promoted, setPromoted] = useState<string | null>(null);
  const [cloning, setCloning] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!activeProject) return null;

  const environments: Environment[] = ['production'];

  async function handlePromote(from: Environment, to: Environment) {
    if (!activeProject || promoting || cloning) return;
    const key = `${from}-${to}`;
    setPromoting(key);
    setError(null);

    try {
      if (activeEnvironment === from) {
        await apiArchitectureService.saveCanvas(
          activeProject.id,
          activeProject.nodes,
          activeProject.edges,
          from,
        );
      }

      await apiArchitectureService.promoteEnvironment(activeProject.id, from, to);
      const canvas = await apiArchitectureService.loadCanvas(activeProject.id, to);

      dispatch({
        type: 'SET_ENVIRONMENT_CANVAS',
        env: to,
        nodes: canvas.nodes,
        edges: canvas.edges,
      });

      setPromoted(key);
      setTimeout(() => setPromoted(null), 2000);
    } catch {
      dispatch({ type: 'PROMOTE_ENVIRONMENT', from, to });
      setPromoted(key);
      setTimeout(() => setPromoted(null), 2000);
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
      if (activeEnvironment === from) {
        await apiArchitectureService.saveCanvas(
          activeProject.id,
          activeProject.nodes,
          activeProject.edges,
          from,
        ).catch(() => {});
      }

      await apiArchitectureService.cloneEnvironment(activeProject.id, from, to);
      const canvas = await apiArchitectureService.loadCanvas(activeProject.id, to);

      dispatch({
        type: 'SET_ENVIRONMENT_CANVAS',
        env: to,
        nodes: canvas.nodes,
        edges: canvas.edges,
      });
    } catch {
      dispatch({ type: 'CLONE_ENVIRONMENT', from, to });
    } finally {
      setCloning(null);
    }
  }

  function handleSwitch(env: Environment) {
    dispatch({ type: 'SET_ENVIRONMENT', env });
    dispatch({ type: 'SET_VIEW', view: 'canvas' });
  }

  return (
    <div className={clsx("flex-1 overflow-y-auto px-4 sm:px-6 py-6 pb-36 custom-scrollbar", isLight ? "bg-slate-50 text-slate-900" : "bg-gray-950 text-slate-100")}>
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <GitBranch className={clsx("w-6 h-6", isLight ? "text-blue-600" : "text-blue-400")} />
          <h2 className={clsx("font-bold text-lg", isLight ? "text-slate-900" : "text-white")}>Environments</h2>
        </div>

        {/* Error Alert */}
        {error && (
          <div className={clsx(
            "rounded-xl p-3 mb-5 flex items-start justify-between gap-2 border",
            isLight ? "bg-rose-50 border-rose-200" : "bg-red-900/30 border-red-700/80"
          )}>
            <div className={clsx("flex items-center gap-2 text-xs", isLight ? "text-rose-800" : "text-red-300")}>
              <AlertTriangle className={clsx("w-4 h-4 shrink-0", isLight ? "text-rose-600" : "text-red-400")} />
              <span>{error}</span>
            </div>
            <button
              onClick={() => setError(null)}
              className={clsx("text-xs p-1", isLight ? "text-rose-600 hover:text-rose-800" : "text-red-400 hover:text-red-200")}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Current environment indicator */}
        <div className={clsx("border rounded-xl p-4 mb-6 flex items-center gap-3", isLight ? "bg-white border-slate-200 shadow-sm" : "bg-gray-800 border-gray-700")}>
          <div className={clsx('w-2 h-2 rounded-full', ENV_CONFIG[activeEnvironment].color.replace('text-', 'bg-'))} />
          <p className={clsx("text-sm", isLight ? "text-slate-700" : "text-white")}>
            Currently viewing: <span className={clsx('font-semibold', isLight ? (activeEnvironment === 'development' ? 'text-blue-600' : activeEnvironment === 'staging' ? 'text-amber-600' : 'text-emerald-600') : ENV_CONFIG[activeEnvironment].color)}>{ENV_CONFIG[activeEnvironment].label}</span>
          </p>
        </div>

        {/* Environment cards */}
        <div className="space-y-4">
          {environments.map((env) => {
            const cfg = ENV_CONFIG[env];
            const envState = activeProject.environments[env];
            const isActive = env === activeEnvironment;
            const isCloningThis = cloning === `production-${env}`;
            const activeBorder = isLight 
              ? (env === 'development' ? 'border-blue-400 ring-1 ring-blue-400' : env === 'staging' ? 'border-amber-400 ring-1 ring-amber-400' : 'border-emerald-400 ring-1 ring-emerald-400')
              : cfg.border;
            const envColorClass = isLight 
              ? (env === 'development' ? 'text-blue-700' : env === 'staging' ? 'text-amber-700' : 'text-emerald-700')
              : cfg.color;

            return (
              <div key={env} className={clsx('border rounded-xl p-5 transition-all', isLight ? 'bg-white shadow-sm' : 'bg-gray-800', isActive ? activeBorder : isLight ? 'border-slate-200' : 'border-gray-700')}>
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className={clsx('w-2.5 h-2.5 rounded-full', cfg.color.replace('text-', 'bg-'))} />
                    <div>
                      <h3 className={clsx('font-semibold text-sm', envColorClass)}>{cfg.label}</h3>
                      <p className={clsx("text-xs", isLight ? "text-slate-500" : "text-gray-500")}>{REGION_LABELS[envState.region] ?? envState.region}</p>
                    </div>
                    {isActive && (
                      <span className={clsx("text-xs px-2 py-0.5 rounded-full font-medium", isLight ? "bg-slate-100 text-slate-700 border border-slate-200" : "bg-gray-700 text-gray-400")}>Active</span>
                    )}
                  </div>
                  <button
                    onClick={() => handleSwitch(env)}
                    className={clsx("text-xs font-semibold transition-colors", isLight ? "text-blue-600 hover:text-blue-700" : "text-blue-400 hover:text-blue-300")}
                  >
                    Switch & Edit →
                  </button>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div className={clsx("text-center rounded-lg py-2", isLight ? "bg-slate-50 border border-slate-200" : "bg-gray-900")}>
                    <p className={clsx("font-bold text-sm", isLight ? "text-slate-900" : "text-white")}>{envState.nodes.length}</p>
                    <p className={clsx("text-xs", isLight ? "text-slate-500" : "text-gray-500")}>Resources</p>
                  </div>
                  <div className={clsx("text-center rounded-lg py-2", isLight ? "bg-slate-50 border border-slate-200" : "bg-gray-900")}>
                    <p className={clsx("text-sm font-medium", isLight ? "text-slate-700" : "text-gray-400")}>{envState.region}</p>
                    <p className={clsx("text-xs", isLight ? "text-slate-500" : "text-gray-500")}>Region</p>
                  </div>
                  <div className={clsx("text-center rounded-lg py-2", isLight ? "bg-slate-50 border border-slate-200" : "bg-gray-900")}>
                    <p className={clsx("font-bold text-sm", isLight ? "text-emerald-600" : "text-emerald-400")}>{envState.nodes.length > 0 ? 'Active' : 'Empty'}</p>
                    <p className={clsx("text-xs", isLight ? "text-slate-500" : "text-gray-500")}>Status</p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  {env !== 'production' && (
                    <button
                      onClick={() => handleClone('production', env)}
                      disabled={isCloningThis || !!promoting}
                      className={clsx(
                        "flex items-center gap-1.5 px-3 py-1.5 disabled:opacity-50 rounded-lg text-xs font-medium transition-colors border",
                        isLight ? "bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300" : "bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white border-transparent"
                      )}
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
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition-colors shadow-sm"
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
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition-colors shadow-sm"
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
        <div className={clsx("mt-6 border rounded-xl p-5", isLight ? "bg-white border-slate-200 shadow-sm" : "bg-gray-800 border-gray-700")}>
          <h3 className={clsx("font-semibold text-sm mb-4", isLight ? "text-slate-900" : "text-white")}>Environment Comparison</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className={clsx("border-b", isLight ? "text-slate-500 border-slate-200" : "text-gray-500 border-gray-700")}>
                  <th className="text-left py-2 font-medium">Metric</th>
                  {environments.map((e) => (
                    <th key={e} className={clsx('text-center py-2 font-semibold', isLight ? (e === 'development' ? 'text-blue-700' : e === 'staging' ? 'text-amber-700' : 'text-emerald-700') : ENV_CONFIG[e].color)}>
                      {ENV_CONFIG[e].label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className={clsx("divide-y", isLight ? "divide-slate-100" : "divide-gray-700/50")}>
                <tr>
                  <td className={clsx("py-2.5 font-medium", isLight ? "text-slate-600" : "text-gray-400")}>Resources</td>
                  {environments.map((e) => (
                    <td key={e} className={clsx("py-2.5 text-center font-semibold", isLight ? "text-slate-900" : "text-white")}>
                      {activeProject.environments[e].nodes.length}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className={clsx("py-2.5 font-medium", isLight ? "text-slate-600" : "text-gray-400")}>Region</td>
                  {environments.map((e) => (
                    <td key={e} className={clsx("py-2.5 text-center", isLight ? "text-slate-700" : "text-gray-300")}>
                      {activeProject.environments[e].region}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className={clsx("py-2.5 font-medium", isLight ? "text-slate-600" : "text-gray-400")}>Status</td>
                  {environments.map((e) => (
                    <td key={e} className={clsx('py-2.5 text-center font-medium', activeProject.environments[e].nodes.length > 0 ? (isLight ? 'text-emerald-600' : 'text-emerald-400') : (isLight ? 'text-slate-400' : 'text-gray-600'))}>
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
