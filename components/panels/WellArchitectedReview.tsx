'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { apiWellArchitectedService } from '@/lib/services/ApiWellArchitectedService';
import type { WaAssessment, WaFinding, WaPillar, WaSeverity, ResourceState } from '@/lib/engines/wellArchitected/types';
import {
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  Zap,
  DollarSign,
  Leaf,
  Activity,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Info,
  Layers,
  ArrowRight,
  Filter,
} from 'lucide-react';
import clsx from 'clsx';

const PILLAR_CONFIG: Record<
  string,
  { label: string; icon: React.ElementType; color: string; bg: string; border: string; desc: string }
> = {
  security: {
    label: 'Security',
    icon: ShieldAlert,
    color: 'text-rose-400',
    bg: 'bg-rose-950/25',
    border: 'border-rose-500/30',
    desc: 'Protect information, systems, and assets while delivering business value.',
  },
  reliability: {
    label: 'Reliability',
    icon: TrendingUp,
    color: 'text-blue-400',
    bg: 'bg-blue-950/25',
    border: 'border-blue-500/30',
    desc: 'Prevent and quickly recover from failures to meet business and customer demand.',
  },
  cost_optimization: {
    label: 'Cost Optimization',
    icon: DollarSign,
    color: 'text-emerald-400',
    bg: 'bg-emerald-950/25',
    border: 'border-emerald-500/30',
    desc: 'Avoid unneeded expenditure and run workloads at the lowest price point.',
  },
  operational_excellence: {
    label: 'Operational Excellence',
    icon: Activity,
    color: 'text-purple-400',
    bg: 'bg-purple-950/25',
    border: 'border-purple-500/30',
    desc: 'Run and monitor systems to deliver business value and continually improve.',
  },
  performance_efficiency: {
    label: 'Performance Efficiency',
    icon: Zap,
    color: 'text-amber-400',
    bg: 'bg-amber-950/25',
    border: 'border-amber-500/30',
    desc: 'Use computing resources efficiently to meet requirements as demand changes.',
  },
  sustainability: {
    label: 'Sustainability',
    icon: Leaf,
    color: 'text-teal-400',
    bg: 'bg-teal-950/25',
    border: 'border-teal-500/30',
    desc: 'Minimize the environmental impacts of running cloud workloads.',
  },
};

const SEVERITY_CONFIG: Record<
  WaSeverity,
  { label: string; color: string; bg: string; border: string }
