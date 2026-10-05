'use client';
import { useApp, useActiveProject } from '@/context/AppContext';
import { Activity, ShieldCheck, Brain, CheckSquare, ArrowRight, ShieldAlert, Sparkles, Scale, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { apiSecurityService } from '@/lib/services/ApiSecurityService';
import { apiAdvisorService, AdvisorResult } from '@/lib/services/ApiAdvisorService';
import { apiWellArchitectedService } from '@/lib/services/ApiWellArchitectedService';
import { useEffect, useState } from 'react';
import { SecurityIssue } from '@/types';
import { WaAssessment } from '@/lib/engines/wellArchitected/types';
import { runSecurityScan } from '@/lib/analysis';
import { scoreArchitecture, generateRecommendations } from '@/lib/generator';

export default function AnalyzePanel() {
  const { state, dispatch } = useApp();
  const activeProject = useActiveProject();

  const [loading, setLoading] = useState(true);
  const [securityScore, setSecurityScore] = useState<number | null>(null);
  const [securityIssues, setSecurityIssues] = useState<number>(0);
  const [advisorScore, setAdvisorScore] = useState<number | null>(null);
  const [advisorRecs, setAdvisorRecs] = useState<number>(0);
  const [waScore, setWaScore] = useState<number | null>(null);
  const [waFindings, setWaFindings] = useState<number>(0);

  useEffect(() => {
    if (!activeProject || activeProject.nodes.length === 0) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;

    Promise.all([
      apiSecurityService.scan(activeProject.nodes).catch(() => runSecurityScan(activeProject.nodes)),
      apiAdvisorService.analyze(activeProject.nodes, activeProject.scaleProfile?.expectedUsers).catch((): AdvisorResult => ({
        score: scoreArchitecture(activeProject.nodes),
        recommendations: generateRecommendations(activeProject.nodes).map((r) => ({
          id: r.id,
          category: r.category as any,
          severity: r.severity as any,
          title: r.title,
          description: r.description,
          affectedResourceIds: [],
          affectedResourceLabels: r.affectedResources,
          rationale: r.description,
          suggestedAction: r.action,
        })),
        fromApi: false,
      })),
      apiWellArchitectedService.analyze(activeProject.nodes, activeProject.edges).catch(() => null)
    ]).then(([sec, adv, wa]) => {
      if (cancelled) return;
      const issues = sec as SecurityIssue[];
      setSecurityIssues(issues.length);
      const crit = issues.filter(i => i.severity === 'critical').length;
      const high = issues.filter(i => i.severity === 'high').length;
      setSecurityScore(Math.max(0, 100 - (crit * 20) - (high * 10)));

      const advisor = adv as AdvisorResult | null;
      if (advisor) {
        setAdvisorScore(advisor.score.overall);
        setAdvisorRecs(advisor.recommendations.length);
      }

      const waRes = wa as WaAssessment | null;
      if (waRes) {
        setWaScore(waRes.overallScore);
        setWaFindings(waRes.findings.length);
      }
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [activeProject?.id, activeProject?.updatedAt, activeProject?.nodes.length, activeProject?.edges.length, activeProject?.scaleProfile?.expectedUsers, state.architectureVersion, state.activeEnvironment]);

  const isLight = state.theme === 'light';

  if (!activeProject || activeProject.nodes.length === 0) {
    return (
      <div className={clsx("flex-1 flex items-center justify-center", isLight ? "bg-slate-50" : "bg-gray-900")}>
        <div className="text-center px-8 py-12">
          <Activity className={clsx("w-12 h-12 mx-auto mb-4", isLight ? "text-slate-300" : "text-gray-700")} />
          <p className={clsx("font-medium text-lg", isLight ? "text-slate-700" : "text-gray-400")}>No architecture to analyze</p>
          <p className={clsx("text-sm mt-1", isLight ? "text-slate-500" : "text-gray-600")}>Add resources to the canvas to see insights</p>
        </div>
      </div>
    );
  }

  const overallScore = Math.round(
    [securityScore, advisorScore, waScore].filter(s => s !== null).reduce((a, b) => (a || 0) + (b || 0), 0) /
    ([securityScore, advisorScore, waScore].filter(s => s !== null).length || 1)
  ) || 0;

  const scoreColor = overallScore >= 80 
    ? (isLight ? 'text-emerald-600' : 'text-emerald-400')
    : overallScore >= 60 
      ? (isLight ? 'text-amber-600' : 'text-amber-400') 
      : (isLight ? 'text-rose-600' : 'text-rose-400');
  const isStale = state.architectureVersion > state.lastSavedVersion;

  return (
    <div className={clsx("flex-1 overflow-y-auto px-4 sm:px-6 py-6 pb-36 custom-scrollbar", isLight ? "bg-slate-50 text-slate-900" : "bg-slate-950 text-slate-100")}>
      <div className="max-w-5xl mx-auto space-y-6">
        {isStale && (
          <div className={clsx(
            "rounded-xl p-4 flex items-center justify-between border",
            isLight ? "bg-amber-50 border-amber-200" : "bg-amber-900/30 border-amber-800/50"
          )}>
            <div className="flex items-center gap-3">
              <AlertTriangle className={clsx("w-5 h-5", isLight ? "text-amber-600" : "text-amber-400")} />
              <p className={clsx("text-sm font-medium", isLight ? "text-amber-800" : "text-amber-300")}>You have unsaved changes. Save your architecture to refresh this analysis.</p>
            </div>
            <button 
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'canvas' })}
              className={clsx(
                "px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors",
                isLight ? "bg-amber-600 hover:bg-amber-700 text-white" : "bg-amber-800 hover:bg-amber-700 text-white"
              )}
            >
              Return to Builder
            </button>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div>
            <h2 className={clsx("text-2xl font-bold flex items-center gap-3", isLight ? "text-slate-900" : "text-white")}>
              <Activity className={clsx("w-6 h-6", isLight ? "text-cyan-600" : "text-cyan-400")} />
              Architecture Intelligence Overview
            </h2>
            <p className={clsx("text-sm mt-1", isLight ? "text-slate-500" : "text-slate-400")}>Unified insights for your multi-cloud architecture.</p>
          </div>
          <div className={clsx(
            "text-right rounded-xl px-4 py-3 shadow-sm border",
            isLight ? "bg-white border-slate-200" : "bg-slate-900 border-slate-800 shadow-lg"
          )}>
            <p className={clsx("text-xs uppercase tracking-wider font-semibold mb-1", isLight ? "text-slate-400" : "text-slate-500")}>Overall Health Score</p>
            {loading ? (
              <div className={clsx("h-8 w-16 rounded animate-pulse ml-auto", isLight ? "bg-slate-200" : "bg-slate-800")} />
            ) : (
              <p className={clsx("text-3xl font-bold leading-none", scoreColor)}>{overallScore}<span className={clsx("text-lg", isLight ? "text-slate-400" : "text-slate-600")}>/100</span></p>
            )}
          </div>
        </div>

        {/* Centralized Modules Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          
          {/* Security */}
          <div className={clsx(
            "rounded-2xl p-5 border transition-all group",
            isLight ? "bg-white border-slate-200 hover:border-slate-300 shadow-sm" : "bg-slate-900 border-slate-800 hover:border-slate-700"
          )}>
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className={clsx(
                  "w-10 h-10 rounded-xl flex items-center justify-center border",
                  isLight ? "bg-rose-50 text-rose-600 border-rose-200" : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                )}>
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className={clsx("font-semibold", isLight ? "text-slate-900" : "text-white")}>Security Posture</h3>
                  <p className={clsx("text-xs", isLight ? "text-slate-500" : "text-slate-400")}>Vulnerability & Compliance</p>
                </div>
              </div>
              {!loading && securityScore !== null && (
                <div className="text-right">
                  <p className={clsx("font-bold text-lg", isLight ? "text-rose-600" : "text-rose-400")}>{securityScore}</p>
                </div>
              )}
            </div>
            
            <p className={clsx("text-sm mb-6", isLight ? "text-slate-600" : "text-slate-300")}>
              {loading ? 'Analyzing...' : `${securityIssues} issues found. Review the security panel to mitigate vulnerabilities.`}
            </p>
            
            <button
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'security' })}
              className={clsx(
                "w-full flex items-center justify-between px-4 py-2.5 rounded-xl text-sm font-medium transition-colors",
                isLight ? "bg-slate-100 hover:bg-slate-200 text-slate-800" : "bg-slate-800 hover:bg-slate-700 text-white"
              )}
            >
              <span>View Security Report</span>
              <ArrowRight className={clsx("w-4 h-4 transition-colors", isLight ? "text-slate-500 group-hover:text-slate-900" : "text-slate-400 group-hover:text-white")} />
            </button>
          </div>

          {/* Advisor */}
          <div className={clsx(
            "rounded-2xl p-5 border transition-all group",
            isLight ? "bg-white border-slate-200 hover:border-slate-300 shadow-sm" : "bg-slate-900 border-slate-800 hover:border-slate-700"
          )}>
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className={clsx(
                  "w-10 h-10 rounded-xl flex items-center justify-center border",
                  isLight ? "bg-indigo-50 text-indigo-600 border-indigo-200" : "bg-indigo-500/10 text-indigo-400 border-indigo-500/20"
                )}>
                  <Brain className="w-5 h-5" />
                </div>
                <div>
                  <h3 className={clsx("font-semibold", isLight ? "text-slate-900" : "text-white")}>Architecture Advisor</h3>
                  <p className={clsx("text-xs", isLight ? "text-slate-500" : "text-slate-400")}>Rule-based recommendations</p>
                </div>
              </div>
              {!loading && advisorScore !== null && (
                <div className="text-right">
                  <p className={clsx("font-bold text-lg", isLight ? "text-indigo-600" : "text-indigo-400")}>{advisorScore}</p>
                </div>
              )}
            </div>
            
            <p className={clsx("text-sm mb-6", isLight ? "text-slate-600" : "text-slate-300")}>
              {loading ? 'Analyzing...' : `${advisorRecs} recommendations to improve reliability, performance, and scalability.`}
            </p>
            
            <button
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'advisor' })}
              className={clsx(
                "w-full flex items-center justify-between px-4 py-2.5 rounded-xl text-sm font-medium transition-colors",
                isLight ? "bg-slate-100 hover:bg-slate-200 text-slate-800" : "bg-slate-800 hover:bg-slate-700 text-white"
              )}
            >
              <span>Review Recommendations</span>
              <ArrowRight className={clsx("w-4 h-4 transition-colors", isLight ? "text-slate-500 group-hover:text-slate-900" : "text-slate-400 group-hover:text-white")} />
            </button>
          </div>

          {/* Well-Architected */}
          <div className={clsx(
            "rounded-2xl p-5 border transition-all group",
            isLight ? "bg-white border-slate-200 hover:border-slate-300 shadow-sm" : "bg-slate-900 border-slate-800 hover:border-slate-700"
          )}>
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className={clsx(
                  "w-10 h-10 rounded-xl flex items-center justify-center border",
                  isLight ? "bg-amber-50 text-amber-600 border-amber-200" : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                )}>
                  <CheckSquare className="w-5 h-5" />
                </div>
                <div>
                  <h3 className={clsx("font-semibold", isLight ? "text-slate-900" : "text-white")}>Well-Architected Review</h3>
                  <p className={clsx("text-xs", isLight ? "text-slate-500" : "text-slate-400")}>5-Pillar Assessment</p>
                </div>
              </div>
              {!loading && waScore !== null && (
                <div className="text-right">
                  <p className={clsx("font-bold text-lg", isLight ? "text-amber-600" : "text-amber-400")}>{waScore}</p>
                </div>
              )}
            </div>
            
            <p className={clsx("text-sm mb-6", isLight ? "text-slate-600" : "text-slate-300")}>
              {loading ? 'Analyzing...' : `${waFindings} findings across operational excellence, security, reliability, performance, and cost optimization.`}
            </p>
            
            <button
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'well-architected' })}
              className={clsx(
                "w-full flex items-center justify-between px-4 py-2.5 rounded-xl text-sm font-medium transition-colors",
                isLight ? "bg-slate-100 hover:bg-slate-200 text-slate-800" : "bg-slate-800 hover:bg-slate-700 text-white"
              )}
            >
              <span>Open Framework Review</span>
              <ArrowRight className={clsx("w-4 h-4 transition-colors", isLight ? "text-slate-500 group-hover:text-slate-900" : "text-slate-400 group-hover:text-white")} />
            </button>
          </div>

          {/* Cost Comparison Link */}
          <div className={clsx(
            "rounded-2xl p-5 border transition-all group",
            isLight 
              ? "bg-gradient-to-br from-blue-50/80 to-indigo-50/80 border-blue-200 hover:border-blue-300 shadow-sm" 
              : "bg-gradient-to-br from-slate-900 to-blue-950 border-blue-900/50 hover:border-blue-700/50"
          )}>
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className={clsx(
                  "w-10 h-10 rounded-xl flex items-center justify-center border shadow-inner",
                  isLight ? "bg-blue-100 text-blue-600 border-blue-200" : "bg-blue-500/20 text-blue-400 border-blue-500/30"
                )}>
                  <Scale className="w-5 h-5" />
                </div>
                <div>
                  <h3 className={clsx("font-semibold flex items-center gap-2", isLight ? "text-slate-900" : "text-white")}>
                    AWS vs Azure Comparison <Sparkles className={clsx("w-3 h-3", isLight ? "text-cyan-600" : "text-cyan-400")} />
                  </h3>
                  <p className={clsx("text-xs", isLight ? "text-blue-700" : "text-blue-300/80")}>Multi-cloud pricing analysis</p>
                </div>
              </div>
            </div>
            
            <p className={clsx("text-sm mb-6", isLight ? "text-slate-700" : "text-blue-200/80")}>
              Automatically translate this architecture and compare real-world costs between AWS and Azure side-by-side.
            </p>
            
            <button
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'cost-comparison' })}
              className={clsx(
                "w-full flex items-center justify-between px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors border",
                isLight 
                  ? "bg-blue-600 hover:bg-blue-700 border-blue-600 text-white shadow-sm" 
                  : "bg-blue-900/40 hover:bg-blue-800/60 border-blue-700/50 text-blue-100"
              )}
            >
              <span>Run Cost Comparison</span>
              <ArrowRight className={clsx("w-4 h-4 transition-colors", isLight ? "text-blue-100 group-hover:text-white" : "text-blue-400 group-hover:text-blue-200")} />
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
