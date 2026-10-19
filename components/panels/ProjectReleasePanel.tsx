'use client';
/**
 * "Deploy from CloudBuilder" for a project of several services on an Azure VM or an AWS EC2 instance (see docs/IN_APP_DEPLOYMENT_DESIGN.md).
 *
 * The person picks a connected Azure account and where Terraform keeps its state, CloudBuilder plans the deployment on the server, the person confirms with
 * their password (the same single-use approval as any Terraform apply) and the release runs in the background: infrastructure, secrets, build, publish,
 * start, verify. When it needs secrets it stops and asks for them here; they are sent once to the server, written straight to the vault and forgotten (this
 * form clears them, and nothing here stores them). The server decides everything that matters; this is only the window onto it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Loader2, XCircle, CircleDashed, Rocket } from 'lucide-react';
import { LAYERS, LAYER_LABEL, type StackProject } from '@/lib/engines/containers/stackProject';
import { AwsBackendSchema, AzureBackendSchema } from '@/lib/terraform/execution/backendSchema';

interface Account { id: string; name: string; provider: string; identity?: { authMethod?: string } }
interface Step { name: string; state: 'pending' | 'running' | 'done' | 'failed' | 'waiting' | 'skipped' | 'rolled_back'; message?: string }
interface ReleaseView {
  ownCode: string[]; previousReleaseId?: string | null; rollbackOf?: string | null; createdAt?: number; id: string; project: string; imageTag: string; status: string; steps: Step[]; error: string | null; log: string[]; secrets: string[]; planId: string | null; planHash: string | null;
  outputs: { url: string; resourceGroup: string; vmName: string } | null;
}
interface DestroyPreview { confirmationToken: string; planId: string; planHash: string; resourceCount: number; resources: Array<{ address: string; type: string }>; project: string }
interface PlanView { planId: string; planHash: string; summary: { toAdd: number; toChange: number; toDestroy: number }; expiresAt: string }

const STEP_LABEL: Record<'azure' | 'aws' | 'ecs' | 'aca', Record<string, string>> = {
  azure: {
    infrastructure: 'Create the resource group, registry, vault and VM', secrets: 'Store the secrets', build: 'Build the images in Azure',
    publish: 'Put the release on the VM', start: 'Start the services', verify: 'Check the address answers',
  },
  aca: {
    infrastructure: 'Create the resource group, registry, vault, environment and apps', secrets: 'Store the secrets', build: 'Build the images in Azure',
    publish: 'Point the apps at the new images', start: 'Start the apps and wait until they are ready', verify: 'Check the address answers',
  },
  ecs: {
    infrastructure: 'Create the cluster, load balancer, registry and build project', secrets: 'Store the secrets', build: 'Build the images in CodeBuild',
    publish: 'Point the services at the new images', start: 'Start the services and wait until they are steady', verify: 'Check the address answers',
  },
  aws: {
    infrastructure: 'Create the instance, registry, build project and buckets', secrets: 'Store the secrets', build: 'Build the images in CodeBuild',
    publish: 'Put the release files in the bucket', start: 'Restart the services on the instance', verify: 'Check the address answers',
  },
};
const ACTIVE = new Set(['approved', 'running', 'waiting']);

/** The server's message, with the reasons behind a "Validation failed" (which field, what is wrong) when it gave them. */
function explain(e: { message?: string; details?: { formErrors?: string[]; fieldErrors?: Record<string, string[]> } } | undefined): string {
  const base = e?.message ?? 'Could not reach the server';
  const d = e?.details;
  const reasons = [...(d?.formErrors ?? []), ...Object.values(d?.fieldErrors ?? {}).flat()];
  return reasons.length > 0 ? `${base}: ${[...new Set(reasons)].join('; ')}` : base;
}

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; code: string; message: string }> {
  try {
    const res = await fetch(path, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, code: body?.error?.code ?? 'ERROR', message: explain(body?.error) };
    return { ok: true, data: body.data as T };
  } catch { return { ok: false, status: 0, code: 'NETWORK', message: 'Could not reach the server' }; }
}

