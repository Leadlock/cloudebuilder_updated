'use client';
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useApp } from '@/context/AppContext';

/**
 * Warns before an apply is queued if the deployment worker is not running. Applies run in that separate process: without it the
 * apply would wait in the queue and nothing would happen, which looks exactly like a very slow deployment.
 */
export default function TerraformWorkerNotice({ projectId, environment }: { projectId: string; environment: string }) {
  const { state: appState } = useApp();
  const isLight = appState.theme === 'light';

  const [info, setInfo] = useState<{ alive: boolean; command: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/terraform/status?env=${encodeURIComponent(environment)}`, { credentials: 'include' });
        const body = await res.json();
        const w = body?.data?.applyWorker;
        if (!cancelled && w && typeof w.alive === 'boolean') setInfo({ alive: w.alive, command: String(w.command ?? 'npm run worker:terraform-apply') });
      } catch { /* the notice is advisory: no answer, no warning */ }
    };
    void load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [projectId, environment]);

  if (!info || info.alive) return null;
  return (
    <div className={`mb-3 p-3 rounded-lg border text-xs ${
      isLight ? 'bg-amber-50 border-amber-200 text-amber-950' : 'bg-amber-950/40 border-amber-700/50 text-amber-200'
    }`} data-testid="worker-notice">
      <p className={`flex items-center gap-2 font-semibold ${isLight ? 'text-amber-900' : ''}`}><AlertTriangle className={`w-4 h-4 shrink-0 ${isLight ? 'text-amber-600' : 'text-amber-400'}`} /> The deployment worker is not running</p>
      <p className={`mt-1 leading-relaxed ${isLight ? 'text-slate-700' : 'text-amber-200/90'}`}>
        Applying runs in a separate worker process. Without it, &ldquo;Confirm &amp; Apply&rdquo; will queue your deployment and nothing will happen. In a terminal, in the CloudCraft folder, run:
      </p>
      <pre className={`mt-1.5 px-2 py-1 rounded border font-mono select-all ${
        isLight ? 'bg-slate-100 border-slate-300 text-slate-800' : 'bg-black/50 border-amber-900/50 text-amber-100'
      }`}>{info.command}</pre>
    </div>
  );
}