> = {
  critical: { label: 'Critical', color: 'text-rose-400', bg: 'bg-rose-500/10', border: 'border-rose-500/30' },
  high:     { label: 'High',     color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/30' },
  medium:   { label: 'Medium',   color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30' },
  low:      { label: 'Low',      color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/30' },
  info:     { label: 'Info',     color: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-500/30' },
};

export default function WellArchitectedReview() {
  const { state, dispatch } = useApp();
  const activeProject = useActiveProject();

  const [assessment, setAssessment] = useState<WaAssessment | null>(null);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [selectedPillar, setSelectedPillar] = useState<string>('all');
  const [selectedSeverity, setSelectedSeverity] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const fetchAssessment = async () => {
    if (!activeProject) return;
    setLoading(true);
    setError(null);
    try {
      if (activeProject.id === 'draft-project') {
        const data = await apiWellArchitectedService.analyze(activeProject.nodes, activeProject.edges);
        setAssessment(data);
      } else {
        // Use the latest persisted assessment; if none exists yet, analyze the
        // saved architecture now rather than showing an empty review.
        const data = await apiWellArchitectedService.getAssessment();
        setAssessment(data ?? await apiWellArchitectedService.analyze(activeProject.nodes, activeProject.edges));
      }
    } catch (err) {
      try {
        const data = await apiWellArchitectedService.analyze(activeProject.nodes, activeProject.edges);
        setAssessment(data);
      } catch (fallbackErr) {
        setError(err instanceof Error ? err.message : 'Failed to fetch assessment');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRunAnalysis = async () => {
    if (!activeProject) return;
    setAnalyzing(true);
    setError(null);
    try {
      const fresh = await apiWellArchitectedService.analyze(activeProject.nodes, activeProject.edges);
      if (fresh) {
        setAssessment(fresh);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  useEffect(() => {
    fetchAssessment();
  }, [
    activeProject?.id,
    activeProject?.nodes.length,
    activeProject?.edges.length,
    activeProject?.updatedAt,
    state.architectureVersion,
    state.activeEnvironment,
  ]);

  // Filtered findings
  const filteredFindings = useMemo(() => {
    if (!assessment?.findings) return [];
    return assessment.findings.filter((f) => {
      if (selectedPillar !== 'all' && f.pillar !== selectedPillar) return false;
      if (selectedSeverity !== 'all' && f.severity !== selectedSeverity) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = f.title.toLowerCase().includes(q);
        const matchesDesc = f.description.toLowerCase().includes(q);
        const matchesRec = f.recommendation.toLowerCase().includes(q);
        const matchesResource = (f.affectedResourceLabels || []).some((r) => r.toLowerCase().includes(q));
        if (!matchesTitle && !matchesDesc && !matchesRec && !matchesResource) return false;
      }
      return true;
    });
  }, [assessment, selectedPillar, selectedSeverity, searchQuery]);

  // Critical findings
  const criticalFindings = useMemo(() => {
    return (assessment?.findings || []).filter((f) => f.severity === 'critical');
  }, [assessment]);

  const isStale = state.architectureVersion > state.lastSavedVersion;

  if (!activeProject) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-950 text-slate-400">
        <p>Please select or create a project to view Well-Architected intelligence.</p>
      </div>
    );
  }

  const overallScore = assessment?.overallScore ?? 0;
  // Coverage-aware: when nothing could be evaluated the score is not shown as a number.
  const overallScored = assessment?.overallScored !== false;
  const scoreColor =
    overallScore >= 80 ? 'text-emerald-400' : overallScore >= 60 ? 'text-amber-400' : 'text-rose-400';
  const scoreBorder =
    overallScore >= 80 ? 'border-emerald-500/40' : overallScore >= 60 ? 'border-amber-500/40' : 'border-rose-500/40';

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-slate-950 text-slate-100 p-6 lg:p-8 space-y-6">
        {isStale && (
          <div className="bg-amber-900/30 border border-amber-800/50 rounded-xl p-4 flex items-center justify-between mb-6">
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

      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-black tracking-tight text-white flex items-center gap-2.5">
              <ShieldCheck className="w-7 h-7 text-cyan-400" />
              Well-Architected Review
            </h1>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider bg-slate-800 text-slate-300 border border-slate-700">
              {activeProject.provider.toUpperCase()}
            </span>
            {assessment?.isStale && (
              <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500/10 text-amber-300 border border-amber-500/30 flex items-center gap-1.5 animate-pulse">
                <AlertTriangle className="w-3 h-3" />
                Stale — Architecture Changed
              </span>
            )}
          </div>
          <p className="text-sm text-slate-400 mt-1">
            Design-time checks mapped to the pillars of the {activeProject.provider === 'azure' ? 'Microsoft Azure Well-Architected Framework' : activeProject.provider === 'multi' ? 'AWS and Microsoft Azure Well-Architected Frameworks' : 'AWS Well-Architected Framework'}
            — a heuristic assessment, not an official certification or compliance report.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleRunAnalysis}
            disabled={analyzing}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all shadow-lg',
              analyzing
                ? 'bg-cyan-900/50 text-cyan-300 cursor-wait'
                : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-cyan-900/30 active:scale-95'
            )}
          >
            <RefreshCw className={clsx('w-4 h-4', analyzing && 'animate-spin')} />
            <span>{analyzing ? 'Analyzing Architecture...' : 'Run Review'}</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-950/40 border border-rose-500/40 text-rose-300 text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Top Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Overall Health Card */}
        <div className={clsx('p-5 rounded-2xl bg-slate-900/70 border backdrop-blur-md relative overflow-hidden', scoreBorder)}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Overall Health</span>
            <ShieldCheck className={clsx('w-5 h-5', scoreColor)} />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className={clsx('text-4xl font-black tracking-tight', scoreColor)}>
              {assessment && overallScored ? `${overallScore}` : '—'}
            </span>
            <span className="text-xs text-slate-400">
              {!assessment ? (loading ? 'Analyzing…' : 'Not analyzed yet — run the review') : overallScored ? `/100 · coverage ${assessment.coveragePct ?? 0}%` : 'Not scored — insufficient evidence'}
            </span>
          </div>
          <div className="mt-3 w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div
              className={clsx('h-full transition-all duration-700', overallScore >= 80 ? 'bg-emerald-400' : overallScore >= 60 ? 'bg-amber-400' : 'bg-rose-400')}
              style={{ width: `${overallScored ? overallScore : 0}%` }}
            />
          </div>
          {assessment && (assessment.notEvaluatedCount ?? 0) > 0 && (
            <p className="mt-2 text-[11px] text-slate-400">{assessment.notEvaluatedCount} check(s) not evaluated — excluded from the score, never counted as passing.</p>
          )}
        </div>

        {/* Critical Findings */}
        <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Critical Issues</span>
            <ShieldAlert className="w-5 h-5 text-rose-400" />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className={clsx('text-4xl font-black tracking-tight', criticalFindings.length > 0 ? 'text-rose-400' : 'text-slate-200')}>
              {criticalFindings.length}
            </span>
            <span className="text-xs text-slate-400">Blocking Deployments</span>
          </div>
          <p className="text-xs text-slate-400 mt-2">
            {criticalFindings.length === 0 ? 'No critical vulnerabilities detected.' : 'Require remediation prior to prod.'}
          </p>
        </div>

        {/* Total Findings */}
        <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Total Findings</span>
            <Layers className="w-5 h-5 text-cyan-400" />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-4xl font-black tracking-tight text-white">
              {assessment?.findings?.length ?? 0}
            </span>
            <span className="text-xs text-slate-400">Opportunities</span>
          </div>
          <p className="text-xs text-slate-400 mt-2">
            Across {activeProject.nodes.length} canvas resources.
          </p>
        </div>

        {/* Intelligence Source */}
        <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Intelligence Source</span>
            <Info className="w-5 h-5 text-indigo-400" />
          </div>
          <div className="mt-3">
            <span className="text-sm font-bold text-white block truncate">
              {assessment?.source === 'LIVE_AWS_WAF'
                ? 'AWS Well-Architected Tool API'
                : assessment?.source === 'LIVE_AZURE_ADVISOR'
                ? 'Azure Advisor ARM API'
                : 'Design-Time Rule Engine'}
            </span>
            <span className="text-xs text-slate-400 mt-0.5 block">
              Confidence: {assessment?.confidence ?? 'Design-Time'}
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mt-2 truncate">
            {assessment?.frameworkVersion ? `Version: ${assessment.frameworkVersion}` : 'Deterministic analysis'}
          </p>
        </div>
      </div>

      {/* Critical Findings Alert Banner (if any) */}
      {criticalFindings.length > 0 && (
        <div className="p-4 rounded-2xl bg-rose-950/30 border border-rose-500/40 backdrop-blur-md flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-xl bg-rose-500/20 text-rose-400 shrink-0">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-rose-200">
                Deployment Gate: {criticalFindings.length} Critical Finding{criticalFindings.length > 1 ? 's' : ''} Detected
              </h3>
              <p className="text-xs text-rose-300/80 mt-0.5">
                The architecture contains high-risk misconfigurations (e.g. public database or unencrypted storage).
                Remediate before triggering deployment approval.
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              setSelectedSeverity('critical');
              setSelectedPillar('all');
            }}
            className="px-3 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-xs font-semibold border border-rose-500/40 transition-colors shrink-0"
          >
            Review Critical Only
          </button>
        </div>
      )}

      {/* Pillar Scores Section */}
      <div>
        <h2 className="text-base font-bold text-white mb-3">Pillar Performance</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {assessment?.pillarScores?.map((ps) => {
            const config = PILLAR_CONFIG[ps.pillar] || {
              label: ps.pillarLabel,
              icon: Activity,
              color: 'text-slate-400',
              bg: 'bg-slate-900/30',
              border: 'border-slate-800',
              desc: '',
            };
            const Icon = config.icon;
            const isSelected = selectedPillar === ps.pillar;

            const scored = ps.scored !== false;
            return (
              <button
                key={`${ps.provider ?? 'p'}-${ps.pillar}`}
                onClick={() => setSelectedPillar(isSelected ? 'all' : ps.pillar)}
                className={clsx(
                  'p-4 rounded-2xl text-left border transition-all relative group',
                  isSelected
                    ? 'ring-2 ring-cyan-400 border-cyan-400 bg-slate-900/90'
                    : 'bg-slate-900/60 hover:bg-slate-900 border-slate-800 hover:border-slate-700'
                )}
              >
                <div className="flex items-center justify-between">
                  <div className={clsx('p-2 rounded-xl border', config.bg, config.border, config.color)}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <span className={clsx('text-xl font-bold font-mono', !scored ? 'text-slate-500' : ps.score >= 80 ? 'text-emerald-400' : ps.score >= 60 ? 'text-amber-400' : 'text-rose-400')}>
                    {scored ? ps.score : '—'}
                  </span>
                </div>

                <h4 className="font-bold text-xs text-white mt-3 truncate">{ps.provider && assessment?.provider === 'multi' ? `${ps.provider.toUpperCase()} · ` : ''}{config.label}</h4>
                <p className="text-[10px] text-slate-500 mt-0.5">{scored ? `Coverage ${ps.coveragePct ?? 0}% · ${ps.status ?? ''}` : (ps.status === 'Insufficient evidence' || !ps.status ? 'Insufficient evidence' : `${ps.status} (informational checks only)`)}</p>
                <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                  <span>{ps.findingCount} finding{ps.findingCount === 1 ? '' : 's'}</span>
                  {ps.criticalCount > 0 && (
                    <span className="text-rose-400 font-bold">{ps.criticalCount} crit</span>
                  )}
                </div>

                <div className="mt-2.5 w-full bg-slate-800 rounded-full h-1 overflow-hidden">
                  <div
                    className={clsx('h-full', ps.score >= 80 ? 'bg-emerald-400' : ps.score >= 60 ? 'bg-amber-400' : 'bg-rose-400')}
                    style={{ width: `${scored ? ps.score : 0}%` }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Findings Browser */}
      <div className="pt-4 border-t border-slate-800">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <span>Well-Architected Findings</span>
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-800 text-slate-300">
                {filteredFindings.length}
              </span>
            </h2>
          </div>

          {/* Filter controls */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              placeholder="Search findings or resources..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-750 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 w-56"
            />

            {/* Severity Filter */}
            <select
              value={selectedSeverity}
              onChange={(e) => setSelectedSeverity(e.target.value)}
              className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-750 text-xs text-slate-300 focus:outline-none focus:border-cyan-500"
            >
              <option value="all">All Severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>

            {/* Pillar Filter */}
            <select
              value={selectedPillar}
              onChange={(e) => setSelectedPillar(e.target.value)}
              className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-750 text-xs text-slate-300 focus:outline-none focus:border-cyan-500"
            >
              <option value="all">All Pillars</option>
              {Object.entries(PILLAR_CONFIG).map(([key, cfg]) => (
                <option key={key} value={key}>{cfg.label}</option>
              ))}
            </select>

            {(selectedPillar !== 'all' || selectedSeverity !== 'all' || searchQuery) && (
              <button
                onClick={() => {
                  setSelectedPillar('all');
                  setSelectedSeverity('all');
                  setSearchQuery('');
                }}
                className="px-2 py-1 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
              >
                Reset
              </button>
            )}
          </div>
        </div>

        {/* Findings List */}
        {filteredFindings.length === 0 ? (
          <div className="p-12 text-center rounded-2xl bg-slate-900/40 border border-slate-800">
            <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
            <p className="text-base font-semibold text-white">No findings in this view</p>
            <p className="text-xs text-slate-400 mt-1">All architecture rules are satisfied for the selected filters.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredFindings.map((finding) => {
              const sev = SEVERITY_CONFIG[finding.severity] || SEVERITY_CONFIG.info;
              const pillarCfg = PILLAR_CONFIG[finding.pillar];

              return (
                <div
                  key={finding.id}
                  className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 transition-all backdrop-blur-md"
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 pb-3 border-b border-slate-800/60">
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* Severity badge */}
                      <span className={clsx('px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider border', sev.color, sev.bg, sev.border)}>
                        {sev.label}
                      </span>
                      {/* Pillar badge */}
                      {pillarCfg && (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-slate-800 text-slate-300 border border-slate-700">
                          {pillarCfg.label}
                        </span>
                      )}
                      {/* Source attribution */}
                      <span className="text-[10px] text-slate-500 font-mono">
                        {finding.sourceLabel || finding.source}
                      </span>
                    </div>

                    {/* Official documentation link */}
                    {finding.pillarRef && (
                      <a
                        href={finding.pillarRef}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 font-medium transition-colors"
                      >
                        <span>Official Guidance</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>

                  <h3 className="text-sm font-bold text-white mt-3">{finding.title}</h3>
                  <p className="text-xs text-slate-300 mt-1 leading-relaxed">{finding.description}</p>

                  {/* Recommendation & Remediation */}
                  <div className="mt-3.5 grid grid-cols-1 md:grid-cols-2 gap-3 pt-3 border-t border-slate-800/40">
                    <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/60">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400 block mb-1">
                        Recommendation
                      </span>
                      <p className="text-xs text-slate-300">{finding.recommendation}</p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/60">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 block mb-1">
                        Remediation Action
                      </span>
                      <p className="text-xs text-slate-300">{finding.remediation}</p>
                    </div>
                  </div>

                  {/* Affected resources */}
                  {finding.affectedResourceLabels && finding.affectedResourceLabels.length > 0 && (
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] text-slate-400">Affected resources:</span>
                      {finding.affectedResourceLabels.map((lbl, i) => (
                        <span
                          key={i}
                          className="px-2 py-0.5 rounded-lg bg-slate-800/80 border border-slate-700 text-[11px] font-mono text-slate-200"
                        >
                          {lbl}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
