'use client';
/** Evidence over time (snapshots, for a Type 2 look-back) and everything for the auditor: the package, and read-only links. */
import { useCallback, useEffect, useState } from 'react';
import { Copy, Download, Loader2 } from 'lucide-react';
import { apiReadinessService, saveBlob, type AuditorAccessItem, type ReadinessView, type SnapshotsView } from '@/lib/services/ApiReadinessService';
import type { FrameworkId } from '@/lib/compliance/types';
import { pill, theme } from './ui';

interface Props { view: ReadinessView; projectId: string; framework: FrameworkId; isLight: boolean }

export default function OverTimeAndAuditors({ view, projectId, framework, isLight }: Props) {
  const t = theme(isLight);
  const [snaps, setSnaps] = useState<SnapshotsView | null>(null);
  const [links, setLinks] = useState<AuditorAccessItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [days, setDays] = useState(14);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // "Now" is read when the list is loaded, not while drawing, so what is shown as active does not change on its own between redraws.
  const [loadedAt, setLoadedAt] = useState(0);

  const load = useCallback(async () => {
    try {
      setSnaps(await apiReadinessService.snapshots(projectId, framework));
      setLoadedAt(Date.now());
      if (view.canAdminister) setLinks(await apiReadinessService.auditorAccess(projectId, framework));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read the history.'); }
  }, [projectId, framework, view.canAdminister]);
  useEffect(() => { void load(); }, [load]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'That did not work.'); } finally { setBusy(null); }
  }
  const isLive = (l: AuditorAccessItem) => !l.revokedAt && Date.parse(l.expiresAt) > loadedAt;
  const active = links.filter(isLive);

  return (
    <div className="space-y-4">
      <section className={t.card}>
        <h2 className="text-sm font-bold">Evidence over time</h2>
        <p className={`text-[11px] mb-3 ${t.muted}`}>A SOC 2 Type 2 examination asks whether controls kept operating across a period, not only on one day. CloudBuilder takes a dated snapshot of every control each night (03:30 UTC) for every project that uses these reports, and whenever you issue a version. This is preparation: the CPA firm does its own testing of the period.</p>
        {snaps ? (
          <>
            <p className="text-xs">{snaps.period.sentence}</p>
            {snaps.period.gaps.length > 0 && <ul className={`text-[11px] mt-1 ${t.muted}`}>{snaps.period.gaps.slice(0, 5).map((g) => <li key={g.from + g.to}>No snapshot from {g.from} to {g.to} ({g.days} days)</li>)}</ul>}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button type="button" className={t.btn} disabled={busy !== null} onClick={() => void run('snap', async () => { await apiReadinessService.takeSnapshot(projectId, framework); await load(); })}>{busy === 'snap' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Take a snapshot now'}</button>
            </div>
            {snaps.snapshots.length > 0 && (
              <ul className={`mt-3 space-y-1 text-[11px] ${t.muted}`}>
                {snaps.snapshots.slice(0, 8).map((s) => <li key={s.id}>{s.takenAt.slice(0, 16).replace('T', ' ')} · {s.trigger} · {s.readiness} · {s.operating} of {s.scored} scored controls operating · {s.failing} with a failing check</li>)}
              </ul>
            )}
          </>
        ) : <p className={`text-xs ${t.muted}`}>Reading the history…</p>}
      </section>

      <section className={t.card}>
        <h2 className="text-sm font-bold">Package for the auditor</h2>
        <p className={`text-[11px] mb-3 ${t.muted}`}>One zip: the report{framework === 'soc2' ? ' (Word and PDF)' : ''}, the control matrix, findings, every evidence file with its fingerprint checked again, sign-offs, the snapshot history, and a manifest of SHA-256 fingerprints. A file that no longer matches its fingerprint is flagged inside.</p>
        <button type="button" className={t.btn} disabled={busy !== null} onClick={() => void run('pkg', async () => saveBlob(await apiReadinessService.downloadPackage(projectId, framework)))}>
          {busy === 'pkg' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span className="flex items-center gap-1.5"><Download className="w-3.5 h-3.5" />Download the package (.zip)</span>}
        </button>
      </section>

      <section className={t.card}>
        <h2 className="text-sm font-bold">Read-only access for an auditor</h2>
        <p className={`text-[11px] mb-3 ${t.muted}`}>Give the CPA firm a link instead of emailing files. It shows this framework&apos;s report, controls and evidence and lets them download the package. It cannot change anything and sees nothing else in the project. It stops working on its end date, and you can revoke it at any time.</p>
        {!view.canAdminister ? <p className={`text-xs ${t.muted}`}>Only an owner or admin of the organization can make auditor links.</p> : (
          <>
            <div className="grid sm:grid-cols-3 gap-2">
              <label><span className={t.label}>Auditor&apos;s name</span><input className={t.input} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></label>
              <label><span className={t.label}>Auditor&apos;s email</span><input className={t.input} value={email} maxLength={200} onChange={(e) => setEmail(e.target.value)} /></label>
              <label><span className={t.label}>Days of access (1 to 90)</span><input type="number" min={1} max={90} className={t.input} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>
            </div>
            <button type="button" className={`${t.btn} mt-2`} disabled={busy !== null || name.trim().length < 2 || !/^\S+@\S+\.\S+$/.test(email) || days < 1 || days > 90} onClick={() => void run('make', async () => { const r = await apiReadinessService.createAuditorAccess(projectId, framework, { name, email, days }); setFresh(r.link); setCopied(false); setName(''); setEmail(''); await load(); })}>{busy === 'make' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Make a link'}</button>
            {fresh && (
              <div className={`${t.inner} mt-3`}>
                <p className="text-xs font-semibold">Copy this link now. It is shown once and cannot be retrieved again.</p>
                <p className="text-[11px] break-all mt-1 font-mono">{fresh}</p>
                <button type="button" className={`${t.btnQuiet} mt-2`} onClick={() => { void navigator.clipboard?.writeText(fresh).then(() => setCopied(true)); }}><span className="flex items-center gap-1"><Copy className="w-3.5 h-3.5" />{copied ? 'Copied' : 'Copy'}</span></button>
              </div>
            )}
            <ul className="mt-3 space-y-1.5">
              {links.map((l) => {
                const live = isLive(l);
                return (
                  <li key={l.id} className={`${t.inner} flex flex-wrap items-center gap-2 text-xs`}>
                    <span className={pill(live ? 'green' : 'grey', isLight)}>{l.revokedAt ? 'Revoked' : live ? 'Active' : 'Expired'}</span>
                    <span className="font-semibold">{l.name}</span><span className={t.muted}>{l.email} · ends {l.expiresAt.slice(0, 10)} · opened {l.useCount} {l.useCount === 1 ? 'time' : 'times'}{l.lastUsedAt ? `, last ${l.lastUsedAt.slice(0, 10)}` : ''}</span>
                    {live && <button type="button" className={`${t.btnQuiet} ml-auto`} disabled={busy !== null} onClick={() => void run(l.id, async () => { await apiReadinessService.revokeAuditorAccess(projectId, framework, l.id); await load(); })}>Revoke</button>}
                  </li>
                );
              })}
              {links.length === 0 && <li className={`text-xs ${t.muted}`}>No links yet.</li>}
            </ul>
            {active.length >= 10 && <p className={`text-[11px] mt-2 ${t.muted}`}>Ten links are active, which is the most allowed.</p>}
          </>
        )}
        {error && <p className={`text-xs mt-2 ${t.error}`} role="alert">{error}</p>}
      </section>
    </div>
  );
}
