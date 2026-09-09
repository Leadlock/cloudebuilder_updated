import { useState } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { normalizeDiscoveredInfrastructure } from '@/lib/cloud/normalizer';
import type { DiscoveredResource } from '@/lib/cloud/types';
import type { CanvasNode, CanvasEdge } from '@/types';
import { apiArchitectureService } from '@/lib/services/ApiArchitectureService';
import {
  Upload, Cloud, FileCode2, CheckCircle2, Loader2,
  Server, Network, Database, HardDrive, AlertTriangle, RefreshCw,
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
  { icon: Network, label: 'Scanning networks...' },
  { icon: Server, label: 'Discovering compute instances...' },
  { icon: Database, label: 'Discovering databases...' },
  { icon: HardDrive, label: 'Discovering storage...' },
  { icon: Cloud, label: 'Building architecture diagram...' },
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

  // ── Helpers ────────────────────────────────────────────────────────────

  function reset() {
    setStep('select-source');
    setSelected(null);
    setAccounts([]);
    setSelectedAccountId(null);
    setDiscoveryRun(null);
    setDiscoveryStep(-1);
    setPolling(false);
    setError(null);
    setAwsForm({ roleArn: '', externalId: '', region: 'us-east-1' });
    setAzureForm({ tenantId: '', clientId: '', clientSecret: '', subscriptionId: '' });
    setAccountName('');
    setConnecting(false);
  }

  async function fetchAccounts(provider: string) {
    try {
      const res = await fetch(`/api/cloud-accounts?provider=${provider}`);
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'aws',
          name: accountName || `AWS (${awsForm.region})`,
          // Credentials go directly to backend — never stored in React context
          credentials: awsForm,
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
      await fetch(`/api/cloud-accounts/${accountId}/validate`, { method: 'POST' });
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
      const res = await fetch(`/api/cloud-accounts/${accountId}/discover`, { method: 'POST' });
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
        const res = await fetch(`/api/cloud-accounts/${accountId}/discovery?runId=${runId}`);
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
    const { nodes, edges } = normalizeDiscoveredInfrastructure(discoveryRun.resources);

    if (nodes.length === 0) {
      setError('Discovered resources could not be normalized into valid canvas nodes.');
      return;
    }

    if (mode === 'update' && activeProject) {
      if (selectedAccountId && discoveryRun.id && discoveryRun.id !== 'file-import') {
        try {
          const res = await fetch(`/api/cloud-accounts/${selectedAccountId}/discovery/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              runId: discoveryRun.id,
              environmentId: activeProject.id,
              merge: false,
            }),
          });
          const data = await res.json() as { ok: boolean; data?: { nodes: CanvasNode[]; edges: CanvasEdge[] }; error?: { message: string } };
          if (data.ok && data.data) {
            dispatch({ type: 'UPDATE_CANVAS', nodes: data.data.nodes, edges: data.data.edges });
            dispatch({ type: 'SET_VIEW', view: 'canvas' });
            return;
          }
        } catch {
          // Fall through
        }
      }

      dispatch({ type: 'UPDATE_CANVAS', nodes, edges });
      dispatch({ type: 'SET_VIEW', view: 'canvas' });
      apiArchitectureService.saveCanvas(activeProject.id, nodes, edges, activeEnvironment).catch(() => {});
      return;
    }

    dispatch({
      type: 'CREATE_PROJECT',
      provider,
      name: `Discovered — ${provider.toUpperCase()} (${nodes.length} resources)`,
      nodes,
      edges,
    });
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

            {/* Existing accounts */}
            {accounts.length > 0 && (
              <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
                <p className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-3">Connected Accounts</p>
                <div className="space-y-2">
                  {accounts.map((acct) => (
                    <button
                      key={acct.id}
                      onClick={() => setSelectedAccountId(acct.id)}
                      className={clsx(
                        'w-full flex items-center justify-between p-3 rounded-lg border transition-colors text-left',
                        selectedAccountId === acct.id
                          ? 'border-blue-500 bg-blue-900/20'
                          : 'border-gray-700 hover:bg-gray-700/50',
                      )}
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
                  ))}
                </div>
                {selectedAccountId && (
                  <button
                    onClick={() => startDiscovery(selectedAccountId)}
                    className="mt-4 w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-sm font-medium transition-colors"
                  >
                    Start Discovery →
                  </button>
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
        {step === 'results' && (
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
                  <p className="text-emerald-700 text-xs mt-0.5">
                    {discoveryRun
                      ? `${Object.values(discoveryRun.summary).reduce((a, b) => a + b, 0)} resources discovered`
                      : '8 resources discovered across 2 availability zones'}
                  </p>
                </div>
              </div>
            )}

            {/* Resource summary */}
            {discoveryRun && Object.keys(discoveryRun.summary).length > 0 && (
              <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
                <p className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-3">
                  Discovered Resources
                </p>
                <div className="space-y-2 text-sm">
                  {Object.entries(discoveryRun.summary).map(([type, count]) => (
                    <div key={type} className="flex items-center gap-2 text-gray-300">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      {count} × {type}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={reset}
                className="flex-1 py-2 border border-gray-700 text-gray-400 hover:text-white rounded-xl text-sm transition-colors"
              >
                Start Over
              </button>
              {activeProject && (
                <button
                  onClick={() => handleImport('update')}
                  disabled={discoveryRun?.status === 'failed'}
                  className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-xl text-sm font-medium transition-colors"
                >
                  Import to Current
                </button>
              )}
              <button
                onClick={() => handleImport('new')}
                disabled={discoveryRun?.status === 'failed'}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-xl text-sm font-medium transition-colors"
              >
                {activeProject ? 'Open as New Project' : 'Open in Canvas →'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
