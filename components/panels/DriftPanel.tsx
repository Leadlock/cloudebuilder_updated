'use client';

import React, { useState, useEffect } from 'react';
import {
  RefreshCw, ShieldAlert, CheckCircle2, AlertTriangle, ArrowRight,
  Download, Upload, Eye, Layers, ExternalLink, Activity, Info
} from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '@/context/AppContext';
import type { DriftReport, ResourceDrift, ReconciliationMode } from '@/lib/drift/types';
import { CloudServiceIcon } from '@/components/icons/cloud/CloudServiceIcon';

export default function DriftPanel() {
  const { state, dispatch } = useApp();
  const isLight = state.theme === 'light';

  const activeProject = state.projects.find((p) => p.id === state.activeProjectId) ?? state.draftProject;
  const nodes = activeProject.nodes ?? [];

  const [loading, setLoading] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [report, setReport] = useState<DriftReport | null>(null);
  const [selectedResource, setSelectedResource] = useState<ResourceDrift | null>(null);
  const [reconciliationMessage, setReconciliationMessage] = useState<string | null>(null);

  // Poll or load initial drift status
  useEffect(() => {
    async function loadStatus() {
      try {
        const res = await fetch(`/api/drift/status?projectId=${activeProject.id}&environment=${state.activeEnvironment}`);
        if (res.ok) {
          const json = await res.json();
          const reportData = json.data?.report ?? json.report ?? json.data ?? json;
          if (reportData && Array.isArray(reportData.resources)) setReport(reportData);
        }
      } catch {}
    }
    loadStatus();
  }, [activeProject.id, state.activeEnvironment]);

  // Run on-demand drift scan
  const handleScan = async () => {
    setLoading(true);
    setReconciliationMessage(null);
    try {
      const res = await fetch('/api/drift/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: activeProject.id,
          environment: state.activeEnvironment,
          provider: activeProject.provider,
          nodes,
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const reportData = json.data ?? json;
        setReport(reportData);
        if (reportData.resources?.length > 0) {
          setSelectedResource(reportData.resources[0]);
        }
      }
    } catch (err) {
      console.error('Drift scan failed:', err);
    } finally {
      setLoading(false);
    }
  };

  // Reconcile
  const handleReconcile = async (mode: ReconciliationMode) => {
    setReconciling(true);
    setReconciliationMessage(null);
    try {
      const res = await fetch('/api/drift/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: activeProject.id,
          environment: state.activeEnvironment,
          mode,
          nodes,
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const result = json.data ?? json;
        setReconciliationMessage(result.message);

        // If imported to canvas, update local canvas nodes
        if (mode === 'import_drift_to_canvas' && result.updatedNodes) {
          for (const item of result.updatedNodes) {
            dispatch({
              type: 'UPDATE_NODE_CONFIG',
              nodeId: item.id,
              config: item.config,
            });
          }
        }
        // Refresh report
        await handleScan();
      }
    } catch (err) {
      console.error('Reconciliation failed:', err);
    } finally {
      setReconciling(false);
    }
  };

  const hasDrift = report && (report.driftedCount > 0 || report.missingCount > 0);

  return (
    <div className={clsx('flex flex-col h-full overflow-y-auto p-6 transition-colors', isLight ? 'bg-slate-50 text-slate-900' : 'bg-slate-950 text-slate-100')}>
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight">Automated Drift Detection & Reconciliation</h1>
            <span className={clsx('px-2.5 py-0.5 text-xs font-semibold rounded-full border', isLight ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-indigo-500/10 border-indigo-500/30 text-indigo-300')}>
              Spacelift TACOS Engine
            </span>
          </div>
          <p className={clsx('text-xs mt-1', isLight ? 'text-slate-500' : 'text-slate-400')}>
            Continuously monitors live cloud infrastructure for out-of-band changes and restores state integrity with two-way reconciliation.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleScan}
            disabled={loading || reconciling}
            className={clsx(
              'inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-white shadow-md transition-all',
              loading ? 'bg-indigo-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-500 active:scale-95',
            )}
          >
            <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
            {loading ? 'Scanning Cloud State…' : 'Run Drift Scan'}
          </button>
        </div>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className={clsx('p-4 rounded-2xl border transition-all', isLight ? 'bg-white border-slate-200 shadow-xs' : 'bg-slate-900/60 border-slate-800')}>
          <p className={clsx('text-xs font-medium', isLight ? 'text-slate-500' : 'text-slate-400')}>Inspected Resources</p>
          <p className="text-2xl font-bold mt-1">{report ? report.resources.length : nodes.length}</p>
          <p className={clsx('text-[11px] mt-1', isLight ? 'text-slate-400' : 'text-slate-500')}>Across canvas & state</p>
        </div>

        <div className={clsx('p-4 rounded-2xl border transition-all', isLight ? 'bg-white border-slate-200 shadow-xs' : 'bg-slate-900/60 border-slate-800')}>
          <div className="flex items-center gap-1.5 text-emerald-500">
            <CheckCircle2 className="w-4 h-4" />
            <p className={clsx('text-xs font-medium', isLight ? 'text-slate-600' : 'text-slate-300')}>In Sync</p>
          </div>
          <p className="text-2xl font-bold mt-1 text-emerald-500">{report ? report.inSyncCount : '—'}</p>
          <p className={clsx('text-[11px] mt-1', isLight ? 'text-slate-400' : 'text-slate-500')}>Matches canvas design</p>
        </div>

        <div className={clsx('p-4 rounded-2xl border transition-all', isLight ? 'bg-white border-slate-200 shadow-xs' : 'bg-slate-900/60 border-slate-800')}>
          <div className="flex items-center gap-1.5 text-amber-500">
            <AlertTriangle className="w-4 h-4" />
            <p className={clsx('text-xs font-medium', isLight ? 'text-slate-600' : 'text-slate-300')}>Drifted</p>
          </div>
          <p className="text-2xl font-bold mt-1 text-amber-500">{report ? report.driftedCount : '0'}</p>
          <p className={clsx('text-[11px] mt-1', isLight ? 'text-slate-400' : 'text-slate-500')}>Modified out-of-band</p>
        </div>

        <div className={clsx('p-4 rounded-2xl border transition-all', isLight ? 'bg-white border-slate-200 shadow-xs' : 'bg-slate-900/60 border-slate-800')}>
          <div className="flex items-center gap-1.5 text-rose-500">
            <ShieldAlert className="w-4 h-4" />
            <p className={clsx('text-xs font-medium', isLight ? 'text-slate-600' : 'text-slate-300')}>Missing / Deleted</p>
          </div>
          <p className="text-2xl font-bold mt-1 text-rose-500">{report ? report.missingCount : '0'}</p>
          <p className={clsx('text-[11px] mt-1', isLight ? 'text-slate-400' : 'text-slate-500')}>Removed in cloud console</p>
        </div>
      </div>

      {/* Reconciliation Actions Alert */}
      {hasDrift && (
        <div className={clsx('p-5 rounded-2xl border mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4', isLight ? 'bg-amber-50/80 border-amber-200' : 'bg-amber-950/20 border-amber-500/30')}>
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className={clsx('text-sm font-semibold', isLight ? 'text-amber-900' : 'text-amber-200')}>
                Infrastructure Drift Detected ({report.driftedCount + report.missingCount} out-of-band changes)
              </p>
              <p className={clsx('text-xs mt-0.5', isLight ? 'text-amber-700' : 'text-amber-400')}>
                Choose how you want to reconcile the discrepancy between your visual canvas and live cloud reality.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              onClick={() => handleReconcile('align_cloud_to_canvas')}
              disabled={reconciling}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs transition-all"
            >
              <Upload className="w-3.5 h-3.5" />
              Align Cloud to Canvas (Re-apply)
            </button>
            <button
              onClick={() => handleReconcile('import_drift_to_canvas')}
              disabled={reconciling}
              className={clsx('inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold border transition-all', isLight ? 'bg-white border-amber-300 text-amber-900 hover:bg-amber-100/50' : 'bg-amber-500/10 border-amber-500/30 text-amber-200 hover:bg-amber-500/20')}
            >
              <Download className="w-3.5 h-3.5" />
              Import Drift to Canvas
            </button>
          </div>
        </div>
      )}

      {reconciliationMessage && (
        <div className={clsx('p-4 rounded-xl border mb-6 text-xs flex items-center gap-2', isLight ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300')}>
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-500" />
          <span>{reconciliationMessage}</span>
        </div>
      )}

      {/* Main Split: Resource List vs Diff Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1 min-h-0">
        {/* Left: Resource Drift List */}
        <div className={clsx('lg:col-span-5 rounded-2xl border overflow-hidden flex flex-col', isLight ? 'bg-white border-slate-200' : 'bg-slate-900/60 border-slate-800')}>
          <div className={clsx('px-4 py-3 border-b text-xs font-semibold flex items-center justify-between', isLight ? 'bg-slate-50 border-slate-200 text-slate-700' : 'bg-slate-900 border-slate-800 text-slate-300')}>
            <span>Resources ({report?.resources.length ?? nodes.length})</span>
            <span className="text-[11px] font-normal opacity-70">Click to inspect differences</span>
          </div>

          <div className="divide-y overflow-y-auto flex-1 divide-slate-100 dark:divide-slate-800/60">
            {report?.resources && report.resources.length > 0 ? (
              report.resources.map((res) => {
                const isSelected = selectedResource?.resourceId === res.resourceId;
                return (
                  <button
                    key={res.resourceId}
                    onClick={() => setSelectedResource(res)}
                    className={clsx(
                      'w-full text-left p-3.5 flex items-center justify-between transition-colors',
                      isSelected ? (isLight ? 'bg-indigo-50/70 text-indigo-900' : 'bg-indigo-500/15 text-indigo-200') : (isLight ? 'hover:bg-slate-50' : 'hover:bg-slate-800/40'),
                    )}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <CloudServiceIcon resourceType={res.resourceType} size={20} />
                      <div className="truncate">
                        <p className="text-xs font-semibold truncate">{res.nodeLabel}</p>
                        <p className={clsx('text-[11px] truncate', isLight ? 'text-slate-400' : 'text-slate-500')}>{res.resourceType}</p>
                      </div>
                    </div>

                    <div className="shrink-0 flex items-center gap-2">
                      <span className={clsx(
                        'px-2 py-0.5 rounded-full text-[10px] font-semibold border uppercase tracking-wider',
                        res.status === 'in_sync' && (isLight ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'),
                        res.status === 'drifted' && (isLight ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-amber-500/10 border-amber-500/30 text-amber-400'),
                        res.status === 'missing' && (isLight ? 'bg-rose-50 border-rose-200 text-rose-700' : 'bg-rose-500/10 border-rose-500/30 text-rose-400'),
                      )}>
                        {res.status.replace('_', ' ')}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5 opacity-40" />
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="p-8 text-center">
                <Activity className="w-8 h-8 mx-auto mb-2 opacity-30 text-indigo-500" />
                <p className="text-xs font-medium">No drift report available</p>
                <p className={clsx('text-[11px] mt-1', isLight ? 'text-slate-400' : 'text-slate-500')}>Click &quot;Run Drift Scan&quot; above to inspect your cloud state.</p>
              </div>
            )}
          </div>
        </div>

        {/* Right: Difference Inspector */}
        <div className={clsx('lg:col-span-7 rounded-2xl border p-5 flex flex-col', isLight ? 'bg-white border-slate-200' : 'bg-slate-900/60 border-slate-800')}>
          {selectedResource ? (
            <div className="flex flex-col h-full">
              <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800 mb-4">
                <div className="flex items-center gap-3">
                  <CloudServiceIcon resourceType={selectedResource.resourceType} size={24} />
                  <div>
                    <h3 className="text-sm font-bold">{selectedResource.nodeLabel}</h3>
                    <p className={clsx('text-xs font-mono', isLight ? 'text-slate-500' : 'text-slate-400')}>{selectedResource.cloudResourceId}</p>
                  </div>
                </div>

                <span className={clsx(
                  'px-2.5 py-1 rounded-md text-xs font-semibold border',
                  selectedResource.status === 'in_sync' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
                  selectedResource.status === 'drifted' && 'border-amber-500/30 bg-amber-500/10 text-amber-500',
                  selectedResource.status === 'missing' && 'border-rose-500/30 bg-rose-500/10 text-rose-500',
                )}>
                  Status: {selectedResource.status.toUpperCase()}
                </span>
              </div>

              {selectedResource.differences.length > 0 ? (
                <div className="space-y-3 flex-1 overflow-y-auto">
                  <p className={clsx('text-xs font-semibold uppercase tracking-wider', isLight ? 'text-slate-500' : 'text-slate-400')}>
                    Attribute Discrepancies ({selectedResource.differences.length})
                  </p>

                  {selectedResource.differences.map((diff, idx) => (
                    <div key={idx} className={clsx('p-4 rounded-xl border', isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800')}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold font-mono text-indigo-500">{diff.field}</span>
                        <span className={clsx('text-[10px] uppercase font-semibold px-2 py-0.5 rounded', diff.severity === 'critical' ? 'bg-rose-500/10 text-rose-500' : 'bg-amber-500/10 text-amber-500')}>
                          {diff.severity}
                        </span>
                      </div>
                      <p className={clsx('text-xs mb-3', isLight ? 'text-slate-600' : 'text-slate-300')}>{diff.description}</p>

                      <div className="grid grid-cols-2 gap-3 font-mono text-xs">
                        <div className={clsx('p-2.5 rounded-lg border', isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800')}>
                          <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Canvas Intended Value</p>
                          <p className="font-semibold text-emerald-500 truncate">{JSON.stringify(diff.expected)}</p>
                        </div>
                        <div className={clsx('p-2.5 rounded-lg border', isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800')}>
                          <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Live Cloud Reality</p>
                          <p className="font-semibold text-rose-500 truncate">{JSON.stringify(diff.actual)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                  <CheckCircle2 className="w-10 h-10 text-emerald-500 mb-2 opacity-80" />
                  <p className="text-sm font-bold">Resource is in Perfect Sync</p>
                  <p className={clsx('text-xs mt-1 max-w-sm', isLight ? 'text-slate-500' : 'text-slate-400')}>
                    The live cloud attributes match the canvas specification for this resource. No out-of-band modifications detected.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <Eye className="w-8 h-8 opacity-30 text-indigo-500 mb-2" />
              <p className="text-xs font-semibold">No resource selected</p>
              <p className={clsx('text-[11px] mt-1', isLight ? 'text-slate-400' : 'text-slate-500')}>Select a resource from the left to view detailed live cloud differences.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
