'use client';
import { useEffect, useState } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { ApiTerraformExecutionService, type TerraformPlanResult, type TerraformApplyStatus } from '@/lib/services/ApiTerraformExecutionService';
import { ApiReviewService } from '@/lib/services/ApiReviewService';
import type { ArchitectureReview } from '@/lib/services/ArchitectureReviewService';
import type { TerraformStateBackendConfig } from '@/lib/terraform/execution/types';
import {
  CloudCog, Loader2, CheckCircle2, XCircle, AlertTriangle, ShieldAlert, Plus, ArrowRightLeft, Terminal,
} from 'lucide-react';
import clsx from 'clsx';

interface CloudAccount {
  id: string;
  provider: string;
  name: string;
  status: string;
}

type AwsBackendForm = { bucket: string; key: string; region: string; dynamodbTable: string };
type AzureBackendForm = { resourceGroupName: string; storageAccountName: string; containerName: string; key: string };

export default function TerraformExecutionPanel() {
  const { state } = useApp();
  const activeProject = useActiveProject();
  const currentUser = state.currentUser ?? { id: 'usr-admin-1', role: 'admin' as const, name: 'Cloud Administrator', email: 'admin@cloudcraft.io', orgId: '' };
  const isAdmin = currentUser.role === 'admin';

  const [latestReview, setLatestReview] = useState<ArchitectureReview | null>(null);
  const isApproved = latestReview?.status === 'approved';

  const defaultProvider: 'aws' | 'azure' = activeProject?.provider === 'azure' ? 'azure' : 'aws';
  const [backendProvider, setBackendProvider] = useState<'aws' | 'azure'>(defaultProvider);
  const [accounts, setAccounts] = useState<CloudAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [loadingAccounts, setLoadingAccounts] = useState(false);

  const [awsBackend, setAwsBackend] = useState<AwsBackendForm>({ bucket: '', key: '', region: 'us-east-1', dynamodbTable: '' });
  const [azureBackend, setAzureBackend] = useState<AzureBackendForm>({ resourceGroupName: '', storageAccountName: '', containerName: '', key: '' });

  const [plan, setPlan] = useState<TerraformPlanResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [applyJobId, setApplyJobId] = useState<string | null>(null);
  const [applyStatus, setApplyStatus] = useState<TerraformApplyStatus | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProject) return;
    const projectId = activeProject.id;
    ApiReviewService.getReviews(projectId, state.activeEnvironment)
      .then((data) => setLatestReview(data.latest))
      .catch(() => {});
  }, [activeProject, state.activeEnvironment]);

  useEffect(() => {
    let cancelled = false;
    setLoadingAccounts(true);
    fetch(`/api/cloud-accounts?provider=${backendProvider}`)
      .then((r) => r.json())
      .then((data: { ok: boolean; data: CloudAccount[] }) => {
        if (cancelled) return;
        setAccounts(data.ok ? data.data.filter((a) => a.provider === backendProvider) : []);
        setSelectedAccountId('');
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingAccounts(false);
      });
    return () => { cancelled = true; };
  }, [backendProvider]);

  if (!activeProject) return null;

  function backendReady(): boolean {
    if (backendProvider === 'aws') return Boolean(awsBackend.bucket && awsBackend.key && awsBackend.region);
    return Boolean(azureBackend.resourceGroupName && azureBackend.storageAccountName && azureBackend.containerName && azureBackend.key);
  }

  function buildBackend(): TerraformStateBackendConfig {
    if (backendProvider === 'aws') {
      return {
        provider: 'aws',
        bucket: awsBackend.bucket,
        key: awsBackend.key,
        region: awsBackend.region,
        ...(awsBackend.dynamodbTable ? { dynamodbTable: awsBackend.dynamodbTable } : {}),
      };
    }
    return {
      provider: 'azure',
      resourceGroupName: azureBackend.resourceGroupName,
      storageAccountName: azureBackend.storageAccountName,
      containerName: azureBackend.containerName,
      key: azureBackend.key,
    };
  }

  async function handleGeneratePlan() {
    if (!activeProject || !selectedAccountId) return;
    setPlanning(true);
    setPlanError(null);
    setPlan(null);
    setApplyStatus(null);
    setApplyJobId(null);
    setApplyError(null);
    try {
      const result = await ApiTerraformExecutionService.generatePlan(
        activeProject.id,
        state.activeEnvironment,
        selectedAccountId,
        buildBackend(),
        currentUser,
      );
      setPlan(result);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Plan generation failed');
    } finally {
      setPlanning(false);
    }
  }

  async function handleConfirmApply() {
    if (!activeProject || !plan) return;
    setApplying(true);
    setApplyError(null);
    try {
      const { jobId } = await ApiTerraformExecutionService.confirmApply(activeProject.id, plan.planId, plan.planHash, currentUser);
      setApplyJobId(jobId);
      pollApplyStatus(activeProject.id, jobId);
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'Apply failed to start');
      setApplying(false);
    }
  }

  function pollApplyStatus(projectId: string, jobId: string) {
    const interval = setInterval(async () => {
      try {
        const status = await ApiTerraformExecutionService.getApplyStatus(projectId, jobId, currentUser);
        setApplyStatus(status);
        if (status.state === 'completed' || status.state === 'failed' || status.state === 'unknown') {
          clearInterval(interval);
          setApplying(false);
          if (status.state === 'unknown') setApplyError('Apply job could not be found — it may have expired before the worker picked it up.');
        }
      } catch (err) {
        clearInterval(interval);
        setApplying(false);
        setApplyError(err instanceof Error ? err.message : 'Failed to poll apply status');
      }
    }, 3000);
  }

  function resetPlan() {
    setPlan(null);
    setPlanError(null);
    setApplyJobId(null);
    setApplyStatus(null);
    setApplyError(null);
  }

  if (!isAdmin) return null;

  return (
    <div className="mt-6 bg-gray-800/50 border border-emerald-900/40 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <CloudCog className="w-4 h-4 text-emerald-400" />
        <h3 className="text-white font-semibold text-sm">Real Infrastructure Deployment</h3>
        <span className="text-[10px] px-2 py-0.5 bg-emerald-900/40 text-emerald-300 border border-emerald-800 rounded-full font-medium">Live</span>
      </div>
      <p className="text-gray-500 text-xs mb-4">
        Runs actual <code className="text-gray-400">terraform plan</code> / <code className="text-gray-400">apply</code> against a connected cloud account.
        Destroy actions are always refused. A remote state backend is required.
      </p>

      {!isApproved ? (
        <div className="p-3 rounded-lg bg-amber-950/40 border border-amber-500/40 text-amber-300 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>Formal Architecture Review approval is required before a Terraform plan can be generated.</span>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Provider + account selection */}
          {activeProject.provider === 'multi' && (
            <div className="flex gap-2">
              {(['aws', 'azure'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setBackendProvider(p)}
                  className={clsx(
                    'px-3 py-1 rounded-lg text-xs font-medium border transition-colors',
                    backendProvider === p ? 'bg-emerald-700 border-emerald-600 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-600',
                  )}
                >
                  {p.toUpperCase()}
                </button>
              ))}
            </div>
          )}

          <div>
            <label htmlFor="tf-account" className="block text-gray-400 text-xs mb-1">Cloud Account</label>
            {loadingAccounts ? (
              <div className="flex items-center gap-2 text-gray-500 text-xs"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading connected accounts…</div>
            ) : accounts.length === 0 ? (
              <p className="text-gray-600 text-xs">No connected {backendProvider.toUpperCase()} accounts. Connect one from the Import panel first.</p>
            ) : (
              <select
                id="tf-account"
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="">Select an account…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({a.status})</option>
                ))}
              </select>
            )}
          </div>

          {/* State backend form */}
          <div>
            <p className="text-gray-400 text-xs mb-1.5">Remote State Backend (must already exist — CloudCraft does not provision it)</p>
            {backendProvider === 'aws' ? (
              <div className="grid grid-cols-2 gap-2">
                <input placeholder="S3 bucket" value={awsBackend.bucket} onChange={(e) => setAwsBackend({ ...awsBackend, bucket: e.target.value })}
                  className="bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                <input placeholder="State key (path)" value={awsBackend.key} onChange={(e) => setAwsBackend({ ...awsBackend, key: e.target.value })}
                  className="bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                <input placeholder="Region" value={awsBackend.region} onChange={(e) => setAwsBackend({ ...awsBackend, region: e.target.value })}
                  className="bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                <input placeholder="DynamoDB lock table (optional)" value={awsBackend.dynamodbTable} onChange={(e) => setAwsBackend({ ...awsBackend, dynamodbTable: e.target.value })}
                  className="bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500" />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <input placeholder="Resource group" value={azureBackend.resourceGroupName} onChange={(e) => setAzureBackend({ ...azureBackend, resourceGroupName: e.target.value })}
                  className="bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                <input placeholder="Storage account" value={azureBackend.storageAccountName} onChange={(e) => setAzureBackend({ ...azureBackend, storageAccountName: e.target.value })}
                  className="bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                <input placeholder="Container" value={azureBackend.containerName} onChange={(e) => setAzureBackend({ ...azureBackend, containerName: e.target.value })}
                  className="bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                <input placeholder="State key (path)" value={azureBackend.key} onChange={(e) => setAzureBackend({ ...azureBackend, key: e.target.value })}
                  className="bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500" />
              </div>
            )}
          </div>

          {!plan && (
            <button
              onClick={handleGeneratePlan}
              disabled={!selectedAccountId || !backendReady() || planning}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed text-white transition-colors"
            >
              {planning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRightLeft className="w-3.5 h-3.5" />}
              {planning ? 'Generating plan…' : 'Generate Terraform Plan'}
            </button>
          )}

          {planError && (
            <div className="p-3 rounded-lg bg-rose-950/60 border border-rose-500/50 text-rose-300 text-xs flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" /> <span>{planError}</span>
            </div>
          )}

          {plan && (
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-white text-xs font-semibold">Plan Ready</p>
                <span className="font-mono text-[10px] text-gray-500">hash: {plan.planHash.slice(0, 12)}…</span>
              </div>
              <div className="flex gap-3 text-xs mb-3">
                <span className="flex items-center gap-1 text-emerald-400"><Plus className="w-3 h-3" /> {plan.summary.toAdd} to add</span>
                <span className="flex items-center gap-1 text-amber-400">~ {plan.summary.toChange} to change</span>
                <span className="text-gray-500">0 to destroy (blocked by policy)</span>
              </div>
              {plan.summary.resourceChanges.length > 0 && (
                <div className="max-h-32 overflow-y-auto bg-gray-950 rounded-lg p-2 mb-3">
                  {plan.summary.resourceChanges.map((rc) => (
                    <p key={rc.address} className="font-mono text-[11px] text-gray-400">
                      <span className={rc.actions.includes('create') ? 'text-emerald-400' : 'text-amber-400'}>
                        {rc.actions.includes('create') ? '+' : '~'}
                      </span> {rc.address}
                    </p>
                  ))}
                </div>
              )}

              {!applyJobId ? (
                <div className="flex gap-2">
                  <button
                    onClick={handleConfirmApply}
                    disabled={applying}
                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60 text-white transition-colors"
                  >
                    {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                    Confirm &amp; Apply This Plan
                  </button>
                  <button onClick={resetPlan} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400">
                    Discard
                  </button>
                </div>
              ) : (
                <div>
                  {(!applyStatus || applyStatus.state === 'pending' || applyStatus.state === 'active') && (
                    <div className="flex items-center gap-2 text-blue-300 text-xs">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Applying to {state.activeEnvironment}…
                    </div>
                  )}
                  {applyStatus?.state === 'completed' && (
                    <div className="p-3 rounded-lg bg-emerald-950/60 border border-emerald-500/50 text-emerald-300 text-xs">
                      <div className="flex items-center gap-2 mb-1"><CheckCircle2 className="w-4 h-4" /> {applyStatus.output?.message}</div>
                      {applyStatus.output?.outputTail && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-emerald-400/80">View terraform output</summary>
                          <div className="mt-1 bg-gray-950 rounded-lg p-2 flex items-start gap-2">
                            <Terminal className="w-3.5 h-3.5 text-gray-600 mt-0.5 shrink-0" />
                            <pre className="text-[11px] text-gray-300 font-mono whitespace-pre-wrap">{applyStatus.output.outputTail}</pre>
                          </div>
                        </details>
                      )}
                      <button onClick={resetPlan} className="mt-2 text-[11px] text-emerald-400/80 hover:text-emerald-300 underline">Start a new deployment</button>
                    </div>
                  )}
                  {(applyStatus?.state === 'failed' || applyError) && (
                    <div className="p-3 rounded-lg bg-rose-950/60 border border-rose-500/50 text-rose-300 text-xs">
                      <div className="flex items-center gap-2 mb-1"><XCircle className="w-4 h-4" /> {applyStatus?.output?.message ?? applyError}</div>
                      <button onClick={resetPlan} className="mt-1 text-[11px] text-rose-400/80 hover:text-rose-300 underline">Re-plan and try again</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
