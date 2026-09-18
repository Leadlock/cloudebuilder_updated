import React, { useState, useEffect } from 'react';
import { ShieldCheck, ShieldAlert, X, Activity, ChevronDown, ChevronRight, CheckCircle2 } from 'lucide-react';
import { CanvasNode } from '@/types';
import clsx from 'clsx';

interface CompliancePanelProps {
  projectId: string;
  architectureId: string;
  resources: CanvasNode[];
  onClose: () => void;
}

export default function CompliancePanel({ projectId, architectureId, resources, onClose }: CompliancePanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [frameworks, setFrameworks] = useState<('SOC2' | 'HIPAA' | 'PCI-DSS')[]>(['SOC2', 'PCI-DSS']);
  const [results, setResults] = useState<any>(null);
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
      body: JSON.stringify({ projectId, resources, frameworks })
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
  }, [architectureId, projectId, resources, frameworks, evalTrigger]);

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
          <h2 className="text-sm font-semibold text-white">Compliance Center</h2>
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
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Overall Score</span>
              <div className={clsx(
                'px-3 py-1 rounded-full text-sm font-bold',
                results.score >= 90 ? 'bg-emerald-500/20 text-emerald-400' :
                results.score >= 70 ? 'bg-amber-500/20 text-amber-400' : 'bg-rose-500/20 text-rose-400'
              )}>
                {results.score}/100
              </div>
            </div>

            {results.results.map((r: any, idx: number) => {
              const rule = r.rule;
              const passed = r.evaluation.passed;
              const expanded = expandedRule === rule.id;

              return (
                <div key={idx} className={clsx(
                  'border rounded-xl overflow-hidden transition-all',
                  passed ? 'bg-slate-800/20 border-emerald-500/20' : 'bg-slate-800/40 border-rose-500/30'
                )}>
                  <div 
                    className="p-3 flex gap-3 cursor-pointer select-none items-start"
                    onClick={() => setExpandedRule(expanded ? null : rule.id)}
                  >
                    <div className="mt-0.5">
                      {passed ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <ShieldAlert className="w-4 h-4 text-rose-400" />
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-bold text-slate-300">{rule.framework}</span>
                        <span className="text-xs text-slate-500">{rule.controlId}</span>
                      </div>
                      <p className="text-sm font-medium text-white leading-snug">{rule.title}</p>
                    </div>
                    <div>
                      {expanded ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
                    </div>
                  </div>

                  {expanded && (
                    <div className="p-3 pt-0 border-t border-slate-700/50 mt-2 bg-slate-900/30 text-xs">
                      <p className="text-slate-400 mb-3">{rule.description}</p>
                      
                      {!passed && (
                        <>
                          <div className="mb-2">
                            <span className="font-semibold text-rose-300">Issue:</span>
                            <span className="text-slate-300 ml-2">{r.evaluation.recommendation}</span>
                          </div>
                          <div className="mb-2">
                            <span className="font-semibold text-blue-300">Remediation:</span>
                            <span className="text-slate-300 ml-2">{r.evaluation.remediation}</span>
                          </div>
                          <div className="mt-3">
                            <span className="font-semibold text-slate-400 block mb-1">Affected Resources:</span>
                            <div className="flex flex-wrap gap-1">
                              {r.evaluation.affectedResourceIds.map((id: string) => (
                                <span key={id} className="px-1.5 py-0.5 bg-rose-500/10 text-rose-300 border border-rose-500/20 rounded font-mono text-[10px]">
                                  {id}
                                </span>
                              ))}
                            </div>
                          </div>
                        </>
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
