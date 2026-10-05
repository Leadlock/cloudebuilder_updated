import React, { useState, useEffect } from 'react';
import { ShieldCheck, ShieldAlert, X, Activity, ChevronDown, ChevronRight, CheckCircle2, HelpCircle } from 'lucide-react';
import { CanvasNode, CanvasEdge } from '@/types';
import type { ComplianceAssessmentResult, ComplianceResultItem } from '@/lib/engines/compliance/ComplianceEngine';
import { useApp } from '@/context/AppContext';
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
  const { state } = useApp();
  const isLight = state.theme === 'light';

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
    <div className={clsx(
      "absolute right-4 top-20 bottom-4 w-96 rounded-xl shadow-2xl flex flex-col z-30 border",
      isLight ? "bg-white border-slate-200 text-slate-900 shadow-xl" : "bg-slate-900 border-slate-700 text-slate-100"
    )}>
      <div className={clsx(
        "p-4 border-b flex items-center justify-between rounded-t-xl",
        isLight ? "border-slate-200 bg-slate-50" : "border-slate-800 bg-slate-800/50"
      )}>
        <div className="flex items-center gap-2">
          <ShieldCheck className={clsx("w-5 h-5", isLight ? "text-emerald-600" : "text-emerald-400")} />
          <h2 className={clsx("text-sm font-semibold", isLight ? "text-slate-900" : "text-white")}>Control Mapping (technical indicators)</h2>
        </div>
        <button onClick={onClose} className={clsx("p-1 rounded-lg transition-colors", isLight ? "text-slate-400 hover:text-slate-800 hover:bg-slate-200" : "text-slate-400 hover:text-white hover:bg-slate-700")}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className={clsx("p-4 border-b", isLight ? "border-slate-200" : "border-slate-800")}>
        <label className={clsx("text-xs font-semibold mb-2 block", isLight ? "text-slate-600" : "text-slate-400")}>Frameworks to Evaluate</label>
        <div className="flex flex-wrap gap-2">
          {(['SOC2', 'HIPAA', 'PCI-DSS'] as const).map(fw => {
            const active = frameworks.includes(fw);
            return (
              <button
                key={fw}
                onClick={() => toggleFramework(fw)}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-xs font-medium transition-all border',
                  active
                    ? (isLight ? 'bg-blue-50 border-blue-300 text-blue-700 font-semibold' : 'bg-blue-900/40 border-blue-500/50 text-blue-300')
                    : (isLight ? 'bg-slate-100 border-slate-200 text-slate-600 hover:bg-slate-200' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-300')
                )}
              >
                {fw}
              </button>
            );
          })}
        </div>
        <button
          onClick={runEvaluation}
          disabled={loading || frameworks.length === 0}
          className="mt-4 w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {loading ? <Activity className="w-4 h-4 animate-spin" /> : 'Run Assessment'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
        {results ? (
          <>
            <div className={clsx(
              "p-3 rounded-lg border text-[11px] leading-relaxed",
              isLight ? "bg-slate-50 border-slate-200 text-slate-600" : "bg-slate-800/60 border-slate-700 text-slate-400"
            )}>
              {results.disclaimer}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              {([
                ['Indicators passed', results.passing, isLight ? 'text-emerald-600' : 'text-emerald-400'],
                ['Failing', results.failing, isLight ? 'text-rose-600' : 'text-rose-400'],
                ['Not evaluated', results.notEvaluated, isLight ? 'text-slate-500' : 'text-slate-400'],
              ] as const).map(([label, n, cls]) => (
                <div key={label} className={clsx("border rounded-lg p-2", isLight ? "bg-slate-50 border-slate-200" : "bg-slate-800/40 border-slate-700")}>
                  <p className={clsx('text-lg font-bold', cls)}>{n}</p>
                  <p className={clsx("text-[10px] uppercase tracking-wide", isLight ? "text-slate-500" : "text-slate-500")}>{label}</p>
                </div>
              ))}
            </div>

            {results.results.map((r: ComplianceResultItem) => {
              const expanded = expandedRule === r.ruleId;
              const tone = isLight
                ? (r.status === 'fail' ? 'border-rose-200 bg-rose-50/50' : r.status === 'pass' ? 'border-emerald-200 bg-emerald-50/30' : 'border-slate-200 bg-slate-50')
                : (r.status === 'fail' ? 'border-rose-500/30 bg-slate-800/40' : r.status === 'pass' ? 'border-emerald-500/20 bg-slate-800/20' : 'border-slate-600/40 bg-slate-800/20');
              
              return (
                <div key={r.ruleId} className={clsx('border rounded-xl overflow-hidden transition-all', tone)}>
                  <button
                    type="button"
                    className="w-full text-left p-3 flex gap-3 select-none items-start"
                    onClick={() => setExpandedRule(expanded ? null : r.ruleId)}
                    aria-expanded={expanded}
                  >
                    <div className="mt-0.5">
                      {r.status === 'pass' ? <CheckCircle2 className={clsx("w-4 h-4", isLight ? "text-emerald-600" : "text-emerald-400")} />
                        : r.status === 'fail' ? <ShieldAlert className={clsx("w-4 h-4", isLight ? "text-rose-600" : "text-rose-400")} />
                          : <HelpCircle className={clsx("w-4 h-4", isLight ? "text-slate-400" : "text-slate-400")} />}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={clsx("text-xs font-bold", isLight ? "text-slate-800" : "text-slate-300")}>{r.framework}</span>
                        <span className={clsx("text-xs", isLight ? "text-slate-500" : "text-slate-500")}>{r.controlId}</span>
                        <span className={clsx(
                          'text-[10px] px-1.5 py-0.5 rounded font-medium',
                          isLight
                            ? (r.status === 'fail' ? 'bg-rose-100 text-rose-800' : r.status === 'pass' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700')
                            : (r.status === 'fail' ? 'bg-rose-500/15 text-rose-300' : r.status === 'pass' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-700 text-slate-300')
                        )}>
                          {r.status === 'fail' ? 'Gaps found' : r.status === 'pass' ? 'Technical indicators passed' : 'Not evaluated'}
                        </span>
                      </div>
                      <p className={clsx("text-sm font-medium leading-snug", isLight ? "text-slate-900" : "text-white")}>{r.title}</p>
                    </div>
                    {expanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                  </button>

                  {expanded && (
                    <div className={clsx(
                      "p-3 pt-2 border-t text-xs space-y-2",
                      isLight ? "border-slate-200 bg-white text-slate-700" : "border-slate-700/50 bg-slate-900/30 text-slate-300"
                    )}>
                      <p className={isLight ? "text-slate-600" : "text-slate-400"}>{r.description}</p>
                      <p className={isLight ? "text-slate-800" : "text-slate-300"}>
                        <span className={clsx("font-semibold", isLight ? "text-indigo-600" : "text-blue-300")}>Next step: </span>{r.recommendation}
                      </p>
                      {r.evidence.length > 0 && (
                        <div>
                          <span className={clsx("font-semibold block mb-1", isLight ? "text-slate-700" : "text-slate-400")}>{r.status === 'fail' ? 'Failing technical evidence' : 'Technical evidence'}</span>
                          <ul className={clsx("space-y-1", isLight ? "text-slate-600" : "text-slate-300")}>{r.evidence.map((e) => <li key={e} className="font-mono text-[10px] leading-snug">{e}</li>)}</ul>
                        </div>
                      )}
                      {r.affectedResourceLabels.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {r.affectedResourceLabels.map((l) => (
                            <span key={l} className={clsx(
                              "px-1.5 py-0.5 rounded text-[10px] border",
                              isLight ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-rose-500/10 text-rose-300 border-rose-500/20"
                            )}>{l}</span>
                          ))}
                        </div>
                      )}
                      {r.notEvaluated.length > 0 && (
                        <div>
                          <span className={clsx("font-semibold block mb-1", isLight ? "text-slate-700" : "text-slate-400")}>Not evaluated — evidence required</span>
                          <ul className={clsx("space-y-1", isLight ? "text-slate-500" : "text-slate-400")}>{r.notEvaluated.map((e) => <li key={e} className="text-[10px] leading-snug">{e}</li>)}</ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        ) : error && !loading ? (
          <div className={clsx("p-4 border rounded-xl text-center my-6", isLight ? "bg-rose-50 border-rose-200" : "bg-rose-900/20 border-rose-500/30")}>
            <ShieldAlert className={clsx("w-8 h-8 mx-auto mb-2", isLight ? "text-rose-600" : "text-rose-400")} />
            <p className={clsx("text-sm font-medium mb-1", isLight ? "text-rose-900" : "text-rose-200")}>Compliance Evaluation Failed</p>
            <p className={clsx("text-xs mb-3", isLight ? "text-rose-600" : "text-rose-400/80")}>{error}</p>
            <button
              onClick={runEvaluation}
              className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-semibold transition-colors"
            >
              Retry Evaluation
            </button>
          </div>
        ) : (
          !loading && <div className={clsx("text-center text-sm mt-10", isLight ? "text-slate-500" : "text-slate-500")}>Select frameworks and run an assessment to see compliance findings.</div>
        )}
      </div>
    </div>
  );
}
