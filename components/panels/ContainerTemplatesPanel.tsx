'use client';
/**
 * Container Templates: pick a stack, configure the service in a form, preview every generated file (Dockerfile, compose, .env.example,
 * .dockerignore, README, nginx.conf) and download them as one zip or copy a single file. Nothing is sent to a server: the files are
 * produced in the browser by lib/engines/containers/dockerTemplates.ts, so what you see is what you download.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Copy, Download, Package, Plus, Trash2, AlertTriangle, Check, ShieldCheck, Save } from 'lucide-react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { takeContainerHandoff } from './containerHandoff';
import { nodeConfigFromContainerFor, nodeTypeForTarget } from '@/lib/engines/containers/nodeConfig';
import { getResourceDefinition } from '@/lib/resources';
import type { CanvasNode } from '@/types';
import {
  defaultConfig, deployTargets, DEPLOY_TARGET_LABEL, TARGET_CLOUD, generateContainerFiles, STACK_LABEL, STARTER_TEMPLATES, VERSIONS, withDeployTarget,
  type ContainerConfig, type ContainerStack, type DeployTarget, type EnvVar,
} from '@/lib/engines/containers/dockerTemplates';
import { buildZip } from '@/lib/engines/containers/zip';
import { withProjectRegion } from '@/lib/engines/containers/projectRegion';
import { pickStackOption } from '@/lib/engines/containers/stackOptions';
import {
  defaultProject, enabledLayers, generateProjectFiles, LAYER_LABEL, layerOf, mapLayerConfigs, projectFromConfig, type Layer, type StackProject,
} from '@/lib/engines/containers/stackProject';
import StackLayers from './StackLayers';
import { applyDatabase, databaseOf, DB_TARGETS } from '@/lib/engines/containers/databases';
import { FARGATE_CPU, fargateMemoryOptions } from '@/lib/engines/containers/ecsDeploy';
import { ACA_CPU } from '@/lib/engines/containers/containerAppsDeploy';
import { SOFTWARE } from '@/lib/engines/servers/software';

const newNodeId = () => `node-${Date.now()}`;

/** "Install on the server": software put on the virtual machine itself at first boot, next to the container. Docker is left out: it is always installed. */
function SoftwarePicker({ id, value, pageText, onChange, onPageText, inputClass, labelClass }: {
  id: string; value: string[]; pageText: string; onChange: (v: string[]) => void; onPageText: (v: string) => void; inputClass: string; labelClass: string;
}) {
  const web = value.some((v) => v === 'nginx' || v === 'apache');
  const toggle = (sid: string, on: boolean) => { const rest = value.filter((v) => v !== sid); onChange(on ? [...rest, sid] : rest); };
  return (
    <fieldset className="col-span-2 space-y-1">
      <legend className={labelClass}>Install on the server</legend>
      <p className="text-xs opacity-70">Put software on the machine itself the first time it starts (the app keeps running in its container). A web server opens ports 80 and 443 to the same range as the app port.</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {SOFTWARE.filter((s) => s.id !== 'docker').map((s) => (
          <label key={s.id} className="flex items-center gap-2 text-xs" title={s.description}>
            <input type="checkbox" checked={value.includes(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} aria-label={`Install ${s.label}`} />{s.label}
          </label>
        ))}
      </div>
      {web && <div><label className={labelClass} htmlFor={`${id}-page`}>Start page text (optional)</label><input id={`${id}-page`} className={inputClass} maxLength={200} value={pageText} onChange={(e) => onPageText(e.target.value)} /></div>}
    </fieldset>
  );
}

interface Saved { id: string; name: string; config: ContainerConfig; updatedAt: string }
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? 'Could not reach the server');
  return body.data as T;
}