export default function ProjectReleasePanel({ projectId, environment, stack, isLight, draftName, onSaveProject, saving }: {
  projectId: string | null; environment: string; stack: StackProject; isLight: boolean;
  /** Set when the open project is an unsaved draft: the name it would be saved under. */
  draftName?: string; onSaveProject?: () => void; saving?: boolean;
}) {
  const muted = isLight ? 'text-slate-500' : 'text-slate-400';
  const label = clsx('block text-xs font-medium mb-1', isLight ? 'text-slate-700' : 'text-slate-300');
  const input = clsx('w-full rounded-lg border px-3 py-2 text-sm', isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-slate-950 border-slate-700 text-slate-100');
  const card = clsx('rounded-2xl border p-5 space-y-3', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/60 border-slate-800');

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountId, setAccountId] = useState('');
  const kind: 'azure' | 'aws' | 'ecs' | 'aca' = stack.deploy.target === 'container-apps' ? 'aca' : stack.deploy.target === 'ecs' ? 'ecs' : stack.deploy.target === 'ec2' ? 'aws' : 'azure';
  const cloud: 'azure' | 'aws' = kind === 'azure' || kind === 'aca' ? 'azure' : 'aws';
  const [backend, setBackend] = useState({ resourceGroupName: '', storageAccountName: '', containerName: 'tfstate', key: '' });
  const [awsState, setAwsState] = useState({ bucket: '', region: 'eu-north-1', dynamodbTable: '', key: '' });
  const [off, setOff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creatingState, setCreatingState] = useState(false);
  const [stateNote, setStateNote] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ typed: string; busy: boolean } | null>(null);
  const [plan, setPlan] = useState<{ release: ReleaseView; plan: PlanView; cost: { monthlyUsd: number } | null; warnings: string[] } | null>(null);
  const [release, setRelease] = useState<ReleaseView | null>(null);
  const [history, setHistory] = useState<ReleaseView[]>([]);
  const [putBack, setPutBack] = useState<string | null>(null);
  const [teardown, setTeardown] = useState<{ preview: DestroyPreview | null; nothing: boolean; name: string; password: string; code: string; needsCode: boolean; runId: string | null; state: string | null; tail: string[]; elapsed: number } | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  /** Whether the background worker that runs releases is up (the server says; undefined until it has). */
  const [workerAlive, setWorkerAlive] = useState<boolean | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  /** The zips of the person's own code, by service: what the server returned for each upload (never the file). */
  const [sources, setSources] = useState<Record<string, { id: string; name: string; files: number; bytes: number; replaced: string[] }>>({});
  const builtLayers = LAYERS.filter((l) => l !== 'database' && stack.layers[l].enabled && stack.layers[l].config.image === '');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const base = projectId ? `/api/projects/${projectId}/releases` : '';

  // Accounts, the state backend the Deploy tab already knows (its storage, not its state key), and the latest release of this environment.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      const r = await api<Account[]>(`/api/cloud-accounts?provider=${cloud}`);
      if (!cancelled && r.ok) {
        const list = (Array.isArray(r.data) ? r.data : []).filter((a) => a.provider === cloud && a.identity?.authMethod !== 'access-key');
        setAccounts(list); setAccountId((cur) => cur || list[0]?.id || '');
      } else if (!cancelled) setAccounts([]);
      try {
        const saved = JSON.parse(localStorage.getItem(`cloudbuilder_tf_backend_${projectId}`) ?? 'null') as { azureBackend?: { resourceGroupName?: string; storageAccountName?: string; containerName?: string }; awsBackend?: { bucket?: string; region?: string; dynamodbTable?: string } } | null;
        if (cloud === 'aws') {
          if (saved?.awsBackend && !cancelled) setAwsState((b) => ({ ...b, bucket: saved.awsBackend!.bucket ?? '', region: saved.awsBackend!.region || b.region, dynamodbTable: saved.awsBackend!.dynamodbTable ?? '' }));
        } else if (saved?.azureBackend && !cancelled) setBackend((b) => ({ ...b, resourceGroupName: saved.azureBackend!.resourceGroupName ?? '', storageAccountName: saved.azureBackend!.storageAccountName ?? '', containerName: saved.azureBackend!.containerName || 'tfstate' }));
      } catch { /* nothing remembered: the person types it */ }
      const list = await api<{ releases: ReleaseView[] }>(`${base}?environment=${encodeURIComponent(environment)}`);
      if (cancelled) return;
      if (!list.ok) { if (list.status === 503) setOff(list.message); return; }
      const latest = list.data.releases[0];
      setHistory(list.data.releases);
      if (latest) setRelease(latest);
    })();
    return () => { cancelled = true; };
  }, [projectId, environment, base, cloud]);

  // The state key is this project's own, never the architecture's: two Terraform projects must not share one state.
  useEffect(() => {
    const key = `cloudbuilder/releases/${stack.name}-${environment}.tfstate`;
    setBackend((b) => (b.key ? b : { ...b, key })); setAwsState((b) => (b.key ? b : { ...b, key }));
  }, [stack.name, environment]);

  const refresh = useCallback(async (id: string) => {
    const r = await api<{ release: ReleaseView; missing: string[] | null; worker?: { alive: boolean } }>(`${base}/${id}`);
    if (!r.ok) return;
    setRelease(r.data.release); setMissing(r.data.missing); setWorkerAlive(r.data.worker?.alive);
  }, [base]);

  // Follow a release that is going on.
  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (release && ACTIVE.has(release.status)) timer.current = setInterval(() => void refresh(release.id), 3000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [release?.id, release?.status, refresh]);   // eslint-disable-line react-hooks/exhaustive-deps

  const reloadHistory = async () => {
    const list = await api<{ releases: ReleaseView[] }>(`${base}?environment=${encodeURIComponent(environment)}`);
    if (list.ok) setHistory(list.data.releases);
  };

  // Follow a teardown that is going on; when it is over, ask the cloud whether the resources are really gone.
  useEffect(() => {
    if (!teardown?.runId || teardown.state !== 'running' || !release) return;
    const id = setInterval(async () => {
      const r = await api<{ state: string; logTail: string[]; elapsedSeconds: number; error?: string }>(`/api/projects/${projectId}/terraform/destroy?runId=${teardown.runId}`);
      if (!r.ok) return;
      setTeardown((x) => (x ? { ...x, state: r.data.state, tail: r.data.logTail, elapsed: r.data.elapsedSeconds } : x));
      if (r.data.state === 'failed') setError(r.data.error ?? 'The teardown failed. Read its output below and try again.');
      if (r.data.state === 'succeeded') {
        const fresh = await api<{ release: ReleaseView }>(`${base}/${release.id}?reconcile=1`);
        if (fresh.ok) setRelease(fresh.data.release);
        await reloadHistory();
      }
    }, 3000);
    return () => clearInterval(id);
  }, [teardown?.runId, teardown?.state, release?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!projectId) {
    return (
      <div className={card} data-testid="release-needs-project">
        <div className="flex items-center gap-2"><Rocket className="w-4 h-4 text-cyan-500" /><p className="text-sm font-semibold">Deploy from CloudBuilder</p></div>
        <p className={clsx('text-xs', muted)}>{saving ? 'Saving the project…' : 'A deployment belongs to a saved project, and this one is still a draft that is kept only in your browser.'}</p>
        {onSaveProject && !saving && (
          <button type="button" onClick={onSaveProject} className="px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 text-white">Save as a project{draftName ? ` (${draftName})` : ''}</button>
        )}
        {!onSaveProject && !saving && <p className={clsx('text-xs', muted)}>Open or create a saved project: pick one in the Projects list on the left.</p>}
      </div>
    );
  }
  if (off) return <div className={card}><p className="text-sm font-semibold">Deploy from CloudBuilder</p><p className={clsx('text-xs', muted)}>{off} You can still download the files and run <code>bash deploy.sh</code> yourself.</p></div>;

  const fail = (m: string) => { setError(m); setBusy(false); };

  async function upload(layer: string, file: File | undefined) {
    if (!file) return;
    setError(null); setBusy(true);
    const form = new FormData();
    form.set('layer', layer); form.set('file', file);
    try {
      const res = await fetch(`${base}/sources`, { method: 'POST', credentials: 'include', body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return fail(body?.error?.message ?? 'Could not upload the zip');
      setSources((cur) => ({ ...cur, [layer]: { id: body.data.sourceId, name: file.name, files: body.data.files, bytes: body.data.bytes, replaced: body.data.replaced ?? [] } }));
      setBusy(false);
    } catch { fail('Could not reach the server'); }
  }

  async function makePlan() {
    setBusy(true); setError(null); setPlan(null);
    const useSources = Object.fromEntries(Object.entries(sources).filter(([layer]) => (builtLayers as string[]).includes(layer)).map(([layer, s]) => [layer, s.id]));
    const r = await api<{ release: ReleaseView; plan: PlanView; cost: { monthlyUsd: number } | null; warnings: string[] }>(base, {
      method: 'POST', body: JSON.stringify({ environment, cloudAccountId: accountId, stateBackend: stateBackend(), project: stack, ...(Object.keys(useSources).length > 0 ? { sources: useSources } : {}) }),
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

  async function putBackNow(id: string) {
    setBusy(true); setError(null); setPutBack(null);
    const r = await api<{ release: ReleaseView }>(`${base}/${id}/rollback`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
    if (!r.ok) return fail(r.message);
    setRelease(r.data.release); setBusy(false);
    await reloadHistory();
  }

  const stateBackend = () => (cloud === 'aws'
    ? { provider: 'aws', bucket: awsState.bucket, key: awsState.key, region: awsState.region, ...(awsState.dynamodbTable ? { dynamodbTable: awsState.dynamodbTable } : {}) }
    : { provider: 'azure', ...backend });
  const stateFilled = cloud === 'aws' ? Boolean(awsState.bucket && awsState.region && awsState.key) : Boolean(backend.resourceGroupName && backend.storageAccountName);
  // The same rules the server applies, so a typo is shown here, next to the fields, and nothing is sent.
  const stateProblems: string[] = (() => {
    if (!stateFilled) return [];
    const r = (cloud === 'aws' ? AwsBackendSchema : AzureBackendSchema).safeParse(stateBackend());
    return r.success ? [] : [...new Set(r.error.issues.map((i) => i.message))];
  })();
  const stateReady = stateFilled && stateProblems.length === 0;

  /** Deletes the state bucket CloudBuilder made (the server refuses one that is not CloudBuilder's or that still records resources). */
  async function deleteState() {
    if (!deleting) return;
    setDeleting({ ...deleting, busy: true }); setError(null); setStateNote(null);
    const r = await api<{ steps: Array<{ what: string; outcome: string }> }>(`/api/projects/${projectId}/terraform/state-backend`, {
      method: 'DELETE', body: JSON.stringify({ cloudAccountId: accountId, stateBackend: { provider: 'aws', bucket: awsState.bucket.trim(), region: awsState.region.trim() }, confirmName: deleting.typed }),
    });
    if (!r.ok) { setDeleting({ ...deleting, busy: false }); setError(r.message); return; }
    setDeleting(null);
    setAwsState((b) => ({ ...b, bucket: '' }));
    setStateNote(r.data.steps.map((x) => `${x.what}: ${x.outcome === 'deleted' ? 'deleted' : 'already gone'}`).join('; '));
  }

  /** Creates the state storage in the chosen account (nothing is changed if it exists). An empty AWS bucket name lets CloudBuilder pick a unique one. */
  async function createState() {
    setCreatingState(true); setStateNote(null); setError(null);
    const body = cloud === 'aws'
      ? { provider: 'aws', region: awsState.region, ...(awsState.bucket.trim() && !AwsBackendSchema.shape.bucket.safeParse(awsState.bucket).error ? { bucket: awsState.bucket.trim() } : {}), ...(awsState.key ? { key: awsState.key } : {}), ...(awsState.dynamodbTable ? { dynamodbTable: awsState.dynamodbTable } : {}) }
      : { provider: 'azure', resourceGroupName: backend.resourceGroupName, storageAccountName: backend.storageAccountName, containerName: backend.containerName || 'tfstate', key: backend.key, location: String((stack.deploy.target === 'container-apps' ? stack.deploy.aca.location : stack.deploy.azvm.location) || 'eastus') };
    const r = await api<{ bucket?: string; dynamodbTable?: string; steps: Array<{ what: string; outcome: string }> }>(`/api/projects/${projectId}/terraform/state-backend`, { method: 'POST', body: JSON.stringify({ cloudAccountId: accountId, stateBackend: body }) });
    setCreatingState(false);
    if (!r.ok) { setError(r.message); return; }
    if (cloud === 'aws' && r.data.bucket) setAwsState((b) => ({ ...b, bucket: r.data.bucket!, ...(r.data.dynamodbTable ? { dynamodbTable: r.data.dynamodbTable } : {}) }));
    setStateNote(r.data.steps.map((x) => `${x.what}: ${x.outcome === 'created' ? 'created' : 'already there'}`).join('; ') || 'State storage is ready.');
  }

  async function previewTeardown() {
    if (!release) return;
    setBusy(true); setError(null);
    const r = await api<{ status: string } & Partial<DestroyPreview>>(`${base}/${release.id}/destroy`, { method: 'POST', body: JSON.stringify({ stateBackend: stateBackend() }) });
    if (!r.ok) return fail(r.message);
    setBusy(false);
    setTeardown({ preview: r.data.status === 'confirmation_required' ? (r.data as DestroyPreview) : null, nothing: r.data.status === 'nothing_to_destroy', name: '', password: '', code: '', needsCode: false, runId: null, state: null, tail: [], elapsed: 0 });
  }

  async function runTeardown() {
    if (!release || !teardown?.preview) return;
    const t = teardown; const p = teardown.preview;
    setBusy(true); setError(null);
    const c = await api<unknown>(`/api/projects/${projectId}/terraform/confirm`, { method: 'POST', body: JSON.stringify({ action: 'destroy', planId: p.planId, planHash: p.planHash, password: t.password, ...(t.code ? { code: t.code } : {}) }) });
    setTeardown((x) => (x ? { ...x, password: '', code: '' } : x));
    if (!c.ok) { if (c.code === 'CODE_REQUIRED') setTeardown((x) => (x ? { ...x, needsCode: true } : x)); return fail(c.message); }
    const r = await api<{ runId: string }>(`${base}/${release.id}/destroy`, { method: 'POST', body: JSON.stringify({ stateBackend: stateBackend(), confirmationToken: p.confirmationToken, planId: p.planId, confirmName: t.name }) });
    if (!r.ok) return fail(r.message);
    setBusy(false);
    setTeardown((x) => (x ? { ...x, runId: r.data.runId, state: 'running' } : x));
  }

  const infraDone = release?.steps.find((s) => s.name === 'infrastructure')?.state === 'done';
  const stateIcon = (s: Step['state']) => (s === 'done' ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : s === 'running' ? <Loader2 className="w-4 h-4 animate-spin text-cyan-500" /> : s === 'failed' ? <XCircle className="w-4 h-4 text-rose-500" />
    : s === 'waiting' ? <AlertTriangle className="w-4 h-4 text-amber-500" /> : s === 'rolled_back' ? <AlertTriangle className="w-4 h-4 text-amber-500" /> : <CircleDashed className={clsx('w-4 h-4', muted)} />);

  return (
    <div className={card} data-testid="project-release">
      <div className="flex items-center gap-2"><Rocket className="w-4 h-4 text-cyan-500" /><p className="text-sm font-semibold">Deploy from CloudBuilder</p></div>
      <p className={clsx('text-xs', muted)}>{cloud === 'aws'
        ? 'CloudBuilder creates the AWS resources, builds the images in CodeBuild, stores the secrets in Parameter Store and starts the services, with the account you connected.'
        : 'CloudBuilder creates the Azure resources, builds the images in Azure, stores the secrets in a Key Vault and starts the services, with the account you connected.'} You see the plan and confirm with your password first. Nothing is created before that.</p>

      {!release || !ACTIVE.has(release.status) ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className={label} htmlFor="rel-account">{cloud === 'aws' ? 'AWS' : 'Azure'} account</label>
            <select id="rel-account" className={input} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts === null && <option value="">Loading…</option>}
              {accounts !== null && accounts.length === 0 && <option value="">No {cloud === 'aws' ? 'AWS' : 'Azure'} account connected</option>}
              {(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <ul className="col-span-2 space-y-1 text-xs" data-testid="release-checklist">
            {([
              ['A saved project', true, ''],
              [`${cloud === 'aws' ? 'An AWS' : 'An Azure'} account that can deploy`, !!accountId, cloud === 'aws' ? 'Connect one in Cloud Accounts with the Simple (access key) or Safer (role) option.' : 'Connect a service principal in Cloud Accounts.'],
              ['Somewhere for Terraform to keep its record', stateReady, stateProblems.length > 0 ? 'Fix the highlighted field.' : 'Press "Create state storage for me", or fill in storage you already have.'],
            ] as const).map(([what, done, how]) => (
              <li key={what} className="flex items-start gap-2">{done ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" /> : <XCircle className="w-4 h-4 text-rose-500 shrink-0" />}<span>{what}{!done && how ? <span className={muted}> · {how}</span> : null}</span></li>
            ))}
          </ul>
          {cloud === 'aws' ? <>
          <div><label className={label} htmlFor="rel-bucket">State: S3 bucket</label><input id="rel-bucket" className={input} value={awsState.bucket} onChange={(e) => setAwsState({ ...awsState, bucket: e.target.value })} /></div>
          <div><label className={label} htmlFor="rel-region">State: region</label><input id="rel-region" className={input} value={awsState.region} onChange={(e) => setAwsState({ ...awsState, region: e.target.value })} /></div>
          <div><label className={label} htmlFor="rel-ddb">State: lock table (optional)</label><input id="rel-ddb" className={input} value={awsState.dynamodbTable} onChange={(e) => setAwsState({ ...awsState, dynamodbTable: e.target.value })} /></div>
          <div><label className={label} htmlFor="rel-key">State: file name</label><input id="rel-key" className={input} value={awsState.key} onChange={(e) => setAwsState({ ...awsState, key: e.target.value })} /></div>
          </> : <>
          <div><label className={label} htmlFor="rel-rg">State: resource group</label><input id="rel-rg" className={input} value={backend.resourceGroupName} onChange={(e) => setBackend({ ...backend, resourceGroupName: e.target.value })} /></div>
          <div><label className={label} htmlFor="rel-sa">State: storage account</label><input id="rel-sa" className={input} value={backend.storageAccountName} onChange={(e) => setBackend({ ...backend, storageAccountName: e.target.value })} /></div>
          <div><label className={label} htmlFor="rel-ct">State: container</label><input id="rel-ct" className={input} value={backend.containerName} onChange={(e) => setBackend({ ...backend, containerName: e.target.value })} /></div>
          <div><label className={label} htmlFor="rel-key">State: file name</label><input id="rel-key" className={input} value={backend.key} onChange={(e) => setBackend({ ...backend, key: e.target.value })} /></div>
          </>}
          {stateProblems.length > 0 && <ul role="alert" className="col-span-2 text-xs text-rose-500 space-y-0.5">{stateProblems.map((m) => <li key={m}>{m}</li>)}</ul>}
          <div className="col-span-2 space-y-1">
            <button type="button" disabled={busy || creatingState || !accountId || (cloud === 'aws' ? !awsState.region : !(backend.resourceGroupName && backend.storageAccountName))} onClick={() => void createState()}
              className={clsx('px-3 py-1.5 rounded-lg border text-xs font-medium disabled:opacity-40', isLight ? 'border-slate-300 text-slate-700 bg-slate-100' : 'border-slate-600 text-slate-200 bg-slate-800')}>
              {creatingState ? 'Creating state storage…' : 'Create state storage for me'}
            </button>
            <p className={clsx('text-[11px]', muted)}>{cloud === 'aws' ? 'Makes a private, encrypted, versioned bucket in this account. Leave the bucket name empty and CloudBuilder picks a unique one. Nothing changes if it already exists.' : 'Makes the resource group, storage account and container if they do not exist. Nothing changes if they do.'}</p>
            {stateNote && <p className="text-[11px] text-emerald-500">{stateNote}</p>}
            {cloud === 'aws' && stateReady && accountId && !(release && infraDone && release.status !== 'destroyed') && !deleting && (
              <button type="button" disabled={busy || creatingState} onClick={() => setDeleting({ typed: '', busy: false })} className="text-[11px] text-rose-500 underline disabled:opacity-40">Delete this state storage…</button>
            )}
            {deleting && (
              <div className={clsx('rounded-lg border p-3 space-y-2', isLight ? 'border-rose-200' : 'border-rose-500/30')} data-testid="delete-state">
                <p className="text-[11px]">Permanently deletes the bucket <strong>{awsState.bucket}</strong> and everything in it. Only a bucket CloudBuilder created is deleted, and only when its Terraform record lists no resources: if something is still deployed, use Remove everything first.</p>
                <label className={label} htmlFor="rel-delete-bucket">Type the bucket name to confirm</label>
                <input id="rel-delete-bucket" className={input} value={deleting.typed} onChange={(e) => setDeleting({ ...deleting, typed: e.target.value })} autoComplete="off" />
                <div className="flex gap-2">
                  <button type="button" disabled={deleting.busy || deleting.typed.trim() !== awsState.bucket.trim()} onClick={() => void deleteState()} className="px-3 py-1.5 rounded-lg border text-xs font-medium border-rose-300 text-rose-600 disabled:opacity-40">{deleting.busy ? 'Deleting…' : 'Delete permanently'}</button>
                  <button type="button" disabled={deleting.busy} onClick={() => setDeleting(null)} className="px-3 py-1.5 rounded-lg border text-xs">Cancel</button>
                </div>
              </div>
            )}
          </div>
          <div className="col-span-2 space-y-2" data-testid="own-code">
            <p className={label}>Your code (optional)</p>
            <p className={clsx('text-[11px]', muted)}>Without it, each service is built from the generated sample app. Upload a zip (up to 5 MB) of a service&apos;s code to build that instead. CloudBuilder&apos;s own Dockerfile is used, not one from the zip.</p>
            {builtLayers.map((layer) => (
              <div key={layer} className="flex flex-wrap items-center gap-2 text-xs">
                <label className="font-medium w-20" htmlFor={`code-${layer}`}>{LAYER_LABEL[layer]}</label>
                {sources[layer] ? (
                  <>
                    <span>{sources[layer]!.name}: {sources[layer]!.files} files{sources[layer]!.replaced.length ? ` (${sources[layer]!.replaced.join(', ')} from the zip is not used)` : ''}</span>
                    <button type="button" className="text-rose-500" onClick={() => setSources(({ [layer]: _gone, ...rest }) => rest)}>Remove</button>
                  </>
                ) : (
                  <input id={`code-${layer}`} type="file" accept=".zip,application/zip" disabled={busy} onChange={(e) => { void upload(layer, e.target.files?.[0]); e.target.value = ''; }} />
                )}
              </div>
            ))}
          </div>
          <p className={clsx('col-span-2 text-[11px]', muted)}>{cloud === 'aws' ? 'Terraform keeps a record of what it created in an S3 bucket you own (the button above creates it). This project uses its own file in it.' : 'Terraform keeps a record of what it created in an Azure storage container you own. The button above can create it. This project uses its own file in it.'}</p>
          <div className="col-span-2">
            <button type="button" disabled={busy || !accountId || !stateReady} onClick={() => void makePlan()}
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
            {(plan.release.ownCode ?? []).length > 0 && <p className={muted}>Built from your code: {plan.release.ownCode.join(', ')}.</p>}
            <p className={muted}>Then: store the secrets{plan.release.secrets.length ? ` (${plan.release.secrets.join(', ')})` : ' (none are needed)'}, build the images, put the release on the {kind === 'azure' || kind === 'aws' ? 'server' : 'services'}, start it and check the address answers.</p>
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
              <li key={s.name} className="flex items-start gap-2 text-xs">{stateIcon(s.state)}<span><span className="font-medium">{STEP_LABEL[kind][s.name] ?? s.name}</span>{s.message && <span className={muted}> · {s.message}</span>}</span></li>
            ))}
          </ul>

          {release.status === 'waiting' && (
            <div className={clsx('rounded-lg border p-3 space-y-2', isLight ? 'border-amber-200 bg-amber-50' : 'border-amber-500/30 bg-amber-500/10')} data-testid="release-secrets">
              <p className="text-xs font-semibold">Enter the secrets the services need</p>
              <p className={clsx('text-[11px]', muted)}>Each value is sent once, stored in {cloud === 'aws' ? 'Parameter Store' : 'the Key Vault'} and forgotten: CloudBuilder keeps none. Use letters, digits and . _ ~ - only. Leave blank one that is already stored.</p>
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

          {(release.status === 'approved' || release.status === 'running') && workerAlive === false && (
            <p role="alert" className="text-xs text-rose-500">The background worker that runs releases is not running, so nothing is happening. Start it on the server (<code>npm run worker:terraform-apply</code>, or restart <code>cloudcraft-tf-apply</code> in pm2); the release then continues.</p>
          )}
          {release.status === 'destroyed' && <p className="text-xs text-amber-600">Everything this release created was removed. Plan a new deployment to create it again.</p>}
          <div className="flex flex-wrap gap-2">
            {ACTIVE.has(release.status) && <button type="button" disabled={busy} onClick={() => void act('cancel')} className="px-3 py-1.5 rounded-lg border text-xs font-medium border-rose-300 text-rose-600 disabled:opacity-40">Cancel</button>}
            {release.status === 'failed' && infraDone && <button type="button" disabled={busy} onClick={() => void act('run')} className="px-3 py-1.5 rounded-lg border text-xs font-medium border-cyan-500 text-cyan-600 disabled:opacity-40">Retry from the failed step</button>}
            {release.status === 'failed' && !infraDone && <p className={clsx('text-xs', muted)}>The infrastructure was not created. Plan the deployment again.</p>}
            {release.status === 'waiting' && missing && missing.length === 0 && <button type="button" disabled={busy} onClick={() => void act('run')} className="px-3 py-1.5 rounded-lg border text-xs font-medium border-cyan-500 text-cyan-600 disabled:opacity-40">Continue</button>}
          </div>
        </div>
      )}

      {history.filter((h) => h.status === 'succeeded' && h.id !== release?.id).length > 0 && release && (release.status === 'succeeded' || release.status === 'rolled_back' || release.status === 'failed') && (
        <div className="space-y-2" data-testid="release-history">
          <p className="text-xs font-semibold">Earlier releases that worked</p>
          {history.filter((h) => h.status === 'succeeded' && h.id !== release.id).map((h) => (
            <div key={h.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono">{h.imageTag}</span>
              {putBack === h.id ? (
                <>
                  <span>Put {h.imageTag} back on the VM?</span>
                  <button type="button" disabled={busy} onClick={() => void putBackNow(h.id)} className="px-2 py-1 rounded border border-cyan-500 text-cyan-600 font-medium">Put it back</button>
                  <button type="button" onClick={() => setPutBack(null)} className={muted}>No</button>
                </>
              ) : <button type="button" disabled={busy} onClick={() => setPutBack(h.id)} className="px-2 py-1 rounded border border-slate-400 font-medium">Put this one back</button>}
            </div>
          ))}
        </div>
      )}

      {release && infraDone && release.status !== 'destroyed' && !ACTIVE.has(release.status) && (
        <div className={clsx('rounded-lg border p-3 space-y-2', isLight ? 'border-rose-200' : 'border-rose-500/30')} data-testid="teardown">
          <p className="text-xs font-semibold">Remove everything</p>
          {!teardown && <>
            <p className={clsx('text-[11px]', muted)}>{cloud === 'aws' ? (kind === 'aca' ? 'Deletes the resource group this release created: the apps and their environment, the registry with its images, the vault with its secrets. You see the list first.' : kind === 'ecs' ? 'Deletes what this release created: the cluster and its services, the load balancer, the registry with its images, the bucket and the build project. The secrets in Parameter Store stay until you delete them. You see the list first.' : 'Deletes what this release created: the instance (and the database data on its disk), the registry with its images, the buckets and the build project. The secrets in Parameter Store stay until you delete them. You see the list first.') : 'Deletes the resource group this release created: the VM (and the database data on its disk), the registry with its images, the vault with its secrets and the network. You see the list first.'}</p>
            <button type="button" disabled={busy || !stateReady} onClick={() => void previewTeardown()} className="px-3 py-1.5 rounded-lg border text-xs font-medium border-rose-300 text-rose-600 disabled:opacity-40">Preview what would be removed</button>
          </>}
          {teardown?.nothing && <p className={clsx('text-xs', muted)}>Terraform&apos;s record holds nothing to remove.</p>}
          {teardown?.preview && !teardown.runId && (
            <div className="space-y-2">
              <p className="text-xs">{teardown.preview.resourceCount} resources would be deleted:</p>
              <ul className={clsx('text-[11px] font-mono max-h-32 overflow-auto', muted)}>{teardown.preview.resources.map((r) => <li key={r.address}>{r.address}</li>)}</ul>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={label} htmlFor="td-name">Type the project name ({teardown.preview.project})</label><input id="td-name" className={input} value={teardown.name} onChange={(e) => setTeardown({ ...teardown, name: e.target.value })} /></div>
                <div><label className={label} htmlFor="td-pw">Your password</label><input id="td-pw" type="password" autoComplete="current-password" className={input} value={teardown.password} onChange={(e) => setTeardown({ ...teardown, password: e.target.value })} /></div>
                {teardown.needsCode && <div><label className={label} htmlFor="td-code">Code from your authenticator app</label><input id="td-code" inputMode="numeric" autoComplete="one-time-code" className={input} value={teardown.code} onChange={(e) => setTeardown({ ...teardown, code: e.target.value })} /></div>}
              </div>
              <div className="flex gap-2">
                <button type="button" disabled={busy || teardown.name !== teardown.preview.project || teardown.password === ''} onClick={() => void runTeardown()} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 text-white disabled:opacity-40">Delete everything</button>
                <button type="button" onClick={() => setTeardown(null)} className={clsx('text-xs', muted)}>Cancel</button>
              </div>
            </div>
          )}
          {teardown?.runId && (
            <div className="space-y-1" data-testid="teardown-run">
              <p className="text-xs">{teardown.state === 'succeeded' ? 'Removed.' : teardown.state === 'failed' ? 'The teardown failed.' : `Removing… ${teardown.elapsed}s`}</p>
              {teardown.tail.length > 0 && <pre className={clsx('rounded-lg p-3 text-[11px] max-h-32 overflow-auto font-mono', isLight ? 'bg-slate-900 text-slate-100' : 'bg-slate-950 text-slate-200 border border-slate-800')}>{teardown.tail.slice(-8).join('\n')}</pre>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
