'use client';
import { useEffect, useState, useRef } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { ApiTerraformExecutionService, type TerraformPlanResult, type TerraformApplyStatus } from '@/lib/services/ApiTerraformExecutionService';
import { ApiReviewService } from '@/lib/services/ApiReviewService';
import type { ArchitectureReview } from '@/lib/services/ArchitectureReviewService';
import type { TerraformStateBackendConfig } from '@/lib/terraform/execution/types';
import {
  CloudCog, Loader2, CheckCircle2, XCircle, AlertTriangle, ShieldAlert, Plus, ArrowRightLeft,
  Terminal, Database, Globe, Layers, Server, Shield, Box, Activity, Cpu, Search, Clock, Zap
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

function getResourceIcon(type: string, address: string) {
  const lower = (type + ' ' + address).toLowerCase();
  if (lower.includes('db') || lower.includes('rds') || lower.includes('dynamo') || lower.includes('sql') || lower.includes('redis') || lower.includes('cache')) {
    return Database;
  }
  if (lower.includes('cloudfront') || lower.includes('cdn') || lower.includes('dns') || lower.includes('route53')) {
    return Globe;
  }
  if (lower.includes('ecs') || lower.includes('eks') || lower.includes('cluster') || lower.includes('task') || lower.includes('service')) {
    return Layers;
  }
  if (lower.includes('lb') || lower.includes('load') || lower.includes('target') || lower.includes('ec2') || lower.includes('vm') || lower.includes('instance')) {
    return Server;
  }
  if (lower.includes('security') || lower.includes('iam') || lower.includes('role') || lower.includes('policy') || lower.includes('waf') || lower.includes('acl')) {
    return Shield;
  }
  if (lower.includes('s3') || lower.includes('bucket') || lower.includes('storage') || lower.includes('blob')) {
    return Box;
  }
  if (lower.includes('log') || lower.includes('watch') || lower.includes('metric') || lower.includes('alarm') || lower.includes('auto') || lower.includes('scale')) {
    return Activity;
  }
  return Cpu;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

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

  // Live progress tracking
  const [completedCount, setCompletedCount] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'completed' | 'in_progress' | 'queued'>('all');

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const progressTimerRef = useRef<NodeJS.Timeout | null>(null);

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

  // Track timer and simulated progress while applying
  useEffect(() => {
    if (applying) {
      setElapsedSeconds(0);
      setCompletedCount(0);
      timerRef.current = setInterval(() => {
        setElapsedSeconds((s) => s + 1);
      }, 1000);

      const totalResources = plan?.summary.resourceChanges.length ?? 1;
      progressTimerRef.current = setInterval(() => {
        setCompletedCount((prev) => {
          if (prev < Math.max(1, totalResources - 1)) {
            return prev + 1;
          }
          return prev;
        });
      }, 2500);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    };
  }, [applying, plan?.summary.resourceChanges.length]);

  // When apply completes successfully, set progress to 100%
  useEffect(() => {
    if (applyStatus?.state === 'completed') {
      const total = plan?.summary.resourceChanges.length ?? 0;
      setCompletedCount(total);
      if (timerRef.current) clearInterval(timerRef.current);
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    }
  }, [applyStatus?.state, plan?.summary.resourceChanges.length]);

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
    setCompletedCount(0);
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
    setCompletedCount(0);
    setElapsedSeconds(0);
  }

  if (!isAdmin) return null;

  const resourceChanges = plan?.summary.resourceChanges ?? [];
  const totalResources = resourceChanges.length;
  const isAllDone = applyStatus?.state === 'completed' || completedCount >= totalResources;
  const progressPercent = totalResources > 0 ? Math.min(100, Math.round((completedCount / totalResources) * 100)) : 0;

  const filteredResources = resourceChanges.filter((rc, idx) => {
    const isDone = isAllDone || idx < completedCount;
    const isRunning = applying && idx === completedCount;
    const isQueued = !isDone && !isRunning;

    if (filterMode === 'completed' && !isDone) return false;
    if (filterMode === 'in_progress' && !isRunning) return false;
    if (filterMode === 'queued' && !isQueued) return false;

    if (searchQuery.trim()) {
      return rc.address.toLowerCase().includes(searchQuery.toLowerCase()) || rc.type.toLowerCase().includes(searchQuery.toLowerCase());
    }
    return true;
  });

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
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 shadow-xl">
              {/* Header */}
              <div className="flex items-center justify-between mb-3 border-b border-gray-800 pb-2.5">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                  <p className="text-white text-xs font-bold uppercase tracking-wider">
                    {applying ? 'Live Deployment In Progress' : isAllDone ? 'Deployment Completed' : 'Plan Ready for Apply'}
                  </p>
                </div>
                <span className="font-mono text-[10px] text-gray-500 bg-gray-950 px-2 py-0.5 rounded border border-gray-800">
                  SHA: {plan.planHash.slice(0, 10)}…
                </span>
              </div>

              {/* Summary Stats */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs mb-3 bg-gray-950/60 p-2.5 rounded-lg border border-gray-800">
                <div className="flex gap-3">
                  <span className="flex items-center gap-1 text-emerald-400 font-medium"><Plus className="w-3.5 h-3.5" /> {plan.summary.toAdd} to add</span>
                  <span className="flex items-center gap-1 text-amber-400 font-medium">~ {plan.summary.toChange} to change</span>
                  <span className="text-gray-500">0 to destroy (blocked)</span>
                </div>
                {applying && (
                  <div className="flex items-center gap-2 text-xs text-indigo-300 font-mono">
                    <Clock className="w-3.5 h-3.5 animate-spin" /> Elapsed: {formatDuration(elapsedSeconds)}
                  </div>
                )}
              </div>

              {/* Overall Progress Bar (Shown while applying or completed) */}
              {(applying || applyJobId) && (
                <div className="mb-4 bg-gray-950 border border-gray-800 rounded-xl p-3.5 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-300 font-semibold flex items-center gap-1.5">
                      {isAllDone ? (
                        <>
                          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          <span className="text-emerald-300">All {totalResources} Services Provisioned</span>
                        </>
                      ) : (
                        <>
                          <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                          <span>Provisioning Infrastructure ({completedCount} of {totalResources} Complete)</span>
                        </>
                      )}
                    </span>
                    <span className="font-bold text-xs text-white">{progressPercent}%</span>
                  </div>

                  {/* Animated Progress Bar */}
                  <div className="w-full bg-gray-900 rounded-full h-2.5 overflow-hidden p-0.5 border border-gray-800">
                    <div
                      style={{ width: `${progressPercent}%` }}
                      className={clsx(
                        'h-full rounded-full transition-all duration-500 ease-out shadow-sm',
                        isAllDone
                          ? 'bg-gradient-to-r from-emerald-500 to-teal-400 shadow-emerald-500/30'
                          : 'bg-gradient-to-r from-blue-500 via-indigo-500 to-emerald-400 animate-pulse'
                      )}
                    />
                  </div>
                </div>
              )}

              {/* Search & Filter for Services */}
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-gray-400 text-xs font-semibold">
                  Target Cloud Services ({resourceChanges.length})
                </p>
                <div className="flex items-center gap-1.5">
                  <div className="relative">
                    <Search className="w-3 h-3 text-gray-500 absolute left-2 top-2" />
                    <input
                      placeholder="Search service..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="bg-gray-950 border border-gray-800 rounded-lg pl-6 pr-2 py-1 text-[11px] text-white focus:outline-none focus:ring-1 focus:ring-emerald-500 w-32 sm:w-40"
                    />
                  </div>
                  <div className="flex bg-gray-950 border border-gray-800 rounded-lg p-0.5 text-[10px]">
                    <button
                      onClick={() => setFilterMode('all')}
                      className={clsx('px-2 py-0.5 rounded font-medium transition-colors', filterMode === 'all' ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300')}
                    >
                      All
                    </button>
                    {(applying || applyJobId) && (
                      <>
                        <button
                          onClick={() => setFilterMode('completed')}
                          className={clsx('px-2 py-0.5 rounded font-medium transition-colors', filterMode === 'completed' ? 'bg-emerald-950 text-emerald-300' : 'text-gray-500 hover:text-gray-300')}
                        >
                          Done
                        </button>
                        <button
                          onClick={() => setFilterMode('in_progress')}
                          className={clsx('px-2 py-0.5 rounded font-medium transition-colors', filterMode === 'in_progress' ? 'bg-blue-950 text-blue-300' : 'text-gray-500 hover:text-gray-300')}
                        >
                          Active
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Resource-by-Resource Live Status List */}
              {resourceChanges.length > 0 && (
                <div className="max-h-60 overflow-y-auto bg-gray-950 rounded-xl p-2 mb-3 border border-gray-800 space-y-1.5 custom-scrollbar">
                  {filteredResources.map((rc) => {
                    const originalIdx = resourceChanges.findIndex((r) => r.address === rc.address);
                    const isDone = isAllDone || originalIdx < completedCount;
                    const isRunning = applying && originalIdx === completedCount;
                    const isQueued = !isDone && !isRunning;
                    const Icon = getResourceIcon(rc.type, rc.address);

                    return (
                      <div
                        key={rc.address}
                        className={clsx(
                          'flex items-center justify-between p-2 rounded-lg border text-xs transition-all',
                          isDone
                            ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-200'
                            : isRunning
                            ? 'bg-blue-950/40 border-blue-500/50 text-blue-200 shadow-sm shadow-blue-500/10'
                            : 'bg-gray-900/40 border-gray-800/80 text-gray-400'
                        )}
                      >
                        <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
                          <div
                            className={clsx(
                              'w-6 h-6 rounded-md flex items-center justify-center shrink-0 border',
                              isDone
                                ? 'bg-emerald-900/40 border-emerald-500/40 text-emerald-300'
                                : isRunning
                                ? 'bg-blue-900/40 border-blue-500/50 text-blue-300'
                                : 'bg-gray-800 border-gray-700 text-gray-500'
                            )}
                          >
                            <Icon className="w-3.5 h-3.5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className={clsx('font-mono text-[11px] truncate font-medium', isDone ? 'text-emerald-200' : isRunning ? 'text-white' : 'text-gray-300')}>
                              {rc.address}
                            </p>
                            {/* Individual Mini Progress Bar for each item */}
                            <div className="w-full bg-gray-900 rounded-full h-1 mt-1 overflow-hidden">
                              <div
                                className={clsx(
                                  'h-full transition-all duration-300',
                                  isDone
                                    ? 'w-full bg-emerald-400'
                                    : isRunning
                                    ? 'w-2/3 bg-blue-400 animate-pulse'
                                    : 'w-0 bg-gray-700'
                                )}
                              />
                            </div>
                          </div>
                        </div>

                        {/* Status Badges with Ticks */}
                        <div className="shrink-0 flex items-center gap-1.5">
                          {isDone ? (
                            <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-900/50 border border-emerald-500/40 text-emerald-300 text-[10px] font-semibold">
                              <CheckCircle2 className="w-3 h-3 text-emerald-400" /> Done
                            </span>
                          ) : isRunning ? (
                            <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-900/60 border border-blue-500/50 text-blue-300 text-[10px] font-semibold animate-pulse">
                              <Loader2 className="w-3 h-3 animate-spin text-blue-400" /> Applying
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-900 border border-gray-800 text-gray-500 text-[10px]">
                              <Clock className="w-3 h-3" /> Queued
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Action Buttons */}
              {!applyJobId ? (
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={handleConfirmApply}
                    disabled={applying}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white transition-all shadow-lg shadow-emerald-600/20"
                  >
                    {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                    Confirm &amp; Apply to AWS
                  </button>
                  <button onClick={resetPlan} className="px-3 py-2 rounded-lg text-xs font-medium bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400">
                    Discard
                  </button>
                </div>
              ) : (
                <div className="pt-2">
                  {applyStatus?.state === 'completed' && (
                    <div className="p-3.5 rounded-xl bg-emerald-950/60 border border-emerald-500/50 text-emerald-300 text-xs shadow-lg">
                      <div className="flex items-center gap-2 mb-1.5 font-semibold text-sm">
                        <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                        <span>All Infrastructure Successfully Provisioned in AWS!</span>
                      </div>
                      <p className="text-[11px] text-emerald-400/90">{applyStatus.output?.message}</p>
                      {applyStatus.output?.outputTail && (
                        <details className="mt-2.5 bg-gray-950/80 rounded-lg p-2 border border-emerald-900/40">
                          <summary className="cursor-pointer text-emerald-400/90 font-medium">View Live Terraform Console Output</summary>
                          <div className="mt-2 bg-black rounded-lg p-2.5 flex items-start gap-2 max-h-40 overflow-y-auto">
                            <Terminal className="w-3.5 h-3.5 text-gray-500 mt-0.5 shrink-0" />
                            <pre className="text-[10px] text-gray-300 font-mono whitespace-pre-wrap">{applyStatus.output.outputTail}</pre>
                          </div>
                        </details>
                      )}
                      <button onClick={resetPlan} className="mt-3 px-3 py-1.5 rounded-lg bg-emerald-800 hover:bg-emerald-700 text-white font-medium text-xs transition-colors">
                        Start a new deployment
                      </button>
                    </div>
                  )}
                  {(applyStatus?.state === 'failed' || applyError) && (
                    <div className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-500/50 text-rose-300 text-xs shadow-lg">
                      <div className="flex items-center gap-2 mb-1.5 font-semibold">
                        <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
                        <span>Deployment encountered an issue</span>
                      </div>
                      <p className="text-[11px] text-rose-300/90 bg-black/40 p-2 rounded border border-rose-900/30 font-mono">
                        {applyStatus?.output?.message ?? applyError}
                      </p>
                      <button onClick={resetPlan} className="mt-2.5 text-xs text-rose-400 hover:text-rose-200 underline font-medium">
                        Re-plan and try again
                      </button>
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
