import { useState } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { normalizeDiscoveredInfrastructure } from '@/lib/cloud/normalizer';
import type { DiscoveredResource } from '@/lib/cloud/types';
import type { CloudRelationship } from '@/lib/cloud/discovery/types';
import type { CanvasNode, CanvasEdge } from '@/types';
import { apiArchitectureService } from '@/lib/services/ApiArchitectureService';
import {
  Upload, Cloud, FileCode2, CheckCircle2, Loader2,
  Server, Network, Database, HardDrive, AlertTriangle, RefreshCw,
  Globe, Layers, ShieldCheck, Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import ConnectAwsAccountForm from '@/components/accounts/ConnectAwsAccountForm';
import ConnectAzureAccountForm from '@/components/accounts/ConnectAzureAccountForm';
import DeleteAccountDialog from '@/components/accounts/DeleteAccountDialog';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CloudAccount {
  id: string;
  provider: string;
  name: string;
  status: string;
  identity: Record<string, unknown>;
}

interface DiscoveryRun {
  id: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  resources: DiscoveredResource[];
  relationships?: CloudRelationship[];
  summary: Record<string, number>;
  error: string | null;
}

type ImportStep =
  | 'select-source'
  | 'connect-aws'
  | 'connect-azure'
  | 'select-account'
  | 'discovering'
  | 'results'
  | 'file-drop';

// ─── Constants ────────────────────────────────────────────────────────────────

const IMPORT_SOURCES = [
  {
    id: 'aws',
    label: 'Import from AWS',
    provider: 'aws',
    icon: '☁',
    description: 'Discover real AWS resources via cross-account IAM role',
    color: 'border-orange-700 hover:bg-orange-900/10',
  },
  {
    id: 'azure',
    label: 'Import from Azure',
    provider: 'azure',
    icon: '⬡',
    description: 'Discover real Azure resources via service principal',
    color: 'border-blue-700 hover:bg-blue-900/10',
  },
  {
    id: 'terraform',
    label: 'Upload Terraform',
    provider: null,
    icon: '⬛',
    description: 'Import .tf or .tfstate files',
    color: 'border-purple-700 hover:bg-purple-900/10',
  },
  {
    id: 'file',
    label: 'Import Architecture File',
    provider: null,
    icon: '📄',
    description: 'Import a previously exported CloudCraft JSON',
    color: 'border-gray-600 hover:bg-gray-800',
  },
];

const DISCOVERY_STEPS = [
  { icon: Cloud, label: 'Connecting to Cloud Provider API...' },
  { icon: Globe, label: 'Discovering accessible regions...' },
  { icon: Network, label: 'Scanning VPCs & Virtual Networks...' },
  { icon: Network, label: 'Scanning subnets, gateways & route tables...' },
  { icon: Server, label: 'Scanning compute instances & load balancers...' },
  { icon: Database, label: 'Scanning databases & storage accounts...' },
  { icon: Layers, label: 'Reconstructing relationships & network topology...' },
  { icon: CheckCircle2, label: 'Building CloudCraft architecture diagram...' },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function ImportPanel() {
  const { state, dispatch } = useApp();
  const activeProject = useActiveProject();
  const { activeEnvironment } = state;

  // Navigation state
  const [step, setStep] = useState<ImportStep>('select-source');
  const [selected, setSelected] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Discovery state
  const [accounts, setAccounts] = useState<CloudAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [availableRegions, setAvailableRegions] = useState<string[]>([]);
  const [selectedRegions, setSelectedRegions] = useState<string[]>([]);
  const [loadingRegions, setLoadingRegions] = useState(false);
  const [allRegionsSelected, setAllRegionsSelected] = useState(true);
  const [discoveryRun, setDiscoveryRun] = useState<DiscoveryRun | null>(null);
  const [discoveryStep, setDiscoveryStep] = useState(-1);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AWS connection form — credentials are held transiently in component state
  // and POSTed directly to the backend. They are never stored in React context
  // or any persistent client-side store.
  // Deleting a connected account asks first (the dialog is shared with the Cloud Accounts tab).
  const [accountToDelete, setAccountToDelete] = useState<CloudAccount | null>(null);
  // "Re-check": run the connection check again for one account.
  const [recheckingId, setRecheckingId] = useState<string | null>(null);

  // ── Helpers ────────────────────────────────────────────────────────────

  function reset() {
    setStep('select-source');
    setSelected(null);
    setAccounts([]);
    setSelectedAccountId(null);
    setAvailableRegions([]);
    setSelectedRegions([]);
    setLoadingRegions(false);
    setAllRegionsSelected(true);
    setDiscoveryRun(null);
    setDiscoveryStep(-1);
    setPolling(false);
    setError(null);
  }

  async function recheckAccount(acct: CloudAccount) {
    setRecheckingId(acct.id);
    setError(null);
    try {
      const res = await fetch(`/api/cloud-accounts/${acct.id}/validate`, { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(data?.error?.message ?? `Could not check the account (${res.status})`);
      }
      await fetchAccounts(acct.provider);     // the check saved its result with the account; show it
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check the account');
    } finally {
      setRecheckingId(null);
    }
  }

  function askToDeleteAccount(acct: CloudAccount) {
    setAccountToDelete(acct);
  }

  function handleAccountDeleted(accountId: string) {
    setAccounts((prev) => prev.filter((a) => a.id !== accountId));
    if (selectedAccountId === accountId) {
      setSelectedAccountId(null);
      setAvailableRegions([]);
      setSelectedRegions([]);
      setAllRegionsSelected(true);
    }
    setAccountToDelete(null);
  }

  /** A new account was connected and checked: show it (with its result) and select it. */
  async function handleAccountConnected(accountId: string) {
    if (selected === 'aws' || selected === 'azure') await fetchAccounts(selected);
    setSelectedAccountId(accountId);
  }

  async function handleSelectAccount(accountId: string) {
    setSelectedAccountId(accountId);
    setLoadingRegions(true);
    setAvailableRegions([]);
    setSelectedRegions([]);
    setAllRegionsSelected(true);
    try {
      const res = await fetch(`/api/cloud-accounts/${accountId}/regions`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json() as { ok: boolean; data?: { regions: string[] } };
        if (data.ok && data.data?.regions?.length) {
          setAvailableRegions(data.data.regions);
        }
      }
    } catch {
      // Non-fatal: user can still proceed with all accessible
    } finally {
      setLoadingRegions(false);
    }
  }

  async function fetchAccounts(provider: string) {
    try {
      const res = await fetch(`/api/cloud-accounts?provider=${provider}`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json() as { ok: boolean; data: CloudAccount[] };
      if (data.ok) {
        setAccounts(data.data.filter((a) => a.provider === provider));
      }
    } catch {
      // Non-fatal — user can still connect a new account
    }
  }

  // ── Step: select import source ─────────────────────────────────────────

  async function handleSourceSelect(sourceId: string) {
    setSelected(sourceId);
    setError(null);

    if (sourceId === 'aws') {
      await fetchAccounts('aws');
      setStep('select-account');
    } else if (sourceId === 'azure') {
      await fetchAccounts('azure');
      setStep('select-account');
    } else {
      setStep('file-drop');
    }
  }

  // ── Step: connect new account ──────────────────────────────────────────

  // ── Step: start discovery ──────────────────────────────────────────────

  async function startDiscovery(accountId: string) {
    setError(null);
    setStep('discovering');
    setDiscoveryStep(0);

    try {
      const targetRegions = allRegionsSelected ? undefined : selectedRegions;
      const res = await fetch(`/api/cloud-accounts/${accountId}/discover`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          regions: targetRegions && targetRegions.length > 0 ? targetRegions : undefined,
        }),
      });
      const data = await res.json() as { ok: boolean; data: { runId: string; status: string }; error?: { message: string } };
      if (!data.ok) {
        setError(data.error?.message ?? 'Failed to start discovery');
        setStep('select-account');
        return;
      }

      const runId = data.data.runId;
      pollDiscovery(accountId, runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      setStep('select-account');
    }
  }

  function pollDiscovery(accountId: string, runId: string) {
    setPolling(true);
    let stepIndex = 0;

    const interval = setInterval(async () => {
      // Animate steps while polling
      if (stepIndex < DISCOVERY_STEPS.length - 1) {
        stepIndex++;
        setDiscoveryStep(stepIndex);
      }

      try {
        const res = await fetch(`/api/cloud-accounts/${accountId}/discovery?runId=${runId}`, { credentials: 'include' });
        const data = await res.json() as { ok: boolean; data: DiscoveryRun };
        if (!data.ok) return;

        const run = data.data;
        if (run.status === 'completed' || run.status === 'failed') {
          clearInterval(interval);
          setPolling(false);
          setDiscoveryStep(DISCOVERY_STEPS.length - 1);
          setDiscoveryRun(run);

          if (run.status === 'failed') {
            setError(run.error ?? 'Discovery failed');
          }

          // Small delay so the last step is shown as complete
          setTimeout(() => setStep('results'), 400);
        }
      } catch {
        // Keep polling on transient network errors
      }
    }, 1200);
  }

  // ── Step: open in canvas ───────────────────────────────────────────────

  async function handleImport(mode: 'new' | 'update' = 'new') {
    if (!discoveryRun) return;

    if (discoveryRun.status === 'failed') {
      setError(discoveryRun.error ?? 'Discovery failed');
      return;
    }

    if (!discoveryRun.resources || discoveryRun.resources.length === 0) {
      setError('No resources were found in the discovery run to import.');
      return;
    }

    const provider = (selected === 'azure' ? 'azure' : 'aws') as 'aws' | 'azure';
    const { nodes, edges } = normalizeDiscoveredInfrastructure(discoveryRun.resources, discoveryRun.relationships ?? []);

    if (nodes.length === 0) {
      setError('Discovered resources could not be normalized into valid canvas nodes.');
      return;
    }

    if (mode === 'update' && activeProject) {
      if (selectedAccountId && discoveryRun.id && discoveryRun.id !== 'file-import') {
        try {
          const res = await fetch(`/api/cloud-accounts/${selectedAccountId}/discovery/import`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              runId: discoveryRun.id,
              environmentId: activeProject.id,
              merge: true, // Safe merge: preserves user's existing canvas nodes!
            }),
          });
          const data = await res.json() as { ok: boolean; data?: { nodes: CanvasNode[]; edges: CanvasEdge[] }; error?: { message: string } };
          if (data.ok && data.data) {
            let updatedName = activeProject.name;
            const discoveryNameMatch = activeProject.name.match(/^Discovered — (AWS|AZURE|Multi) \(\d+ resources\)$/i);
            if (discoveryNameMatch) {
              updatedName = `Discovered — ${provider.toUpperCase()} (${data.data.nodes.length} resources)`;
            }
            dispatch({
              type: 'UPDATE_CANVAS',
              nodes: data.data.nodes,
              edges: data.data.edges,
              bumpCanvasKey: true,
              name: updatedName,
            });
            dispatch({ type: 'SET_VIEW', view: 'canvas' });
            return;
          }
        } catch {
          // Fall through to client merge
        }
      }

      // Client-side fallback merge
      const currentProjectEnv = activeProject.environments[activeEnvironment] || activeProject.environments['production'];
      const currentNodes = currentProjectEnv?.nodes ?? [];
      const currentEdges = currentProjectEnv?.edges ?? [];

      const nodeMap = new Map<string, CanvasNode>();
      const cloudIdToNodeId = new Map<string, string>();
      for (const n of currentNodes) {
        nodeMap.set(n.id, n);
        const cloudId = (n.config?.['resourceId'] as string) || (n.config?.['arn'] as string) || (n.config?.['providerResourceId'] as string);
        if (cloudId) cloudIdToNodeId.set(cloudId, n.id);
      }
      for (const n of nodes) {
        const cloudId = (n.config?.['resourceId'] as string) || (n.config?.['arn'] as string) || (n.config?.['providerResourceId'] as string);
        const matchedExistingId = cloudId ? cloudIdToNodeId.get(cloudId) : undefined;
        if (matchedExistingId && matchedExistingId !== n.id) {
          const existingNode = nodeMap.get(matchedExistingId)!;
          nodeMap.set(matchedExistingId, {
            ...existingNode,
            label: n.label,
            config: { ...existingNode.config, ...n.config },
            importState: 'imported',
          });
        } else {
          nodeMap.set(n.id, n);
        }
      }

      const edgeMap = new Map<string, CanvasEdge>();
      for (const e of currentEdges) edgeMap.set(`${e.source}->${e.target}`, e);
      for (const e of edges) edgeMap.set(`${e.source}->${e.target}`, e);

      const mergedNodes = [...nodeMap.values()];
      const mergedEdges = [...edgeMap.values()];

      let updatedName = activeProject.name;
      const discoveryNameMatch = activeProject.name.match(/^Discovered — (AWS|AZURE|Multi) \(\d+ resources\)$/i);
      if (discoveryNameMatch) {
        updatedName = `Discovered — ${provider.toUpperCase()} (${mergedNodes.length} resources)`;
      }

      dispatch({
        type: 'UPDATE_CANVAS',
        nodes: mergedNodes,
        edges: mergedEdges,
        bumpCanvasKey: true,
        name: updatedName,
      });
      dispatch({ type: 'SET_VIEW', view: 'canvas' });
      apiArchitectureService.saveCanvas(activeProject.id, mergedNodes, mergedEdges, activeEnvironment).catch(() => {});
      return;
    }

    dispatch({
      type: 'CREATE_PROJECT',
      provider,
      name: `Discovered — ${provider.toUpperCase()} (${nodes.length} resources)`,
      nodes,
      edges,
    });
    dispatch({ type: 'SET_VIEW', view: 'canvas' });
  }

  // ── Simulated file import (unchanged) ─────────────────────────────────

  async function handleFileDrop() {
    setStep('discovering');
    setDiscoveryStep(0);
    for (let i = 0; i < DISCOVERY_STEPS.length; i++) {
      setDiscoveryStep(i);
      await new Promise((r) => setTimeout(r, 700 + Math.random() * 400));
    }
    // Simulate a completed run for file-based imports
    setDiscoveryRun({
      id: 'file-import',
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      resources: [],
      summary: {},
      error: null,
    });
    setStep('results');
  }

  // ─── Render ──────────────────────────────────────────────────────────────
  const isLight = state.theme === 'light';

  return (
    <div className={clsx("flex-1 overflow-y-auto px-4 sm:px-6 py-6 pb-36 custom-scrollbar", isLight ? "bg-slate-50 text-slate-900" : "bg-gray-950 text-slate-100")}>
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Upload className={clsx("w-5 h-5", isLight ? "text-blue-600" : "text-blue-400")} />
          <div>
            <h2 className={clsx("font-bold text-lg", isLight ? "text-slate-900" : "text-white")}>Import Infrastructure</h2>
            <p className={clsx("text-sm", isLight ? "text-slate-500" : "text-gray-400")}>Discover and import existing cloud resources</p>
          </div>
        </div>

        {error && (
          <div className={clsx("border rounded-xl p-3 mb-4 flex items-start gap-2", isLight ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-red-900/20 border-red-800 text-red-300")}>
            <AlertTriangle className={clsx("w-4 h-4 shrink-0 mt-0.5", isLight ? "text-rose-600" : "text-red-400")} />
            <p className="text-sm font-medium">{error}</p>
          </div>
        )}

        {/* ── Step: select-source ─────────────────────────────────────── */}
        {step === 'select-source' && (
          <>
            <div className="grid grid-cols-2 gap-3 mb-5">
              {IMPORT_SOURCES.map((src) => (
                <button
                  key={src.id}
                  onClick={() => handleSourceSelect(src.id)}
                  className={clsx(
                    'text-left p-4 rounded-xl border-2 transition-all',
                    selected === src.id
                      ? (isLight ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-blue-500 bg-blue-900/20')
                      : (isLight ? 'border-slate-200 bg-white hover:border-slate-300 shadow-xs' : `border-gray-700 ${src.color}`),
                  )}
                >
                  <div className="text-2xl mb-2">{src.icon}</div>
                  <p className={clsx("font-semibold text-sm", isLight ? "text-slate-900" : "text-white")}>{src.label}</p>
                  <p className={clsx("text-xs mt-0.5", isLight ? "text-slate-500" : "text-gray-500")}>{src.description}</p>
                </button>
              ))}
            </div>
          </>
        )}

        {/* ── Step: select-account ────────────────────────────────────── */}
        {step === 'select-account' && (
          <div className="space-y-4">
            <button onClick={reset} className={clsx("text-xs flex items-center gap-1 mb-1 font-medium", isLight ? "text-slate-500 hover:text-slate-800" : "text-gray-500 hover:text-gray-300")}>
              ← Back
            </button>

            {accountToDelete && (
              <DeleteAccountDialog account={accountToDelete} onClose={() => setAccountToDelete(null)} onDeleted={handleAccountDeleted} />
            )}

            {/* Existing accounts */}
            {accounts.length > 0 && (
              <div className={clsx("border rounded-xl p-4", isLight ? "bg-white border-slate-200 shadow-sm" : "bg-gray-800 border-gray-700")}>
                <p className={clsx("text-xs font-semibold uppercase tracking-wider mb-3", isLight ? "text-slate-500" : "text-gray-400")}>Connected Accounts</p>
                <div className="space-y-2">
                  {accounts.map((acct) => (
                    <div
                      key={acct.id}
                      className={clsx(
                        'w-full rounded-lg border transition-colors',
                        selectedAccountId === acct.id
                          ? (isLight ? 'border-blue-500 bg-blue-50/70' : 'border-blue-500 bg-blue-900/20')
                          : (isLight ? 'border-slate-200 bg-slate-50/50 hover:bg-slate-100/70' : 'border-gray-700 hover:bg-gray-700/50'),
                      )}
                    >
                    <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleSelectAccount(acct.id)}
                      className="flex-1 min-w-0 flex items-center justify-between p-3 text-left"
                    >
                      <div>
                        <p className={clsx("text-sm font-semibold", isLight ? "text-slate-900" : "text-white")}>{acct.name}</p>
                        <p className={clsx("text-xs", isLight ? "text-slate-500" : "text-gray-500")}>
                          {acct.provider.toUpperCase()} ·{' '}
                          {typeof acct.identity === 'object' && acct.identity !== null
                            ? (acct.identity.accountId as string ?? acct.identity.subscriptionId as string ?? '')
                            : ''}
                          {acct.identity?.authMethod === 'access-key' ? ' · access key · discovery only' : ''}
                        </p>
                      </div>
                      <span className={clsx(
                        'text-xs px-2 py-0.5 rounded-full font-medium',
                        acct.status === 'active' ? (isLight ? 'bg-emerald-100 text-emerald-800' : 'bg-emerald-900 text-emerald-400') :
                        acct.status === 'invalid' ? (isLight ? 'bg-rose-100 text-rose-800' : 'bg-red-900 text-red-400') :
                        (isLight ? 'bg-slate-200 text-slate-700' : 'bg-gray-700 text-gray-400'),
                      )}>
                        {acct.status}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => recheckAccount(acct)}
                      disabled={recheckingId === acct.id}
                      title="Check the connection again"
                      aria-label={`Re-check account ${acct.name}`}
                      className={clsx(
                        "flex items-center gap-1 px-2 py-1.5 rounded-md text-xs disabled:opacity-60 transition-colors",
                        isLight ? "text-slate-500 hover:text-blue-600 hover:bg-slate-200" : "text-gray-400 hover:text-blue-300 hover:bg-blue-950/40"
                      )}
                    >
                      <RefreshCw className={clsx('w-3.5 h-3.5', recheckingId === acct.id && 'animate-spin')} />
                      {recheckingId === acct.id ? 'Checking…' : 'Re-check'}
                    </button>
                    <button
                      type="button"
                      onClick={() => askToDeleteAccount(acct)}
                      title="Delete this account"
                      aria-label={`Delete account ${acct.name}`}
                      className={clsx(
                        "mr-2 p-2 rounded-md transition-colors",
                        isLight ? "text-slate-400 hover:text-rose-600 hover:bg-rose-50" : "text-gray-500 hover:text-red-300 hover:bg-red-950/40"
                      )}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    </div>
                    {acct.status === 'invalid' && (
                      <div className={clsx("mx-3 mb-3 text-xs leading-relaxed p-2 rounded-lg", isLight ? "bg-rose-50 text-rose-800" : "text-red-300")} data-testid="account-invalid-reason">
                        <p className={isLight ? "text-rose-800 font-medium" : "text-red-300"}>
                          {typeof acct.identity?.validationReason === 'string' ? acct.identity.validationReason : 'The last connection check failed.'}
                        </p>
                        <p className={clsx("mt-0.5", isLight ? "text-rose-600" : "text-gray-400")}>
                          {typeof acct.identity?.validationFix === 'string' ? acct.identity.validationFix : 'Click Re-check to see why.'}
                        </p>
                      </div>
                    )}
                    {acct.status === 'pending' && (
                      <p className={clsx("mx-3 mb-3 text-xs", isLight ? "text-slate-500" : "text-gray-500")}>Not checked yet. Click Re-check.</p>
                    )}
                    </div>
                  ))}
                </div>

                {selectedAccountId && (
                  <div className={clsx("mt-4 pt-4 border-t space-y-3", isLight ? "border-slate-200" : "border-gray-700/80")}>
                    <div className="flex items-center justify-between">
                      <div className={clsx("flex items-center gap-1.5 text-xs font-semibold", isLight ? "text-slate-700" : "text-gray-300")}>
                        <Globe className={clsx("w-3.5 h-3.5", isLight ? "text-blue-600" : "text-blue-400")} />
                        <span>Regions to Discover</span>
                      </div>
                      {loadingRegions ? (
                        <span className={clsx("text-xs flex items-center gap-1", isLight ? "text-slate-500" : "text-gray-500")}>
                          <Loader2 className="w-3 h-3 animate-spin" /> Querying regions...
                        </span>
                      ) : availableRegions.length > 0 ? (
                        <span className={clsx("text-xs font-medium", isLight ? "text-slate-600" : "text-gray-400")}>
                          {availableRegions.length} accessible regions found
                        </span>
                      ) : null}
                    </div>

                    <div className="flex gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => setAllRegionsSelected(true)}
                        className={clsx(
                          'px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors',
                          allRegionsSelected
                            ? (isLight ? 'bg-blue-600 text-white border-blue-600' : 'bg-blue-600/30 border-blue-500 text-blue-200')
                            : (isLight ? 'bg-slate-100 border-slate-300 text-slate-700 hover:bg-slate-200' : 'bg-gray-700/40 border-gray-600 text-gray-400 hover:text-gray-200')
                        )}
                      >
                        All Accessible Regions
                      </button>
                      <button
                        type="button"
                        onClick={() => setAllRegionsSelected(false)}
                        className={clsx(
                          'px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors',
                          !allRegionsSelected
                            ? (isLight ? 'bg-blue-600 text-white border-blue-600' : 'bg-blue-600/30 border-blue-500 text-blue-200')
                            : (isLight ? 'bg-slate-100 border-slate-300 text-slate-700 hover:bg-slate-200' : 'bg-gray-700/40 border-gray-600 text-gray-400 hover:text-gray-200')
                        )}
                      >
                        Select Specific Regions
                      </button>
                    </div>

                    {!allRegionsSelected && availableRegions.length > 0 && (
                      <div className={clsx(
                        "flex flex-wrap gap-1.5 max-h-36 overflow-y-auto p-2 rounded-lg border custom-scrollbar",
                        isLight ? "bg-slate-50 border-slate-200" : "bg-gray-900/60 border-gray-700"
                      )}>
                        {availableRegions.map((region) => {
                          const isChecked = selectedRegions.includes(region);
                          return (
                            <button
                              key={region}
                              type="button"
                              onClick={() => {
                                setSelectedRegions((prev) =>
                                  isChecked ? prev.filter((r) => r !== region) : [...prev, region]
                                );
                              }}
                              className={clsx(
                                'text-xs px-2.5 py-1 rounded-md border font-medium transition-colors',
                                isChecked
                                  ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                                  : (isLight ? 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100' : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-white')
                              )}
                            >
                              {region}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    <button
                      onClick={() => startDiscovery(selectedAccountId)}
                      disabled={!allRegionsSelected && selectedRegions.length === 0}
                      className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2 shadow-sm"
                    >
                      <Layers className="w-4 h-4" />
                      Discover & Import Existing Infrastructure →
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Connect new account */}
            <div className={clsx("border rounded-xl p-4", isLight ? "bg-white border-slate-200 shadow-sm" : "bg-gray-800 border-gray-700")}>
              <p className={clsx("text-xs font-semibold uppercase tracking-wider mb-3", isLight ? "text-slate-500" : "text-gray-400")}>
                Connect New {selected === 'aws' ? 'AWS' : 'Azure'} Account
              </p>

              {selected === 'aws' && <ConnectAwsAccountForm onConnected={handleAccountConnected} />}
              {selected === 'azure' && <ConnectAzureAccountForm onConnected={handleAccountConnected} />}
            </div>
          </div>
        )}

        {/* ── Step: file-drop ─────────────────────────────────────────── */}
        {step === 'file-drop' && (
          <div className="space-y-4">
            <button onClick={reset} className={clsx("text-xs flex items-center gap-1 mb-1 font-medium", isLight ? "text-slate-500 hover:text-slate-800" : "text-gray-500 hover:text-gray-300")}>
              ← Back
            </button>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); void handleFileDrop(); }}
              className={clsx(
                'border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer',
                dragOver 
                  ? (isLight ? 'border-blue-500 bg-blue-50' : 'border-blue-500 bg-blue-900/10')
                  : (isLight ? 'border-slate-300 bg-white hover:border-slate-400 shadow-sm' : 'border-gray-700 hover:border-gray-600'),
              )}
              onClick={() => void handleFileDrop()}
            >
              <FileCode2 className={clsx("w-8 h-8 mx-auto mb-3", isLight ? "text-slate-400" : "text-gray-600")} />
              <p className={clsx("text-sm font-medium", isLight ? "text-slate-700" : "text-gray-400")}>
                Drop your {selected === 'terraform' ? '.tf / .tfstate' : '.json'} file here
              </p>
              <p className={clsx("text-xs mt-1", isLight ? "text-slate-400" : "text-gray-600")}>or click to browse</p>
            </div>
          </div>
        )}

        {/* ── Step: discovering ────────────────────────────────────────── */}
        {step === 'discovering' && (
          <div className={clsx("border rounded-xl p-6", isLight ? "bg-white border-slate-200 shadow-sm" : "bg-gray-800 border-gray-700")}>
            <div className="flex items-center justify-between mb-6">
              <p className={clsx("font-semibold text-sm", isLight ? "text-slate-900" : "text-white")}>Scanning infrastructure…</p>
              {polling && <RefreshCw className={clsx("w-4 h-4 animate-spin", isLight ? "text-blue-600" : "text-blue-400")} />}
            </div>
            <div className="space-y-3">
              {DISCOVERY_STEPS.map((s, i) => {
                const Icon = s.icon;
                const isDone = i < discoveryStep;
                const isActive = i === discoveryStep;
                return (
                  <div
                    key={i}
                    className={clsx(
                      'flex items-center gap-3 p-3 rounded-lg transition-colors',
                      isActive 
                        ? (isLight ? 'bg-blue-50 border border-blue-200' : 'bg-blue-900/20') 
                        : isDone 
                          ? (isLight ? 'bg-slate-50' : 'bg-gray-900/50') 
                          : '',
                    )}
                  >
                    <div
                      className={clsx(
                        'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                        isDone ? (isLight ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-900 text-emerald-400') :
                        isActive ? (isLight ? 'bg-blue-600 text-white' : 'bg-blue-900 text-blue-400') :
                        (isLight ? 'bg-slate-100 text-slate-400' : 'bg-gray-700 text-gray-600'),
                      )}
                    >
                      {isDone ? (
                        <CheckCircle2 className="w-4 h-4" />
                      ) : isActive ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Icon className="w-4 h-4" />
                      )}
                    </div>
                    <span
                      className={clsx(
                        'text-sm font-medium',
                        isDone 
                          ? (isLight ? 'text-slate-600' : 'text-gray-400') 
                          : isActive 
                            ? (isLight ? 'text-slate-900 font-bold' : 'text-white') 
                            : (isLight ? 'text-slate-400' : 'text-gray-600'),
                      )}
                    >
                      {s.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Step: results ────────────────────────────────────────────── */}
        {step === 'results' && (() => {
          const totalResources = discoveryRun?.resources?.length ?? (discoveryRun ? Object.values(discoveryRun.summary).reduce((a, b) => a + b, 0) : 0);
          const unsupportedCount = discoveryRun?.resources?.filter((r) => r.resourceType.includes('unsupported')).length ?? 0;
          const totalRelationships = discoveryRun?.resources?.reduce((acc, r) => {
            const rels = r.metadata?.['relationships'];
            return acc + (Array.isArray(rels) ? rels.length : 0);
          }, 0) ?? 0;

          return (
            <div className="space-y-4">
              {discoveryRun?.status === 'failed' ? (
                <div className={clsx("border rounded-xl p-4 flex items-center gap-3", isLight ? "bg-rose-50 border-rose-200" : "bg-red-900/20 border-red-800")}>
                  <AlertTriangle className={clsx("w-5 h-5 shrink-0", isLight ? "text-rose-600" : "text-red-400")} />
                  <div>
                    <p className={clsx("font-semibold text-sm", isLight ? "text-rose-900" : "text-red-300")}>Discovery Failed</p>
                    <p className={clsx("text-xs mt-0.5", isLight ? "text-rose-600" : "text-red-500")}>{discoveryRun.error ?? 'Unknown error'}</p>
                  </div>
                </div>
              ) : (
                <div className={clsx("border rounded-xl p-4 flex items-center gap-3", isLight ? "bg-emerald-50 border-emerald-200" : "bg-emerald-900/20 border-emerald-800")}>
                  <CheckCircle2 className={clsx("w-5 h-5 shrink-0", isLight ? "text-emerald-600" : "text-emerald-400")} />
                  <div>
                    <p className={clsx("font-semibold text-sm", isLight ? "text-emerald-900" : "text-emerald-300")}>Discovery Complete</p>
                    <p className={clsx("text-xs mt-0.5", isLight ? "text-emerald-700" : "text-emerald-400/90")}>
                      Successfully inspected live cloud environment and reconstructed architecture topology.
                    </p>
                  </div>
                </div>
              )}

              {/* Stat Counters */}
              <div className="grid grid-cols-3 gap-3">
                <div className={clsx("border rounded-xl p-3 text-center", isLight ? "bg-white border-slate-200 shadow-sm" : "bg-gray-800/80 border-gray-700/80")}>
                  <div className={clsx("text-2xl font-bold", isLight ? "text-slate-900" : "text-white")}>{totalResources}</div>
                  <div className={clsx("text-xs mt-0.5", isLight ? "text-slate-500" : "text-gray-400")}>Resources Discovered</div>
                </div>
                <div className={clsx("border rounded-xl p-3 text-center", isLight ? "bg-white border-slate-200 shadow-sm" : "bg-gray-800/80 border-gray-700/80")}>
                  <div className={clsx("text-2xl font-bold", isLight ? "text-blue-600" : "text-blue-400")}>{totalRelationships}</div>
                  <div className={clsx("text-xs mt-0.5", isLight ? "text-slate-500" : "text-gray-400")}>Relationships Found</div>
                </div>
                <div className={clsx("border rounded-xl p-3 text-center", isLight ? "bg-white border-slate-200 shadow-sm" : "bg-gray-800/80 border-gray-700/80")}>
                  <div className={clsx("text-2xl font-bold", isLight ? "text-amber-600" : "text-amber-400")}>{unsupportedCount}</div>
                  <div className={clsx("text-xs mt-0.5", isLight ? "text-slate-500" : "text-gray-400")}>Unsupported / Fallback</div>
                </div>
              </div>

              {/* Safety notice */}
              <div className={clsx("border rounded-xl p-3 flex items-start gap-2.5", isLight ? "bg-blue-50 border-blue-200 text-blue-900" : "bg-blue-950/40 border-blue-800/60 text-blue-300")}>
                <ShieldCheck className={clsx("w-4 h-4 shrink-0 mt-0.5", isLight ? "text-blue-600" : "text-blue-400")} />
                <p className="text-xs">
                  <strong>Read-Only Safety:</strong> Discovered resources will be imported with an &quot;Imported&quot; badge and live cloud metadata. They will generate Terraform data sources rather than destructive resources.
                </p>
              </div>

              {/* Resource summary */}
              {discoveryRun && Object.keys(discoveryRun.summary).length > 0 && (
                <div className={clsx("border rounded-xl p-4", isLight ? "bg-white border-slate-200 shadow-sm" : "bg-gray-800 border-gray-700")}>
                  <p className={clsx("text-xs font-semibold uppercase tracking-wider mb-3", isLight ? "text-slate-500" : "text-gray-400")}>
                    Discovered Resources Breakdown
                  </p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {Object.entries(discoveryRun.summary).map(([type, count]) => (
                      <div key={type} className={clsx("flex items-center gap-2", isLight ? "text-slate-700" : "text-gray-300")}>
                        <CheckCircle2 className={clsx("w-3.5 h-3.5 shrink-0", isLight ? "text-emerald-600" : "text-emerald-500")} />
                        <span>{count} × {type}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  onClick={reset}
                  className={clsx("px-4 py-2.5 border rounded-xl text-sm font-semibold transition-colors", isLight ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-100" : "border-gray-700 text-gray-400 hover:text-white")}
                >
                  Start Over
                </button>
                {activeProject && (
                  <button
                    onClick={() => handleImport('update')}
                    disabled={discoveryRun?.status === 'failed'}
                    className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2 shadow-sm"
                  >
                    <Layers className="w-4 h-4" />
                    Safe Merge to Current Architecture
                  </button>
                )}
                <button
                  onClick={() => handleImport('new')}
                  disabled={discoveryRun?.status === 'failed'}
                  className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-xl text-sm font-semibold transition-colors shadow-sm"
                >
                  {activeProject ? 'Open as New Project' : 'Open in Canvas →'}
                </button>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