export default function ContainerTemplatesPanel() {
  const { state, dispatch } = useApp();
  const project = useActiveProject();
  const isLight = state.theme === 'light';
  // The region chosen for the project fills the matching cloud's region here, now and whenever it changes.
  const projectRegion = project ? (project.environments?.[state.activeEnvironment]?.region ?? project.region) : undefined;
  const projectProvider = project?.provider;
  // The Stack: up to four services (Frontend, Backend, API, Database), each optional. `cfg` below is the one whose settings the form shows.
  const [stack, setStack] = useState<StackProject>(() => mapLayerConfigs(defaultProject(), (c) => withProjectRegion(c, projectProvider, projectRegion)));
  const [activeLayer, setActiveLayer] = useState<Layer>('backend');
  const cfg = stack.layers[activeLayer].config;
  const setCfg = useCallback((u: ContainerConfig | ((c: ContainerConfig) => ContainerConfig)) => setStack((s) => {
    const cur = s.layers[activeLayer];
    return { ...s, layers: { ...s.layers, [activeLayer]: { ...cur, config: typeof u === 'function' ? u(cur.config) : u } } };
  }), [activeLayer]);
  /** A whole single-service configuration (a starter, a saved template, one sent from the canvas): it becomes a project of just that service. */
  const loadConfig = (c: ContainerConfig) => { setStack((s) => projectFromConfig(c, s)); setActiveLayer(layerOf(c)); };
  const lastRegion = useRef(projectRegion);
  useEffect(() => {
    if (lastRegion.current === projectRegion) return;
    lastRegion.current = projectRegion;
    setStack((s) => mapLayerConfigs(s, (c) => withProjectRegion(c, projectProvider, projectRegion)));
  }, [projectRegion, projectProvider]);
  const multi = enabledLayers(stack).length > 1;
  const toggleLayer = (layer: Layer, on: boolean) => {
    const next = { ...stack, layers: { ...stack.layers, [layer]: { ...stack.layers[layer], enabled: on } } };
    setStack(next);
    if (on) setActiveLayer(layer);
    else if (activeLayer === layer) setActiveLayer(enabledLayers(next)[0] ?? layer);
    setSelected('README.md');
  };
  const pickLayer = (layer: Layer, optionId: string) => {
    setStack((s) => ({ ...s, layers: { ...s.layers, [layer]: { ...s.layers[layer], config: pickStackOption(s.layers[layer].config, optionId) } } }));
    setActiveLayer(layer);
  };
  const [selected, setSelected] = useState('Dockerfile');
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<Saved[] | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');
  const [busy, setBusy] = useState(false);
  const [starterCloud, setStarterCloud] = useState<'aws' | 'azure'>('aws');
  /** The cloud chip also moves a form that already has a deployment: without this the files and the cost below kept showing the old target. */
  function chooseStarterCloud(cl: 'aws' | 'azure') {
    setStarterCloud(cl);
    // A database goes to a virtual machine of that cloud (it cannot go to Container Apps); an application to EC2 or Container Apps.
    setCfg((c) => (deployTargets(c).length > 0 ? withDeployTarget(c, databaseOf(c) ? (cl === 'azure' ? 'azure-vm' : 'ec2') : (cl === 'azure' ? 'container-apps' : 'ec2')) : c));
    setSelected('README.md');
  }
  const [linkedNode, setLinkedNode] = useState<string | null>(null);
  const [canvasNote, setCanvasNote] = useState<string | null>(null);

  // A configuration sent here from a Container service node on the canvas.
  useEffect(() => {
    const h = takeContainerHandoff();
    if (h) { loadConfig(h.config); setLinkedNode(h.nodeId ?? null); setSelected('README.md'); }
  }, []);
  const linked = linkedNode ? project?.nodes.find((n) => n.id === linkedNode) : undefined;

  function addToArchitecture() {
    if (!project) { setCanvasNote('Open or create a project first, then come back.'); return; }
    if (multi) { setCanvasNote('A project of several services is not added to the canvas yet. Untick all but one service to add that one, or download the files.'); return; }
    if (dbEngine) { setCanvasNote('A database is not added to the canvas from here: its data volume and passwords are handled by the generated files. Download them, or add an Amazon RDS or Azure Database resource to the architecture.'); return; }
    const res = generateContainerFiles(cfg);
    if (!res.ok) { setCanvasNote('Fix the errors above first.'); return; }
    const type = nodeTypeForTarget(target);
    if (!type) {
      setCanvasNote(target === 'none' ? 'Pick where to deploy (EC2, Azure VM or Container Apps) to add a matching resource.' : `${DEPLOY_TARGET_LABEL[target]} has no single canvas resource: draw it with the cluster resources (ECS, AKS, EKS) instead.`);
      return;
    }
    const def = getResourceDefinition(type);
    if (linked && linked.resourceType === type) {
      dispatch({ type: 'UPDATE_NODE_CONFIG', nodeId: linked.id, config: { ...linked.config, ...nodeConfigFromContainerFor(type, cfg, linked.config) }, label: cfg.appName });
      setCanvasNote(`Updated "${cfg.appName}" on the canvas.`);
      return;
    }
    const id = newNodeId();
    const maxY = project.nodes.reduce((m, n) => Math.max(m, n.position.y + (n.height ?? 100)), 0);
    const node: CanvasNode = {
      id, type: 'cloudNode', resourceType: type, provider: type.startsWith('azure_') ? 'azure' : 'aws', label: cfg.appName, position: { x: 80, y: maxY + 60 },
      config: { ...(def?.defaultConfig ?? {}), ...nodeConfigFromContainerFor(type, cfg) }, width: 180, height: 100,
    };
    dispatch({ type: 'UPDATE_CANVAS', nodes: [...project.nodes, node], edges: project.edges, bumpCanvasKey: true });
    setLinkedNode(id);
    setCanvasNote(`Added "${cfg.appName}" to the architecture. Drag it into a subnet to place it in your network.`);
  }

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

  const result = useMemo(() => generateProjectFiles(stack), [stack]);
  const set = <K extends keyof ContainerConfig>(k: K, v: ContainerConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const dbEngine = databaseOf(cfg);
  const setEc2 = <K extends keyof ContainerConfig['ec2']>(k: K, v: ContainerConfig['ec2'][K]) => setCfg((c) => ({ ...c, ec2: { ...c.ec2, [k]: v } }));
  const setEcs = <K extends keyof ContainerConfig['ecs']>(k: K, v: ContainerConfig['ecs'][K]) => setCfg((c) => ({ ...c, ecs: { ...c.ecs, [k]: v } }));
  const setAca = <K extends keyof ContainerConfig['aca']>(k: K, v: ContainerConfig['aca'][K]) => setCfg((c) => ({ ...c, aca: { ...c.aca, [k]: v } }));
  const setAzvm = <K extends keyof ContainerConfig['azvm']>(k: K, v: ContainerConfig['azvm'][K]) => setCfg((c) => ({ ...c, azvm: { ...c.azvm, [k]: v } }));
  const setAks = <K extends keyof ContainerConfig['aks']>(k: K, v: ContainerConfig['aks'][K]) => setCfg((c) => ({ ...c, aks: { ...c.aks, [k]: v } }));
  const setK8s = <K extends keyof ContainerConfig['k8s']>(k: K, v: ContainerConfig['k8s'][K]) => setCfg((c) => ({ ...c, k8s: { ...c.k8s, [k]: v } }));
  const target = (deployTargets(cfg)[0] ?? 'none') as DeployTarget;
  const ex = cfg.image !== '';
  /** The fields that describe how an application is built: not for a ready-made image and not for a database. */
  const buildForm = !ex && !dbEngine;
  const setTarget = (t: DeployTarget) => setCfg((c) => withDeployTarget(c, t));
  const setEnv = (i: number, patch: Partial<EnvVar>) => setCfg((c) => ({ ...c, env: c.env.map((v, j) => (j === i ? { ...v, ...patch } : v)) }));

  const zipName = multi ? stack.name : cfg.appName;
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
          <p className={clsx('text-xs mb-2', muted)}>Each one includes a small working app and a deployment, so <code>bash deploy.sh</code> runs it end to end. You can change everything below afterwards.</p>
          <div className="flex items-center gap-2 mb-3 text-xs" role="group" aria-label="Cloud for the starter">
            <span className={muted}>Deploys to</span>
            {(['aws', 'azure'] as const).map((cl) => (
              <button key={cl} type="button" aria-pressed={starterCloud === cl} onClick={() => chooseStarterCloud(cl)}
                className={clsx('px-2.5 py-1 rounded-md border font-medium', starterCloud === cl ? (isLight ? 'bg-cyan-600 border-cyan-600 text-white' : 'bg-cyan-500/20 border-cyan-400 text-cyan-200') : (isLight ? 'bg-white border-slate-300 text-slate-700' : 'bg-slate-900 border-slate-700 text-slate-300'))}>
                {cl === 'aws' ? 'AWS (EC2)' : 'Azure (Container Apps)'}
              </button>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {STARTER_TEMPLATES.map((t) => (
              <button key={t.id} type="button" onClick={() => { loadConfig(withProjectRegion(t.config(starterCloud === 'azure' ? 'container-apps' : 'ec2'), projectProvider, projectRegion)); setLoadedId(null); setSelected('README.md'); }}
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
                    <button type="button" className="text-cyan-600 font-medium" onClick={() => { loadConfig(t.config); setLoadedId(t.id); setSaveName(''); setSelected('README.md'); }}>Open</button>
                    <button type="button" disabled={busy} className="text-rose-500" onClick={() => void removeSaved(t.id)}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Template name" placeholder={loadedId ? 'Keep the name or type a new one' : 'Name this configuration'} className={clsx(input, 'max-w-xs')} maxLength={80} value={saveName} onChange={(e) => setSaveName(e.target.value)} />
            {loadedId && <button type="button" disabled={busy || multi} onClick={() => void saveCurrent(false)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-cyan-600 text-white disabled:opacity-50"><Save className="w-3.5 h-3.5" />Update this template</button>}
            <button type="button" disabled={busy || !result.ok || multi} title={multi ? 'Saving a project of several services is not available yet' : undefined} onClick={() => void saveCurrent(true)} className={clsx('flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium disabled:opacity-50', isLight ? 'border-slate-300 text-slate-700' : 'border-slate-600 text-slate-200')}><Save className="w-3.5 h-3.5" />Save as new</button>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          {/* ── form ── */}
          <div className="space-y-4">
            <div className={card}>
              <StackLayers stack={stack} active={activeLayer} onToggle={toggleLayer} onPick={pickLayer} onActive={setActiveLayer} onName={(name) => setStack((st) => ({ ...st, name }))} />
            </div>

            {!dbEngine && (
            <div className={clsx(card, 'space-y-2')}>
              <label className={label} htmlFor="ct-source">Where does the image come from?</label>
              <select id="ct-source" className={input} value={ex ? 'existing' : 'build'} onChange={(e) => set('image', e.target.value === 'existing' ? (cfg.image || 'nginx:1.27') : '')}>
                <option value="build">Build it from my source code</option>
                <option value="existing">Use an image that already exists</option>
              </select>
              {ex ? (
                <>
                  <label className={label} htmlFor="ct-image">Image</label>
                  <input id="ct-image" className={clsx(input, 'font-mono')} placeholder="nginx:1.27 or ghcr.io/yourname/yourapp:1.0" value={cfg.image} onChange={(e) => set('image', e.target.value.trim())} />
                  <p className={clsx('text-[11px]', muted)}>A public image, named like Docker names it. Nothing is built: the server or container service pulls and runs it as it is. Images in a private AWS (ECR) or Azure (ACR) registry are not supported here.</p>
                </>
              ) : (
                <p className={clsx('text-[11px]', muted)}>CloudCraft writes the Dockerfile, builds the image and, with a deployment target, pushes it to a registry it creates for you.</p>
              )}
            </div>
            )}
            <div className={clsx(card, 'space-y-3')}>
              {multi && <p className="text-sm font-semibold" data-testid="editing-layer">Settings for the {LAYER_LABEL[activeLayer]}</p>}
              <div className="grid grid-cols-2 gap-3">
                {!multi && <div className="col-span-2"><label className={label} htmlFor="ct-name">App name</label><input id="ct-name" className={input} value={cfg.appName} onChange={(e) => set('appName', e.target.value)} /></div>}
                <div><label className={label} htmlFor="ct-port">Port</label><input id="ct-port" type="number" className={input} value={cfg.port} disabled={!!dbEngine} onChange={(e) => set('port', Number(e.target.value))} /></div>
                {dbEngine && (
                <div><label className={label} htmlFor="ct-version">{dbEngine.label} version</label>
                  <select id="ct-version" className={input} value={cfg.version} onChange={(e) => setCfg((c) => applyDatabase(c, dbEngine.id, e.target.value))}>{dbEngine.versions.map((v) => <option key={v}>{v}</option>)}</select></div>
                )}
                {buildForm && (
                <div><label className={label} htmlFor="ct-version">{cfg.stack === 'static' ? 'nginx version' : 'Version'}</label>
                  <select id="ct-version" className={input} value={cfg.version} onChange={(e) => set('version', e.target.value)}>{VERSIONS[cfg.stack].map((v) => <option key={v}>{v}</option>)}</select></div>
                )}
                {!dbEngine && <div className="col-span-2"><label className={label} htmlFor="ct-health">Health check path</label><input id="ct-health" className={input} value={cfg.healthPath} onChange={(e) => set('healthPath', e.target.value)} /></div>}
              </div>

              {!ex && (<>
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
              {cfg.stack === 'go' && (
                <div><label className={label} htmlFor="ct-gopkg">Main package</label><input id="ct-gopkg" className={input} placeholder="." value={cfg.goPackage} onChange={(e) => set('goPackage', e.target.value.trim())} />
                  <p className={clsx('text-[11px] mt-1', muted)}>&quot;.&quot; or a folder such as ./cmd/server. The program should listen on the PORT variable.</p></div>
              )}
              {cfg.stack === 'dotnet' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2"><label className={label} htmlFor="ct-csproj">Project file</label><input id="ct-csproj" className={input} placeholder="src/App/App.csproj" value={cfg.dotnetProject} onChange={(e) => set('dotnetProject', e.target.value.trim())} /></div>
                  <div className="col-span-2"><label className={label} htmlFor="ct-asm">Assembly name</label><input id="ct-asm" className={input} value={cfg.dotnetAssembly} onChange={(e) => set('dotnetAssembly', e.target.value.trim())} />
                    <p className={clsx('text-[11px] mt-1', muted)}>The .dll that is run: the project&apos;s AssemblyName.</p></div>
                </div>
              )}
              {cfg.stack === 'ruby' && (
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label} htmlFor="ct-rb">Framework</label>
                    <select id="ct-rb" className={input} value={cfg.rubyFramework} onChange={(e) => set('rubyFramework', e.target.value as ContainerConfig['rubyFramework'])}><option value="rack">Rack / Sinatra (config.ru)</option><option value="rails">Rails</option><option value="other">Other</option></select></div>
                  {cfg.rubyFramework === 'other' && <div><label className={label} htmlFor="ct-rbstart">Start command</label><input id="ct-rbstart" className={input} value={cfg.startCommand} onChange={(e) => set('startCommand', e.target.value)} /></div>}
                </div>
              )}
              {cfg.stack === 'static' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2"><label className={label} htmlFor="ct-sbuild">Build command</label><input id="ct-sbuild" className={input} value={cfg.buildCommand} onChange={(e) => set('buildCommand', e.target.value)} /></div>
                  <div><label className={label} htmlFor="ct-dir">Build output folder</label><input id="ct-dir" className={input} value={cfg.staticBuildDir} onChange={(e) => set('staticBuildDir', e.target.value)} /></div>
                  <label className="flex items-end gap-2 text-xs pb-2"><input type="checkbox" checked={cfg.staticSpaFallback} onChange={(e) => set('staticSpaFallback', e.target.checked)} />Single-page app routing</label>
                </div>
              )}
              </>)}
            </div>

            <div className={clsx(card, 'space-y-3')}>
              <p className={clsx('text-sm font-semibold', isLight ? 'text-slate-900' : 'text-white')}>Server settings</p>
              <div className="grid grid-cols-3 gap-3">
                <div><label className={label} htmlFor="ct-mem">Memory</label><input id="ct-mem" className={input} value={cfg.memoryLimit} onChange={(e) => set('memoryLimit', e.target.value)} /></div>
                <div><label className={label} htmlFor="ct-cpu">CPUs</label><input id="ct-cpu" className={input} value={cfg.cpuLimit} onChange={(e) => set('cpuLimit', e.target.value)} /></div>
                <div><label className={label} htmlFor="ct-restart">Restart</label>
                  <select id="ct-restart" className={input} value={cfg.restart} onChange={(e) => set('restart', e.target.value as ContainerConfig['restart'])}><option>unless-stopped</option><option>always</option><option>on-failure</option><option>no</option></select></div>
              </div>
              {cfg.proxy && !multi && (
                <div><label className={label} htmlFor="ct-domain">Domain for HTTPS</label><input id="ct-domain" className={input} placeholder="app.example.com or localhost" value={cfg.proxyDomain} onChange={(e) => set('proxyDomain', e.target.value.trim())} />
                  <p className={clsx('text-[11px] mt-1', muted)}>A real domain gets a free Let&apos;s Encrypt certificate (its DNS must point at the machine). &quot;localhost&quot; gets a local one. Used by docker-compose.yml only.</p></div>
              )}
              <div className="flex flex-wrap gap-4 text-xs">
                {buildForm && cfg.stack !== 'static' && <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.runAsNonRoot} onChange={(e) => set('runAsNonRoot', e.target.checked)} />Run as non-root (recommended)</label>}
                {!dbEngine && !multi && (<>
                <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.postgres} onChange={(e) => set('postgres', e.target.checked)} />Add PostgreSQL</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.redis} onChange={(e) => set('redis', e.target.checked)} />Add Redis</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.mysql} onChange={(e) => set('mysql', e.target.checked)} />Add MySQL</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.mongodb} onChange={(e) => set('mongodb', e.target.checked)} />Add MongoDB</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.rabbitmq} onChange={(e) => set('rabbitmq', e.target.checked)} />Add RabbitMQ</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.proxy} onChange={(e) => set('proxy', e.target.checked)} />HTTPS reverse proxy (Caddy)</label>
                </>)}
                {!ex && (
                <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.includeSample} onChange={(e) => set('includeSample', e.target.checked)} />Include a sample app</label>
                )}
              </div>
            </div>

            {multi && (
              <div className={clsx(card, 'text-xs space-y-1')} data-testid="project-run-note">
                <p className={clsx('text-sm font-semibold', isLight ? 'text-slate-900' : 'text-white')}>Run it</p>
                <p className={muted}>The services are built and started together: <code>docker compose up --build</code> in the folder you download. Deploying a combined project to a server is not available yet; untick all but one service to get a deployment for it.</p>
              </div>
            )}
            {!multi && (
            <div className={clsx(card, 'space-y-3')}>
              <label className={label} htmlFor="ct-target">Deploy to</label>
              <select id="ct-target" className={input} value={target} onChange={(e) => setTarget(e.target.value as DeployTarget)}>
                <option value="none">{DEPLOY_TARGET_LABEL.none}</option>
                {([['aws', 'AWS'], ['azure', 'Azure'], ['any', 'Any cluster']] as const).map(([cloud, name]) => (
                  <optgroup key={cloud} label={name}>
                    {(Object.keys(DEPLOY_TARGET_LABEL) as DeployTarget[]).filter((t) => TARGET_CLOUD[t] === cloud && (!dbEngine || DB_TARGETS.has(t))).map((t) => <option key={t} value={t}>{DEPLOY_TARGET_LABEL[t]}</option>)}
                  </optgroup>
                ))}
              </select>
              {target === 'none' && <p className={clsx('text-xs', muted)}>Just the Dockerfile and compose files. Pick a place to also get <code>deploy.sh</code>, <code>destroy.sh</code>, the infrastructure code and a GitHub Actions workflow.</p>}
              {target === 'ec2' && <p className={clsx('text-xs', muted)}>One server. Adds <code>deploy.sh</code> (one command to create the server, push the image and start the app), <code>destroy.sh</code>, and the Terraform behind them. No SSH: you connect through Session Manager. Secrets are read from SSM Parameter Store, never written to Terraform.</p>}
              {target === 'ecs' && <p className={clsx('text-xs', muted)}>No servers to look after. Fargate runs your containers behind a load balancer, with rolling updates, automatic rollback and optional autoscaling. Secrets come from SSM Parameter Store.</p>}
              {target === 'azure-vm' && <p className={clsx('text-xs', muted)}>One Azure VM running your container under systemd, with a container registry and a Key Vault for secrets. No SSH and no registry password: it uses a managed identity. The image is built inside Azure.</p>}
              {target === 'aks' && <p className={clsx('text-xs', muted)}>An AKS cluster with its own container registry, plus the hardened Kubernetes manifests and Helm chart. The image is built inside Azure and pulled with the cluster&apos;s identity.</p>}
              {target === 'container-apps' && <p className={clsx('text-xs', muted)}>Azure runs your containers with HTTPS, scaling (down to zero if you like) and health probes. The image is built inside Azure, so you do not need Docker locally.</p>}
              {target === 'kubernetes' && <p className={clsx('text-xs', muted)}>Manifests (Kustomize) and an optional Helm chart for any cluster: EKS, AKS, GKE, k3s. Hardened pods, health probes, rolling updates, optional ingress and autoscaling.</p>}
              {target === 'ec2' && (
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label} htmlFor="ec2-region">Region</label><input id="ec2-region" className={input} value={cfg.ec2.region} onChange={(e) => setEc2('region', e.target.value)} /></div>
                  <div><label className={label} htmlFor="ec2-type">Instance type</label><input id="ec2-type" className={input} value={cfg.ec2.instanceType} onChange={(e) => setEc2('instanceType', e.target.value)} /></div>
                  <div className="col-span-2"><label className={label} htmlFor="ec2-cidr">{dbEngine ? 'Who can connect to the database (not the whole internet)' : 'Who can connect to the app port'}</label><input id="ec2-cidr" className={input} value={cfg.ec2.allowedCidr} onChange={(e) => setEc2('allowedCidr', e.target.value)} /></div>
                  <div><label className={label} htmlFor="ec2-disk">Disk (GB)</label><input id="ec2-disk" type="number" className={input} value={cfg.ec2.volumeGb} onChange={(e) => setEc2('volumeGb', Number(e.target.value))} /></div>
                  {!ex && (
                  <div><label className={label} htmlFor="ec2-tag">Image tag</label><input id="ec2-tag" className={input} value={cfg.ec2.imageTag} onChange={(e) => setEc2('imageTag', e.target.value)} /></div>
                  )}
                  <SoftwarePicker id="ec2-sw" value={cfg.ec2.software ?? []} pageText={cfg.ec2.pageText ?? ''} onChange={(v) => setEc2('software', v)} onPageText={(v) => setEc2('pageText', v)} inputClass={input} labelClass={label} />
                  <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={cfg.ec2.elasticIp} onChange={(e) => setEc2('elasticIp', e.target.checked)} />Fixed public IP</label>
                  {!ex && (<>
                  <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={cfg.ec2.githubActions} onChange={(e) => setEc2('githubActions', e.target.checked)} />GitHub Actions workflow</label>
                  {cfg.ec2.githubActions && <label className="flex items-center gap-2 text-xs col-span-2"><input type="checkbox" checked={cfg.ec2.scanImage} onChange={(e) => setEc2('scanImage', e.target.checked)} />Scan the image for vulnerabilities before pushing (Trivy)</label>}
                  {cfg.ec2.githubActions && (
                    <div className="col-span-2"><label className={label} htmlFor="ec2-gh">GitHub repository (optional, owner/name)</label>
                      <input id="ec2-gh" className={input} placeholder="yourname/yourapp" value={cfg.ec2.githubRepo} onChange={(e) => setEc2('githubRepo', e.target.value.trim())} />
                      <p className={clsx('text-[11px] mt-1', muted)}>If set, Terraform also creates the AWS role the workflow signs in with, so you only paste one value into GitHub.</p></div>
                  )}
                  </>)}
                </div>
              )}
              {target === 'ecs' && (
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label} htmlFor="ecs-region">Region</label><input id="ecs-region" className={input} value={cfg.ecs.region} onChange={(e) => setEcs('region', e.target.value)} /></div>
                  <div><label className={label} htmlFor="ecs-count">Tasks</label><input id="ecs-count" type="number" className={input} value={cfg.ecs.desiredCount} onChange={(e) => setEcs('desiredCount', Number(e.target.value))} /></div>
                  <div><label className={label} htmlFor="ecs-cpu">CPU units</label>
                    <select id="ecs-cpu" className={input} value={cfg.ecs.cpu} onChange={(e) => { const cpu = Number(e.target.value); setCfg((c) => ({ ...c, ecs: { ...c.ecs, cpu, memoryMb: fargateMemoryOptions(cpu).includes(c.ecs.memoryMb) ? c.ecs.memoryMb : fargateMemoryOptions(cpu)[0]! } })); }}>
                      {FARGATE_CPU.map((n) => <option key={n} value={n}>{n} ({n / 1024} vCPU)</option>)}</select></div>
                  <div><label className={label} htmlFor="ecs-mem">Task memory</label>
                    <select id="ecs-mem" className={input} value={cfg.ecs.memoryMb} onChange={(e) => setEcs('memoryMb', Number(e.target.value))}>
                      {fargateMemoryOptions(cfg.ecs.cpu).map((n) => <option key={n} value={n}>{n / 1024} GB</option>)}</select></div>
                  <label className="flex items-center gap-2 text-xs col-span-2"><input type="checkbox" checked={cfg.ecs.autoscaling} onChange={(e) => setEcs('autoscaling', e.target.checked)} />Autoscale on CPU</label>
                  {cfg.ecs.autoscaling && (<>
                    <div><label className={label} htmlFor="ecs-min">Minimum tasks</label><input id="ecs-min" type="number" className={input} value={cfg.ecs.minCount} onChange={(e) => setEcs('minCount', Number(e.target.value))} /></div>
                    <div><label className={label} htmlFor="ecs-max">Maximum tasks</label><input id="ecs-max" type="number" className={input} value={cfg.ecs.maxCount} onChange={(e) => setEcs('maxCount', Number(e.target.value))} /></div>
                  </>)}
                  <div className="col-span-2"><label className={label} htmlFor="ecs-cidr">Who can connect to the load balancer</label><input id="ecs-cidr" className={input} value={cfg.ecs.allowedCidr} onChange={(e) => setEcs('allowedCidr', e.target.value)} /></div>
                  <div className="col-span-2"><label className={label} htmlFor="ecs-cert">ACM certificate ARN (optional, enables HTTPS)</label><input id="ecs-cert" className={input} placeholder="arn:aws:acm:us-east-1:123456789012:certificate/..." value={cfg.ecs.certificateArn} onChange={(e) => setEcs('certificateArn', e.target.value.trim())} /></div>
                  {!ex && (<>
                  <div><label className={label} htmlFor="ecs-tag">Image tag</label><input id="ecs-tag" className={input} value={cfg.ecs.imageTag} onChange={(e) => setEcs('imageTag', e.target.value)} /></div>
                  <label className="flex items-end gap-2 text-xs pb-2"><input type="checkbox" checked={cfg.ecs.githubActions} onChange={(e) => setEcs('githubActions', e.target.checked)} />GitHub Actions workflow</label>
                  {cfg.ecs.githubActions && (<>
                    <label className="flex items-center gap-2 text-xs col-span-2"><input type="checkbox" checked={cfg.ecs.scanImage} onChange={(e) => setEcs('scanImage', e.target.checked)} />Scan the image for vulnerabilities before pushing (Trivy)</label>
                    <div className="col-span-2"><label className={label} htmlFor="ecs-gh">GitHub repository (optional, owner/name)</label><input id="ecs-gh" className={input} placeholder="yourname/yourapp" value={cfg.ecs.githubRepo} onChange={(e) => setEcs('githubRepo', e.target.value.trim())} /></div>
                  </>)}
                  </>)}
                </div>
              )}
              {target === 'container-apps' && (
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label} htmlFor="aca-loc">Azure region</label><input id="aca-loc" className={input} value={cfg.aca.location} onChange={(e) => setAca('location', e.target.value)} /></div>
                  <div><label className={label} htmlFor="aca-cpu">CPU per replica</label>
                    <select id="aca-cpu" className={input} value={cfg.aca.cpu} onChange={(e) => setAca('cpu', Number(e.target.value))}>{ACA_CPU.map((n) => <option key={n} value={n}>{n} vCPU, {n * 2} GiB</option>)}</select></div>
                  <div><label className={label} htmlFor="aca-min">Minimum replicas</label><input id="aca-min" type="number" className={input} value={cfg.aca.minReplicas} onChange={(e) => setAca('minReplicas', Number(e.target.value))} /></div>
                  <div><label className={label} htmlFor="aca-max">Maximum replicas</label><input id="aca-max" type="number" className={input} value={cfg.aca.maxReplicas} onChange={(e) => setAca('maxReplicas', Number(e.target.value))} /></div>
                  <div><label className={label} htmlFor="aca-conc">Requests per replica</label><input id="aca-conc" type="number" className={input} value={cfg.aca.concurrentRequests} onChange={(e) => setAca('concurrentRequests', Number(e.target.value))} /></div>
                  <label className="flex items-end gap-2 text-xs pb-2"><input type="checkbox" checked={cfg.aca.externalIngress} onChange={(e) => setAca('externalIngress', e.target.checked)} />Reachable from the internet</label>
                  {cfg.aca.externalIngress && <div className="col-span-2"><label className={label} htmlFor="aca-cidr">Who can connect</label><input id="aca-cidr" className={input} value={cfg.aca.allowedCidr} onChange={(e) => setAca('allowedCidr', e.target.value)} /></div>}
                  {!ex && (<>
                  <div><label className={label} htmlFor="aca-tag">Image tag</label><input id="aca-tag" className={input} value={cfg.aca.imageTag} onChange={(e) => setAca('imageTag', e.target.value)} /></div>
                  <label className="flex items-end gap-2 text-xs pb-2"><input type="checkbox" checked={cfg.aca.githubActions} onChange={(e) => setAca('githubActions', e.target.checked)} />GitHub Actions workflow</label>
                  {cfg.aca.githubActions && (<>
                    <label className="flex items-center gap-2 text-xs col-span-2"><input type="checkbox" checked={cfg.aca.scanImage} onChange={(e) => setAca('scanImage', e.target.checked)} />Scan the image for vulnerabilities before pushing (Trivy)</label>
                    <div className="col-span-2"><label className={label} htmlFor="aca-gh">GitHub repository (optional, owner/name, used in the setup steps)</label><input id="aca-gh" className={input} placeholder="yourname/yourapp" value={cfg.aca.githubRepo} onChange={(e) => setAca('githubRepo', e.target.value.trim())} /></div>
                  </>)}
                  </>)}
                </div>
              )}
              {target === 'azure-vm' && (
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label} htmlFor="azvm-loc">Azure region</label><input id="azvm-loc" className={input} value={cfg.azvm.location} onChange={(e) => setAzvm('location', e.target.value)} /></div>
                  <div><label className={label} htmlFor="azvm-size">VM size</label><input id="azvm-size" className={input} value={cfg.azvm.size} onChange={(e) => setAzvm('size', e.target.value)} /></div>
                  <div><label className={label} htmlFor="azvm-disk">Disk (GB)</label><input id="azvm-disk" type="number" className={input} value={cfg.azvm.diskGb} onChange={(e) => setAzvm('diskGb', Number(e.target.value))} /></div>
                  {!ex && (
                  <div><label className={label} htmlFor="azvm-tag">Image tag</label><input id="azvm-tag" className={input} value={cfg.azvm.imageTag} onChange={(e) => setAzvm('imageTag', e.target.value)} /></div>
                  )}
                  <div className="col-span-2"><label className={label} htmlFor="azvm-cidr">{dbEngine ? 'Who can connect to the database (not the whole internet)' : 'Who can connect to the app port'}</label><input id="azvm-cidr" className={input} value={cfg.azvm.allowedCidr} onChange={(e) => setAzvm('allowedCidr', e.target.value)} /></div>
                  {!ex && (<>
                  <SoftwarePicker id="azvm-sw" value={cfg.azvm.software ?? []} pageText={cfg.azvm.pageText ?? ''} onChange={(v) => setAzvm('software', v)} onPageText={(v) => setAzvm('pageText', v)} inputClass={input} labelClass={label} />
                  <label className="flex items-center gap-2 text-xs col-span-2"><input type="checkbox" checked={cfg.azvm.githubActions} onChange={(e) => setAzvm('githubActions', e.target.checked)} />GitHub Actions workflow</label>
                  {cfg.azvm.githubActions && (<>
                    <label className="flex items-center gap-2 text-xs col-span-2"><input type="checkbox" checked={cfg.azvm.scanImage} onChange={(e) => setAzvm('scanImage', e.target.checked)} />Scan the image for vulnerabilities before pushing (Trivy)</label>
                    <div className="col-span-2"><label className={label} htmlFor="azvm-gh">GitHub repository (optional, owner/name, used in the setup steps)</label><input id="azvm-gh" className={input} placeholder="yourname/yourapp" value={cfg.azvm.githubRepo} onChange={(e) => setAzvm('githubRepo', e.target.value.trim())} /></div>
                  </>)}
                  </>)}
                </div>
              )}
              {target === 'aks' && (
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={label} htmlFor="aks-loc">Azure region</label><input id="aks-loc" className={input} value={cfg.aks.location} onChange={(e) => setAks('location', e.target.value)} /></div>
                  <div><label className={label} htmlFor="aks-size">Node size</label><input id="aks-size" className={input} value={cfg.aks.nodeSize} onChange={(e) => setAks('nodeSize', e.target.value)} /></div>
                  <div><label className={label} htmlFor="aks-min">Minimum nodes</label><input id="aks-min" type="number" className={input} value={cfg.aks.minNodes} onChange={(e) => setAks('minNodes', Number(e.target.value))} /></div>
                  <div><label className={label} htmlFor="aks-max">Maximum nodes</label><input id="aks-max" type="number" className={input} value={cfg.aks.maxNodes} onChange={(e) => setAks('maxNodes', Number(e.target.value))} /></div>
                  {!ex && (
                  <div><label className={label} htmlFor="aks-tag">Image tag</label><input id="aks-tag" className={input} value={cfg.aks.imageTag} onChange={(e) => setAks('imageTag', e.target.value)} /></div>
                  )}
                  <div><label className={label} htmlFor="aks-ns">Namespace</label><input id="aks-ns" className={input} value={cfg.k8s.namespace} onChange={(e) => setK8s('namespace', e.target.value)} /></div>
                  <div><label className={label} htmlFor="aks-rep">Replicas</label><input id="aks-rep" type="number" className={input} value={cfg.k8s.replicas} onChange={(e) => setK8s('replicas', Number(e.target.value))} /></div>
                  <div><label className={label} htmlFor="aks-svc">Service type</label>
                    <select id="aks-svc" className={input} value={cfg.k8s.serviceType} onChange={(e) => setK8s('serviceType', e.target.value as ContainerConfig['k8s']['serviceType'])}><option>ClusterIP</option><option>LoadBalancer</option></select></div>
                  <div className="col-span-2"><label className={label} htmlFor="aks-host">Ingress host (optional, turns on the managed ingress controller)</label><input id="aks-host" className={input} placeholder="app.example.com" value={cfg.k8s.ingressHost} onChange={(e) => setK8s('ingressHost', e.target.value.trim())} /></div>
                  <label className="flex items-center gap-2 text-xs col-span-2"><input type="checkbox" checked={cfg.k8s.autoscaling} onChange={(e) => setK8s('autoscaling', e.target.checked)} />Autoscale pods on CPU</label>
                  {cfg.k8s.autoscaling && (<>
                    <div><label className={label} htmlFor="aks-pmin">Minimum pods</label><input id="aks-pmin" type="number" className={input} value={cfg.k8s.minReplicas} onChange={(e) => setK8s('minReplicas', Number(e.target.value))} /></div>
                    <div><label className={label} htmlFor="aks-pmax">Maximum pods</label><input id="aks-pmax" type="number" className={input} value={cfg.k8s.maxReplicas} onChange={(e) => setK8s('maxReplicas', Number(e.target.value))} /></div>
                  </>)}
                  <label className="flex items-center gap-2 text-xs col-span-2"><input type="checkbox" checked={cfg.k8s.helm} onChange={(e) => setK8s('helm', e.target.checked)} />Also generate a Helm chart</label>
                </div>
              )}
              {target === 'kubernetes' && (
                <div className="grid grid-cols-2 gap-3">
                  {!ex && (
                  <div className="col-span-2"><label className={label} htmlFor="k8s-image">Image the cluster pulls</label><input id="k8s-image" className={input} placeholder="ghcr.io/yourname/yourapp:1.0" value={cfg.k8s.image} onChange={(e) => setK8s('image', e.target.value.trim())} /></div>
                  )}
                  <div><label className={label} htmlFor="k8s-ns">Namespace</label><input id="k8s-ns" className={input} value={cfg.k8s.namespace} onChange={(e) => setK8s('namespace', e.target.value)} /></div>
                  <div><label className={label} htmlFor="k8s-rep">Replicas</label><input id="k8s-rep" type="number" className={input} value={cfg.k8s.replicas} onChange={(e) => setK8s('replicas', Number(e.target.value))} /></div>
                  <div><label className={label} htmlFor="k8s-svc">Service type</label>
                    <select id="k8s-svc" className={input} value={cfg.k8s.serviceType} onChange={(e) => setK8s('serviceType', e.target.value as ContainerConfig['k8s']['serviceType'])}><option>ClusterIP</option><option>LoadBalancer</option></select></div>
                  <div><label className={label} htmlFor="k8s-host">Ingress host (optional)</label><input id="k8s-host" className={input} placeholder="app.example.com" value={cfg.k8s.ingressHost} onChange={(e) => setK8s('ingressHost', e.target.value.trim())} /></div>
                  {cfg.k8s.ingressHost && (<>
                    <div><label className={label} htmlFor="k8s-class">Ingress class</label><input id="k8s-class" className={input} value={cfg.k8s.ingressClass} onChange={(e) => setK8s('ingressClass', e.target.value.trim())} /></div>
                    <div><label className={label} htmlFor="k8s-tls">TLS secret (optional)</label><input id="k8s-tls" className={input} placeholder="app-tls" value={cfg.k8s.tlsSecret} onChange={(e) => setK8s('tlsSecret', e.target.value.trim())} /></div>
                  </>)}
                  <label className="flex items-center gap-2 text-xs col-span-2"><input type="checkbox" checked={cfg.k8s.autoscaling} onChange={(e) => setK8s('autoscaling', e.target.checked)} />Autoscale on CPU</label>
                  {cfg.k8s.autoscaling && (<>
                    <div><label className={label} htmlFor="k8s-min">Minimum replicas</label><input id="k8s-min" type="number" className={input} value={cfg.k8s.minReplicas} onChange={(e) => setK8s('minReplicas', Number(e.target.value))} /></div>
                    <div><label className={label} htmlFor="k8s-max">Maximum replicas</label><input id="k8s-max" type="number" className={input} value={cfg.k8s.maxReplicas} onChange={(e) => setK8s('maxReplicas', Number(e.target.value))} /></div>
                  </>)}
                  <label className="flex items-center gap-2 text-xs col-span-2"><input type="checkbox" checked={cfg.k8s.helm} onChange={(e) => setK8s('helm', e.target.checked)} />Also generate a Helm chart</label>
                  {!ex && (<>
                  <label className="flex items-center gap-2 text-xs col-span-2"><input type="checkbox" checked={cfg.k8s.githubActions} onChange={(e) => setK8s('githubActions', e.target.checked)} />GitHub Actions workflow that builds and pushes the image (ghcr.io images)</label>
                  {cfg.k8s.githubActions && <label className="flex items-center gap-2 text-xs col-span-2"><input type="checkbox" checked={cfg.k8s.scanImage} onChange={(e) => setK8s('scanImage', e.target.checked)} />Scan the image for vulnerabilities before pushing (Trivy)</label>}
                  </>)}
                </div>
              )}
            </div>
            )}

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
                    <p className="font-semibold">Estimated cost on {DEPLOY_TARGET_LABEL[target].split(' (')[0]}: ${result.cost.monthlyUsd.toFixed(2)} a month</p>
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
                <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
                  <button type="button" onClick={addToArchitecture} className={clsx('px-3 py-1.5 rounded-lg border font-medium', isLight ? 'border-cyan-600 text-cyan-700 hover:bg-cyan-50' : 'border-cyan-400 text-cyan-200 hover:bg-cyan-500/10')}>
                    {linked ? 'Update the canvas node' : 'Add to architecture'}
                  </button>
                  {canvasNote && <span role="status" className={muted}>{canvasNote}</span>}
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
                    <button type="button" onClick={() => download(`${zipName}-docker.zip`, buildZip(files, zipName) as BlobPart, 'application/zip')}
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
