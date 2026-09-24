import React, { useState, useEffect } from 'react';
import { ShieldCheck, ShieldAlert, X, Activity, ChevronDown, ChevronRight, CheckCircle2, HelpCircle } from 'lucide-react';
import { CanvasNode, CanvasEdge } from '@/types';
import type { ComplianceAssessmentResult, ComplianceResultItem } from '@/lib/engines/compliance/ComplianceEngine';
import clsx from 'clsx';

interface CompliancePanelProps {
  projectId: string;
  architectureId: string;
  resources: CanvasNode[];
  edges?: CanvasEdge[];
  environment?: string;
  onClose: () => void;
}

export default function CompliancePanel({ projectId, architectureId, resources, edges = [], environment, onClose }: CompliancePanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [frameworks, setFrameworks] = useState<('SOC2' | 'HIPAA' | 'PCI-DSS')[]>(['SOC2', 'PCI-DSS']);
  const [results, setResults] = useState<ComplianceAssessmentResult | null>(null);
  const [expandedRule, setExpandedRule] = useState<string | null>(null);
  const [evalTrigger, setEvalTrigger] = useState(0);

  const currentKey = frameworks.length > 0 ? `${architectureId}:${projectId}:${resources.length}:${frameworks.join(',')}:${evalTrigger}` : null;
  const [completedKey, setCompletedKey] = useState<string | null>(null);
  const loading = Boolean(currentKey && completedKey !== currentKey);

  useEffect(() => {
    if (frameworks.length === 0) {
      return;
    }
    const keyToResolve = `${architectureId}:${projectId}:${resources.length}:${frameworks.join(',')}:${evalTrigger}`;
    let cancelled = false;

    fetch(`/api/architecture/${architectureId}/compliance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, resources, edges, frameworks, env: environment })
    })
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Compliance evaluation failed');
        }
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          setResults(data);
          setError(null);
          setCompletedKey(keyToResolve);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to run compliance evaluation');
          setCompletedKey(keyToResolve);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [architectureId, projectId, resources, edges, environment, frameworks, evalTrigger]);

  const runEvaluation = () => {
    setError(null);
    setEvalTrigger((prev) => prev + 1);
  };

  const toggleFramework = (fw: 'SOC2' | 'HIPAA' | 'PCI-DSS') => {
    setFrameworks(prev => prev.includes(fw) ? prev.filter(f => f !== fw) : [...prev, fw]);
  };

  return (
    <div className="absolute right-4 top-20 bottom-4 w-96 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl flex flex-col z-30">
      <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-800/50 rounded-t-xl">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-emerald-400" />
          <h2 className="text-sm font-semibold text-white">Control Mapping (technical indicators)</h2>
        </div>
        <button onClick={onClose} className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-700 transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 border-b border-slate-800">
        <label className="text-xs font-semibold text-slate-400 mb-2 block">Frameworks to Evaluate</label>
        <div className="flex flex-wrap gap-2">
          {(['SOC2', 'HIPAA', 'PCI-DSS'] as const).map(fw => (
            <button
              key={fw}
              onClick={() => toggleFramework(fw)}
              className={clsx(
                'px-3 py-1.5 rounded-lg text-xs font-medium transition-all border',
                frameworks.includes(fw)
                  ? 'bg-blue-900/40 border-blue-500/50 text-blue-300'
                  : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-300'
              )}
            >
              {fw}
            </button>
          ))}
        </div>
        <button
          onClick={runEvaluation}
          disabled={loading || frameworks.length === 0}
          className="mt-4 w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {loading ? <Activity className="w-4 h-4 animate-spin" /> : 'Run Assessment'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {results ? (
          <>
            <div className="p-3 rounded-lg bg-slate-800/60 border border-slate-700 text-[11px] text-slate-400 leading-relaxed">
              {results.disclaimer}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              {([
                ['Indicators passed', results.passing, 'text-emerald-400'],
                ['Failing', results.failing, 'text-rose-400'],
                ['Not evaluated', results.notEvaluated, 'text-slate-400'],
              ] as const).map(([label, n, cls]) => (
                <div key={label} className="bg-slate-800/40 border border-slate-700 rounded-lg p-2">
                  <p className={clsx('text-lg font-bold', cls)}>{n}</p>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</p>
                </div>
              ))}
            </div>

            {results.results.map((r: ComplianceResultItem) => {
              const expanded = expandedRule === r.ruleId;
              const tone = r.status === 'fail' ? 'border-rose-500/30 bg-slate-800/40' : r.status === 'pass' ? 'border-emerald-500/20 bg-slate-800/20' : 'border-slate-600/40 bg-slate-800/20';
              return (
                <div key={r.ruleId} className={clsx('border rounded-xl overflow-hidden transition-all', tone)}>
                  <button
                    type="button"
                    className="w-full text-left p-3 flex gap-3 select-none items-start"
                    onClick={() => setExpandedRule(expanded ? null : r.ruleId)}
                    aria-expanded={expanded}
                  >
                    <div className="mt-0.5">
                      {r.status === 'pass' ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        : r.status === 'fail' ? <ShieldAlert className="w-4 h-4 text-rose-400" />
                          : <HelpCircle className="w-4 h-4 text-slate-400" />}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-bold text-slate-300">{r.framework}</span>
                        <span className="text-xs text-slate-500">{r.controlId}</span>
                        <span className={clsx('text-[10px] px-1.5 py-0.5 rounded', r.status === 'fail' ? 'bg-rose-500/15 text-rose-300' : r.status === 'pass' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-700 text-slate-300')}>
                          {r.status === 'fail' ? 'Gaps found' : r.status === 'pass' ? 'Technical indicators passed' : 'Not evaluated'}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-white leading-snug">{r.title}</p>
                    </div>
                    {expanded ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
                  </button>

                  {expanded && (
                    <div className="p-3 pt-2 border-t border-slate-700/50 bg-slate-900/30 text-xs space-y-2">
                      <p className="text-slate-400">{r.description}</p>
                      <p className="text-slate-300"><span className="font-semibold text-blue-300">Next step: </span>{r.recommendation}</p>
                      {r.evidence.length > 0 && (
                        <div>
                          <span className="font-semibold text-slate-400 block mb-1">{r.status === 'fail' ? 'Failing technical evidence' : 'Technical evidence'}</span>
                          <ul className="space-y-1 text-slate-300">{r.evidence.map((e) => <li key={e} className="font-mono text-[10px] leading-snug">{e}</li>)}</ul>
                        </div>
                      )}
                      {r.affectedResourceLabels.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {r.affectedResourceLabels.map((l) => (
                            <span key={l} className="px-1.5 py-0.5 bg-rose-500/10 text-rose-300 border border-rose-500/20 rounded text-[10px]">{l}</span>
                          ))}
                        </div>
                      )}
                      {r.notEvaluated.length > 0 && (
                        <div>
                          <span className="font-semibold text-slate-400 block mb-1">Not evaluated — evidence required</span>
                          <ul className="space-y-1 text-slate-400">{r.notEvaluated.map((e) => <li key={e} className="text-[10px] leading-snug">{e}</li>)}</ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        ) : error && !loading ? (
          <div className="p-4 bg-rose-900/20 border border-rose-500/30 rounded-xl text-center my-6">
            <ShieldAlert className="w-8 h-8 text-rose-400 mx-auto mb-2" />
            <p className="text-sm font-medium text-rose-200 mb-1">Compliance Evaluation Failed</p>
            <p className="text-xs text-rose-400/80 mb-3">{error}</p>
            <button
              onClick={runEvaluation}
              className="px-3 py-1.5 bg-rose-800 hover:bg-rose-700 text-white rounded-lg text-xs font-medium transition-colors"
            >
              Retry Evaluation
            </button>
          </div>
        ) : (
          !loading && <div className="text-center text-slate-500 text-sm mt-10">Select frameworks and run an assessment to see compliance findings.</div>
        )}
      </div>
    </div>
  );
}
