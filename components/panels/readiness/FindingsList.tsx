'use client';
/** The findings the controls give rise to, with management's side: owner, target date, status and response. */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiReadinessService, type ReadinessView } from '@/lib/services/ApiReadinessService';
import type { Finding, FindingStatus, FrameworkId } from '@/lib/compliance/types';
import { FINDING_STATUS_LABEL, pill, severityTone, theme } from './ui';

interface Props { view: ReadinessView; projectId: string; framework: FrameworkId; isLight: boolean; onChanged: () => Promise<void> }

function Item({ f, projectId, framework, isLight, onChanged }: Props & { f: Finding }) {
  const t = theme(isLight);
  const [owner, setOwner] = useState(f.owner);
  const [targetDate, setTargetDate] = useState(f.targetDate ?? '');
  const [status, setStatus] = useState<FindingStatus>(f.status);
  const [response, setResponse] = useState(f.managementResponse);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true); setError(null);
    try { await apiReadinessService.saveFinding(projectId, framework, f.controlId, { owner, targetDate: targetDate || null, status, managementResponse: response }); await onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  }
  return (
    <li className={t.inner}>
      <div className="flex flex-wrap items-start gap-2">
        <span className={pill(severityTone(f.severity), isLight)}>{f.severity}</span>
        <span className={`text-xs font-semibold flex-1 min-w-[12rem] ${t.strong}`}>{f.title}</span>
        <span className={`text-[11px] ${t.muted}`}>{f.controlId}</span>
      </div>
      <dl className={`text-xs mt-2 space-y-1 ${t.muted}`}>
        <div><dt className="inline font-semibold">What we found: </dt><dd className="inline">{f.condition}</dd></div>
        <div><dt className="inline font-semibold">Why it matters: </dt><dd className="inline">{f.effect}</dd></div>
        <div><dt className="inline font-semibold">What to do: </dt><dd className="inline">{f.recommendation}</dd></div>
      </dl>
      <div className="grid sm:grid-cols-3 gap-2 mt-3">
        <label><span className={t.label}>Owner</span><input className={t.input} value={owner} maxLength={120} onChange={(e) => setOwner(e.target.value)} /></label>
        <label><span className={t.label}>Target date</span><input type="date" className={t.input} value={targetDate} onChange={(e) => setTargetDate(e.target.value)} /></label>
        <label><span className={t.label}>Status</span>
          <select className={t.input} value={status} onChange={(e) => setStatus(e.target.value as FindingStatus)}>
            {(Object.keys(FINDING_STATUS_LABEL) as FindingStatus[]).map((s) => <option key={s} value={s}>{FINDING_STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="sm:col-span-3"><span className={t.label}>Management&apos;s response (what was or will be done, or why the risk is accepted)</span>
          <textarea className={t.input} rows={2} value={response} maxLength={4000} onChange={(e) => setResponse(e.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <button type="button" className={t.btn} disabled={busy} onClick={() => void save()}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save'}</button>
        {f.retestedBy && <span className={`text-[11px] ${t.muted}`}>Re-tested by {f.retestedBy}{f.retestedAt ? ` on ${f.retestedAt.slice(0, 10)}` : ''}</span>}
        {f.acceptedBy && <span className={`text-[11px] ${t.muted}`}>Risk accepted by {f.acceptedBy}</span>}
      </div>
      {error && <p className={`text-xs mt-1 ${t.error}`} role="alert">{error}</p>}
    </li>
  );
}

export default function FindingsList(props: Props) {
  const t = theme(props.isLight);
  const { findings } = props.view.report;
  if (findings.length === 0) return <p className={`text-xs ${t.muted}`}>No findings. Controls that are missing, informal or failing a check appear here.</p>;
  return <ul className="space-y-2">{findings.map((f) => <Item key={`${f.id}:${f.status}:${f.managementResponse.length}`} {...props} f={f} />)}</ul>;
}
