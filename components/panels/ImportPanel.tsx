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
  const [awsForm, setAwsForm] = useState({ roleArn: '', externalId: '', region: 'us-east-1' });
  const [azureForm, setAzureForm] = useState({
    tenantId: '', clientId: '', clientSecret: '', subscriptionId: '',
  });
  const [accountName, setAccountName] = useState('');
  const [connecting, setConnecting] = useState(false);
  // Deleting a connected account asks first: this is the account whose credentials CloudCraft stores.
  const [accountToDelete, setAccountToDelete] = useState<CloudAccount | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
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
    setAwsForm({ roleArn: '', externalId: '', region: 'us-east-1' });
    setAzureForm({ tenantId: '', clientId: '', clientSecret: '', subscriptionId: '' });
    setAccountName('');
    setConnecting(false);
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
    setDeleteError(null);
    setAccountToDelete(acct);
  }

  async function confirmDeleteAccount() {
    if (!accountToDelete) return;
    const acct = accountToDelete;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/cloud-accounts/${acct.id}`, { method: 'DELETE', credentials: 'include' });
      const data = await res.json().catch(() => ({})) as { error?: { message?: string } };
      if (!res.ok) throw new Error(data?.error?.message ?? `Could not delete the account (${res.status})`);
      setAccounts((prev) => prev.filter((a) => a.id !== acct.id));
      if (selectedAccountId === acct.id) {
        setSelectedAccountId(null);
        setAvailableRegions([]);
        setSelectedRegions([]);
        setAllRegionsSelected(true);
      }
      setAccountToDelete(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete the account');
    } finally {
      setDeleting(false);
    }
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

  async function handleConnectAws() {
    if (!awsForm.roleArn || !awsForm.externalId) {
      setError('Role ARN and External ID are required');
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch('/api/cloud-accounts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'aws',
          name: accountName || `AWS (${awsForm.region})`,
          // Credentials go directly to backend — never stored in React context
          credentials: {
            ...awsForm,
            externalId: awsForm.externalId.trim(),
          },
        }),
      });
      const data = await res.json() as { ok: boolean; data: CloudAccount; error?: { message: string } };
      if (!data.ok) {
        setError(data.error?.message ?? 'Failed to connect account');
        return;
      }
      // Validate immediately
      await validateAccount(data.data.id);
      setAccounts((prev) => [...prev, data.data]);
      setSelectedAccountId(data.data.id);
      // Clear sensitive form fields immediately after POST
      setAwsForm({ roleArn: '', externalId: '', region: 'us-east-1' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setConnecting(false);
    }
  }

  async function handleConnectAzure() {
    if (!azureForm.tenantId || !azureForm.clientId || !azureForm.clientSecret || !azureForm.subscriptionId) {
      setError('All Azure fields are required');
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch('/api/cloud-accounts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'azure',
          name: accountName || `Azure (${azureForm.subscriptionId.slice(0, 8)}…)`,
          // Credentials go directly to backend — never stored in React context
          credentials: azureForm,
        }),
      });
      const data = await res.json() as { ok: boolean; data: CloudAccount; error?: { message: string } };
      if (!data.ok) {
        setError(data.error?.message ?? 'Failed to connect account');
        return;
      }
      await validateAccount(data.data.id);
      setAccounts((prev) => [...prev, data.data]);
      setSelectedAccountId(data.data.id);
      // Clear sensitive form fields immediately after POST
      setAzureForm({ tenantId: '', clientId: '', clientSecret: '', subscriptionId: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setConnecting(false);
    }
  }

  async function validateAccount(accountId: string) {
    try {
      await fetch(`/api/cloud-accounts/${accountId}/validate`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Non-fatal at connection time — status will be shown in account list
    }
  }

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

  return (
    <div className="flex-1 overflow-y-auto bg-gray-900 p-5">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Upload className="w-5 h-5 text-blue-400" />
          <div>
            <h2 className="text-white font-bold text-lg">Import Infrastructure</h2>
            <p className="text-gray-400 text-sm">Discover and import existing cloud resources</p>
          </div>
        </div>

        {error && (
          <div className="bg-red-900/20 border border-red-800 rounded-xl p-3 mb-4 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <p className="text-red-300 text-sm">{error}</p>
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
                    'text-left p-4 rounded-xl border-2 transition-colors',
                    selected === src.id
                      ? 'border-blue-500 bg-blue-900/20'
                      : `border-gray-700 ${src.color}`,
                  )}
                >
                  <div className="text-2xl mb-2">{src.icon}</div>
                  <p className="text-white font-medium text-sm">{src.label}</p>
                  <p className="text-gray-500 text-xs mt-0.5">{src.description}</p>
                </button>
              ))}
            </div>
          </>
        )}

        {/* ── Step: select-account ────────────────────────────────────── */}
        {step === 'select-account' && (
          <div className="space-y-4">
            <button onClick={reset} className="text-gray-500 hover:text-gray-300 text-xs flex items-center gap-1 mb-1">
              ← Back
            </button>

            {/* Confirm deleting a connected account */}
            {accountToDelete && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="delete-account-title">
                <div className="w-full max-w-md bg-gray-900 border border-red-900/60 rounded-xl p-5 space-y-3 shadow-2xl">
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-lg bg-red-950/60 text-red-400 shrink-0"><Trash2 className="w-5 h-5" /></div>
                    <div className="space-y-1">
                      <h3 id="delete-account-title" className="text-white font-semibold text-sm">Delete “{accountToDelete.name}”?</h3>
                      <p className="text-gray-400 text-xs leading-relaxed">
                        CloudCraft will forget this {accountToDelete.provider.toUpperCase()} account: its stored connection details are deleted and so is its discovery history.
                        Terraform plans and applies that use it will stop working until you connect it again.
                      </p>
                      <p className="text-gray-500 text-xs leading-relaxed">
                        Nothing in your cloud account is touched, and designs you already imported stay as they are.
                      </p>
                    </div>
                  </div>
                  {deleteError && <p className="text-red-400 text-xs bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2">{deleteError}</p>}
                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      autoFocus
                      onClick={() => setAccountToDelete(null)}
                      disabled={deleting}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-300 bg-gray-800 hover:bg-gray-700 disabled:opacity-60"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={confirmDeleteAccount}
                      disabled={deleting}
                      className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white"
                    >
                      {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      Delete account
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Existing accounts */}
            {accounts.length > 0 && (
              <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
                <p className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-3">Connected Accounts</p>
                <div className="space-y-2">
                  {accounts.map((acct) => (
                    <div
                      key={acct.id}
                      className={clsx(
                        'w-full rounded-lg border transition-colors',
                        selectedAccountId === acct.id
                          ? 'border-blue-500 bg-blue-900/20'
                          : 'border-gray-700 hover:bg-gray-700/50',
                      )}
                    >
                    <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleSelectAccount(acct.id)}
                      className="flex-1 min-w-0 flex items-center justify-between p-3 text-left"
                    >
                      <div>
                        <p className="text-white text-sm font-medium">{acct.name}</p>
                        <p className="text-gray-500 text-xs">
                          {acct.provider.toUpperCase()} ·{' '}
                          {typeof acct.identity === 'object' && acct.identity !== null
                            ? (acct.identity.accountId as string ?? acct.identity.subscriptionId as string ?? '')
                            : ''}
                        </p>
                      </div>
                      <span className={clsx(
                        'text-xs px-2 py-0.5 rounded-full',
                        acct.status === 'active' ? 'bg-emerald-900 text-emerald-400' :
                        acct.status === 'invalid' ? 'bg-red-900 text-red-400' :
                        'bg-gray-700 text-gray-400',
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
                      className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-gray-400 hover:text-blue-300 hover:bg-blue-950/40 disabled:opacity-60 transition-colors"
                    >
                      <RefreshCw className={clsx('w-3.5 h-3.5', recheckingId === acct.id && 'animate-spin')} />
                      {recheckingId === acct.id ? 'Checking…' : 'Re-check'}
                    </button>
                    <button
                      type="button"
                      onClick={() => askToDeleteAccount(acct)}
                      title="Delete this account"
                      aria-label={`Delete account ${acct.name}`}
                      className="mr-2 p-2 rounded-md text-gray-500 hover:text-red-300 hover:bg-red-950/40 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    </div>
                    {acct.status === 'invalid' && (
                      <div className="mx-3 mb-3 text-xs leading-relaxed" data-testid="account-invalid-reason">
                        <p className="text-red-300">
                          {typeof acct.identity?.validationReason === 'string' ? acct.identity.validationReason : 'The last connection check failed.'}
                        </p>
                        <p className="text-gray-400 mt-0.5">
                          {typeof acct.identity?.validationFix === 'string' ? acct.identity.validationFix : 'Click Re-check to see why.'}
                        </p>
                      </div>
                    )}
                    {acct.status === 'pending' && (
                      <p className="mx-3 mb-3 text-xs text-gray-500">Not checked yet. Click Re-check.</p>
                    )}
                    </div>
                  ))}
                </div>

                {selectedAccountId && (
                  <div className="mt-4 pt-4 border-t border-gray-700/80 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs text-gray-300 font-medium">
                        <Globe className="w-3.5 h-3.5 text-blue-400" />
                        <span>Regions to Discover</span>
                      </div>
                      {loadingRegions ? (
                        <span className="text-xs text-gray-500 flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" /> Querying regions...
                        </span>
                      ) : availableRegions.length > 0 ? (
                        <span className="text-xs text-gray-400">
                          {availableRegions.length} accessible regions found
                        </span>
                      ) : null}
                    </div>

                    <div className="flex gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => setAllRegionsSelected(true)}
                        className={clsx(
                          'px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors',
                          allRegionsSelected
                            ? 'bg-blue-600/30 border-blue-500 text-blue-200'
                            : 'bg-gray-700/40 border-gray-600 text-gray-400 hover:text-gray-200'
                        )}
                      >
                        All Accessible Regions
                      </button>
                      <button
                        type="button"
                        onClick={() => setAllRegionsSelected(false)}
                        className={clsx(
                          'px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors',
                          !allRegionsSelected
                            ? 'bg-blue-600/30 border-blue-500 text-blue-200'
                            : 'bg-gray-700/40 border-gray-600 text-gray-400 hover:text-gray-200'
                        )}
                      >
                        Select Specific Regions
                      </button>
                    </div>

                    {!allRegionsSelected && availableRegions.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto p-2 bg-gray-900/60 rounded-lg border border-gray-700">
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
                                'text-xs px-2.5 py-1 rounded-md border transition-colors',
                                isChecked
                                  ? 'bg-blue-600 text-white border-blue-500'
                                  : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-white'
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
                      className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2"
                    >
                      <Layers className="w-4 h-4" />
                      Discover & Import Existing Infrastructure →
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Connect new account */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
              <p className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-3">
                Connect New {selected === 'aws' ? 'AWS' : 'Azure'} Account
              </p>

              {selected === 'aws' && (
                <div className="space-y-3">
                  <div className="bg-blue-900/20 border border-blue-800 rounded-lg p-3 text-xs text-blue-300">
                    <p className="font-medium mb-1">Required: IAM Cross-Account Role</p>
                    <p className="text-blue-400">Create an IAM role in your AWS account with <strong>ReadOnlyAccess</strong> and add CloudCraft as a trusted principal. Credentials are stored server-side only.</p>
                  </div>
                  <input
                    type="text"
                    placeholder="Account name (optional)"
                    value={accountName}
                    onChange={(e) => setAccountName(e.target.value)}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <input
                    type="text"
                    placeholder="Role ARN (arn:aws:iam::123456789012:role/CloudCraftReadOnly)"
                    value={awsForm.roleArn}
                    onChange={(e) => setAwsForm((f) => ({ ...f, roleArn: e.target.value }))}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <input
                    type="text"
                    placeholder="External ID (shared secret)"
                    value={awsForm.externalId}
                    onChange={(e) => setAwsForm((f) => ({ ...f, externalId: e.target.value }))}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <select
                    value={awsForm.region}
                    onChange={(e) => setAwsForm((f) => ({ ...f, region: e.target.value }))}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                  >
                    {['us-east-1','us-east-2','us-west-1','us-west-2','eu-west-1','eu-central-1','ap-southeast-1','ap-northeast-1'].map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  <button
                    onClick={handleConnectAws}
                    disabled={connecting}
                    className="w-full py-2.5 bg-orange-700 hover:bg-orange-600 disabled:opacity-40 text-white rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2"
                  >
                    {connecting ? <><Loader2 className="w-4 h-4 animate-spin" /> Connecting…</> : 'Connect AWS Account'}
                  </button>
                </div>
              )}

              {selected === 'azure' && (
                <div className="space-y-3">
                  <div className="bg-blue-900/20 border border-blue-800 rounded-lg p-3 text-xs text-blue-300">
                    <p className="font-medium mb-1">Required: Azure Service Principal</p>
                    <p className="text-blue-400">Create a service principal with <strong>Reader</strong> role on your subscription. Credentials are stored server-side only.</p>
                  </div>
                  <input
                    type="text"
                    placeholder="Account name (optional)"
                    value={accountName}
                    onChange={(e) => setAccountName(e.target.value)}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <input
                    type="text"
                    placeholder="Tenant ID"
                    value={azureForm.tenantId}
                    onChange={(e) => setAzureForm((f) => ({ ...f, tenantId: e.target.value }))}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <input
                    type="text"
                    placeholder="Client ID (Application ID)"
                    value={azureForm.clientId}
                    onChange={(e) => setAzureForm((f) => ({ ...f, clientId: e.target.value }))}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <input
                    type="password"
                    placeholder="Client Secret"
                    value={azureForm.clientSecret}
                    onChange={(e) => setAzureForm((f) => ({ ...f, clientSecret: e.target.value }))}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <input
                    type="text"
                    placeholder="Subscription ID"
                    value={azureForm.subscriptionId}
                    onChange={(e) => setAzureForm((f) => ({ ...f, subscriptionId: e.target.value }))}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={handleConnectAzure}
                    disabled={connecting}
                    className="w-full py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2"
                  >
                    {connecting ? <><Loader2 className="w-4 h-4 animate-spin" /> Connecting…</> : 'Connect Azure Account'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Step: file-drop ─────────────────────────────────────────── */}
        {step === 'file-drop' && (
          <div className="space-y-4">
            <button onClick={reset} className="text-gray-500 hover:text-gray-300 text-xs flex items-center gap-1 mb-1">
              ← Back
            </button>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); void handleFileDrop(); }}
              className={clsx(
                'border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer',
                dragOver ? 'border-blue-500 bg-blue-900/10' : 'border-gray-700 hover:border-gray-600',
              )}
              onClick={() => void handleFileDrop()}
            >
              <FileCode2 className="w-8 h-8 text-gray-600 mx-auto mb-3" />
              <p className="text-gray-400 text-sm font-medium">
                Drop your {selected === 'terraform' ? '.tf / .tfstate' : '.json'} file here
              </p>
              <p className="text-gray-600 text-xs mt-1">or click to browse</p>
            </div>
          </div>
        )}

        {/* ── Step: discovering ────────────────────────────────────────── */}
        {step === 'discovering' && (
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <p className="text-white font-semibold text-sm">Scanning infrastructure…</p>
              {polling && <RefreshCw className="w-4 h-4 text-blue-400 animate-spin" />}
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
                      isActive ? 'bg-blue-900/20' : isDone ? 'bg-gray-900/50' : '',
                    )}
                  >
                    <div
                      className={clsx(
                        'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                        isDone ? 'bg-emerald-900 text-emerald-400' :
                        isActive ? 'bg-blue-900 text-blue-400' :
                        'bg-gray-700 text-gray-600',
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
                        'text-sm',
                        isDone ? 'text-gray-400' : isActive ? 'text-white' : 'text-gray-600',
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
                <div className="bg-red-900/20 border border-red-800 rounded-xl p-4 flex items-center gap-3">
                  <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
                  <div>
                    <p className="text-red-300 font-medium text-sm">Discovery Failed</p>
                    <p className="text-red-500 text-xs mt-0.5">{discoveryRun.error ?? 'Unknown error'}</p>
                  </div>
                </div>
              ) : (
                <div className="bg-emerald-900/20 border border-emerald-800 rounded-xl p-4 flex items-center gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                  <div>
                    <p className="text-emerald-300 font-medium text-sm">Discovery Complete</p>
                    <p className="text-emerald-400/90 text-xs mt-0.5">
                      Successfully inspected live cloud environment and reconstructed architecture topology.
                    </p>
                  </div>
                </div>
              )}

              {/* Stat Counters */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-gray-800/80 border border-gray-700/80 rounded-xl p-3 text-center">
                  <div className="text-2xl font-bold text-white">{totalResources}</div>
                  <div className="text-xs text-gray-400 mt-0.5">Resources Discovered</div>
                </div>
                <div className="bg-gray-800/80 border border-gray-700/80 rounded-xl p-3 text-center">
                  <div className="text-2xl font-bold text-blue-400">{totalRelationships}</div>
                  <div className="text-xs text-gray-400 mt-0.5">Relationships Found</div>
                </div>
                <div className="bg-gray-800/80 border border-gray-700/80 rounded-xl p-3 text-center">
                  <div className="text-2xl font-bold text-amber-400">{unsupportedCount}</div>
                  <div className="text-xs text-gray-400 mt-0.5">Unsupported / Fallback</div>
                </div>
              </div>

              {/* Safety notice */}
              <div className="bg-blue-950/40 border border-blue-800/60 rounded-xl p-3 flex items-start gap-2.5">
                <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                <p className="text-xs text-blue-300">
                  <strong>Read-Only Safety:</strong> Discovered resources will be imported with an &quot;Imported&quot; badge and live cloud metadata. They will generate Terraform data sources rather than destructive resources.
                </p>
              </div>

              {/* Resource summary */}
              {discoveryRun && Object.keys(discoveryRun.summary).length > 0 && (
                <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
                  <p className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-3">
                    Discovered Resources Breakdown
                  </p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {Object.entries(discoveryRun.summary).map(([type, count]) => (
                      <div key={type} className="flex items-center gap-2 text-gray-300">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                        <span>{count} × {type}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  onClick={reset}
                  className="px-4 py-2.5 border border-gray-700 text-gray-400 hover:text-white rounded-xl text-sm transition-colors"
                >
                  Start Over
                </button>
                {activeProject && (
                  <button
                    onClick={() => handleImport('update')}
                    disabled={discoveryRun?.status === 'failed'}
                    className="flex-1 py-2.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2"
                  >
                    <Layers className="w-4 h-4" />
                    Safe Merge to Current Architecture
                  </button>
                )}
                <button
                  onClick={() => handleImport('new')}
                  disabled={discoveryRun?.status === 'failed'}
                  className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-xl text-sm font-medium transition-colors"
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
