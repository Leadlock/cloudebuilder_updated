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

  return (
    <div className="flex-1 overflow-y-auto bg-gray-900 p-5">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <History className="w-5 h-5 text-blue-400" />
            <h2 className="text-white font-bold text-lg">Version History</h2>
          </div>
          <button
            onClick={() => setShowSave(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            Save Version
          </button>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="bg-red-900/30 border border-red-700/80 rounded-xl p-3 mb-5 flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 text-red-300 text-xs">
              <AlertTriangle className="w-4 h-4 shrink-0 text-red-400" />
              <span>{error}</span>
            </div>
            <button onClick={() => setError(null)} className="text-gray-400 hover:text-white">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Save version form */}
        {showSave && (
          <div className="bg-gray-800 border border-blue-700 rounded-xl p-4 mb-5">
            <p className="text-white font-medium text-sm mb-3">Save Current Version</p>
            <input
              type="text"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              placeholder="Describe what changed (e.g. Added RDS and Redis)"
              autoFocus
              disabled={isSaving}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 mb-3 disabled:opacity-50"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setShowSave(false)}
                disabled={isSaving}
                className="flex-1 py-1.5 border border-gray-700 text-gray-400 rounded-lg text-xs disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!summary.trim() || isSaving}
                className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-xs font-medium flex items-center justify-center gap-1.5"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" />
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
        <div className="bg-gray-800 border border-gray-600 rounded-xl p-4 mb-4">
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center shrink-0 mt-0.5">
              <GitCommit className="w-3 h-3 text-white" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <p className="text-white font-medium text-sm">Current (unsaved)</p>
                <span className="text-xs px-2 py-0.5 bg-blue-900/40 text-blue-300 rounded-full">HEAD</span>
              </div>
              <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                <span className="flex items-center gap-1"><User className="w-3 h-3" /> Current User</span>
                <span className="flex items-center gap-1" suppressHydrationWarning><Clock className="w-3 h-3" /> {formatDateTime(activeProject.updatedAt)}</span>
              </div>
              <p className="text-gray-400 text-xs mt-1">{activeProject.nodes.length} resources, {activeProject.edges.length} connections</p>
            </div>
          </div>
        </div>

        {/* Loading state */}
        {loading && (
          <div className="flex items-center justify-center py-8 text-gray-400 gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
            <span className="text-xs">Loading version history from backend...</span>
          </div>
        )}

        {/* Version list */}
        {!loading && versions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center bg-gray-800/50 rounded-xl border border-gray-700">
            <History className="w-10 h-10 text-gray-700 mb-3" />
            <p className="text-gray-400 font-medium">No saved versions</p>
            <p className="text-gray-600 text-sm mt-1">Save the current state to start tracking history</p>
          </div>
        ) : (
          <div className="relative">
            <div className="absolute left-3 top-0 bottom-0 w-px bg-gray-700" />
            <div className="space-y-3">
              {versions.map((v, idx) => (
                <div key={v.id} className="relative pl-9">
                  <div className={clsx('absolute left-0 w-6 h-6 rounded-full flex items-center justify-center shrink-0', idx === 0 ? 'bg-emerald-900 text-emerald-400' : 'bg-gray-700 text-gray-500')}>
                    <span className="text-[10px] font-bold">v{v.version}</span>
                  </div>
                  <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 hover:border-gray-600 transition-colors">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-white font-medium text-sm">{v.summary}</p>
                        <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                          <span className="flex items-center gap-1"><User className="w-3 h-3" />{v.author}</span>
                          <span className="flex items-center gap-1" suppressHydrationWarning><Clock className="w-3 h-3" />{formatDateTime(v.timestamp)}</span>
                        </div>
                        <p className="text-gray-600 text-xs mt-1">{v.nodeCount ?? v.nodes?.length ?? 0} resources</p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        {confirmRestore === v.id ? (
                          <>
                            <button
                              onClick={() => setConfirmRestore(null)}
                              disabled={isRestoring === v.id}
                              className="px-2 py-1 text-xs text-gray-400 border border-gray-700 rounded-lg disabled:opacity-50"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => handleRestore(v.id)}
                              disabled={isRestoring === v.id}
                              className="px-2 py-1 text-xs bg-orange-700 hover:bg-orange-600 disabled:opacity-50 text-white rounded-lg font-medium flex items-center gap-1"
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
                            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition-colors disabled:opacity-40"
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
