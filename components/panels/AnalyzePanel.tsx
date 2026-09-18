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

  if (!activeProject || activeProject.nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900">
        <div className="text-center px-8 py-12">
          <Activity className="w-12 h-12 text-gray-700 mx-auto mb-4" />
          <p className="text-gray-400 font-medium text-lg">No architecture to analyze</p>
          <p className="text-gray-600 text-sm mt-1">Add resources to the canvas to see insights</p>
        </div>
      </div>
    );
  }

  const overallScore = Math.round(
    [securityScore, advisorScore, waScore].filter(s => s !== null).reduce((a, b) => (a || 0) + (b || 0), 0) /
    ([securityScore, advisorScore, waScore].filter(s => s !== null).length || 1)
  ) || 0;

  const scoreColor = overallScore >= 80 ? 'text-emerald-400' : overallScore >= 60 ? 'text-amber-400' : 'text-rose-400';
  const isStale = state.architectureVersion > state.lastSavedVersion;

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {isStale && (
          <div className="bg-amber-900/30 border border-amber-800/50 rounded-xl p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400" />
              <p className="text-amber-300 text-sm">You have unsaved changes. Save your architecture to refresh this analysis.</p>
            </div>
            <button 
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'canvas' })}
              className="px-3 py-1.5 bg-amber-800 hover:bg-amber-700 text-white rounded-lg text-xs font-medium transition-colors"
            >
              Return to Builder
            </button>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white flex items-center gap-3">
              <Activity className="w-6 h-6 text-cyan-400" />
              Architecture Intelligence Overview
            </h2>
            <p className="text-slate-400 text-sm mt-1">Unified insights for your multi-cloud architecture.</p>
          </div>
          <div className="text-right bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 shadow-lg">
            <p className="text-xs text-slate-500 uppercase tracking-wider font-semibold mb-1">Overall Health Score</p>
            {loading ? (
              <div className="h-8 w-16 bg-slate-800 rounded animate-pulse ml-auto" />
            ) : (
              <p className={clsx("text-3xl font-bold leading-none", scoreColor)}>{overallScore}<span className="text-lg text-slate-600">/100</span></p>
            )}
          </div>
        </div>

        {/* Centralized Modules Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          
          {/* Security */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-slate-700 transition-colors group">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-rose-500/10 flex items-center justify-center text-rose-400 border border-rose-500/20">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-white font-semibold">Security Posture</h3>
                  <p className="text-slate-400 text-xs">Vulnerability & Compliance</p>
                </div>
              </div>
              {!loading && securityScore !== null && (
                <div className="text-right">
                  <p className="text-rose-400 font-bold">{securityScore}</p>
                </div>
              )}
            </div>
            
            <p className="text-sm text-slate-300 mb-6">
              {loading ? 'Analyzing...' : `${securityIssues} issues found. Review the security panel to mitigate vulnerabilities.`}
            </p>
            
            <button
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'security' })}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-sm font-medium transition-colors"
            >
              <span>View Security Report</span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
            </button>
          </div>

          {/* Advisor */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-slate-700 transition-colors group">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-400 border border-indigo-500/20">
                  <Brain className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-white font-semibold">Architecture Advisor</h3>
                  <p className="text-slate-400 text-xs">Rule-based recommendations</p>
                </div>
              </div>
              {!loading && advisorScore !== null && (
                <div className="text-right">
                  <p className="text-indigo-400 font-bold">{advisorScore}</p>
                </div>
              )}
            </div>
            
            <p className="text-sm text-slate-300 mb-6">
              {loading ? 'Analyzing...' : `${advisorRecs} recommendations to improve reliability, performance, and scalability.`}
            </p>
            
            <button
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'advisor' })}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-sm font-medium transition-colors"
            >
              <span>Review Recommendations</span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
            </button>
          </div>

          {/* Well-Architected */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-slate-700 transition-colors group">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center text-amber-400 border border-amber-500/20">
                  <CheckSquare className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-white font-semibold">Well-Architected Review</h3>
                  <p className="text-slate-400 text-xs">5-Pillar Assessment</p>
                </div>
              </div>
              {!loading && waScore !== null && (
                <div className="text-right">
                  <p className="text-amber-400 font-bold">{waScore}</p>
                </div>
              )}
            </div>
            
            <p className="text-sm text-slate-300 mb-6">
              {loading ? 'Analyzing...' : `${waFindings} findings across operational excellence, security, reliability, performance, and cost optimization.`}
            </p>
            
            <button
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'well-architected' })}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-sm font-medium transition-colors"
            >
              <span>Open Framework Review</span>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
            </button>
          </div>

          {/* Cost Comparison Link */}
          <div className="bg-gradient-to-br from-slate-900 to-blue-950 border border-blue-900/50 rounded-2xl p-5 hover:border-blue-700/50 transition-colors group">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center text-blue-400 border border-blue-500/30 shadow-inner">
                  <Scale className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-white font-semibold flex items-center gap-2">AWS vs Azure Comparison <Sparkles className="w-3 h-3 text-cyan-400" /></h3>
                  <p className="text-blue-300/80 text-xs">Multi-cloud pricing analysis</p>
                </div>
              </div>
            </div>
            
            <p className="text-sm text-blue-200/80 mb-6">
              Automatically translate this architecture and compare real-world costs between AWS and Azure side-by-side.
            </p>
            
            <button
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'cost-comparison' })}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-blue-900/40 hover:bg-blue-800/60 border border-blue-700/50 text-blue-100 rounded-xl text-sm font-medium transition-colors"
            >
              <span>Run Cost Comparison</span>
              <ArrowRight className="w-4 h-4 text-blue-400 group-hover:text-blue-200 transition-colors" />
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
