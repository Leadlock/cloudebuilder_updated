'use client';
/**
 * Security & Well-Architected assessment view.
 *
 * Live results come from the same assessment engine that runs on the server
 * (lib/engines/assessment), evaluated on the active canvas graph. Persisted
 * scans are immutable snapshots of the SAVED architecture (revision-bound) and
 * are the only source for exported reports. Auto-Fix runs through the verified
 * pipeline (validation → rule re-run → regression check → Terraform) and then
 * persists through the normal canvas save path.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ShieldCheck, AlertTriangle, CheckCircle2, Download, RefreshCw, Wrench, History, HelpCircle, Info } from 'lucide-react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { apiSecurityService, type ReviewRecord, type ScanHistoryEntry, type PersistedScan } from '@/lib/services/ApiSecurityService';
import { apiArchitectureService } from '@/lib/services/ApiArchitectureService';
import { runAssessment } from '@/lib/engines/assessment/AssessmentEngine';
import { planAutoFix, applyAutoFix, applySafeFixes, safeFixCandidates, type AutoFixPlan } from '@/lib/engines/assessment/autofix';
import { RULES_BY_ID } from '@/lib/engines/assessment/rules';
import { SCORE_METHODOLOGY } from '@/lib/engines/assessment/scoring';
import type { Finding, FindingReview, Severity } from '@/lib/engines/assessment/types';
import FindingCard from './security/FindingCard';
import { AutoFixPreviewModal, BulkFixModal, ReviewModal } from './security/AutoFixModals';
import { SEVERITY_STYLE, StatusBadge } from './security/ui';

type Tab = 'findings' | 'not-evaluated' | 'passed' | 'history';
type Scope = 'security' | 'all';
interface Toast { kind: 'ok' | 'error' | 'info'; text: string }

function ScoreRing({ score }: { score: number | null }) {
  const r = 36; const c = 2 * Math.PI * r;
  const offset = c - ((score ?? 0) / 100) * c;
  const color = score === null ? '#4B5563' : score >= 75 ? '#10B981' : score >= 50 ? '#F59E0B' : '#EF4444';
  return (
    <div className="relative w-24 h-24 flex items-center justify-center shrink-0">
      <svg className="w-24 h-24 -rotate-90" viewBox="0 0 88 88" aria-hidden="true">
        <circle cx="44" cy="44" r={r} fill="none" stroke="#374151" strokeWidth="6" />
        {score !== null && <circle cx="44" cy="44" r={r} fill="none" stroke={color} strokeWidth="6" strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round" />}
      </svg>
      <div className="absolute text-center">
        <p className="text-2xl font-bold text-white leading-none">{score ?? '—'}</p>
        <p className="text-gray-500 text-[9px] uppercase tracking-wide">{score === null ? 'Not scored' : 'of 100'}</p>
      </div>
    </div>
  );
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function SecurityPanel() {
  const { state, dispatch } = useApp();
  const project = useActiveProject();
  const [tab, setTab] = useState<Tab>('findings');
  const [scope, setScope] = useState<Scope>('security');
  const [sevFilter, setSevFilter] = useState<Severity | 'ALL'>('ALL');
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [persisted, setPersisted] = useState<PersistedScan | null>(null);
  const [history, setHistory] = useState<ScanHistoryEntry[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [plan, setPlan] = useState<AutoFixPlan | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [reviewing, setReviewing] = useState<Finding | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [showMethod, setShowMethod] = useState(false);
  const pendingAudit = useRef<string[]>([]);

  const isSaved = Boolean(project && project.id !== 'draft-project' && state.activeProjectId === project.id);
  const isStale = state.architectureVersion > state.lastSavedVersion;
  const nodes = useMemo(() => project?.nodes ?? [], [project?.nodes]);
  const edges = useMemo(() => project?.edges ?? [], [project?.edges]);

  const activeReviews: FindingReview[] = useMemo(() => reviews.filter((r) => !r.revokedAt).map((r) => ({
    findingId: r.findingId, status: r.status, reason: r.reason, approvedBy: r.approvedBy, approvedAt: r.approvedAt, ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
  })), [reviews]);

  // Live evaluation of the current canvas graph (same engine as the server).
  const assessment = useMemo(() => runAssessment({ nodes, edges, reviews: activeReviews }), [nodes, edges, activeReviews]);

  const refreshServer = useCallback(async () => {
    if (!isSaved) return;
    setScanning(true);
    try {
      const [scan, hist, revs] = await Promise.all([
        apiSecurityService.runPersistedScan(),
        apiSecurityService.listScans().catch(() => ({ scans: [] as ScanHistoryEntry[] })),
        apiSecurityService.listReviews().catch(() => [] as ReviewRecord[]),
      ]);
      setPersisted(scan); setHistory(hist.scans); setReviews(revs); setScanError(null);
    } catch (e) {
      setScanError((e as Error).message);
    } finally { setScanning(false); }
  }, [isSaved]);

  // Persisted scan whenever the SAVED architecture changes (never on unsaved state).
  const savedKey = `${project?.id}:${state.activeEnvironment}:${state.lastSavedVersion}`;
  useEffect(() => {
    if (!isSaved || isStale) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- server sync on save
    void refreshServer();
    // After an Auto-Fix is saved, record it in the architecture version history (audit trail).
    if (pendingAudit.current.length > 0 && project) {
      const summary = pendingAudit.current.join('; ');
      pendingAudit.current = [];
      apiArchitectureService.saveVersion(project.id, `Security Auto-Fix: ${summary}`.slice(0, 480), state.activeEnvironment).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey, isStale, isSaved]);

  const ruleOf = (id: string) => RULES_BY_ID.get(id)!;
  const inScope = (f: { ruleId: string }) => scope === 'all' || ruleOf(f.ruleId).domain === 'SECURITY';
  const findings = assessment.findings.filter(inScope).filter((f) => sevFilter === 'ALL' || f.severity === sevFilter);
  const scopedEvals = assessment.evaluations.filter(inScope);
  const notEvaluated = scopedEvals.filter((e) => e.status === 'NOT_EVALUATED' || e.status === 'INSUFFICIENT_DATA');
  const passed = scopedEvals.filter((e) => e.status === 'PASS');
  const score = scope === 'security' ? assessment.securityScore : assessment.overallScore;
  const counts = (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'] as Severity[]).map((s) => [s, assessment.findings.filter(inScope).filter((f) => f.severity === s).length] as const);
  const safeFixes = safeFixCandidates(assessment.findings);
  const persistedIds = new Set((persisted?.assessment?.findings ?? []).map((f) => f.findingId));
  const liveIds = new Set(assessment.findings.map((f) => f.findingId));
  const divergent = persisted?.assessment && (assessment.findings.some((f) => !persistedIds.has(f.findingId)) || [...persistedIds].some((id) => !liveIds.has(id)));

  const flash = (t: Toast) => { setToast(t); setTimeout(() => setToast(null), 9000); };

  function openAutoFix(f: Finding) {
    const p = planAutoFix(nodes, edges, f.findingId);
    if ('error' in p) { flash({ kind: 'error', text: p.error }); return; }
    setPlan(p);
  }

  function applyPlan() {
    if (!plan) return;
    setBusy(true);
    const result = applyAutoFix(nodes, edges, plan.findingId, { confirmed: true });
    setBusy(false); setPlan(null);
    if (result.status === 'RESOLVED') {
      dispatch({ type: 'UPDATE_CANVAS', nodes: result.nodes, edges: result.edges });
      pendingAudit.current.push(`${plan.ruleId} on ${plan.resourceLabel} (${plan.changes.map((c) => `${c.label}: ${c.current} → ${c.proposed}`).join(', ')})`);
      flash({ kind: 'ok', text: `${plan.findingId} resolved and verified. ${result.reason}${isSaved ? ' Saving and re-scanning the persisted architecture…' : ' Save the project to persist the change.'}` });
    } else {
      flash({ kind: 'error', text: `AUTO-FIX FAILED — ${result.reason}` });
    }
  }

  const bulkCost = useMemo(() => {
    if (!bulkOpen) return 0;
    return safeFixes.reduce((s, f) => { const p = planAutoFix(nodes, edges, f.findingId); return s + ('error' in p ? 0 : p.cost.deltaMonthly); }, 0);
  }, [bulkOpen, safeFixes, nodes, edges]);

  function applyBulk() {
    setBusy(true);
    const summary = applySafeFixes(nodes, edges, safeFixes.map((f) => f.findingId));
    setBusy(false); setBulkOpen(false);
    if (summary.resolved > 0) {
      dispatch({ type: 'UPDATE_CANVAS', nodes: summary.nodes, edges: summary.edges });
      pendingAudit.current.push(...summary.results.filter((r) => r.status === 'RESOLVED').map((r) => `${r.ruleId} on ${r.plan?.resourceLabel}`));
    }
    const failed = summary.results.filter((r) => r.status === 'AUTO_FIX_FAILED');
    flash({ kind: failed.length ? 'error' : 'ok', text: `${summary.resolved} safe fix(es) applied and verified.${failed.length ? ` ${failed.length} failed verification and were not applied: ${failed.map((r) => `${r.findingId} (${r.reason})`).join('; ')}` : ''}` });
  }

  async function submitReview(v: { status: 'ACCEPTED_RISK' | 'FALSE_POSITIVE' | 'NOT_APPLICABLE'; reason: string; expiresAt?: string }) {
    if (!reviewing) return;
    setBusy(true); setReviewError(null);
    try {
      await apiSecurityService.createReview({ findingId: reviewing.findingId, ...v });
      setReviews(await apiSecurityService.listReviews());
      setReviewing(null);
      flash({ kind: 'info', text: `Review decision recorded for ${reviewing.findingId}. The finding remains technically failing.` });
    } catch (e) { setReviewError((e as Error).message); } finally { setBusy(false); }
  }

  async function exportReport(format: 'pdf' | 'html' | 'json', scanId?: string) {
    setExporting(format);
    try {
      const { blob, filename } = await apiSecurityService.downloadReport(format, scanId);
      download(blob, filename);
      if (!scanId) apiSecurityService.listScans().then((h) => setHistory(h.scans)).catch(() => {});
    } catch (e) { flash({ kind: 'error', text: (e as Error).message }); } finally { setExporting(null); }
  }

  if (!project) return null;
  if (nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900">
        <div className="text-center px-8 py-12"><ShieldCheck className="w-12 h-12 text-gray-700 mx-auto mb-4" />
          <p className="text-gray-400 font-medium text-lg">No resources to assess</p>
          <p className="text-gray-600 text-sm mt-1">Add resources to the canvas to run the security and Well-Architected assessment.</p></div>
      </div>
    );
  }

  const cov = score.coverage;
  return (
    <div className="flex-1 overflow-y-auto bg-gray-900 p-5" data-testid="security-panel">
      <div className="max-w-5xl mx-auto space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3">
          <ShieldCheck className="w-5 h-5 text-blue-400" />
          <h2 className="text-white font-bold text-lg">Security &amp; Architecture Assessment</h2>
          <span className="text-[11px] px-2 py-0.5 rounded bg-amber-900/40 text-amber-200 border border-amber-800/50">{assessment.analysisMode === 'DESIGN_TIME' ? 'Design-time analysis' : 'Design-time + discovered configuration'}</span>
          <span className="text-[11px] text-gray-500">Ruleset {assessment.rulesetVersion} · {assessment.providers.map((p) => p.toUpperCase()).join(' + ')}</span>
          <div className="ml-auto flex gap-2">
            <button onClick={() => void refreshServer()} disabled={!isSaved || isStale || scanning} title={!isSaved ? 'Save the project to run persisted scans' : isStale ? 'Save your changes first' : 'Re-run the persisted scan'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs disabled:opacity-40">
              <RefreshCw className={clsx('w-3.5 h-3.5', scanning && 'animate-spin')} />Re-scan
            </button>
            {(['pdf', 'html', 'json'] as const).map((fmt) => (
              <button key={fmt} onClick={() => void exportReport(fmt)} disabled={!isSaved || isStale || exporting !== null}
                title={!isSaved ? 'Save the project to export a report' : isStale ? 'Save your changes first — reports are generated from the saved architecture' : `Export ${fmt.toUpperCase()} report`}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-600 text-white text-xs font-medium disabled:opacity-40" data-testid={`export-${fmt}`}>
                <Download className="w-3.5 h-3.5" />{exporting === fmt ? 'Generating…' : fmt.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Persistence status */}
        <div className={clsx('rounded-lg border px-4 py-2.5 text-xs flex flex-wrap items-center gap-2', isStale ? 'bg-amber-900/20 border-amber-800/50 text-amber-200' : 'bg-gray-800/60 border-gray-700 text-gray-400')}>
          {isStale ? <><AlertTriangle className="w-4 h-4" />Showing a live evaluation of unsaved changes. Save to persist, re-scan the stored architecture and enable report export.</>
            : !isSaved ? <><Info className="w-4 h-4" />Draft architecture — live evaluation only. Save as a project to persist scans, record review decisions and export reports.</>
              : persisted?.assessment ? <><CheckCircle2 className="w-4 h-4 text-emerald-400" />Persisted scan of revision {persisted.architectureRevision} at {new Date(persisted.createdAt).toLocaleString()} · graph {persisted.graphHash}{divergent ? <span className="text-amber-300 ml-2">— differs from the live view; re-scan after saving.</span> : <span className="text-emerald-400 ml-2">— matches the live view.</span>}</>
                : scanError ? <><AlertTriangle className="w-4 h-4 text-red-400" />Server scan unavailable: {scanError}. The live evaluation below uses the same engine.</>
                  : <>Running persisted scan…</>}
        </div>

        {toast && (
          <div role="status" className={clsx('rounded-lg px-4 py-3 text-xs border', toast.kind === 'ok' ? 'bg-emerald-900/30 border-emerald-700 text-emerald-200' : toast.kind === 'error' ? 'bg-red-900/30 border-red-700 text-red-200' : 'bg-blue-900/30 border-blue-700 text-blue-200')}>{toast.text}</div>
        )}

        {/* Scores */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 bg-gray-800 border border-gray-700 rounded-xl p-5 flex items-center gap-5">
            <ScoreRing score={score.score} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-white font-semibold text-sm">{scope === 'security' ? 'Security score' : 'All checks'} — {score.rating}</h3>
                <button onClick={() => setShowMethod((s) => !s)} className="text-gray-500 hover:text-gray-300" aria-label="Score methodology"><HelpCircle className="w-3.5 h-3.5" /></button>
              </div>
              <p className="text-gray-400 text-xs mt-0.5">Assessment coverage <b className="text-white">{cov.coveragePct ?? 0}%</b> — {cov.evaluated} of {cov.applicable} applicable checks evaluated · {cov.failed} failed · {cov.warnings} warnings · {cov.passed} passed · {cov.notEvaluated + cov.insufficientData} not evaluated</p>
              {score.capApplied && <p className="text-amber-300 text-xs mt-1">{score.capApplied}</p>}
              {score.lowCoverage && <p className="text-amber-300 text-xs mt-1">Low coverage: the score reflects only the checks that could be evaluated.</p>}
              {showMethod && <p className="text-gray-500 text-[11px] mt-2">{SCORE_METHODOLOGY}</p>}
              <div className="flex gap-4 mt-3">
                {counts.map(([s, n]) => (
                  <button key={s} onClick={() => setSevFilter(sevFilter === s ? 'ALL' : s)} className={clsx('text-center rounded px-1', sevFilter === s && 'ring-1 ring-gray-500')}>
                    <p className={clsx('text-base font-bold', SEVERITY_STYLE[s].text)}>{n}</p>
                    <p className="text-gray-500 text-[10px]">{SEVERITY_STYLE[s].label}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-3">
            <h3 className="text-white font-semibold text-sm">Auto-Fix</h3>
            <p className="text-gray-400 text-xs">{safeFixes.length} safe · {assessment.findings.filter((f) => f.autoFix.available && f.autoFix.safety === 'REVIEW_REQUIRED').length} need review · {assessment.findings.filter((f) => !f.autoFix.available).length} manual</p>
            <button onClick={() => setBulkOpen(true)} disabled={safeFixes.length === 0} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-800 hover:bg-emerald-700 text-emerald-50 text-xs font-semibold disabled:opacity-40" data-testid="fix-all-safe">
              <Wrench className="w-3.5 h-3.5" />Fix all safe issues ({safeFixes.length})
            </button>
            <div className="flex rounded-lg overflow-hidden border border-gray-700 text-xs">
              {(['security', 'all'] as const).map((s) => (
                <button key={s} onClick={() => setScope(s)} className={clsx('flex-1 py-1.5', scope === s ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200')}>{s === 'security' ? 'Security' : 'All pillars'}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-800 text-xs">
          {([['findings', `Findings (${findings.length})`], ['not-evaluated', `Not evaluated (${notEvaluated.length})`], ['passed', `Passed (${passed.length})`], ['history', `History (${history.length})`]] as [Tab, string][]).map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)} className={clsx('px-3 py-2 -mb-px border-b-2', tab === t ? 'border-blue-500 text-white' : 'border-transparent text-gray-400 hover:text-gray-200')}>{label}</button>
          ))}
        </div>

        {tab === 'findings' && (findings.length === 0 ? (
          <div className="text-center py-12 bg-gray-800/40 rounded-xl border border-gray-700">
            <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2" />
            <p className="text-white font-medium">No failing checks{sevFilter !== 'ALL' ? ` at ${SEVERITY_STYLE[sevFilter].label} severity` : ''}</p>
            <p className="text-gray-500 text-xs mt-1">{notEvaluated.length > 0 ? `${notEvaluated.length} check(s) could not be evaluated — see "Not evaluated". This is not the same as passing.` : 'All applicable checks were evaluated.'}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {findings.map((f) => <FindingCard key={f.findingId} finding={f} onAutoFix={openAutoFix} onReview={(x) => { setReviewError(null); setReviewing(x); }} canReview={isSaved && !isStale} />)}
          </div>
        ))}

        {tab === 'not-evaluated' && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">These controls apply but could not be evaluated from the architecture. They are excluded from the score and never treated as passing.</p>
            {notEvaluated.map((e) => (
              <div key={e.findingId} className="bg-gray-800/60 border border-gray-700 rounded-lg p-3 text-xs">
                <div className="flex items-center gap-2 mb-1"><StatusBadge status={e.status} /><code className="text-gray-500">{e.findingId}</code><span className="text-white">{ruleOf(e.ruleId).title}</span></div>
                <p className="text-gray-400">{e.resourceLabels.join(', ') || 'Account / subscription level'} — {e.observation}</p>
                {e.requiredData && <p className="text-gray-500 mt-1">Needed: {e.requiredData}</p>}
              </div>
            ))}
          </div>
        )}

        {tab === 'passed' && (
          <div className="space-y-1.5">
            {passed.map((e) => (
              <div key={e.findingId} className="flex items-start gap-2 text-xs bg-gray-800/40 rounded-lg px-3 py-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
                <span className="text-gray-300"><span className="text-gray-500">{e.ruleId}</span> · {e.resourceLabels.join(', ') || 'Architecture'} — {e.observation}</span>
              </div>
            ))}
          </div>
        )}

        {tab === 'history' && (
          <div className="space-y-2 text-xs">
            {!isSaved && <p className="text-gray-500">Scan history is available for saved projects.</p>}
            {history.map((h, i) => {
              const prev = history[i + 1];
              return (
                <div key={h.scanId} className="flex flex-wrap items-center gap-3 bg-gray-800/60 border border-gray-700 rounded-lg px-3 py-2">
                  <History className="w-3.5 h-3.5 text-gray-500" />
                  <span className="text-gray-300">{new Date(h.createdAt).toLocaleString()}</span>
                  <span className="text-gray-500">rev {h.architectureRevision ?? '—'} · ruleset {h.rulesetVersion ?? 'legacy'}</span>
                  <span className="text-white">score {h.securityScore ?? 'not scored'}{prev && prev.securityScore !== null && h.securityScore !== null && h.securityScore !== prev.securityScore ? <span className={h.securityScore > prev.securityScore ? 'text-emerald-400' : 'text-red-400'}> ({h.securityScore > prev.securityScore ? '+' : ''}{h.securityScore - prev.securityScore})</span> : null}</span>
                  <span className="text-gray-400">coverage {h.coveragePct ?? '—'}% · {h.findingCount} findings</span>
                  {!h.legacy && (
                    <span className="ml-auto flex gap-1">
                      {(['pdf', 'html'] as const).map((fmt) => <button key={fmt} onClick={() => void exportReport(fmt, h.scanId)} className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200">{fmt.toUpperCase()}</button>)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {plan && <AutoFixPreviewModal plan={plan} busy={busy} onApply={applyPlan} onCancel={() => setPlan(null)} />}
      {bulkOpen && <BulkFixModal findings={safeFixes} costDelta={bulkCost} busy={busy} onApply={applyBulk} onCancel={() => setBulkOpen(false)} />}
      {reviewing && <ReviewModal finding={reviewing} busy={busy} error={reviewError} onSubmit={(v) => void submitReview(v)} onCancel={() => setReviewing(null)} />}
    </div>
  );
}
