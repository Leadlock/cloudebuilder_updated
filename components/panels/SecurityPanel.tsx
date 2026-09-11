'use client';
import { useState, useEffect, useMemo } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { apiSecurityService } from '@/lib/services/ApiSecurityService';
import { SecurityIssue } from '@/types';
import { ShieldCheck, ShieldAlert, ShieldX, AlertTriangle, Info, CheckCircle2, Wrench, Shield } from 'lucide-react';
import clsx from 'clsx';
import { scoreArchitecture } from '@/lib/generator';
import { runSecurityScan } from '@/lib/analysis';

const severityConfig = {
  critical: { icon: ShieldX,    color: 'text-red-400',    bg: 'bg-red-900/30',    border: 'border-red-800',    badge: 'bg-red-900 text-red-300',    label: 'Critical' },
  high:     { icon: ShieldAlert, color: 'text-orange-400', bg: 'bg-orange-900/30', border: 'border-orange-800', badge: 'bg-orange-900 text-orange-300', label: 'High' },
  medium:   { icon: AlertTriangle,color:'text-yellow-400', bg: 'bg-yellow-900/30', border: 'border-yellow-800', badge: 'bg-yellow-900 text-yellow-300', label: 'Medium' },
  low:      { icon: Info,         color: 'text-blue-400',  bg: 'bg-blue-900/30',  border: 'border-blue-800',  badge: 'bg-blue-900 text-blue-300',  label: 'Low' },
};

function ScoreRing({ score, label = 'Score' }: { score: number; label?: string }) {
  const r = 36;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 80 ? '#10B981' : score >= 60 ? '#F59E0B' : '#EF4444';
  return (
    <div className="relative w-24 h-24 flex items-center justify-center">
      <svg className="w-24 h-24 -rotate-90" viewBox="0 0 88 88" aria-hidden="true">
        <circle cx="44" cy="44" r={r} fill="none" stroke="#374151" strokeWidth="6" />
        <circle cx="44" cy="44" r={r} fill="none" stroke={color} strokeWidth="6"
          strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.5s ease' }} />
      </svg>
      <div className="absolute text-center">
        <p className="text-2xl font-bold text-white leading-none">{score}</p>
        <p className="text-gray-500 text-[9px] uppercase tracking-wide">{label}</p>
      </div>
    </div>
  );
}

function MiniBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${value}%`, backgroundColor: color }} />
      </div>
      <span className="text-xs text-gray-400 w-6 text-right">{value}</span>
    </div>
  );
}

export default function SecurityPanel() {
  const { state, dispatch } = useApp();
  const activeProject = useActiveProject();
  const [fixedIds, setFixedIds] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [issues, setIssues] = useState<SecurityIssue[]>([]);

  // Run security scan via the API-backed service whenever the active project or nodes change.
  // apiSecurityService already has the project ID injected by AppContext.
  const nodeCount = activeProject?.nodes.length ?? 0;
  const activeProjectId = activeProject?.id ?? null;
  const projectUpdatedAt = activeProject?.updatedAt ?? null;

  useEffect(() => {
    if (!activeProject || nodeCount === 0) {
      return;
    }
    let cancelled = false;
    apiSecurityService.scan(activeProject.nodes).then((result) => {
      if (!cancelled) {
        setIssues(result);
        setError(null);
        setScanning(false);
      }
    }).catch(() => {
      if (!cancelled) {
        const local = runSecurityScan(activeProject.nodes);
        setIssues(local);
        setError(null);
        setScanning(false);
      }
    });
    return () => { cancelled = true; };
  }, [activeProjectId, nodeCount, projectUpdatedAt, retryCount]);

  const score = useMemo(() => apiSecurityService.score(issues), [issues]);
  const archScores = useMemo(
    () => (activeProject ? scoreArchitecture(activeProject.nodes) : { reliability: 0, security: 0, performance: 0, cost: 0, scalability: 0 }),
    [activeProject],
  );

  if (!activeProject) return null;

  const counts = {
    critical: issues.filter((i) => i.severity === 'critical').length,
    high:     issues.filter((i) => i.severity === 'high').length,
    medium:   issues.filter((i) => i.severity === 'medium').length,
    low:      issues.filter((i) => i.severity === 'low').length,
  };

  const visibleIssues = issues
    .filter((i) => !fixedIds.has(i.id))
    .sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return order[a.severity] - order[b.severity];
    });

  function handleFix(issue: SecurityIssue) {
    if (!issue.fixable || !issue.ruleId) return;
    dispatch({ type: 'FIX_SECURITY_ISSUE', nodeId: issue.nodeId, ruleId: issue.ruleId });
    setFixedIds((s) => new Set(s).add(issue.id));
  }

  // Empty state
  if (nodeCount === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900">
        <div className="text-center px-8 py-12">
          <Shield className="w-12 h-12 text-gray-700 mx-auto mb-4" />
          <p className="text-gray-400 font-medium text-lg">No resources to scan</p>
          <p className="text-gray-600 text-sm mt-1">Add resources to the canvas to run a security analysis</p>
        </div>
      </div>
    );
  }

  // Scanning state
  if (scanning) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900">
        <div className="text-center" role="status" aria-label="Scanning security">
          <div className="w-12 h-12 border-4 border-blue-700 border-t-blue-400 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400 font-medium">Scanning security…</p>
          <p className="text-gray-600 text-sm mt-1">Analysing {nodeCount} resource{nodeCount !== 1 ? 's' : ''}</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900 p-6">
        <div className="text-center max-w-md bg-gray-800 border border-red-800/60 rounded-xl p-8 shadow-xl">
          <AlertTriangle className="w-12 h-12 text-red-400 mx-auto mb-4" aria-hidden="true" />
          <h3 className="text-white font-semibold text-lg mb-2">Security Scan Failed</h3>
          <p className="text-gray-400 text-sm mb-6">{error}</p>
          <button
            onClick={() => setRetryCount((c) => c + 1)}
            className="px-4 py-2 bg-red-800 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            Retry Scan
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-900 p-5">
      <div className="max-w-4xl mx-auto">
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

        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <ShieldCheck className="w-5 h-5 text-blue-400" />
          <h2 className="text-white font-bold text-lg">Security Scan</h2>
          {issues.length === 0 && <span className="text-xs px-2 py-0.5 bg-emerald-900/40 text-emerald-300 rounded-full">All Clear</span>}
        </div>

        {/* Score cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {/* Security score */}
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 flex items-center gap-5">
            <ScoreRing score={score} label="Security" />
            <div className="flex-1">
              <h3 className="text-white font-semibold mb-1 text-sm">
                {score >= 80 ? 'Good Security Posture' : score >= 60 ? 'Needs Improvement' : 'Critical Issues Found'}
              </h3>
              <p className="text-gray-400 text-xs mb-3">
                {issues.length === 0 ? 'No issues detected.' : `${issues.length} issue${issues.length !== 1 ? 's' : ''} found.`}
              </p>
              <div className="flex gap-4">
                {(['critical', 'high', 'medium', 'low'] as const).map((s) => (
                  <div key={s} className="text-center">
                    <p className={clsx('text-base font-bold', severityConfig[s].color)}>{counts[s]}</p>
                    <p className="text-gray-600 text-[10px]">{severityConfig[s].label}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Architecture score breakdown */}
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
            <h3 className="text-white font-semibold text-sm mb-3">Architecture Posture</h3>
            <div className="space-y-2">
              {([
                ['Reliability',  archScores.reliability,  '#3B82F6'],
                ['Security',     archScores.security,     '#10B981'],
                ['Performance',  archScores.performance,  '#F59E0B'],
                ['Cost',         archScores.cost,         '#A78BFA'],
                ['Scalability',  archScores.scalability,  '#F97316'],
              ] as [string, number, string][]).map(([label, value, color]) => (
                <div key={label} className="flex items-center gap-3">
                  <span className="text-gray-400 text-xs w-20">{label}</span>
                  <MiniBar value={value} color={color} />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Issues list */}
        {visibleIssues.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center bg-gray-800/50 rounded-xl border border-gray-700">
            <CheckCircle2 className="w-12 h-12 text-emerald-500 mb-3" />
            <p className="text-white font-medium text-lg">No security issues found</p>
            <p className="text-gray-500 text-sm mt-1">Your infrastructure follows security best practices</p>
          </div>
        ) : (
          <div className="space-y-3">
            {visibleIssues.map((issue) => {
              const cfg = severityConfig[issue.severity];
              const Icon = cfg.icon;
              return (
                <div key={issue.id} className={clsx('rounded-xl border p-4', cfg.bg, cfg.border)}>
                  <div className="flex items-start gap-3">
                    <Icon className={clsx('w-5 h-5 mt-0.5 shrink-0', cfg.color)} aria-hidden="true" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <div>
                          <p className="text-white font-medium text-sm">{issue.message}</p>
                          <p className="text-gray-500 text-xs mt-0.5">Affected: {issue.nodeLabel}</p>
                        </div>
                        <span className={clsx('text-xs px-2 py-0.5 rounded-full font-medium shrink-0', cfg.badge)}>
                          {cfg.label}
                        </span>
                      </div>
                      <div className="mt-2 p-2.5 bg-black/20 rounded-lg">
                        <p className="text-gray-300 text-xs">
                          <span className="text-green-400 font-medium">Fix: </span>
                          {issue.recommendation}
                        </p>
                      </div>
                      {issue.fixable && issue.ruleId && (
                        <button
                          onClick={() => handleFix(issue)}
                          aria-label={`Auto-fix: ${issue.message}`}
                          className="mt-2 flex items-center gap-1.5 px-3 py-1 bg-emerald-800 hover:bg-emerald-700 text-emerald-200 rounded-lg text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        >
                          <Wrench className="w-3 h-3" aria-hidden="true" />
                          Auto-Fix
                        </button>
                      )}
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
