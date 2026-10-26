'use client';
/** The project's evidence: files, links and notes, each dated, marked as from a system or collected by hand, and linked to the controls it supports. */
import { useState } from 'react';
import { Download, Loader2, Trash2, X } from 'lucide-react';
import { apiReadinessService, saveBlob, type EvidenceItem, type ReadinessView } from '@/lib/services/ApiReadinessService';
import type { FrameworkId } from '@/lib/compliance/types';
import { pill, theme } from './ui';

interface Props { view: ReadinessView; projectId: string; framework: FrameworkId; isLight: boolean; evidence: EvidenceItem[]; presetControl: string | null; onChanged: () => Promise<void> }

const today = () => new Date().toISOString().slice(0, 10);
const size = (n: number | null) => (n === null ? '' : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function EvidenceVault({ view, projectId, framework, isLight, evidence, presetControl, onChanged }: Props) {
  const t = theme(isLight);
  const [kind, setKind] = useState<'file' | 'link' | 'note'>('file');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [origin, setOrigin] = useState<'system' | 'manual'>('manual');
  const [collectedAt, setCollectedAt] = useState(today());
  const [validUntil, setValidUntil] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [controls, setControls] = useState<string[]>(presetControl ? [presetControl] : []);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const titleOf = (key: string) => { const id = key.split(':')[1]; return view.report.defs.find((d) => d.id === id)?.title ?? key; };

  async function add() {
    setBusy('add'); setError(null);
    try {
      await apiReadinessService.addEvidence(projectId, framework, { kind, title, description, origin, collectedAt, ...(validUntil ? { validUntil } : {}), ...(kind === 'link' ? { url } : {}), controls, ...(file ? { file } : {}) });
      setTitle(''); setDescription(''); setUrl(''); setFile(null); setValidUntil(''); setControls([]);
      await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not add the evidence.'); } finally { setBusy(null); }
  }
  async function act(id: string, what: 'download' | 'remove') {
    setBusy(id); setError(null);
    try {
      if (what === 'download') saveBlob(await apiReadinessService.downloadEvidence(projectId, framework, id));
      else { await apiReadinessService.removeEvidence(projectId, framework, id); await onChanged(); }
    } catch (e) { setError(e instanceof Error ? e.message : 'That did not work.'); } finally { setBusy(null); }
  }

  const ready = title.trim().length >= 3 && (kind !== 'file' || file) && (kind !== 'link' || url.startsWith('https://')) && (kind !== 'note' || description.trim().length >= 20);
  return (
    <div className="space-y-5">
      <section className={t.inner}>
        <h3 className={`text-xs font-bold ${t.strong}`}>Add evidence</h3>
        <p className={`text-[11px] ${t.muted} mb-2`}>Evidence is what an auditor looks at: an export, a screenshot, a policy, a log extract. Give the date it was produced (not today&apos;s date, unless it is), and link it to the controls it supports. Files are stored encrypted, up to 5 MB.</p>
        <div className="grid sm:grid-cols-2 gap-2">
          <label><span className={t.label}>Type</span>
            <select className={t.input} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="file">A file</option><option value="link">A link (https)</option><option value="note">A written note</option>
            </select>
          </label>
          <label><span className={t.label}>Title</span><input className={t.input} value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} placeholder="Quarterly access review, Q3" /></label>
          {kind === 'file' && <label className="sm:col-span-2"><span className={t.label}>File (pdf, image, csv, json, docx, xlsx, zip, text)</span><input type="file" className={t.input} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>}
          {kind === 'link' && <label className="sm:col-span-2"><span className={t.label}>Address</span><input className={t.input} value={url} maxLength={500} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></label>}
          <label><span className={t.label}>Date it was produced</span><input type="date" className={t.input} value={collectedAt} max={today()} onChange={(e) => setCollectedAt(e.target.value)} /></label>
          <label><span className={t.label}>Valid until (optional)</span><input type="date" className={t.input} value={validUntil} min={collectedAt} onChange={(e) => setValidUntil(e.target.value)} /></label>
          <label><span className={t.label}>Where it came from</span>
            <select className={t.input} value={origin} onChange={(e) => setOrigin(e.target.value as typeof origin)}>
              <option value="manual">Collected or written by hand</option><option value="system">Exported from a system</option>
            </select>
          </label>
          <label className="sm:col-span-2"><span className={t.label}>{kind === 'note' ? 'The note (what happened, who did it, when)' : 'Description (optional)'}</span><textarea className={t.input} rows={2} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} /></label>
          <div className="sm:col-span-2">
            <span className={t.label}>Controls it supports</span>
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {controls.map((c) => <span key={c} className={`${pill('grey', isLight)} normal-case`}>{c.split(':')[1]} <button type="button" aria-label={`Unlink ${c}`} onClick={() => setControls(controls.filter((x) => x !== c))}><X className="inline w-3 h-3" /></button></span>)}
              {controls.length === 0 && <span className={`text-[11px] ${t.muted}`}>None yet: evidence linked to no control is not used in any report.</span>}
            </div>
            <select className={t.input} value={pick} onChange={(e) => { const v = e.target.value; setPick(''); if (v && !controls.includes(v)) setControls([...controls, v]); }}>
              <option value="">Link a control…</option>
              {view.report.defs.map((d) => <option key={d.id} value={`${framework}:${d.id}`}>{d.id} {d.title.slice(0, 90)}</option>)}
            </select>
          </div>
        </div>
        <button type="button" className={`${t.btn} mt-3`} disabled={!ready || busy !== null} onClick={() => void add()}>{busy === 'add' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Add evidence'}</button>
        {error && <p className={`text-xs mt-2 ${t.error}`} role="alert">{error}</p>}
      </section>

      <section>
        <h3 className={`text-xs font-bold mb-1.5 ${t.strong}`}>Evidence on file ({evidence.length})</h3>
        {evidence.length === 0 && <p className={`text-xs ${t.muted}`}>Nothing yet. Without evidence a control can reach 2 (Implemented) at most through checks, and only 1 through answers alone.</p>}
        <ul className="space-y-1.5">
          {evidence.map((e) => (
            <li key={e.id} className={t.inner}>
              <div className="flex flex-wrap items-start gap-2">
                <span className={pill(e.origin === 'system' ? 'teal' : 'grey', isLight)}>{e.origin === 'system' ? 'From a system' : 'By hand'}</span>
                <span className={`text-xs font-semibold flex-1 min-w-[10rem] ${t.strong}`}>{e.title}</span>
                <span className={`text-[11px] ${t.muted}`}>{e.kind === 'file' ? `${e.fileName ?? 'file'} ${size(e.sizeBytes)}` : e.kind}</span>
              </div>
              <p className={`text-[11px] mt-1 ${t.muted}`}>Produced {e.collectedAt}{e.validUntil ? `, valid until ${e.validUntil}` : ''} · added by {e.uploadedBy}{e.sha256 ? ` · SHA-256 ${e.sha256.slice(0, 12)}…` : ''}</p>
              {e.description && <p className={`text-xs mt-1 ${t.muted}`}>{e.description}</p>}
              {e.url && <a className="text-xs text-cyan-500 underline break-all" href={e.url} target="_blank" rel="noopener noreferrer">{e.url}</a>}
              <p className={`text-[11px] mt-1 ${t.muted}`}>Supports: {e.controls.length ? e.controls.map((c) => `${c.split(':')[0] === framework ? '' : c.split(':')[0] + ' '}${c.split(':')[1]} (${titleOf(c).slice(0, 40)})`).join(', ') : 'no control yet'}</p>
              <div className="flex gap-2 mt-2">
                {e.kind === 'file' && <button type="button" className={t.btnQuiet} disabled={busy !== null} onClick={() => void act(e.id, 'download')}>{busy === e.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span className="flex items-center gap-1"><Download className="w-3.5 h-3.5" />Download</span>}</button>}
                <button type="button" className={t.btnQuiet} disabled={busy !== null} onClick={() => { if (window.confirm('Remove this evidence from the reports? The record stays, marked as removed; the stored file is deleted.')) void act(e.id, 'remove'); }}><span className="flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" />Remove</span></button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
