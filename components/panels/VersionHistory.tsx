'use client';
import { useState, useEffect } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { ArchitectureVersion } from '@/types';
import { apiArchitectureService } from '@/lib/services/ApiArchitectureService';
import { formatDateTime } from '@/lib/date';
import { History, RotateCcw, GitCommit, User, Clock, Save, Loader2, AlertTriangle, X } from 'lucide-react';
import clsx from 'clsx';

export default function VersionHistory() {
  const { state, dispatch } = useApp();
  const { activeEnvironment } = state;
  const activeProject = useActiveProject();

  const [versions, setVersions] = useState<ArchitectureVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showSave, setShowSave] = useState(false);
  const [summary, setSummary] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState<string | null>(null);

  const projectId = activeProject?.id;

  // ── Load versions from backend ──────────────────────────────────────────
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    apiArchitectureService.listVersions(projectId, activeEnvironment)
      .then((loaded) => {
        if (!cancelled) {
          if (loaded && loaded.length > 0) {
            setVersions(loaded.slice().reverse());
          } else {
            setVersions(activeProject?.versions ?? []);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVersions(activeProject?.versions ?? []);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, activeEnvironment, activeProject?.versions]);

  if (!activeProject) return null;

  async function handleSave() {
    if (!summary.trim() || isSaving || !activeProject) return;
    setIsSaving(true);
    setError(null);

    try {
      // Ensure canvas is persisted to backend for this environment first
      await apiArchitectureService.saveCanvas(
        activeProject.id,
        activeProject.nodes,
        activeProject.edges,
        activeEnvironment,
      ).catch(() => {});

      // Save version snapshot on backend
      const savedVersion = await apiArchitectureService.saveVersion(
        activeProject.id,
        summary.trim(),
        activeEnvironment,
      );

      setVersions((prev) => [savedVersion, ...prev.filter((v) => v.id !== savedVersion.id)]);
      setSummary('');
      setShowSave(false);
    } catch {
      // Local in-memory fallback
      dispatch({ type: 'SAVE_VERSION', summary: summary.trim() });
      const localVersion: ArchitectureVersion = {
        id: `v-${Date.now()}`,
        version: versions.length + 1,
        label: summary.trim(),
        timestamp: new Date().toISOString(),
        author: 'Current User',
        summary: summary.trim(),
        nodes: activeProject.nodes,
        edges: activeProject.edges,
      };
      setVersions((prev) => [localVersion, ...prev]);
      setSummary('');
      setShowSave(false);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRestore(versionId: string) {
    if (!activeProject || isRestoring) return;
    setIsRestoring(versionId);
    setError(null);

    try {
      const result = await apiArchitectureService.restoreVersion(
        activeProject.id,
        versionId,
        activeEnvironment,
      );

      dispatch({
        type: 'RESTORE_VERSION',
        versionId,
        nodes: result.nodes,
        edges: result.edges,
      });
      setConfirmRestore(null);
    } catch {
      // Local in-memory fallback
      dispatch({
        type: 'RESTORE_VERSION',
        versionId,
      });
      setConfirmRestore(null);
    } finally {
      setIsRestoring(null);
    }
  }

  const isLight = state.theme === 'light';

  return (
    <div
      className={clsx(
        'flex-1 overflow-y-auto px-4 sm:px-6 py-6 pb-36 custom-scrollbar transition-colors',
        isLight ? 'bg-slate-50 text-slate-900' : 'bg-gray-950 text-slate-100'
      )}
    >
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <History className={clsx('w-5 h-5', isLight ? 'text-blue-600' : 'text-blue-400')} />
            <h2 className={clsx('font-bold text-lg', isLight ? 'text-slate-900' : 'text-white')}>Version History</h2>
          </div>
          <button
            onClick={() => setShowSave(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium transition-colors shadow-sm"
          >
            <Save className="w-3.5 h-3.5" />
            Save Version
          </button>
        </div>

        {/* Error Alert */}
        {error && (
          <div
            className={clsx(
              'rounded-xl p-3 mb-5 flex items-start justify-between gap-2 border',
              isLight ? 'bg-rose-50 border-rose-200 text-rose-800' : 'bg-red-900/30 border-red-700/80 text-red-300'
            )}
          >
            <div className="flex items-center gap-2 text-xs">
              <AlertTriangle className={clsx('w-4 h-4 shrink-0', isLight ? 'text-rose-600' : 'text-red-400')} />
              <span>{error}</span>
            </div>
            <button
              onClick={() => setError(null)}
              className={clsx('p-1 rounded transition-colors', isLight ? 'text-slate-400 hover:text-slate-700' : 'text-gray-400 hover:text-white')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Save version form */}
        {showSave && (
          <div
            className={clsx(
              'border rounded-xl p-4 mb-5 shadow-sm transition-colors',
              isLight ? 'bg-white border-blue-300 shadow-blue-100/50' : 'bg-gray-800 border-blue-700'
            )}
          >
            <p className={clsx('font-medium text-sm mb-3', isLight ? 'text-slate-900' : 'text-white')}>
              Save Current Version
            </p>
            <input
              type="text"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              placeholder="Describe what changed (e.g. Added RDS and Redis)"
              autoFocus
              disabled={isSaving}
              className={clsx(
                'w-full border rounded-lg px-3 py-2 text-sm mb-3 disabled:opacity-50 transition-all focus:outline-none focus:ring-2 focus:ring-blue-500/50',
                isLight
                  ? 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:bg-white focus:border-blue-500'
                  : 'bg-gray-900 border-gray-700 text-white placeholder-gray-600 focus:border-blue-500'
              )}
            />
            <div className="flex gap-2">
              <button
                onClick={() => setShowSave(false)}
                disabled={isSaving}
                className={clsx(
                  'flex-1 py-1.5 border rounded-lg text-xs font-medium disabled:opacity-50 transition-colors',
                  isLight
                    ? 'border-slate-300 text-slate-700 hover:bg-slate-100 bg-white'
                    : 'border-gray-700 text-gray-400 hover:bg-gray-700'
                )}
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!summary.trim() || isSaving}
                className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 shadow-sm transition-colors"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Save'
                )}
              </button>
            </div>
          </div>
        )}

        {/* Current state */}
        <div
          className={clsx(
            'border rounded-xl p-4 mb-4 shadow-sm transition-colors',
            isLight ? 'bg-white border-slate-200' : 'bg-gray-800 border-gray-600'
          )}
        >
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center shrink-0 mt-0.5 shadow-sm">
              <GitCommit className="w-3 h-3 text-white" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <p className={clsx('font-medium text-sm', isLight ? 'text-slate-900' : 'text-white')}>
                  Current (unsaved)
                </p>
                <span
                  className={clsx(
                    'text-xs px-2 py-0.5 rounded-full font-semibold border',
                    isLight
                      ? 'bg-blue-50 text-blue-700 border-blue-200'
                      : 'bg-blue-900/40 text-blue-300 border-blue-800'
                  )}
                >
                  HEAD
                </span>
              </div>
              <div
                className={clsx(
                  'flex items-center gap-3 mt-1 text-xs',
                  isLight ? 'text-slate-500' : 'text-gray-500'
                )}
              >
                <span className="flex items-center gap-1">
                  <User className="w-3 h-3" /> Current User
                </span>
                <span className="flex items-center gap-1" suppressHydrationWarning>
                  <Clock className="w-3 h-3" /> {formatDateTime(activeProject.updatedAt)}
                </span>
              </div>
              <p className={clsx('text-xs mt-1', isLight ? 'text-slate-600' : 'text-gray-400')}>
                {activeProject.nodes.length} resources, {activeProject.edges.length} connections
              </p>
            </div>
          </div>
        </div>

        {/* Loading state */}
        {loading && (
          <div className={clsx('flex items-center justify-center py-8 gap-2', isLight ? 'text-slate-500' : 'text-gray-400')}>
            <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
            <span className="text-xs">Loading version history from backend...</span>
          </div>
        )}

        {/* Version list */}
        {!loading && versions.length === 0 ? (
          <div
            className={clsx(
              'flex flex-col items-center justify-center py-12 text-center rounded-xl border transition-colors',
              isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-gray-800/50 border-gray-700'
            )}
          >
            <History className={clsx('w-10 h-10 mb-3', isLight ? 'text-slate-300' : 'text-gray-700')} />
            <p className={clsx('font-medium', isLight ? 'text-slate-700' : 'text-gray-400')}>No saved versions</p>
            <p className={clsx('text-sm mt-1', isLight ? 'text-slate-400' : 'text-gray-600')}>
              Save the current state to start tracking history
            </p>
          </div>
        ) : (
          <div className="relative">
            <div
              className={clsx(
                'absolute left-3 top-0 bottom-0 w-px',
                isLight ? 'bg-slate-200' : 'bg-gray-700'
              )}
            />
            <div className="space-y-3">
              {versions.map((v, idx) => (
                <div key={v.id} className="relative pl-9">
                  <div
                    className={clsx(
                      'absolute left-0 w-6 h-6 rounded-full flex items-center justify-center shrink-0 border',
                      idx === 0
                        ? isLight
                          ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                          : 'bg-emerald-900 text-emerald-400 border-emerald-700'
                        : isLight
                        ? 'bg-slate-200 text-slate-700 border-slate-300'
                        : 'bg-gray-700 text-gray-400 border-gray-600'
                    )}
                  >
                    <span className="text-[10px] font-bold">v{v.version}</span>
                  </div>
                  <div
                    className={clsx(
                      'border rounded-xl p-4 transition-all shadow-xs',
                      isLight
                        ? 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm'
                        : 'bg-gray-800 border-gray-700 hover:border-gray-600'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className={clsx('font-medium text-sm', isLight ? 'text-slate-900' : 'text-white')}>
                          {v.summary}
                        </p>
                        <div
                          className={clsx(
                            'flex items-center gap-3 mt-1 text-xs',
                            isLight ? 'text-slate-500' : 'text-gray-500'
                          )}
                        >
                          <span className="flex items-center gap-1">
                            <User className="w-3 h-3" />
                            {v.author}
                          </span>
                          <span className="flex items-center gap-1" suppressHydrationWarning>
                            <Clock className="w-3 h-3" />
                            {formatDateTime(v.timestamp)}
                          </span>
                        </div>
                        <p className={clsx('text-xs mt-1', isLight ? 'text-slate-500' : 'text-gray-500')}>
                          {v.nodeCount ?? v.nodes?.length ?? 0} resources
                        </p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        {confirmRestore === v.id ? (
                          <>
                            <button
                              onClick={() => setConfirmRestore(null)}
                              disabled={isRestoring === v.id}
                              className={clsx(
                                'px-2 py-1 text-xs border rounded-lg disabled:opacity-50 transition-colors',
                                isLight
                                  ? 'border-slate-300 text-slate-600 hover:bg-slate-100 bg-white'
                                  : 'text-gray-400 border-gray-700 hover:bg-gray-700'
                              )}
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => handleRestore(v.id)}
                              disabled={isRestoring === v.id}
                              className="px-2 py-1 text-xs bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white rounded-lg font-medium flex items-center gap-1 shadow-sm"
                            >
                              {isRestoring === v.id ? (
                                <>
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                  Restoring...
                                </>
                              ) : (
                                'Confirm'
                              )}
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setConfirmRestore(v.id)}
                            disabled={!!isRestoring}
                            className={clsx(
                              'flex items-center gap-1 px-2.5 py-1 text-xs border rounded-lg transition-colors disabled:opacity-40 font-medium',
                              isLight
                                ? 'bg-slate-50 hover:bg-slate-100 border-slate-300 text-slate-700'
                                : 'text-gray-300 hover:text-white border-gray-700 hover:border-gray-600 bg-gray-900/60'
                            )}
                          >
                            <RotateCcw className="w-3 h-3" />
                            Restore
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
