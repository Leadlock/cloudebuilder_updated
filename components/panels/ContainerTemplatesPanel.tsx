'use client';
/**
 * Container Templates: pick a stack, configure the service in a form, preview every generated file (Dockerfile, compose, .env.example,
 * .dockerignore, README, nginx.conf) and download them as one zip or copy a single file. Nothing is sent to a server: the files are
 * produced in the browser by lib/engines/containers/dockerTemplates.ts, so what you see is what you download.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Copy, Download, Package, Plus, Trash2, AlertTriangle, Check, ShieldCheck, Save } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import {
  defaultConfig, generateContainerFiles, STACK_LABEL, STARTER_TEMPLATES, VERSIONS,
  type ContainerConfig, type ContainerStack, type EnvVar,
} from '@/lib/engines/containers/dockerTemplates';
import { buildZip } from '@/lib/engines/containers/zip';

const STACKS = Object.keys(STACK_LABEL) as ContainerStack[];

interface Saved { id: string; name: string; config: ContainerConfig; updatedAt: string }
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? 'Could not reach the server');
  return body.data as T;
}

export default function ContainerTemplatesPanel() {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const [cfg, setCfg] = useState<ContainerConfig>(() => defaultConfig('node'));
  const [selected, setSelected] = useState('Dockerfile');
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<Saved[] | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');
  const [busy, setBusy] = useState(false);

  const refreshSaved = useCallback(async () => {
    try { setSaved((await api<{ templates: Saved[] }>('/api/container-templates')).templates); setSavedError(null); }
    catch (e) { setSaved([]); setSavedError(e instanceof Error ? e.message : 'Could not load saved templates'); }
  }, []);
  useEffect(() => { void refreshSaved(); }, [refreshSaved]);

  async function saveCurrent(asNew: boolean) {
    setBusy(true);
    try {
      const name = saveName.trim() || saved?.find((t) => t.id === loadedId)?.name || cfg.appName;
      const body = JSON.stringify({ name, config: cfg });
      const r = !asNew && loadedId
        ? await api<{ template: Saved }>(`/api/container-templates/${loadedId}`, { method: 'PUT', body })
        : await api<{ template: Saved }>('/api/container-templates', { method: 'POST', body });
      setLoadedId(r.template.id); setSaveName(''); setSavedError(null);
      await refreshSaved();
    } catch (e) { setSavedError(e instanceof Error ? e.message : 'Could not save'); }
    finally { setBusy(false); }
  }
  async function removeSaved(id: string) {
    setBusy(true);
    try { await api(`/api/container-templates/${id}`, { method: 'DELETE' }); if (loadedId === id) setLoadedId(null); await refreshSaved(); }
    catch (e) { setSavedError(e instanceof Error ? e.message : 'Could not delete'); }
    finally { setBusy(false); }
  }

  const result = useMemo(() => generateContainerFiles(cfg), [cfg]);
  const set = <K extends keyof ContainerConfig>(k: K, v: ContainerConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const pickStack = (s: ContainerStack) => setCfg((c) => ({
    ...defaultConfig(s), appName: c.appName, env: c.env, runAsNonRoot: c.runAsNonRoot, restart: c.restart, postgres: c.postgres, redis: c.redis, ec2: c.ec2,
  }));
  const setEc2 = <K extends keyof ContainerConfig['ec2']>(k: K, v: ContainerConfig['ec2'][K]) => setCfg((c) => ({ ...c, ec2: { ...c.ec2, [k]: v } }));
  const setEnv = (i: number, patch: Partial<EnvVar>) => setCfg((c) => ({ ...c, env: c.env.map((v, j) => (j === i ? { ...v, ...patch } : v)) }));

  const files = result.ok ? result.files : [];
  const current = files.find((f) => f.path === selected) ?? files[0];

  function download(name: string, data: BlobPart, type: string) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function copy() {
    if (!current) return;
    try { await navigator.clipboard.writeText(current.content); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked: the file can still be downloaded */ }
  }

  const card = clsx('rounded-2xl border p-5', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/60 border-slate-800');
  const muted = isLight ? 'text-slate-500' : 'text-slate-400';
  const label = clsx('block text-xs font-medium mb-1', isLight ? 'text-slate-700' : 'text-slate-300');
  const input = clsx('w-full rounded-lg border px-3 py-2 text-sm', isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-slate-950 border-slate-700 text-slate-100');

  return (
    <div className={clsx('flex-1 overflow-y-auto px-4 sm:px-6 py-6 pb-36 custom-scrollbar', isLight ? 'bg-slate-50 text-slate-900' : 'bg-gray-950 text-slate-100')}>
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="flex items-center gap-3">
          <Package className="w-6 h-6 text-cyan-500" />
          <div>
            <h2 className={clsx('font-bold text-lg', isLight ? 'text-slate-900' : 'text-white')}>Container Templates</h2>
            <p className={clsx('text-sm', muted)}>Configure a service and get a ready-to-run Dockerfile, compose file and everything around it.</p>
          </div>
        </div>

        <div className={card}>
          <p className={clsx('text-sm font-semibold mb-1', isLight ? 'text-slate-900' : 'text-white')}>Start from a template</p>
          <p className={clsx('text-xs mb-3', muted)}>Each one includes a small working app and the EC2 deployment, so <code>bash deploy.sh</code> runs it end to end. You can change everything below afterwards.</p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {STARTER_TEMPLATES.map((t) => (
              <button key={t.id} type="button" onClick={() => { setCfg(t.config()); setLoadedId(null); setSelected('README.md'); }}
                className={clsx('rounded-xl border p-3 text-left', isLight ? 'bg-white border-slate-300 hover:bg-slate-50' : 'bg-slate-900 border-slate-700 hover:bg-slate-800')}>
                <span className={clsx('block text-sm font-semibold', isLight ? 'text-slate-900' : 'text-white')}>{t.title}</span>
                <span className={clsx('block text-[11px] mt-0.5', muted)}>{t.blurb}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={card} data-testid="saved-templates">
          <p className={clsx('text-sm font-semibold mb-1', isLight ? 'text-slate-900' : 'text-white')}>Your saved templates</p>
          <p className={clsx('text-xs mb-3', muted)}>Shared with your organization. Secret values are never saved: you enter them again when you use a template.</p>
          {savedError && <p role="alert" className="text-xs text-rose-500 mb-2">{savedError}</p>}
          {saved && saved.length === 0 && !savedError && <p className={clsx('text-xs mb-3', muted)}>Nothing saved yet.</p>}
          {saved && saved.length > 0 && (
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4 mb-3">
              {saved.map((t) => (
                <li key={t.id} className={clsx('rounded-xl border p-3', loadedId === t.id ? 'border-cyan-500' : isLight ? 'border-slate-300 bg-white' : 'border-slate-700 bg-slate-900')}>
                  <span className={clsx('block text-sm font-semibold truncate', isLight ? 'text-slate-900' : 'text-white')}>{t.name}</span>
                  <span className={clsx('block text-[11px]', muted)}>{STACK_LABEL[t.config.stack]} · {t.config.appName}</span>
                  <div className="flex gap-3 mt-2 text-xs">
                    <button type="button" className="text-cyan-600 font-medium" onClick={() => { setCfg(t.config); setLoadedId(t.id); setSaveName(''); setSelected('README.md'); }}>Open</button>
                    <button type="button" disabled={busy} className="text-rose-500" onClick={() => void removeSaved(t.id)}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Template name" placeholder={loadedId ? 'Keep the name or type a new one' : 'Name this configuration'} className={clsx(input, 'max-w-xs')} maxLength={80} value={saveName} onChange={(e) => setSaveName(e.target.value)} />
            {loadedId && <button type="button" disabled={busy} onClick={() => void saveCurrent(false)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-cyan-600 text-white disabled:opacity-50"><Save className="w-3.5 h-3.5" />Update this template</button>}
            <button type="button" disabled={busy || !result.ok} onClick={() => void saveCurrent(true)} className={clsx('flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium disabled:opacity-50', isLight ? 'border-slate-300 text-slate-700' : 'border-slate-600 text-slate-200')}><Save className="w-3.5 h-3.5" />Save as new</button>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          {/* ── form ── */}
          <div className="space-y-4">
            <div className={card}>
              <p className={label}>Stack</p>
              <div className="grid grid-cols-2 gap-2">
                {STACKS.map((s) => (
                  <button key={s} type="button" onClick={() => pickStack(s)} aria-pressed={cfg.stack === s}
                    className={clsx('rounded-lg border px-3 py-2 text-xs font-medium text-left',
                      cfg.stack === s ? (isLight ? 'bg-cyan-600 border-cyan-600 text-white' : 'bg-cyan-500/20 border-cyan-400 text-cyan-200')
                        : (isLight ? 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50' : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'))}>
                    {STACK_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>

            <div className={clsx(card, 'space-y-3')}>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2"><label className={label} htmlFor="ct-name">App name</label><input id="ct-name" className={input} value={cfg.appName} onChange={(e) => set('appName', e.target.value)} /></div>
                <div><label className={label} htmlFor="ct-port">Port</label><input id="ct-port" type="number" className={input} value={cfg.port} onChange={(e) => set('port', Number(e.target.value))} /></div>
                <div><label className={label} htmlFor="ct-version">{cfg.stack === 'static' ? 'nginx version' : 'Version'}</label>
                  <select id="ct-version" className={input} value={cfg.version} onChange={(e) => set('version', e.target.value)}>{VERSIONS[cfg.stack].map((v) => <option key={v}>{v}</option>)}</select></div>
                <div className="col-span-2"><label className={label} htmlFor="ct-health">Health check path</label><input id="ct-health" className={input} value={cfg.healthPath} onChange={(e) => set('healthPath', e.target.value)} /></div>
              </div>

              {cfg.stack === 'node' && (
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label} htmlFor="ct-pm">Package manager</label>
                    <select id="ct-pm" className={input} value={cfg.packageManager} onChange={(e) => set('packageManager', e.target.value as ContainerConfig['packageManager'])}><option>npm</option><option>yarn</option><option>pnpm</option></select></div>
                  <label className="flex items-end gap-2 text-xs pb-2"><input type="checkbox" checked={cfg.nextStandalone} onChange={(e) => set('nextStandalone', e.target.checked)} />Next.js standalone output</label>
                  <div className="col-span-2"><label className={label} htmlFor="ct-build">Build command</label><input id="ct-build" className={input} value={cfg.buildCommand} onChange={(e) => set('buildCommand', e.target.value)} /></div>
                  {!cfg.nextStandalone && <div className="col-span-2"><label className={label} htmlFor="ct-start">Start command</label><input id="ct-start" className={input} value={cfg.startCommand} onChange={(e) => set('startCommand', e.target.value)} /></div>}
                </div>
              )}
              {cfg.stack === 'python' && (
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label} htmlFor="ct-fw">Framework</label>
                    <select id="ct-fw" className={input} value={cfg.pythonFramework} onChange={(e) => set('pythonFramework', e.target.value as ContainerConfig['pythonFramework'])}>
                      <option value="fastapi">FastAPI</option><option value="django">Django</option><option value="flask">Flask</option><option value="other">Other</option></select></div>
                  {cfg.pythonFramework === 'other'
                    ? <div><label className={label} htmlFor="ct-pstart">Start command</label><input id="ct-pstart" className={input} value={cfg.startCommand} onChange={(e) => set('startCommand', e.target.value)} /></div>
                    : <div><label className={label} htmlFor="ct-mod">{cfg.pythonFramework === 'django' ? 'Django project' : 'Module:app'}</label><input id="ct-mod" className={input} value={cfg.pythonModule} onChange={(e) => set('pythonModule', e.target.value)} /></div>}
                </div>
              )}
              {cfg.stack === 'java' && (
                <div><label className={label} htmlFor="ct-jt">Build tool</label>
                  <select id="ct-jt" className={input} value={cfg.javaBuildTool} onChange={(e) => set('javaBuildTool', e.target.value as ContainerConfig['javaBuildTool'])}><option value="maven">Maven</option><option value="gradle">Gradle</option></select></div>
              )}
              {cfg.stack === 'static' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2"><label className={label} htmlFor="ct-sbuild">Build command</label><input id="ct-sbuild" className={input} value={cfg.buildCommand} onChange={(e) => set('buildCommand', e.target.value)} /></div>
                  <div><label className={label} htmlFor="ct-dir">Build output folder</label><input id="ct-dir" className={input} value={cfg.staticBuildDir} onChange={(e) => set('staticBuildDir', e.target.value)} /></div>
                  <label className="flex items-end gap-2 text-xs pb-2"><input type="checkbox" checked={cfg.staticSpaFallback} onChange={(e) => set('staticSpaFallback', e.target.checked)} />Single-page app routing</label>
                </div>
              )}
            </div>

            <div className={clsx(card, 'space-y-3')}>
              <p className={clsx('text-sm font-semibold', isLight ? 'text-slate-900' : 'text-white')}>Server settings</p>
              <div className="grid grid-cols-3 gap-3">
                <div><label className={label} htmlFor="ct-mem">Memory</label><input id="ct-mem" className={input} value={cfg.memoryLimit} onChange={(e) => set('memoryLimit', e.target.value)} /></div>
                <div><label className={label} htmlFor="ct-cpu">CPUs</label><input id="ct-cpu" className={input} value={cfg.cpuLimit} onChange={(e) => set('cpuLimit', e.target.value)} /></div>
                <div><label className={label} htmlFor="ct-restart">Restart</label>
                  <select id="ct-restart" className={input} value={cfg.restart} onChange={(e) => set('restart', e.target.value as ContainerConfig['restart'])}><option>unless-stopped</option><option>always</option><option>on-failure</option><option>no</option></select></div>
              </div>
              <div className="flex flex-wrap gap-4 text-xs">
                {cfg.stack !== 'static' && <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.runAsNonRoot} onChange={(e) => set('runAsNonRoot', e.target.checked)} />Run as non-root (recommended)</label>}
                <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.postgres} onChange={(e) => set('postgres', e.target.checked)} />Add PostgreSQL</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.redis} onChange={(e) => set('redis', e.target.checked)} />Add Redis</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.includeSample} onChange={(e) => set('includeSample', e.target.checked)} />Include a sample app</label>
              </div>
            </div>

            <div className={clsx(card, 'space-y-3')}>
              <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={cfg.ec2.enabled} onChange={(e) => setEc2('enabled', e.target.checked)} />Deploy to EC2</label>
              <p className={clsx('text-xs', muted)}>Adds <code>deploy.sh</code> (one command to create the server, push the image and start the app), <code>destroy.sh</code>, and the Terraform behind them. No SSH: you connect through Session Manager. Secrets are read from SSM Parameter Store, never written to Terraform.</p>
              {cfg.ec2.enabled && (
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label} htmlFor="ec2-region">Region</label><input id="ec2-region" className={input} value={cfg.ec2.region} onChange={(e) => setEc2('region', e.target.value)} /></div>
                  <div><label className={label} htmlFor="ec2-type">Instance type</label><input id="ec2-type" className={input} value={cfg.ec2.instanceType} onChange={(e) => setEc2('instanceType', e.target.value)} /></div>
                  <div className="col-span-2"><label className={label} htmlFor="ec2-cidr">Who can connect to the app port</label><input id="ec2-cidr" className={input} value={cfg.ec2.allowedCidr} onChange={(e) => setEc2('allowedCidr', e.target.value)} /></div>
                  <div><label className={label} htmlFor="ec2-disk">Disk (GB)</label><input id="ec2-disk" type="number" className={input} value={cfg.ec2.volumeGb} onChange={(e) => setEc2('volumeGb', Number(e.target.value))} /></div>
                  <div><label className={label} htmlFor="ec2-tag">Image tag</label><input id="ec2-tag" className={input} value={cfg.ec2.imageTag} onChange={(e) => setEc2('imageTag', e.target.value)} /></div>
                  <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={cfg.ec2.elasticIp} onChange={(e) => setEc2('elasticIp', e.target.checked)} />Fixed public IP</label>
                  <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={cfg.ec2.githubActions} onChange={(e) => setEc2('githubActions', e.target.checked)} />GitHub Actions workflow</label>
                  {cfg.ec2.githubActions && <label className="flex items-center gap-2 text-xs col-span-2"><input type="checkbox" checked={cfg.ec2.scanImage} onChange={(e) => setEc2('scanImage', e.target.checked)} />Scan the image for vulnerabilities before pushing (Trivy)</label>}
                  {cfg.ec2.githubActions && (
                    <div className="col-span-2"><label className={label} htmlFor="ec2-gh">GitHub repository (optional, owner/name)</label>
                      <input id="ec2-gh" className={input} placeholder="yourname/yourapp" value={cfg.ec2.githubRepo} onChange={(e) => setEc2('githubRepo', e.target.value.trim())} />
                      <p className={clsx('text-[11px] mt-1', muted)}>If set, Terraform also creates the AWS role the workflow signs in with, so you only paste one value into GitHub.</p></div>
                  )}
                </div>
              )}
            </div>

            <div className={clsx(card, 'space-y-2')}>
              <div className="flex items-center justify-between">
                <p className={clsx('text-sm font-semibold', isLight ? 'text-slate-900' : 'text-white')}>Environment variables</p>
                <button type="button" onClick={() => set('env', [...cfg.env, { key: '', value: '' }])} className="flex items-center gap-1 text-xs text-cyan-600"><Plus className="w-3.5 h-3.5" />Add</button>
              </div>
              {cfg.env.length === 0 && <p className={clsx('text-xs', muted)}>None yet. Mark a variable as secret and its value is never written to any file.</p>}
              {cfg.env.map((v, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input aria-label="Variable name" placeholder="NAME" className={clsx(input, 'font-mono text-xs')} value={v.key} onChange={(e) => setEnv(i, { key: e.target.value })} />
                  <input aria-label="Variable value" placeholder={v.secret ? 'not stored' : 'value'} disabled={v.secret} className={clsx(input, 'font-mono text-xs')} value={v.secret ? '' : v.value} onChange={(e) => setEnv(i, { value: e.target.value })} />
                  <label className="flex items-center gap-1 text-[11px] whitespace-nowrap"><input type="checkbox" checked={!!v.secret} onChange={(e) => setEnv(i, { secret: e.target.checked, value: '' })} />secret</label>
                  <button type="button" aria-label="Remove variable" onClick={() => set('env', cfg.env.filter((_, j) => j !== i))} className="text-rose-500"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
          </div>

          {/* ── preview ── */}
          <div className={clsx(card, 'min-w-0')}>
            {!result.ok ? (
              <div role="alert" className={clsx('text-sm space-y-1', isLight ? 'text-rose-700' : 'text-rose-300')}>
                <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="w-4 h-4" />Fix these to generate the files</p>
                <ul className="list-disc pl-5 text-xs">{result.errors.map((e) => <li key={e}>{e}</li>)}</ul>
              </div>
            ) : (
              <>
                {result.warnings.length > 0 && (
                  <ul className={clsx('mb-3 space-y-1 rounded-lg border px-3 py-2 text-xs', isLight ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-amber-500/10 border-amber-500/30 text-amber-200')}>
                    {result.warnings.map((w) => <li key={w} className="flex gap-2"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{w}</li>)}
                  </ul>
                )}
                {result.cost && (
                  <div className={clsx('mb-3 rounded-lg border px-3 py-2 text-xs', isLight ? 'bg-slate-50 border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-700 text-slate-200')}>
                    <p className="font-semibold">Estimated cost on EC2: ${result.cost.monthlyUsd.toFixed(2)} a month</p>
                    <p className={muted}>{result.cost.lines.map((l) => `${l.label} $${l.monthlyUsd.toFixed(2)}`).join(' · ')}</p>
                    {result.cost.notes.map((n) => <p key={n} className={muted}>{n}</p>)}
                  </div>
                )}
                <div className={clsx('mb-3 rounded-lg border px-3 py-2 text-xs', isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-700')} data-testid="container-checks">
                  <p className={clsx('flex items-center gap-2 font-semibold', isLight ? 'text-slate-900' : 'text-white')}><ShieldCheck className="w-4 h-4 text-emerald-500" />
                    {result.findings.length === 0 ? 'Security checks: nothing found' : `Security checks: ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'}`}</p>
                  {result.findings.length > 0 && (
                    <ul className="mt-2 space-y-2">
                      {result.findings.map((f) => (
                        <li key={`${f.id}${f.title}`} className="flex gap-2">
                          <span className={clsx('mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase',
                            f.severity === 'high' ? 'bg-rose-500/15 text-rose-500' : f.severity === 'medium' ? 'bg-amber-500/15 text-amber-600' : 'bg-slate-500/15 text-slate-500')}>{f.severity}</span>
                          <span><span className="font-medium">{f.title}</span> <span className={muted}>({f.id}{f.file ? `, ${f.file}` : ''})</span><br /><span className={muted}>{f.detail} </span><span className="font-medium">Fix: </span><span className={muted}>{f.fix}</span></span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div className="flex flex-wrap gap-1.5" role="tablist">
                    {files.map((f) => (
                      <button key={f.path} type="button" role="tab" aria-selected={current?.path === f.path} onClick={() => setSelected(f.path)}
                        className={clsx('px-2.5 py-1 rounded-md border text-xs font-mono',
                          current?.path === f.path ? (isLight ? 'bg-slate-900 text-white border-slate-900' : 'bg-slate-100 text-slate-900 border-slate-100')
                            : (isLight ? 'bg-white border-slate-300 text-slate-700' : 'bg-slate-900 border-slate-700 text-slate-300'))}>
                        {f.path}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void copy()} className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs', isLight ? 'border-slate-300 text-slate-700 hover:bg-slate-50' : 'border-slate-700 text-slate-300 hover:bg-slate-800')}>
                      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}{copied ? 'Copied' : 'Copy'}
                    </button>
                    <button type="button" onClick={() => current && download(current.path.replace(/\//g, '_'), current.content, 'text/plain')} className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs', isLight ? 'border-slate-300 text-slate-700 hover:bg-slate-50' : 'border-slate-700 text-slate-300 hover:bg-slate-800')}>
                      <Download className="w-3.5 h-3.5" />File
                    </button>
                    <button type="button" onClick={() => download(`${cfg.appName}-docker.zip`, buildZip(files, cfg.appName) as BlobPart, 'application/zip')}
                      className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium', isLight ? 'bg-cyan-600 text-white' : 'bg-cyan-500/20 border border-cyan-400 text-cyan-200')}>
                      <Download className="w-3.5 h-3.5" />All as zip
                    </button>
                  </div>
                </div>
                <pre className={clsx('rounded-xl p-4 text-xs leading-relaxed overflow-auto max-h-[70vh] font-mono', isLight ? 'bg-slate-900 text-slate-100' : 'bg-slate-950 text-slate-200 border border-slate-800')}><code>{current?.content}</code></pre>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
