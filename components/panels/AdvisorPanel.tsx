'use client';
import { useState, useEffect } from 'react';
import { useActiveProject } from '@/context/AppContext';
import { apiAdvisorService } from '@/lib/services/ApiAdvisorService';
import type { AdvisorResult } from '@/lib/services/ApiAdvisorService';
import { Brain, TrendingUp, Shield, Zap, DollarSign, Scale, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { scoreArchitecture, generateRecommendations } from '@/lib/generator';

const CATEGORY_CONFIG = {
  reliability:  { icon: TrendingUp, color: 'text-blue-400',   bg: 'bg-blue-900/30',   border: 'border-blue-800',   label: 'Reliability' },
  security:     { icon: Shield,      color: 'text-emerald-400', bg: 'bg-emerald-900/30', border: 'border-emerald-800', label: 'Security' },
  performance:  { icon: Zap,         color: 'text-yellow-400', bg: 'bg-yellow-900/30', border: 'border-yellow-800', label: 'Performance' },
  cost:         { icon: DollarSign,  color: 'text-orange-400', bg: 'bg-orange-900/30', border: 'border-orange-800', label: 'Cost' },
  scalability:  { icon: Scale,       color: 'text-purple-400', bg: 'bg-purple-900/30', border: 'border-purple-800', label: 'Scalability' },
};

function RadialScore({ score }: { score: number }) {
  const color = score >= 80 ? '#10B981' : score >= 60 ? '#F59E0B' : '#EF4444';
  const r = 40;
  const circ = 2 * Math.PI * r;
  const offset = circ - (score / 100) * circ;
  return (
    <div className="relative w-28 h-28 flex items-center justify-center">
      <svg className="w-28 h-28 -rotate-90" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r={r} fill="none" stroke="#374151" strokeWidth="8" />
        <circle cx="48" cy="48" r={r} fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
      </svg>
      <div className="absolute text-center">
        <p className="text-3xl font-bold text-white leading-none">{score}</p>
        <p className="text-gray-500 text-[9px] uppercase tracking-wide">/100</p>
      </div>
    </div>
  );
}

export default function AdvisorPanel() {
  const activeProject = useActiveProject();
  const [result, setResult] = useState<AdvisorResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const activeProjectId = activeProject?.id ?? null;
  const nodeCount = activeProject?.nodes.length ?? 0;

  // Run advisor via the API-backed service whenever active project or nodes change.
  // apiAdvisorService already has the project ID injected by AppContext.
  useEffect(() => {
    if (!activeProject || nodeCount === 0) {
      return;
    }
    let cancelled = false;
    apiAdvisorService.analyze(activeProject.nodes).then((r) => {
      if (!cancelled) {
        setResult(r);
        setError(null);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) {
        const score = scoreArchitecture(activeProject.nodes);
        const recs = generateRecommendations(activeProject.nodes).map((r) => ({
          id: r.id,
          category: r.category as any,
          severity: r.severity as any,
          title: r.title,
          description: r.description,
          affectedResourceIds: [],
          affectedResourceLabels: r.affectedResources,
          rationale: r.description,
          suggestedAction: r.action,
        }));
        setResult({ score, recommendations: recs, fromApi: false });
        setError(null);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [activeProjectId, nodeCount, retryCount]);

  if (!activeProject) return null;

  if (nodeCount === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900">
        <div className="text-center px-8 py-12">
          <Brain className="w-12 h-12 text-gray-700 mx-auto mb-4" />
          <p className="text-gray-400 font-medium text-lg">No resources to analyse</p>
          <p className="text-gray-600 text-sm mt-1">Add resources to the canvas to get architecture recommendations</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900">
        <div className="text-center" role="status" aria-label="Analysing architecture">
          <div className="w-12 h-12 border-4 border-purple-700 border-t-purple-400 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400 font-medium">Analysing architecture…</p>
          <p className="text-gray-600 text-sm mt-1">Running Well-Architected checks</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900 p-6">
        <div className="text-center max-w-md bg-gray-800 border border-red-800/60 rounded-xl p-8 shadow-xl">
          <AlertTriangle className="w-12 h-12 text-red-400 mx-auto mb-4" aria-hidden="true" />
          <h3 className="text-white font-semibold text-lg mb-2">Architecture Analysis Failed</h3>
          <p className="text-gray-400 text-sm mb-6">{error}</p>
          <button
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-4 py-2 bg-red-800 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            Retry Analysis
          </button>
        </div>
      </div>
    );
  }

  if (!result) return null;

  const { score: scores, recommendations: recs, fromApi } = result;

  const severityColors = {
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
    <div className="flex-1 overflow-y-auto bg-gray-900 p-5">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Brain className="w-5 h-5 text-purple-400" />
          <h2 className="text-white font-bold text-lg">Architecture Advisor</h2>
          <span className="text-xs px-2 py-0.5 bg-purple-900/40 text-purple-300 rounded-full">Well-Architected</span>
          {fromApi && (
            <span className="text-xs px-2 py-0.5 bg-emerald-900/40 text-emerald-400 rounded-full">API</span>
          )}
        </div>

        {/* Overall score */}
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 mb-5 flex items-center gap-6">
          <RadialScore score={scores.overall} />
          <div className="flex-1">
            <h3 className="text-white font-semibold text-base mb-1">
              Architecture Score: <span className={clsx(scores.overall >= 80 ? 'text-emerald-400' : scores.overall >= 60 ? 'text-yellow-400' : 'text-red-400')}>{scores.overall}/100</span>
            </h3>
            <p className="text-gray-400 text-sm mb-3">
              {scores.overall >= 80 ? 'Your architecture follows most best practices.' : scores.overall >= 60 ? 'Some improvements recommended for production readiness.' : 'Significant improvements needed before production deployment.'}
            </p>
            <p className="text-gray-500 text-xs">{recs.length} recommendation{recs.length !== 1 ? 's' : ''} • {nodeCount} resources analysed</p>
          </div>
        </div>

        {/* Category scores */}
        <div className="grid grid-cols-5 gap-3 mb-6">
          {scoreItems.map(([cat, val]) => {
            const cfg = CATEGORY_CONFIG[cat];
            const Icon = cfg.icon;
            const color = val >= 80 ? '#10B981' : val >= 60 ? '#F59E0B' : '#EF4444';
            return (
              <div key={cat} className="bg-gray-800 border border-gray-700 rounded-xl p-3 text-center">
                <Icon className={clsx('w-4 h-4 mx-auto mb-1.5', cfg.color)} />
                <p className="text-white font-bold text-lg" style={{ color }}>{val}</p>
                <p className="text-gray-500 text-[10px]">{cfg.label}</p>
              </div>
            );
          })}
        </div>

        {/* Recommendations */}
        {recs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center bg-gray-800/50 rounded-xl border border-gray-700">
            <Brain className="w-10 h-10 text-emerald-500 mb-3" />
            <p className="text-white font-medium">Architecture looks great!</p>
            <p className="text-gray-500 text-sm mt-1">No significant recommendations at this time</p>
          </div>
        ) : (
          <div className="space-y-3">
            <h3 className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-2">Recommendations</h3>
            {recs.map((rec) => {
              const cfg = CATEGORY_CONFIG[rec.category];
              const Icon = cfg.icon;
              // API recs use suggestedAction, local recs expose it the same way
              const action = rec.suggestedAction;
              return (
                <div key={rec.id} className={clsx('rounded-xl border p-4', severityColors[rec.severity])}>
                  <div className="flex items-start gap-3">
                    <Icon className="w-4 h-4 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <p className="text-white font-medium text-sm">{rec.title}</p>
                        <div className="flex gap-1 shrink-0">
                          <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full', cfg.bg, cfg.color)}>{cfg.label}</span>
                        </div>
                      </div>
                      <p className="text-gray-400 text-xs mb-2">{rec.description}</p>
                      <div className="p-2 bg-black/20 rounded-lg">
                        <p className="text-gray-300 text-xs"><span className="text-blue-400 font-medium">Action: </span>{action}</p>
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
