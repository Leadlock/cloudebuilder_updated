'use client';
/**
 * "Deploy from CloudCraft" for a project of several services on an Azure VM (see docs/IN_APP_DEPLOYMENT_DESIGN.md).
 *
 * The person picks a connected Azure account and where Terraform keeps its state, CloudCraft plans the deployment on the server, the person confirms with
 * their password (the same single-use approval as any Terraform apply) and the release runs in the background: infrastructure, secrets, build, publish,
 * start, verify. When it needs secrets it stops and asks for them here; they are sent once to the server, written straight to the vault and forgotten (this
 * form clears them, and nothing here stores them). The server decides everything that matters; this is only the window onto it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Loader2, XCircle, CircleDashed, Rocket } from 'lucide-react';
import type { StackProject } from '@/lib/engines/containers/stackProject';

interface Account { id: string; name: string; provider: string; identity?: { authMethod?: string } }
interface Step { name: string; state: 'pending' | 'running' | 'done' | 'failed' | 'waiting' | 'skipped' | 'rolled_back'; message?: string }
interface ReleaseView {
  id: string; project: string; imageTag: string; status: string; steps: Step[]; error: string | null; log: string[]; secrets: string[]; planId: string | null; planHash: string | null;
  outputs: { url: string; resourceGroup: string; vmName: string } | null;
}
interface PlanView { planId: string; planHash: string; summary: { toAdd: number; toChange: number; toDestroy: number }; expiresAt: string }

const STEP_LABEL: Record<string, string> = {
  infrastructure: 'Create the resource group, registry, vault and VM', secrets: 'Store the secrets', build: 'Build the images in Azure',
  publish: 'Put the release on the VM', start: 'Start the services', verify: 'Check the address answers',
};
const ACTIVE = new Set(['approved', 'running', 'waiting']);

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; code: string; message: string }> {
  try {
    const res = await fetch(path, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, code: body?.error?.code ?? 'ERROR', message: body?.error?.message ?? 'Could not reach the server' };
    return { ok: true, data: body.data as T };
  } catch { return { ok: false, status: 0, code: 'NETWORK', message: 'Could not reach the server' }; }
}

export default function ProjectReleasePanel({ projectId, environment, stack, isLight }: { projectId: string | null; environment: string; stack: StackProject; isLight: boolean }) {
  const muted = isLight ? 'text-slate-500' : 'text-slate-400';
  const label = clsx('block text-xs font-medium mb-1', isLight ? 'text-slate-700' : 'text-slate-300');
  const input = clsx('w-full rounded-lg border px-3 py-2 text-sm', isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-slate-950 border-slate-700 text-slate-100');
  const card = clsx('rounded-2xl border p-5 space-y-3', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/60 border-slate-800');

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountId, setAccountId] = useState('');
  const [backend, setBackend] = useState({ resourceGroupName: '', storageAccountName: '', containerName: 'tfstate', key: '' });
  const [off, setOff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<{ release: ReleaseView; plan: PlanView; cost: { monthlyUsd: number } | null; warnings: string[] } | null>(null);
  const [release, setRelease] = useState<ReleaseView | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const base = projectId ? `/api/projects/${projectId}/releases` : '';

  // Accounts, the state backend the Deploy tab already knows (its storage, not its state key), and the latest release of this environment.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      const r = await api<Account[]>('/api/cloud-accounts?provider=azure');
      if (!cancelled && r.ok) {
        const list = (Array.isArray(r.data) ? r.data : []).filter((a) => a.provider === 'azure' && a.identity?.authMethod !== 'access-key');
        setAccounts(list); setAccountId((cur) => cur || list[0]?.id || '');
      } else if (!cancelled) setAccounts([]);
      try {
        const saved = JSON.parse(localStorage.getItem(`cloudcraft_tf_backend_${projectId}`) ?? 'null') as { azureBackend?: { resourceGroupName?: string; storageAccountName?: string; containerName?: string } } | null;
        if (saved?.azureBackend && !cancelled) setBackend((b) => ({ ...b, resourceGroupName: saved.azureBackend!.resourceGroupName ?? '', storageAccountName: saved.azureBackend!.storageAccountName ?? '', containerName: saved.azureBackend!.containerName || 'tfstate' }));
      } catch { /* nothing remembered: the person types it */ }
      const list = await api<{ releases: ReleaseView[] }>(`${base}?environment=${encodeURIComponent(environment)}`);
      if (cancelled) return;
      if (!list.ok) { if (list.status === 503) setOff(list.message); return; }
      const latest = list.data.releases[0];
      if (latest) setRelease(latest);
    })();
    return () => { cancelled = true; };
  }, [projectId, environment, base]);

  // The state key is this project's own, never the architecture's: two Terraform projects must not share one state.
  useEffect(() => { setBackend((b) => (b.key ? b : { ...b, key: `cloudcraft/releases/${stack.name}-${environment}.tfstate` })); }, [stack.name, environment]);

  const refresh = useCallback(async (id: string) => {
    const r = await api<{ release: ReleaseView; missing: string[] | null }>(`${base}/${id}`);
    if (!r.ok) return;
    setRelease(r.data.release); setMissing(r.data.missing);
  }, [base]);

  // Follow a release that is going on.
  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (release && ACTIVE.has(release.status)) timer.current = setInterval(() => void refresh(release.id), 3000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [release?.id, release?.status, refresh]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!projectId) return <div className={card}><p className={clsx('text-xs', muted)}>Open or create a project first: a deployment from CloudCraft belongs to a project.</p></div>;
  if (off) return <div className={card}><p className="text-sm font-semibold">Deploy from CloudCraft</p><p className={clsx('text-xs', muted)}>{off} You can still download the files and run <code>bash deploy.sh</code> yourself.</p></div>;

  const fail = (m: string) => { setError(m); setBusy(false); };

  async function makePlan() {
    setBusy(true); setError(null); setPlan(null);
    const r = await api<{ release: ReleaseView; plan: PlanView; cost: { monthlyUsd: number } | null; warnings: string[] }>(base, {
      method: 'POST', body: JSON.stringify({ environment, cloudAccountId: accountId, stateBackend: { provider: 'azure', ...backend }, project: stack }),
    });
    if (!r.ok) { if (r.status === 503) setOff(r.message); return fail(r.message); }
    setPlan(r.data); setRelease(null); setBusy(false);
  }

  async function approveAndRun() {
    if (!plan) return;
    setBusy(true); setError(null);
    const c = await api<unknown>(`/api/projects/${projectId}/terraform/confirm`, {
      method: 'POST', body: JSON.stringify({ action: 'apply', planId: plan.plan.planId, planHash: plan.plan.planHash, password, ...(code ? { code } : {}) }),
    });
    setPassword('');
    if (!c.ok) { if (c.code === 'CODE_REQUIRED') setNeedsCode(true); return fail(c.message); }
    const r = await api<unknown>(`${base}/${plan.release.id}/run`, { method: 'POST', body: '{}' });
    setCode('');
    if (!r.ok) return fail(r.message);
    setPlan(null); setBusy(false);
    await refresh(plan.release.id);
  }

  async function sendSecrets() {
    if (!release) return;
    setBusy(true); setError(null);
    const values = Object.fromEntries(Object.entries(secretValues).filter(([, v]) => v !== ''));
    const r = await api<{ missing: string[]; continued: boolean }>(`${base}/${release.id}/secrets`, { method: 'POST', body: JSON.stringify({ values }) });
    setSecretValues({});            // gone from this page the moment they are sent
    if (!r.ok) return fail(r.message);
    setMissing(r.data.missing); setBusy(false);
    await refresh(release.id);
  }

  async function act(path: 'run' | 'cancel') {
    if (!release) return;
    setBusy(true); setError(null);
    const r = await api<unknown>(`${base}/${release.id}/${path}`, { method: 'POST', body: '{}' });
    if (!r.ok) return fail(r.message);
    setBusy(false);
    await refresh(release.id);
  }

  const infraDone = release?.steps.find((s) => s.name === 'infrastructure')?.state === 'done';
  const stateIcon = (s: Step['state']) => (s === 'done' ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : s === 'running' ? <Loader2 className="w-4 h-4 animate-spin text-cyan-500" /> : s === 'failed' ? <XCircle className="w-4 h-4 text-rose-500" />
    : s === 'waiting' ? <AlertTriangle className="w-4 h-4 text-amber-500" /> : s === 'rolled_back' ? <AlertTriangle className="w-4 h-4 text-amber-500" /> : <CircleDashed className={clsx('w-4 h-4', muted)} />);

  return (
    <div className={card} data-testid="project-release">
      <div className="flex items-center gap-2"><Rocket className="w-4 h-4 text-cyan-500" /><p className="text-sm font-semibold">Deploy from CloudCraft</p></div>
      <p className={clsx('text-xs', muted)}>CloudCraft creates the Azure resources, builds the images in Azure, stores the secrets in a Key Vault and starts the services, with the account you connected. You see the plan and confirm with your password first. Nothing is created before that.</p>

      {!release || !ACTIVE.has(release.status) ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className={label} htmlFor="rel-account">Azure account</label>
            <select id="rel-account" className={input} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts === null && <option value="">Loading…</option>}
              {accounts !== null && accounts.length === 0 && <option value="">No Azure account connected</option>}
              {(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div><label className={label} htmlFor="rel-rg">State: resource group</label><input id="rel-rg" className={input} value={backend.resourceGroupName} onChange={(e) => setBackend({ ...backend, resourceGroupName: e.target.value })} /></div>
          <div><label className={label} htmlFor="rel-sa">State: storage account</label><input id="rel-sa" className={input} value={backend.storageAccountName} onChange={(e) => setBackend({ ...backend, storageAccountName: e.target.value })} /></div>
          <div><label className={label} htmlFor="rel-ct">State: container</label><input id="rel-ct" className={input} value={backend.containerName} onChange={(e) => setBackend({ ...backend, containerName: e.target.value })} /></div>
          <div><label className={label} htmlFor="rel-key">State: file name</label><input id="rel-key" className={input} value={backend.key} onChange={(e) => setBackend({ ...backend, key: e.target.value })} /></div>
          <p className={clsx('col-span-2 text-[11px]', muted)}>Terraform keeps a record of what it created in an Azure storage container you own. The Deploy tab can create one. This project uses its own file in it.</p>
          <div className="col-span-2">
            <button type="button" disabled={busy || !accountId || !backend.resourceGroupName || !backend.storageAccountName} onClick={() => void makePlan()}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-40">
              {busy && !plan ? 'Planning…' : 'Plan the deployment'}
            </button>
          </div>
        </div>
      ) : null}

      {error && <p role="alert" className="text-xs text-rose-500">{error}</p>}

      {plan && (
        <div className="space-y-3" data-testid="release-plan">
          <div className={clsx('rounded-lg border px-3 py-2 text-xs', isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-900 border-slate-700')}>
            <p className="font-semibold">{plan.plan.summary.toAdd} to create, {plan.plan.summary.toChange} to change, 0 to destroy{plan.cost ? ` · about $${plan.cost.monthlyUsd.toFixed(2)} a month` : ''}</p>
            <p className={muted}>Then: store the secrets{plan.release.secrets.length ? ` (${plan.release.secrets.join(', ')})` : ' (none are needed)'}, build the images, put the release on the VM, start it and check the address answers.</p>
          </div>
          {plan.warnings.length > 0 && <ul className={clsx('space-y-1 rounded-lg border px-3 py-2 text-xs', isLight ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-amber-500/10 border-amber-500/30 text-amber-200')}>{plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label} htmlFor="rel-pw">Your password</label><input id="rel-pw" type="password" autoComplete="current-password" className={input} value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            {needsCode && <div><label className={label} htmlFor="rel-code">Code from your authenticator app</label><input id="rel-code" inputMode="numeric" autoComplete="one-time-code" className={input} value={code} onChange={(e) => setCode(e.target.value)} /></div>}
          </div>
          <button type="button" disabled={busy || password === ''} onClick={() => void approveAndRun()} className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40">
            {busy ? 'Starting…' : 'Confirm and deploy'}
          </button>
        </div>
      )}

      {release && (
        <div className="space-y-3" data-testid="release-status">
          <p className="text-xs font-semibold">Release {release.imageTag} of {release.project}: <span data-testid="release-state">{release.status.replace('_', ' ')}</span></p>
          <ul className="space-y-1.5">
            {release.steps.filter((s) => s.state !== 'skipped').map((s) => (
              <li key={s.name} className="flex items-start gap-2 text-xs">{stateIcon(s.state)}<span><span className="font-medium">{STEP_LABEL[s.name] ?? s.name}</span>{s.message && <span className={muted}> · {s.message}</span>}</span></li>
            ))}
          </ul>

          {release.status === 'waiting' && (
            <div className={clsx('rounded-lg border p-3 space-y-2', isLight ? 'border-amber-200 bg-amber-50' : 'border-amber-500/30 bg-amber-500/10')} data-testid="release-secrets">
              <p className="text-xs font-semibold">Enter the secrets the services need</p>
              <p className={clsx('text-[11px]', muted)}>Each value is sent once, stored in the Key Vault and forgotten: CloudCraft keeps none. Use letters, digits and . _ ~ - only. Leave blank one that is already stored.</p>
              {(missing ?? release.secrets).map((name) => (
                <div key={name}><label className={label} htmlFor={`sec-${name}`}>{name}</label>
                  <input id={`sec-${name}`} type="password" autoComplete="off" className={clsx(input, 'font-mono')} value={secretValues[name] ?? ''} onChange={(e) => setSecretValues({ ...secretValues, [name]: e.target.value })} /></div>
              ))}
              <button type="button" disabled={busy || Object.values(secretValues).every((v) => v === '')} onClick={() => void sendSecrets()} className="px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-600 text-white disabled:opacity-40">Store the secrets and continue</button>
            </div>
          )}

          {release.status === 'succeeded' && release.outputs && <p className="text-xs text-emerald-600">It is running at <a className="underline" href={release.outputs.url} target="_blank" rel="noreferrer">{release.outputs.url}</a></p>}
          {release.status === 'rolled_back' && <p className="text-xs text-amber-600">The new release did not work, so the previous one was put back and answers. {release.error}</p>}
          {(release.status === 'failed') && release.error && <p className="text-xs text-rose-500">{release.error}</p>}
          {release.log.length > 0 && <pre className={clsx('rounded-lg p-3 text-[11px] leading-relaxed max-h-40 overflow-auto font-mono', isLight ? 'bg-slate-900 text-slate-100' : 'bg-slate-950 text-slate-200 border border-slate-800')}>{release.log.slice(-12).join('\n')}</pre>}

          <div className="flex flex-wrap gap-2">
            {ACTIVE.has(release.status) && <button type="button" disabled={busy} onClick={() => void act('cancel')} className="px-3 py-1.5 rounded-lg border text-xs font-medium border-rose-300 text-rose-600 disabled:opacity-40">Cancel</button>}
            {release.status === 'failed' && infraDone && <button type="button" disabled={busy} onClick={() => void act('run')} className="px-3 py-1.5 rounded-lg border text-xs font-medium border-cyan-500 text-cyan-600 disabled:opacity-40">Retry from the failed step</button>}
            {release.status === 'failed' && !infraDone && <p className={clsx('text-xs', muted)}>The infrastructure was not created. Plan the deployment again.</p>}
            {release.status === 'waiting' && missing && missing.length === 0 && <button type="button" disabled={busy} onClick={() => void act('run')} className="px-3 py-1.5 rounded-lg border text-xs font-medium border-cyan-500 text-cyan-600 disabled:opacity-40">Continue</button>}
          </div>
        </div>
      )}
    </div>
  );
}
