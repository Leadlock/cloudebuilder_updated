'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import AiReviewCard from './AiReviewCard';
import type { AiWellArchitectedReview } from '@/lib/services/AiReviewService';
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
  Download,
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

  const [aiReview, setAiReview] = useState<{ review: AiWellArchitectedReview; nodes: unknown } | null>(null);
  const [exporting, setExporting] = useState<'pdf' | 'html' | 'json' | null>(null);
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
  const isSaved = Boolean(activeProject && activeProject.id !== 'draft-project' && state.activeProjectId === activeProject.id);

  const exportReport = async (format: 'pdf' | 'html' | 'json') => {
    setExporting(format);
    setError(null);
    try {
      // The AI commentary is included only when it was written for the design that is open now.
      const ai = aiReview && aiReview.nodes === activeProject?.nodes ? aiReview.review : null;
      const { blob, filename } = await apiWellArchitectedService.downloadReport(format, ai ? {
        summary: ai.summary,
        pillars: ai.pillars.map((p) => ({ pillar: p.key, assessment: p.assessment, topFixes: p.topFixes.map((f) => ({ ruleId: f.ruleId, fix: f.fix })) })),
        plan: ai.plan.map((s) => ({ ruleId: s.ruleId, action: s.action })),
        suggestions: ai.suggestions,
      } : undefined);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Report export failed');
    } finally {
      setExporting(null);
    }
  };

  const isLight = state.theme === 'light';

  if (!activeProject) {
    return (
      <div className={clsx('flex-1 flex items-center justify-center', isLight ? 'bg-slate-50 text-slate-500' : 'bg-slate-950 text-slate-400')}>
        <p>Please select or create a project to view Well-Architected intelligence.</p>
      </div>
    );
  }

  const overallScore = assessment?.overallScore ?? 0;
  // Coverage-aware: when nothing could be evaluated the score is not shown as a number.
  const overallScored = assessment?.overallScored !== false;
  const scoreColor =
    overallScore >= 80 ? (isLight ? 'text-emerald-600' : 'text-emerald-400') : overallScore >= 60 ? (isLight ? 'text-amber-600' : 'text-amber-400') : (isLight ? 'text-rose-600' : 'text-rose-400');
  const scoreBorder =
    overallScore >= 80 ? (isLight ? 'border-emerald-200' : 'border-emerald-500/40') : overallScore >= 60 ? (isLight ? 'border-amber-200' : 'border-amber-500/40') : (isLight ? 'border-rose-200' : 'border-rose-500/40');

  return (
    <div className={clsx('flex-1 flex flex-col overflow-y-auto px-4 sm:px-6 lg:px-8 py-6 pb-36 space-y-6 custom-scrollbar', isLight ? 'bg-slate-50 text-slate-900' : 'bg-slate-950 text-slate-100')}>
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

      {/* Header Banner */}
      <div className={clsx('flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b', isLight ? 'border-slate-200' : 'border-slate-800')}>
        <div>
          <div className="flex items-center gap-3">
            <h1 className={clsx('text-2xl font-black tracking-tight flex items-center gap-2.5', isLight ? 'text-slate-900' : 'text-white')}>
              <ShieldCheck className={clsx('w-7 h-7', isLight ? 'text-cyan-600' : 'text-cyan-400')} />
              Well-Architected Review
            </h1>
            <span className={clsx('px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider border', isLight ? 'bg-slate-100 text-slate-700 border-slate-300' : 'bg-slate-800 text-slate-300 border-slate-700')}>
              {activeProject.provider.toUpperCase()}
            </span>
            {assessment?.isStale && (
              <span className={clsx('px-2.5 py-0.5 rounded-full text-xs font-bold border flex items-center gap-1.5 animate-pulse', isLight ? 'bg-amber-50 text-amber-700 border-amber-300' : 'bg-amber-500/10 text-amber-300 border-amber-500/30')}>
                <AlertTriangle className="w-3 h-3" />
                Stale — Architecture Changed
              </span>
            )}
          </div>
          <p className={clsx('text-sm mt-1', isLight ? 'text-slate-600' : 'text-slate-400')}>
            Design-time checks mapped to the pillars of the {activeProject.provider === 'azure' ? 'Microsoft Azure Well-Architected Framework' : activeProject.provider === 'multi' ? 'AWS and Microsoft Azure Well-Architected Frameworks' : 'AWS Well-Architected Framework'}
            — a heuristic assessment, not an official certification or compliance report.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {(['pdf', 'html'] as const).map((fmt) => (
            <button
              key={fmt}
              onClick={() => void exportReport(fmt)}
              disabled={!isSaved || isStale || exporting !== null}
              title={!isSaved ? 'Save the project to export a report' : isStale ? 'Save your changes first — reports are generated from the saved architecture' : `Export the Well-Architected report as ${fmt.toUpperCase()}`}
              data-testid={`wa-export-${fmt}`}
              className={clsx('flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold transition-all border disabled:opacity-40', isLight ? 'bg-white hover:bg-slate-100 text-slate-800 border-slate-300 shadow-sm' : 'bg-slate-800 hover:bg-slate-700 text-slate-100 border-slate-700')}
            >
              <Download className="w-4 h-4" />{exporting === fmt ? 'Generating…' : fmt.toUpperCase()}
            </button>
          ))}
          <button
            onClick={handleRunAnalysis}
            disabled={analyzing}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all shadow-lg',
              analyzing
                ? isLight ? 'bg-cyan-100 text-cyan-700 cursor-wait' : 'bg-cyan-900/50 text-cyan-300 cursor-wait'
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
        <div className={clsx('p-5 rounded-2xl border backdrop-blur-md relative overflow-hidden transition-all', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/70', scoreBorder)}>
          <div className="flex items-center justify-between">
            <span className={clsx('text-xs font-semibold uppercase tracking-wider', isLight ? 'text-slate-500' : 'text-slate-400')}>Overall Health</span>
            <ShieldCheck className={clsx('w-5 h-5', scoreColor)} />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className={clsx('text-4xl font-black tracking-tight', scoreColor)}>
              {assessment && overallScored ? `${overallScore}` : '—'}
            </span>
            <span className={clsx('text-xs', isLight ? 'text-slate-500' : 'text-slate-400')}>
              {!assessment ? (loading ? 'Analyzing…' : 'Not analyzed yet — run the review') : overallScored ? `/100 · coverage ${assessment.coveragePct ?? 0}%` : 'Not scored — insufficient evidence'}
            </span>
          </div>
          <div className={clsx('mt-3 w-full rounded-full h-1.5 overflow-hidden', isLight ? 'bg-slate-100' : 'bg-slate-800')}>
            <div
              className={clsx('h-full transition-all duration-700', overallScore >= 80 ? 'bg-emerald-500' : overallScore >= 60 ? 'bg-amber-500' : 'bg-rose-500')}
              style={{ width: `${overallScored ? overallScore : 0}%` }}
            />
          </div>
          {assessment && (assessment.notEvaluatedCount ?? 0) > 0 && (
            <p className={clsx('mt-2 text-[11px]', isLight ? 'text-slate-500' : 'text-slate-400')}>{assessment.notEvaluatedCount} check(s) not evaluated — excluded from the score, never counted as passing.</p>
          )}
        </div>

        {/* Critical Findings */}
        <div className={clsx('p-5 rounded-2xl border backdrop-blur-md transition-all', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/70 border-slate-800')}>
          <div className="flex items-center justify-between">
            <span className={clsx('text-xs font-semibold uppercase tracking-wider', isLight ? 'text-slate-500' : 'text-slate-400')}>Critical Issues</span>
            <ShieldAlert className={clsx('w-5 h-5', isLight ? 'text-rose-600' : 'text-rose-400')} />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className={clsx('text-4xl font-black tracking-tight', criticalFindings.length > 0 ? (isLight ? 'text-rose-600' : 'text-rose-400') : (isLight ? 'text-slate-900' : 'text-slate-200'))}>
              {criticalFindings.length}
            </span>
            <span className={clsx('text-xs', isLight ? 'text-slate-500' : 'text-slate-400')}>Blocking Deployments</span>
          </div>
          <p className={clsx('text-xs mt-2', isLight ? 'text-slate-500' : 'text-slate-400')}>
            {criticalFindings.length === 0 ? 'No critical vulnerabilities detected.' : 'Require remediation prior to prod.'}
          </p>
        </div>

        {/* Total Findings */}
        <div className={clsx('p-5 rounded-2xl border backdrop-blur-md transition-all', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/70 border-slate-800')}>
          <div className="flex items-center justify-between">
            <span className={clsx('text-xs font-semibold uppercase tracking-wider', isLight ? 'text-slate-500' : 'text-slate-400')}>Total Findings</span>
            <Layers className={clsx('w-5 h-5', isLight ? 'text-cyan-600' : 'text-cyan-400')} />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className={clsx('text-4xl font-black tracking-tight', isLight ? 'text-slate-900' : 'text-white')}>
              {assessment?.findings?.length ?? 0}
            </span>
            <span className={clsx('text-xs', isLight ? 'text-slate-500' : 'text-slate-400')}>Opportunities</span>
          </div>
          <p className={clsx('text-xs mt-2', isLight ? 'text-slate-500' : 'text-slate-400')}>
            Across {activeProject.nodes.length} canvas resources.
          </p>
        </div>

        {/* Intelligence Source */}
        <div className={clsx('p-5 rounded-2xl border backdrop-blur-md transition-all', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/70 border-slate-800')}>
          <div className="flex items-center justify-between">
            <span className={clsx('text-xs font-semibold uppercase tracking-wider', isLight ? 'text-slate-500' : 'text-slate-400')}>Intelligence Source</span>
            <Info className={clsx('w-5 h-5', isLight ? 'text-indigo-600' : 'text-indigo-400')} />
          </div>
          <div className="mt-3">
            <span className={clsx('text-sm font-bold block truncate', isLight ? 'text-slate-900' : 'text-white')}>
              {assessment?.source === 'LIVE_AWS_WAF'
                ? 'AWS Well-Architected Tool API'
                : assessment?.source === 'LIVE_AZURE_ADVISOR'
                ? 'Azure Advisor ARM API'
                : 'Design-Time Rule Engine'}
            </span>
            <span className={clsx('text-xs mt-0.5 block', isLight ? 'text-slate-500' : 'text-slate-400')}>
              Confidence: {assessment?.confidence ?? 'Design-Time'}
            </span>
          </div>
          <p className={clsx('text-[11px] mt-2 truncate', isLight ? 'text-slate-500' : 'text-slate-400')}>
            {assessment?.frameworkVersion ? `Version: ${assessment.frameworkVersion}` : 'Deterministic analysis'}
          </p>
        </div>
      </div>

      <AiReviewCard nodes={activeProject.nodes} edges={activeProject.edges} mode="well-architected" onReview={(r, n) => setAiReview({ review: r as AiWellArchitectedReview, nodes: n })} />
      {aiReview && aiReview.nodes === activeProject.nodes && <p className={clsx('text-[11px] -mt-4', isLight ? 'text-slate-500' : 'text-slate-500')}>The AI review above will be included in the PDF and HTML export as a separately labelled section.</p>}

      {/* Critical Findings Alert Banner (if any) */}
      {criticalFindings.length > 0 && (
        <div className={clsx('p-4 rounded-2xl border backdrop-blur-md flex flex-col md:flex-row md:items-center justify-between gap-4', isLight ? 'bg-rose-50 border-rose-200' : 'bg-rose-950/30 border-rose-500/40')}>
          <div className="flex items-start gap-3">
            <div className={clsx('p-2 rounded-xl shrink-0', isLight ? 'bg-rose-100 text-rose-600' : 'bg-rose-500/20 text-rose-400')}>
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h3 className={clsx('text-sm font-bold', isLight ? 'text-rose-950' : 'text-rose-200')}>
                Deployment Gate: {criticalFindings.length} Critical Finding{criticalFindings.length > 1 ? 's' : ''} Detected
              </h3>
              <p className={clsx('text-xs mt-0.5', isLight ? 'text-rose-800' : 'text-rose-300/80')}>
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
            className={clsx('px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors shrink-0', isLight ? 'bg-rose-100 hover:bg-rose-200 text-rose-900 border-rose-300' : 'bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border-rose-500/40')}
          >
            Review Critical Only
          </button>
        </div>
      )}

      {/* Pillar Scores Section */}
      <div>
        <h2 className={clsx('text-base font-bold mb-3', isLight ? 'text-slate-900' : 'text-white')}>Pillar Performance</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {assessment?.pillarScores?.map((ps) => {
            const config = PILLAR_CONFIG[ps.pillar] || {
              label: ps.pillarLabel,
              icon: Activity,
              color: isLight ? 'text-slate-600' : 'text-slate-400',
              bg: isLight ? 'bg-slate-100' : 'bg-slate-900/30',
              border: isLight ? 'border-slate-200' : 'border-slate-800',
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
                    ? isLight ? 'ring-2 ring-cyan-500 border-cyan-500 bg-cyan-50/50 shadow-sm' : 'ring-2 ring-cyan-400 border-cyan-400 bg-slate-900/90'
                    : isLight ? 'bg-white hover:bg-slate-50 border-slate-200 hover:border-slate-300 shadow-sm' : 'bg-slate-900/60 hover:bg-slate-900 border-slate-800 hover:border-slate-700'
                )}
              >
                <div className="flex items-center justify-between">
                  <div className={clsx('p-2 rounded-xl border', config.bg, config.border, config.color)}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <span className={clsx('text-xl font-bold font-mono', !scored ? (isLight ? 'text-slate-400' : 'text-slate-500') : ps.score >= 80 ? (isLight ? 'text-emerald-600' : 'text-emerald-400') : ps.score >= 60 ? (isLight ? 'text-amber-600' : 'text-amber-400') : (isLight ? 'text-rose-600' : 'text-rose-400'))}>
                    {scored ? ps.score : '—'}
                  </span>
                </div>

                <h4 className={clsx('font-bold text-xs mt-3 truncate', isLight ? 'text-slate-900' : 'text-white')}>{ps.provider && assessment?.provider === 'multi' ? `${ps.provider.toUpperCase()} · ` : ''}{config.label}</h4>
                <p className={clsx('text-[10px] mt-0.5', isLight ? 'text-slate-500' : 'text-slate-500')}>{scored ? `Coverage ${ps.coveragePct ?? 0}% · ${ps.status ?? ''}` : (ps.status === 'Insufficient evidence' || !ps.status ? 'Insufficient evidence' : `${ps.status} (informational checks only)`)}</p>
                <div className={clsx('flex items-center justify-between text-[11px] mt-1', isLight ? 'text-slate-600' : 'text-slate-400')}>
                  <span>{ps.findingCount} finding{ps.findingCount === 1 ? '' : 's'}</span>
                  {ps.criticalCount > 0 && (
                    <span className={clsx('font-bold', isLight ? 'text-rose-600' : 'text-rose-400')}>{ps.criticalCount} crit</span>
                  )}
                </div>

                <div className={clsx('mt-2.5 w-full rounded-full h-1 overflow-hidden', isLight ? 'bg-slate-100' : 'bg-slate-800')}>
                  <div
                    className={clsx('h-full', ps.score >= 80 ? 'bg-emerald-500' : ps.score >= 60 ? 'bg-amber-500' : 'bg-rose-500')}
                    style={{ width: `${scored ? ps.score : 0}%` }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Findings Browser */}
      <div className={clsx('pt-4 border-t', isLight ? 'border-slate-200' : 'border-slate-800')}>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4">
          <div>
            <h2 className={clsx('text-base font-bold flex items-center gap-2', isLight ? 'text-slate-900' : 'text-white')}>
              <span>Well-Architected Findings</span>
              <span className={clsx('px-2 py-0.5 rounded-full text-xs font-semibold border', isLight ? 'bg-slate-100 text-slate-700 border-slate-300' : 'bg-slate-800 text-slate-300 border-slate-700')}>
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
              className={clsx(
                'px-3 py-1.5 rounded-xl border text-xs focus:outline-none focus:border-cyan-500 w-56 transition-all',
                isLight ? 'bg-white border-slate-300 text-slate-900 placeholder-slate-400 shadow-sm' : 'bg-slate-900 border-slate-750 text-white placeholder-slate-500'
              )}
            />

            {/* Severity Filter */}
            <select
              value={selectedSeverity}
              onChange={(e) => setSelectedSeverity(e.target.value)}
              className={clsx(
                'px-3 py-1.5 rounded-xl border text-xs focus:outline-none focus:border-cyan-500 transition-all',
                isLight ? 'bg-white border-slate-300 text-slate-800 shadow-sm' : 'bg-slate-900 border-slate-750 text-slate-300'
              )}
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
              className={clsx(
                'px-3 py-1.5 rounded-xl border text-xs focus:outline-none focus:border-cyan-500 transition-all',
                isLight ? 'bg-white border-slate-300 text-slate-800 shadow-sm' : 'bg-slate-900 border-slate-750 text-slate-300'
              )}
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
                className={clsx('px-2 py-1 text-xs transition-colors font-medium', isLight ? 'text-cyan-600 hover:text-cyan-700' : 'text-cyan-400 hover:text-cyan-300')}
              >
                Reset
              </button>
            )}
          </div>
        </div>

        {/* Findings List */}
        {filteredFindings.length === 0 ? (
          <div className={clsx('p-12 text-center rounded-2xl border', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/40 border-slate-800')}>
            <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
            <p className={clsx('text-base font-semibold', isLight ? 'text-slate-900' : 'text-white')}>No findings in this view</p>
            <p className={clsx('text-xs mt-1', isLight ? 'text-slate-500' : 'text-slate-400')}>All architecture rules are satisfied for the selected filters.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredFindings.map((finding) => {
              const sev = SEVERITY_CONFIG[finding.severity] || SEVERITY_CONFIG.info;
              const pillarCfg = PILLAR_CONFIG[finding.pillar];

              return (
                <div
                  key={finding.id}
                  className={clsx(
                    'p-5 rounded-2xl border transition-all backdrop-blur-md',
                    isLight ? 'bg-white border-slate-200 hover:border-slate-300 shadow-sm' : 'bg-slate-900/60 border-slate-800/80 hover:border-slate-700'
                  )}
                >
                  <div className={clsx('flex flex-col md:flex-row md:items-center justify-between gap-2 pb-3 border-b', isLight ? 'border-slate-100' : 'border-slate-800/60')}>
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* Severity badge */}
                      <span className={clsx('px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider border', sev.color, sev.bg, sev.border)}>
                        {sev.label}
                      </span>
                      {/* Pillar badge */}
                      {pillarCfg && (
                        <span className={clsx('px-2 py-0.5 rounded-md text-[10px] font-semibold border', isLight ? 'bg-slate-100 text-slate-700 border-slate-200' : 'bg-slate-800 text-slate-300 border-slate-700')}>
                          {pillarCfg.label}
                        </span>
                      )}
                      {/* Source attribution */}
                      <span className={clsx('text-[10px] font-mono', isLight ? 'text-slate-400' : 'text-slate-500')}>
                        {finding.sourceLabel || finding.source}
                      </span>
                    </div>

                    {/* Official documentation link */}
                    {finding.pillarRef && (
                      <a
                        href={finding.pillarRef}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={clsx('inline-flex items-center gap-1 text-xs font-medium transition-colors', isLight ? 'text-cyan-600 hover:text-cyan-700' : 'text-cyan-400 hover:text-cyan-300')}
                      >
                        <span>Official Guidance</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>

                  <h3 className={clsx('text-sm font-bold mt-3', isLight ? 'text-slate-900' : 'text-white')}>{finding.title}</h3>
                  <p className={clsx('text-xs mt-1 leading-relaxed', isLight ? 'text-slate-600' : 'text-slate-300')}>{finding.description}</p>

                  {/* Recommendation & Remediation */}
                  <div className={clsx('mt-3.5 grid grid-cols-1 md:grid-cols-2 gap-3 pt-3 border-t', isLight ? 'border-slate-100' : 'border-slate-800/40')}>
                    <div className={clsx('p-3 rounded-xl border', isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800/60')}>
                      <span className={clsx('text-[10px] font-bold uppercase tracking-wider block mb-1', isLight ? 'text-cyan-700' : 'text-cyan-400')}>
                        Recommendation
                      </span>
                      <p className={clsx('text-xs', isLight ? 'text-slate-700' : 'text-slate-300')}>{finding.recommendation}</p>
                    </div>
                    <div className={clsx('p-3 rounded-xl border', isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800/60')}>
                      <span className={clsx('text-[10px] font-bold uppercase tracking-wider block mb-1', isLight ? 'text-emerald-700' : 'text-emerald-400')}>
                        Remediation Action
                      </span>
                      <p className={clsx('text-xs', isLight ? 'text-slate-700' : 'text-slate-300')}>{finding.remediation}</p>
                    </div>
                  </div>

                  {/* Affected resources */}
                  {finding.affectedResourceLabels && finding.affectedResourceLabels.length > 0 && (
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <span className={clsx('text-[11px]', isLight ? 'text-slate-500' : 'text-slate-400')}>Affected resources:</span>
                      {finding.affectedResourceLabels.map((lbl, i) => (
                        <span
                          key={i}
                          className={clsx('px-2 py-0.5 rounded-lg border text-[11px] font-mono', isLight ? 'bg-slate-100 border-slate-200 text-slate-800' : 'bg-slate-800/80 border-slate-700 text-slate-200')}
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
