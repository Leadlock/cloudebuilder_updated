'use client';
import { useState, useEffect } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { apiAdvisorService } from '@/lib/services/ApiAdvisorService';
import { apiWellArchitectedService } from '@/lib/services/ApiWellArchitectedService';
import type { WaAssessment } from '@/lib/engines/wellArchitected/types';
import type { AdvisorResult } from '@/lib/services/ApiAdvisorService';
import { Brain, TrendingUp, Shield, Zap, DollarSign, Scale, AlertTriangle, ShieldCheck, ArrowRight, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import AiReviewCard from './AiReviewCard';

const CATEGORY_CONFIG = {
  reliability:  { icon: TrendingUp, color: 'text-blue-400',   bg: 'bg-blue-900/30',   border: 'border-blue-800',   label: 'Reliability' },
  security:     { icon: Shield,      color: 'text-emerald-400', bg: 'bg-emerald-900/30', border: 'border-emerald-800', label: 'Security' },
  performance:  { icon: Zap,         color: 'text-yellow-400', bg: 'bg-yellow-900/30', border: 'border-yellow-800', label: 'Performance' },
  cost:         { icon: DollarSign,  color: 'text-orange-400', bg: 'bg-orange-900/30', border: 'border-orange-800', label: 'Cost' },
  scalability:  { icon: Scale,       color: 'text-purple-400', bg: 'bg-purple-900/30', border: 'border-purple-800', label: 'Scalability' },
};

function RadialScore({ score, isLight = false }: { score: number; isLight?: boolean }) {
  const color = score >= 80 ? (isLight ? '#059669' : '#10B981') : score >= 60 ? (isLight ? '#d97706' : '#F59E0B') : (isLight ? '#dc2626' : '#EF4444');
  const r = 40;
  const circ = 2 * Math.PI * r;
  const offset = circ - (score / 100) * circ;
  return (
    <div className="relative w-28 h-28 flex items-center justify-center">
      <svg className="w-28 h-28 -rotate-90" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r={r} fill="none" stroke={isLight ? '#e2e8f0' : '#374151'} strokeWidth="8" />
        <circle cx="48" cy="48" r={r} fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
      </svg>
      <div className="absolute text-center">
        <p className={clsx('text-3xl font-bold leading-none', isLight ? 'text-slate-900' : 'text-white')}>{score}</p>
        <p className={clsx('text-[9px] uppercase tracking-wide', isLight ? 'text-slate-500' : 'text-gray-500')}>/100</p>
      </div>
    </div>
  );
}

export default function AdvisorPanel() {
  const { state, dispatch } = useApp();
  const activeProject = useActiveProject();
  const [result, setResult] = useState<AdvisorResult | null>(null);
  const [waAssessment, setWaAssessment] = useState<WaAssessment | null>(null);
  const [loading, setLoading] = useState(false);
  const [analyzingWa, setAnalyzingWa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const activeProjectId = activeProject?.id ?? null;
  const nodeCount = activeProject?.nodes.length ?? 0;

  useEffect(() => {
    if (!activeProject) return;
    let cancelled = false;
    apiWellArchitectedService.getAssessment().then((ass) => {
      if (!cancelled && ass) {
        setWaAssessment(ass);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeProjectId, retryCount]);

  // Run advisor via the API-backed service whenever active project or nodes change.
  // apiAdvisorService already has the project ID injected by AppContext.
  useEffect(() => {
    if (!activeProject || nodeCount === 0) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiAdvisorService.analyze(activeProject.nodes, activeProject.scaleProfile?.expectedUsers).then((r) => {
      if (!cancelled) {
        setResult(r);
        setError(null);
        setLoading(false);
      }
    }).catch((err) => {
      if (!cancelled) {
        // A failed analysis must surface as an error, not silently swap in a
        // different (legacy, less rigorous) local scoring engine — showing
        // plausible-looking numbers from a different source than the one the
        // user thinks they're looking at is exactly the "wrong data" this
        // panel must never produce. See ArchitectureAdvisor.ts for the real
        // engine this should have used.
        setResult(null);
        setError(err instanceof Error ? err.message : 'Failed to analyse this architecture. Check your connection and retry.');
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [activeProjectId, nodeCount, retryCount, activeProject?.scaleProfile?.expectedUsers]);

  const isStale = state.architectureVersion > state.lastSavedVersion;

  const isLight = state.theme === 'light';

  if (!activeProject) return null;

  if (nodeCount === 0) {
    return (
      <div className={clsx('flex-1 flex items-center justify-center', isLight ? 'bg-slate-50 text-slate-500' : 'bg-gray-900 text-gray-400')}>
        <div className="text-center px-8 py-12">
          <Brain className={clsx('w-12 h-12 mx-auto mb-4', isLight ? 'text-slate-300' : 'text-gray-700')} />
          <p className={clsx('font-medium text-lg', isLight ? 'text-slate-700' : 'text-gray-400')}>No resources to analyse</p>
          <p className={clsx('text-sm mt-1', isLight ? 'text-slate-500' : 'text-gray-600')}>Add resources to the canvas to get architecture recommendations</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={clsx('flex-1 flex items-center justify-center', isLight ? 'bg-slate-50' : 'bg-gray-900')}>
        <div className="text-center" role="status" aria-label="Analysing architecture">
          <div className="w-12 h-12 border-4 border-purple-700 border-t-purple-400 rounded-full animate-spin mx-auto mb-4" />
          <p className={clsx('font-medium', isLight ? 'text-slate-700' : 'text-gray-400')}>Analysing architecture…</p>
          <p className={clsx('text-sm mt-1', isLight ? 'text-slate-500' : 'text-gray-600')}>Running Well-Architected checks</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={clsx('flex-1 flex items-center justify-center p-6', isLight ? 'bg-slate-50' : 'bg-gray-900')}>
        <div className={clsx('text-center max-w-md border rounded-2xl p-8 shadow-xl', isLight ? 'bg-white border-rose-200' : 'bg-gray-800 border-red-800/60')}>
          <AlertTriangle className="w-12 h-12 text-rose-500 mx-auto mb-4" aria-hidden="true" />
          <h3 className={clsx('font-semibold text-lg mb-2', isLight ? 'text-slate-900' : 'text-white')}>Architecture Analysis Failed</h3>
          <p className={clsx('text-sm mb-6', isLight ? 'text-slate-600' : 'text-gray-400')}>{error}</p>
          <button
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-rose-500"
          >
            Retry Analysis
          </button>
        </div>
      </div>
    );
  }

  if (!result) return null;

  const { score: scores, recommendations: recs, fromApi } = result;

  const severityColors = isLight ? {
    critical: 'text-rose-900 border-rose-200 bg-rose-50 shadow-sm',
    high: 'text-orange-900 border-orange-200 bg-orange-50 shadow-sm',
    medium: 'text-amber-900 border-amber-200 bg-amber-50 shadow-sm',
    low: 'text-blue-900 border-blue-200 bg-blue-50 shadow-sm',
  } : {
    critical: 'text-red-400 border-red-800 bg-red-900/20',
    high: 'text-orange-400 border-orange-800 bg-orange-900/20',
    medium: 'text-yellow-400 border-yellow-800 bg-yellow-900/20',
    low: 'text-blue-400 border-blue-800 bg-blue-900/20',
  };

  const scoreItems: [keyof typeof CATEGORY_CONFIG, number][] = [
    ['reliability', scores.reliability],
    ['security', scores.security],
    ['performance', scores.performance],
    ['cost', scores.cost],
    ['scalability', scores.scalability],
  ];

  return (
    <div className={clsx('flex-1 overflow-y-auto px-4 sm:px-6 py-6 pb-36 custom-scrollbar', isLight ? 'bg-slate-50 text-slate-900' : 'bg-gray-950 text-slate-100')}>
      <div className="max-w-4xl mx-auto">
        {isStale && (
          <div className={clsx('border rounded-xl p-4 flex items-center justify-between mb-6', isLight ? 'bg-amber-50 border-amber-200' : 'bg-amber-900/30 border-amber-800/50')}>
            <div className="flex items-center gap-3">
              <AlertTriangle className={clsx('w-5 h-5', isLight ? 'text-amber-600' : 'text-amber-400')} />
              <p className={clsx('text-sm', isLight ? 'text-amber-800' : 'text-amber-300')}>You have unsaved changes. Save your architecture to refresh this analysis.</p>
            </div>
            <button 
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'canvas' })}
              className={clsx('px-3 py-1.5 rounded-lg text-xs font-medium transition-colors', isLight ? 'bg-amber-600 hover:bg-amber-700 text-white' : 'bg-amber-800 hover:bg-amber-700 text-white')}
            >
              Return to Builder
            </button>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between gap-3 mb-6">
          <div className="flex items-center gap-3">
            <Brain className={clsx('w-5 h-5', isLight ? 'text-purple-600' : 'text-purple-400')} />
            <h2 className={clsx('font-bold text-lg', isLight ? 'text-slate-900' : 'text-white')}>Architecture Advisor</h2>
            <span className={clsx('text-xs px-2 py-0.5 rounded-full border', isLight ? 'bg-purple-50 text-purple-700 border-purple-200' : 'bg-purple-900/40 text-purple-300 border-purple-800')}>Well-Architected</span>
            {fromApi && (
              <span className={clsx('text-xs px-2 py-0.5 rounded-full border', isLight ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-emerald-900/40 text-emerald-400 border-emerald-800')}>API</span>
            )}
            {waAssessment?.isStale && (
              <span className={clsx('text-xs px-2 py-0.5 border rounded-full animate-pulse flex items-center gap-1', isLight ? 'bg-amber-50 text-amber-700 border-amber-300' : 'bg-amber-900/40 text-amber-300 border-amber-600/40')}>
                <AlertTriangle className="w-3 h-3" />
                Stale
              </span>
            )}
          </div>

          <button
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'well-architected' })}
            className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-colors shadow-sm', isLight ? 'bg-cyan-50 hover:bg-cyan-100 text-cyan-700 border-cyan-300' : 'bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-300 border-cyan-500/30')}
          >
            <ShieldCheck className={clsx('w-4 h-4', isLight ? 'text-cyan-600' : 'text-cyan-400')} />
            <span>Open Full WAF Review</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>

        {/* Overall score */}
        <div className={clsx('border rounded-2xl p-5 mb-5 flex items-center gap-6 transition-all', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-gray-800 border-gray-700')}>
          <RadialScore score={scores.overall} isLight={isLight} />
          <div className="flex-1">
            <h3 className={clsx('font-semibold text-base mb-1', isLight ? 'text-slate-900' : 'text-white')}>
              Architecture Score: <span className={clsx(scores.overall >= 80 ? (isLight ? 'text-emerald-600' : 'text-emerald-400') : scores.overall >= 60 ? (isLight ? 'text-amber-600' : 'text-yellow-400') : (isLight ? 'text-rose-600' : 'text-red-400'))}>{scores.overall}/100</span>
            </h3>
            <p className={clsx('text-sm mb-3', isLight ? 'text-slate-600' : 'text-gray-400')}>
              {scores.overall >= 80 ? 'Your architecture follows most best practices.' : scores.overall >= 60 ? 'Some improvements recommended for production readiness.' : 'Significant improvements needed before production deployment.'}
            </p>
            <p className={clsx('text-xs', isLight ? 'text-slate-400' : 'text-gray-500')}>{recs.length} recommendation{recs.length !== 1 ? 's' : ''} • {nodeCount} resources analysed</p>
          </div>
        </div>

        {/* Category scores */}
        <div className="grid grid-cols-5 gap-3 mb-6">
          {scoreItems.map(([cat, val]) => {
            const cfg = CATEGORY_CONFIG[cat];
            const Icon = cfg.icon;
            const color = val >= 80 ? (isLight ? '#059669' : '#10B981') : val >= 60 ? (isLight ? '#d97706' : '#F59E0B') : (isLight ? '#dc2626' : '#EF4444');
            return (
              <div key={cat} className={clsx('border rounded-2xl p-3 text-center transition-all', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-gray-800 border-gray-700')}>
                <Icon className={clsx('w-4 h-4 mx-auto mb-1.5', cfg.color)} />
                <p className="font-bold text-lg" style={{ color }}>{val}</p>
                <p className={clsx('text-[10px]', isLight ? 'text-slate-500' : 'text-gray-500')}>{cfg.label}</p>
              </div>
            );
          })}
        </div>

        {/* AI review — explains the engine's findings using the knowledge base */}
        <AiReviewCard nodes={activeProject.nodes} edges={activeProject.edges} />

        {/* Recommendations */}
        {recs.length === 0 ? (
          <div className={clsx('flex flex-col items-center justify-center py-12 text-center rounded-2xl border', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-gray-800/50 border-gray-700')}>
            <Brain className="w-10 h-10 text-emerald-500 mb-3" />
            <p className={clsx('font-medium', isLight ? 'text-slate-900' : 'text-white')}>Architecture looks great!</p>
            <p className={clsx('text-sm mt-1', isLight ? 'text-slate-500' : 'text-gray-500')}>No significant recommendations at this time</p>
          </div>
        ) : (
          <div className="space-y-3">
            <h3 className={clsx('text-xs font-medium uppercase tracking-wider mb-2', isLight ? 'text-slate-500' : 'text-gray-400')}>Recommendations</h3>
            {recs.map((rec) => {
              const cfg = CATEGORY_CONFIG[rec.category];
              const Icon = cfg.icon;
              // API recs use suggestedAction, local recs expose it the same way
              const action = rec.suggestedAction;
              return (
                <div key={rec.id} className={clsx('rounded-2xl border p-4', severityColors[rec.severity])}>
                  <div className="flex items-start gap-3">
                    <Icon className="w-4 h-4 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <p className={clsx('font-semibold text-sm', isLight ? 'text-slate-900' : 'text-white')}>{rec.title}</p>
                        <div className="flex gap-1 shrink-0">
                          <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full border', isLight ? 'bg-white/80 border-slate-300 text-slate-700 font-medium' : clsx(cfg.bg, cfg.color))}>{cfg.label}</span>
                        </div>
                      </div>
                      <p className={clsx('text-xs mb-2', isLight ? 'text-slate-600' : 'text-gray-400')}>{rec.description}</p>
                      <div className={clsx('p-2.5 rounded-xl border', isLight ? 'bg-white/90 border-slate-200/80' : 'bg-black/20 border-transparent')}>
                        <p className={clsx('text-xs', isLight ? 'text-slate-800' : 'text-gray-300')}><span className={clsx('font-semibold', isLight ? 'text-blue-600' : 'text-blue-400')}>Action: </span>{action}</p>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
