'use client';
/**
 * Readiness reports: SOC 2 Type 1 readiness, and the AWS and Azure Well-Architected control reports.
 * The score of a control comes from checks and evidence, never from a box someone ticks. This panel is where the team records owners, answers,
 * evidence, findings and sign-offs, and where the reports are downloaded. A readiness report is not an audit, a certification or a SOC 2 report.
 */
import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { FileText, Loader2, RefreshCw } from 'lucide-react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { apiReadinessService, saveBlob, type EvidenceItem, type ReadinessView } from '@/lib/services/ApiReadinessService';
import type { FrameworkId, Signoff } from '@/lib/compliance/types';
import { SOC2_CATEGORY_LABEL, SOC2_CATEGORY_RANGE, type Soc2Category } from '@/lib/compliance/soc2/criteria';
import ControlsList from './readiness/ControlsList';
import FindingsList from './readiness/FindingsList';
import EvidenceVault from './readiness/EvidenceVault';
import { pill, readinessTone, theme } from './readiness/ui';

const FRAMEWORKS: Array<{ id: FrameworkId; label: string; file: string }> = [
  { id: 'soc2', label: 'SOC 2 Type 1', file: 'Word document' },
  { id: 'aws-waf', label: 'AWS Well-Architected', file: 'PDF' },
  { id: 'azure-waf', label: 'Azure Well-Architected', file: 'PDF' },
];
type Tab = 'controls' | 'findings' | 'evidence' | 'signoff';

export default function ReadinessPanel() {
  const { state } = useApp();
  const project = useActiveProject();
  const isLight = state.theme === 'light';
  const t = theme(isLight);
  const projectId = project && project.id !== 'draft-project' && state.activeProjectId === project.id ? project.id : null;

  const [framework, setFramework] = useState<FrameworkId>('soc2');
  const [tab, setTab] = useState<Tab>('controls');
  const [view, setView] = useState<ReadinessView | null>(null);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const key = projectId ? `${projectId}:${framework}` : null;
  const loading = refreshing || (key !== null && loadedKey !== key);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [v, e] = await Promise.all([apiReadinessService.view(projectId, framework), apiReadinessService.evidence(projectId, framework)]);
      setView(v); setEvidence(e); setError(null);
    } catch (err) { setError(err instanceof Error ? err.message : 'The report could not be read.'); }
  }, [projectId, framework]);

  useEffect(() => {
    if (!key) return;
    let current = true;
    void load().finally(() => { if (current) setLoadedKey(key); });
    return () => { current = false; };
  }, [key, load]);

  if (!project) return <div className={clsx('flex-1 flex items-center justify-center', isLight ? 'bg-slate-50 text-slate-500' : 'bg-slate-950 text-slate-400')}><p>Select or create a project first.</p></div>;

  async function download(kind: 'draft' | 'issue') {
    if (!projectId) return;
    setBusy(kind); setError(null);
    try { saveBlob(kind === 'draft' ? await apiReadinessService.draft(projectId, framework) : await apiReadinessService.issue(projectId, framework)); if (kind === 'issue') await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'The report could not be made.'); } finally { setBusy(null); }
  }
  async function sign(role: Signoff['role']) {
    if (!projectId) return;
    setBusy(`sign-${role}`); setError(null);
    try { await apiReadinessService.sign(projectId, framework, role); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not sign.'); } finally { setBusy(null); }
  }

  const r = view?.report;
  const fw = FRAMEWORKS.find((f) => f.id === framework)!;
  const tabBtn = (id: Tab, label: string) => <button key={id} type="button" onClick={() => setTab(id)} className={tab === id ? t.btn : t.btnQuiet}>{label}</button>;

  return (
    <div className={clsx('flex-1 flex flex-col overflow-y-auto px-4 sm:px-6 lg:px-8 py-6 pb-36 space-y-5 custom-scrollbar', isLight ? 'bg-slate-50 text-slate-900' : 'bg-slate-950 text-slate-100')}>
      <header>
        <div className="flex items-center gap-2"><FileText className="w-5 h-5 text-cyan-500" /><h1 className="text-lg font-bold">Readiness reports</h1></div>
        <p className={clsx('text-xs mt-1 max-w-3xl', t.muted)}>
          Where each control stands, what supports it, and what to do next. Scores come from checks CloudBuilder ran and from evidence you attach, not from ticking a box.
          These are readiness reports: they are not an audit, a certification or a SOC 2 report. Only a CPA firm can issue a SOC 2 report; the SOC 2 document here is built for that firm to start from.
        </p>
      </header>

      <div className="flex flex-wrap gap-2" role="tablist">
        {FRAMEWORKS.map((f) => <button key={f.id} type="button" role="tab" aria-selected={framework === f.id} onClick={() => { setFramework(f.id); setTab('controls'); }} className={framework === f.id ? t.btn : t.btnQuiet}>{f.label}</button>)}
      </div>

      {!projectId && <div className={t.card}><p className="text-xs">Save the project first: the report is built from the saved architecture.</p></div>}
      {projectId && loading && (!view || loadedKey !== key) && <p className={clsx('text-xs flex items-center gap-2', t.muted)}><Loader2 className="w-4 h-4 animate-spin" />Reading the project…</p>}
      {error && <p className={clsx('text-xs', t.error)} role="alert">{error}</p>}

      {projectId && view && r && loadedKey === key && (
        <>
          <section className={t.card} aria-label="Summary">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className={clsx('text-[11px] uppercase tracking-wide', t.muted)}>Readiness</p>
                <p className="mt-1"><span className={pill(readinessTone(r.readiness), isLight)}>{r.readiness}</span></p>
                <p className={clsx('text-xs mt-2 max-w-xl', t.muted)}>{r.readiness === 'Ready' ? 'Every in-scope control is operating and nothing serious is open.' : r.readiness === 'Ready with conditions' ? 'Nothing is missing, but some controls or findings still need work.' : r.readiness === 'Not ready' ? 'At least one control is missing or only informal, or a serious finding is open.' : 'Some controls have not been assessed, so no conclusion can be drawn yet.'}</p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                {[[String(r.summary.total), 'controls in scope'], [`${r.summary.coveragePct}%`, 'assessed'], [r.summary.average === null ? 'n/a' : `${r.summary.average} / 4`, 'average score'], [String(r.findings.length), 'findings']].map(([v, l]) => (
                  <div key={l} className={t.inner}><p className="text-base font-bold">{v}</p><p className={clsx('text-[11px]', t.muted)}>{l}</p></div>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-4">
              <button type="button" className={t.btn} disabled={busy !== null} onClick={() => void download('draft')}>{busy === 'draft' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : `Download draft (${fw.file})`}</button>
              <button type="button" className={t.btnQuiet} disabled={busy !== null} onClick={() => void download('issue')} title="Takes the next version number and records it">{busy === 'issue' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Issue a version'}</button>
              <button type="button" className={t.btnQuiet} disabled={loading} onClick={() => { setRefreshing(true); void load().finally(() => setRefreshing(false)); }} aria-label="Refresh"><RefreshCw className="w-3.5 h-3.5" /></button>
              <span className={clsx('text-[11px]', t.muted)}>{view.versions.length ? `Last issued: v${view.versions[0]!.version} on ${view.versions[0]!.generatedAt.slice(0, 10)}` : 'No version issued yet'}</span>
            </div>
          </section>

          {framework === 'soc2' && view.scope && <ScopeCard view={view} projectId={projectId} isLight={isLight} onChanged={load} />}

          <div className="flex flex-wrap gap-2">
            {tabBtn('controls', `Controls (${r.results.length})`)}
            {tabBtn('findings', `Findings (${r.findings.length})`)}
            {tabBtn('evidence', `Evidence (${evidence.length})`)}
            {tabBtn('signoff', 'Sign-off and limits')}
          </div>

          {tab === 'controls' && <ControlsList view={view} projectId={projectId} framework={framework} isLight={isLight} evidence={evidence} onChanged={load} onAttach={(k) => { setPreset(k); setTab('evidence'); }} />}
          {tab === 'findings' && <FindingsList view={view} projectId={projectId} framework={framework} isLight={isLight} onChanged={load} />}
          {tab === 'evidence' && <EvidenceVault view={view} projectId={projectId} framework={framework} isLight={isLight} evidence={evidence} presetControl={preset} onChanged={load} />}
          {tab === 'signoff' && (
            <div className="space-y-4">
              <section className={t.card}>
                <h2 className="text-sm font-bold">Sign-off</h2>
                <p className={clsx('text-[11px] mb-3', t.muted)}>The preparer signs first, then a different person reviews, then management. Any change to a control, finding, evidence or the scope clears the signatures, because they were given on something that has now changed.</p>
                <ul className="space-y-2">
                  {(['preparer', 'reviewer', 'management'] as const).map((role) => {
                    const s = r.signoffs.find((x) => x.role === role);
                    return (
                      <li key={role} className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="w-24 font-semibold capitalize">{role}</span>
                        {s ? <span className={t.muted}>{s.name} · {s.signedAt.slice(0, 10)}</span> : <span className={t.muted}>not signed</span>}
                        {!s && <button type="button" className={t.btnQuiet} disabled={busy !== null} onClick={() => void sign(role)}>{busy === `sign-${role}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : `Sign as ${role}`}</button>}
                      </li>
                    );
                  })}
                </ul>
              </section>
              {r.cpaChecks.length > 0 && (
                <section className={t.card}>
                  <h2 className="text-sm font-bold">Ready for the CPA firm?</h2>
                  <ul className="mt-2 space-y-1.5">{r.cpaChecks.map((c) => <li key={c.label} className="text-xs flex gap-2"><span className={pill(c.done ? 'green' : 'amber', isLight)}>{c.done ? 'Done' : 'To do'}</span><span><b>{c.label}.</b> <span className={t.muted}>{c.detail}</span></span></li>)}</ul>
                </section>
              )}
              <section className={t.card}>
                <h2 className="text-sm font-bold">What this report cannot tell you</h2>
                <ul className={clsx('mt-2 space-y-1.5 text-xs', t.muted)}>{r.limitations.map((l) => <li key={l.id}><b className={t.strong}>{l.item}.</b> {l.effect}</li>)}</ul>
              </section>
              {view.versions.length > 0 && (
                <section className={t.card}>
                  <h2 className="text-sm font-bold">Versions issued</h2>
                  <ul className={clsx('mt-2 space-y-1 text-xs', t.muted)}>{view.versions.map((v) => <li key={v.version}>v{v.version} · {v.reportId} · {v.readiness} · as of {v.asOf} · {v.generatedBy}</li>)}</ul>
                </section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ScopeCard({ view, projectId, isLight, onChanged }: { view: ReadinessView; projectId: string; isLight: boolean; onChanged: () => Promise<void> }) {
  const t = theme(isLight);
  const scope = view.scope!;
  const [cats, setCats] = useState<Soc2Category[]>(scope.categories);
  const [why, setWhy] = useState<Partial<Record<Soc2Category, string>>>(scope.exclusions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = cats.slice().sort().join() !== scope.categories.slice().sort().join() || (['availability', 'confidentiality'] as const).some((c) => !cats.includes(c) && (why[c] ?? '') !== (scope.exclusions[c] ?? ''));
  async function save() {
    setBusy(true); setError(null);
    try { await apiReadinessService.saveScope(projectId, cats, why); await onChanged(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the scope.'); } finally { setBusy(false); }
  }
  return (
    <section className={t.card} aria-label="Scope">
      <h2 className="text-sm font-bold">What is in scope</h2>
      <p className={clsx('text-[11px] mb-2', t.muted)}>SOC 2 is built on trust services categories. Security is always in scope. Leave a category out only if it does not apply, and say why: the report shows the reason.{view.canAdminister ? '' : ' Only an owner or admin of the organization can change the scope.'}</p>
      <ul className="space-y-2">
        {(['security', 'availability', 'confidentiality'] as const).map((c) => (
          <li key={c} className="text-xs">
            <label className="flex items-center gap-2"><input type="checkbox" checked={cats.includes(c)} disabled={c === 'security' || !view.canAdminister} onChange={(e) => setCats(e.target.checked ? [...cats, c] : cats.filter((x) => x !== c))} /><span className="font-semibold">{SOC2_CATEGORY_LABEL[c]}</span><span className={t.muted}>{SOC2_CATEGORY_RANGE[c]}</span></label>
            {!cats.includes(c) && <input className={clsx(t.input, 'mt-1')} disabled={!view.canAdminister} value={why[c] ?? ''} maxLength={600} placeholder="Why this category is out of scope (required)" onChange={(e) => setWhy({ ...why, [c]: e.target.value })} />}
          </li>
        ))}
      </ul>
      {view.canAdminister && <button type="button" className={clsx(t.btn, 'mt-3')} disabled={busy || !dirty} onClick={() => void save()}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save scope'}</button>}
      {error && <p className={clsx('text-xs mt-2', t.error)} role="alert">{error}</p>}
    </section>
  );
}
