'use client';
import { useEffect, useState, useRef } from 'react';
import { useApp, useActiveProject } from '@/context/AppContext';
import { ApiTerraformExecutionService, type TerraformPlanResult, type TerraformApplyStatus, type TerraformDestroyPreview, type TerraformRunSnapshot } from '@/lib/services/ApiTerraformExecutionService';
import { ApiReviewService } from '@/lib/services/ApiReviewService';
import type { ArchitectureReview } from '@/lib/services/ArchitectureReviewService';
import type { TerraformStateBackendConfig } from '@/lib/terraform/execution/types';
import {
  CloudCog, Loader2, CheckCircle2, XCircle, AlertTriangle, ShieldAlert, Plus, ArrowRightLeft,
  Terminal, Database, Globe, Layers, Server, Shield, Box, Activity, Cpu, Search, Clock, Zap,
  Trash2, AlertOctagon, Flame
} from 'lucide-react';
import clsx from 'clsx';
import TerraformLimitsBar from './TerraformLimitsBar';
import TerraformErrorBox from './TerraformErrorBox';
import TerraformApprovalBar, { TerraformApprovalInbox } from './TerraformApprovalBar';
import TerraformWorkerNotice from './TerraformWorkerNotice';
import CreatedResourcesList from './CreatedResourcesList';
import TerraformPermissionHelp from './TerraformPermissionHelp';

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
  // Whether the current plan / teardown preview has an approval from an owner/admin (the server enforces it; this enables the button).
  const [applyApproved, setApplyApproved] = useState(false);
  const [destroyApproved, setDestroyApproved] = useState(false);

  const storageKey = activeProject ? `cloudcraft_tf_state_${activeProject.id}_${state.activeEnvironment}` : null;
  const backendStorageKey = activeProject ? `cloudcraft_tf_backend_${activeProject.id}` : null;

  const defaultProvider: 'aws' | 'azure' =
    activeProject?.provider === 'azure' ||
    (activeProject?.nodes && activeProject.nodes.some((n) => n.resourceType.startsWith('azure_') || n.provider === 'azure'))
      ? 'azure'
      : 'aws';
  const [backendProvider, setBackendProvider] = useState<'aws' | 'azure'>(defaultProvider);
  const [accounts, setAccounts] = useState<CloudAccount[]>([]);
  const [discoveryOnlyCount, setDiscoveryOnlyCount] = useState(0);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [loadingAccounts, setLoadingAccounts] = useState(false);

  const [creatingBackend, setCreatingBackend] = useState(false);
  const [backendCreated, setBackendCreated] = useState<{ what: string; outcome: 'created' | 'already-exists' }[] | null>(null);
  const [backendCreateError, setBackendCreateError] = useState<string | null>(null);
  const [awsBackend, setAwsBackend] = useState<AwsBackendForm>({ bucket: '', key: 'cloudcraft/terraform.tfstate', region: 'eu-north-1', dynamodbTable: '' });
  const [azureBackend, setAzureBackend] = useState<AzureBackendForm>({ resourceGroupName: '', storageAccountName: '', containerName: '', key: '' });

  const [plan, setPlan] = useState<TerraformPlanResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [applyJobId, setApplyJobId] = useState<string | null>(null);
  const [applyRunId, setApplyRunId] = useState<string | null>(null);
  const [applyStatus, setApplyStatus] = useState<TerraformApplyStatus | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  // Destruction state
  const [destroying, setDestroying] = useState(false);
  const [destroyError, setDestroyError] = useState<string | null>(null);
  const [destroySuccess, setDestroySuccess] = useState<string | null>(null);
  const [destroyOutputTail, setDestroyOutputTail] = useState<string | null>(null);
  const [showDestroyModal, setShowDestroyModal] = useState(false);
  // Step 1 of teardown: what would be removed, plus the server's one-time confirmation token.
  const [destroyPreview, setDestroyPreview] = useState<TerraformDestroyPreview | null>(null);
  const [destroyPreviewLoading, setDestroyPreviewLoading] = useState(false);
  const [destroyPreviewError, setDestroyPreviewError] = useState<string | null>(null);
  // The background teardown: its live output and final result. The run id is remembered so a reload can pick it up again.
  const [destroyRun, setDestroyRun] = useState<TerraformRunSnapshot | null>(null);
  const destroyPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [destroyConfirmInput, setDestroyConfirmInput] = useState('');

  // Live progress tracking
  const [completedCount, setCompletedCount] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'completed' | 'in_progress' | 'queued'>('all');

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const progressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // 1. Restore persistent backend and deployment state from localStorage
  const destroyRunKey = (projectId: string) => `cloudcraft_tf_destroy_run_${projectId}`;

  function pollDestroyRun(projectId: string, runId: string) {
    if (destroyPollRef.current) clearInterval(destroyPollRef.current);
    const stop = () => { if (destroyPollRef.current) clearInterval(destroyPollRef.current); try { localStorage.removeItem(destroyRunKey(projectId)); } catch { /* storage unavailable */ } };
    const tick = async () => {
      try {
        const snap = await ApiTerraformExecutionService.getDestroyRun(projectId, runId, currentUser);
        setDestroyRun(snap);
        if (snap.state === 'running') return;
        stop();
        setDestroying(false);
        if (snap.state === 'succeeded') {
          setDestroySuccess(snap.message ?? 'The planned resources were destroyed.');
          setDestroyOutputTail(snap.logTail.join('\n') || null);
          setPlan(null); setApplyStatus(null); setApplyJobId(null);
        } else {
          setDestroyError(snap.error ?? 'Teardown failed');
        }
      } catch (err) {
        if ((err as { status?: number }).status === 404) {
          stop();
          setDestroying(false);
          setDestroyError('CloudCraft lost track of this teardown (the server was restarted while it ran). Check the cloud console for what was removed, then run a new preview.');
        }
        // any other error is a brief network problem: keep polling
      }
    };
    void tick();
    destroyPollRef.current = setInterval(tick, 2000);
  }

  // Declared before the effects that use it.
  function pollApplyStatus(projectId: string, jobId: string, runId?: string | null) {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(async () => {
      try {
        const status = await ApiTerraformExecutionService.getApplyStatus(projectId, jobId, currentUser, runId);
        setApplyStatus(status);
        if (status.state === 'completed' || status.state === 'failed' || status.state === 'unknown') {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setApplying(false);
          if (status.state === 'unknown') setApplyError('Apply job could not be found — it may have expired before the worker picked it up.');
        }
      } catch (err) {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        setApplying(false);
        setApplyError(err instanceof Error ? err.message : 'Failed to poll apply status');
      }
    }, 2000);
  }

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return;
    try {
      // Restore backend config
      if (backendStorageKey) {
        const savedBackend = localStorage.getItem(backendStorageKey);
        if (savedBackend) {
          const parsed = JSON.parse(savedBackend);
          if (parsed.backendProvider) setBackendProvider(parsed.backendProvider);
          if (parsed.selectedAccountId) setSelectedAccountId(parsed.selectedAccountId);
          if (parsed.awsBackend) setAwsBackend(parsed.awsBackend);
          if (parsed.azureBackend) setAzureBackend(parsed.azureBackend);
        }
      }

      // Restore deployment/plan execution state
      const savedState = localStorage.getItem(storageKey);
      if (savedState) {
        const parsed = JSON.parse(savedState);
        if (parsed.plan) setPlan(parsed.plan);
        if (parsed.applyJobId) setApplyJobId(parsed.applyJobId);
        if (parsed.applyRunId) setApplyRunId(parsed.applyRunId);
        if (parsed.applyStatus) setApplyStatus(parsed.applyStatus);
        if (parsed.applying !== undefined) setApplying(parsed.applying);
        if (parsed.planning !== undefined) setPlanning(parsed.planning);
        if (parsed.completedCount !== undefined) setCompletedCount(parsed.completedCount);
        if (parsed.startedAt) {
          setStartedAt(parsed.startedAt);
          const elapsed = Math.max(0, Math.floor((Date.now() - parsed.startedAt) / 1000));
          setElapsedSeconds(elapsed);
        }
        if (parsed.destroySuccess) setDestroySuccess(parsed.destroySuccess);
        if (parsed.destroyError) setDestroyError(parsed.destroyError);
        if (parsed.destroyOutputTail) setDestroyOutputTail(parsed.destroyOutputTail);

        // Resume polling if job is active or in progress
        if (parsed.applyJobId && activeProject && (!parsed.applyStatus || parsed.applyStatus.state === 'active' || parsed.applyStatus.state === 'pending' || parsed.applying)) {
          pollApplyStatus(activeProject.id, parsed.applyJobId, parsed.applyRunId);
        }
      }
    } catch (e) {
      console.warn('Failed to restore Terraform execution state from localStorage', e);
    }
  }, [storageKey, backendStorageKey, activeProject?.id]);

  // 2. Persist backend settings whenever they change
  useEffect(() => {
    if (!backendStorageKey || typeof window === 'undefined') return;
    try {
      localStorage.setItem(backendStorageKey, JSON.stringify({
        backendProvider,
        selectedAccountId,
        awsBackend,
        azureBackend,
      }));
    } catch {}
  }, [backendStorageKey, backendProvider, selectedAccountId, awsBackend, azureBackend]);

  // 3. Persist deployment state whenever it changes
  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        plan,
        applyJobId,
        applyRunId,
        applyStatus,
        applying,
        planning,
        destroying,
        completedCount,
        startedAt,
        destroySuccess,
        destroyError,
        destroyOutputTail,
      }));
    } catch {}
  }, [storageKey, plan, applyJobId, applyRunId, applyStatus, applying, planning, destroying, completedCount, startedAt, destroySuccess, destroyError, destroyOutputTail]);

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
        const ofProvider = data.ok ? data.data.filter((a) => a.provider === backendProvider) : [];
        // An account connected with an access key is for discovery only; Terraform needs a role.
        const list = ofProvider.filter((a) => (a as { identity?: { authMethod?: string } }).identity?.authMethod !== 'access-key');
        setDiscoveryOnlyCount(ofProvider.length - list.length);
        setAccounts(list);
        setSelectedAccountId((prev) => {
          if (prev && list.some((a) => a.id === prev)) return prev;
          return list.length > 0 ? list[0].id : '';
        });
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingAccounts(false);
      });
    return () => { cancelled = true; };
  }, [backendProvider]);

  // Track timer and simulated progress while applying or destroying
  useEffect(() => {
    if (!activeProject) return;
    let runId: string | null = null;
    try { runId = localStorage.getItem(destroyRunKey(activeProject.id)); } catch { /* storage unavailable */ }
    if (runId) { setDestroying(true); pollDestroyRun(activeProject.id, runId); }
    return () => { if (destroyPollRef.current) clearInterval(destroyPollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id]);

  useEffect(() => {
    if (applying || destroying) {
      if (!startedAt) {
        const now = Date.now();
        setStartedAt(now);
        setElapsedSeconds(0);
      } else {
        setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
      }

      timerRef.current = setInterval(() => {
        setElapsedSeconds((s) => s + 1);
      }, 1000);

      // Apply progress is real (read from Terraform's output on the server). Only teardown still estimates.
      const totalResources = plan?.summary.resourceChanges.length ?? 1;
      if (!applying) {
        progressTimerRef.current = setInterval(() => {
          setCompletedCount((prev) => {
            if (prev < Math.max(1, totalResources - 1)) {
              return prev + 1;
            }
            return prev;
          });
        }, 2500);
      }
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    };
  }, [applying, destroying, startedAt, plan?.summary.resourceChanges.length]);

  // When apply completes successfully, set progress to 100%
  useEffect(() => {
    if (applyStatus?.state === 'completed') {
      const total = plan?.summary.resourceChanges.length ?? 0;
      setCompletedCount(total);
      setApplying(false);
      if (timerRef.current) clearInterval(timerRef.current);
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    } else if (applyStatus?.state === 'failed') {
      setApplying(false);
      if (timerRef.current) clearInterval(timerRef.current);
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    }
  }, [applyStatus?.state, plan?.summary.resourceChanges.length]);

  if (!activeProject) return null;

  function backendReady(): boolean {
    if (backendProvider === 'aws') return Boolean(awsBackend.bucket && awsBackend.key && awsBackend.region);
    return Boolean(azureBackend.resourceGroupName && azureBackend.storageAccountName && azureBackend.containerName && azureBackend.key);
  }

  function canCreateBackend(): boolean {
    if (backendProvider === 'aws') return Boolean(awsBackend.region);
    return Boolean(azureBackend.resourceGroupName && azureBackend.storageAccountName && azureBackend.containerName);
  }

  async function handleCreateStateBackend() {
    if (!activeProject || !selectedAccountId) return;
    setCreatingBackend(true);
    setBackendCreateError(null);
    setBackendCreated(null);
    try {
      const body = backendProvider === 'aws'
        ? { provider: 'aws', region: awsBackend.region, ...(awsBackend.bucket ? { bucket: awsBackend.bucket } : {}), ...(awsBackend.key ? { key: awsBackend.key } : {}), ...(awsBackend.dynamodbTable ? { dynamodbTable: awsBackend.dynamodbTable } : {}) }
        : { provider: 'azure', ...azureBackend, key: azureBackend.key || undefined };
      const result = await ApiTerraformExecutionService.createStateBackend(activeProject.id, selectedAccountId, body, currentUser);
      if (backendProvider === 'aws' && result.bucket) setAwsBackend((b) => ({ ...b, bucket: result.bucket!, key: b.key || 'cloudcraft/terraform.tfstate' }));
      if (backendProvider === 'azure') setAzureBackend((b) => ({ ...b, key: b.key || 'cloudcraft/terraform.tfstate' }));
      setBackendCreated(result.steps);
    } catch (err) {
      setBackendCreateError(err instanceof Error ? err.message : 'Could not create the state storage');
    } finally {
      setCreatingBackend(false);
    }
  }

  function buildBackend(): TerraformStateBackendConfig {
    if (backendProvider === 'aws') {
      return {
        provider: 'aws',
        bucket: awsBackend.bucket.trim(),
        key: awsBackend.key.trim(),
        region: awsBackend.region.trim(),
        ...(awsBackend.dynamodbTable.trim() ? { dynamodbTable: awsBackend.dynamodbTable.trim() } : {}),
      };
    }
    return {
      provider: 'azure',
      resourceGroupName: azureBackend.resourceGroupName.trim(),
      storageAccountName: azureBackend.storageAccountName.trim(),
      containerName: azureBackend.containerName.trim(),
      key: azureBackend.key.trim(),
    };
  }

  async function handleGeneratePlan() {
    if (!activeProject || !selectedAccountId) return;
    setPlanning(true);
    setPlanError(null);
    setPlan(null);
    setApplyStatus(null);
    setApplyJobId(null);
    setApplyRunId(null);
    setApplyError(null);
    setDestroySuccess(null);
    setDestroyError(null);
    setCompletedCount(0);
    setStartedAt(null);
    setElapsedSeconds(0);
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
    const now = Date.now();
    setStartedAt(now);
    setElapsedSeconds(0);
    setCompletedCount(0);
    try {
      const { jobId, applyRunId: runId } = await ApiTerraformExecutionService.confirmApply(activeProject.id, plan.planId, plan.planHash, currentUser);
      setApplyJobId(jobId);
      setApplyRunId(runId);
      pollApplyStatus(activeProject.id, jobId, runId);
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'Apply failed to start');
      setApplying(false);
    }
  }

  async function openDestroyModal() {
    if (!activeProject || !selectedAccountId || !backendReady()) return;
    setDestroyConfirmInput('');
    setDestroyPreview(null);
    setDestroyPreviewError(null);
    setShowDestroyModal(true);
    setDestroyPreviewLoading(true);
    try {
      setDestroyPreview(await ApiTerraformExecutionService.previewDestroy(activeProject.id, state.activeEnvironment, selectedAccountId, buildBackend(), currentUser));
    } catch (err) {
      setDestroyPreviewError(err instanceof Error ? err.message : 'Could not prepare the teardown');
    } finally {
      setDestroyPreviewLoading(false);
    }
  }

  async function handleExecuteDestroy() {
    if (!activeProject || !selectedAccountId || !backendReady() || !destroyPreview?.confirmationToken || !destroyPreview.planId) return;
    const { confirmationToken, planId } = destroyPreview;
    setDestroyPreview(null);   // a token is single-use
    setDestroying(true);
    setDestroyError(null);
    setDestroySuccess(null);
    setDestroyOutputTail(null);
    setDestroyRun(null);
    setShowDestroyModal(false);
    setDestroyConfirmInput('');
    setStartedAt(Date.now());
    setElapsedSeconds(0);

    try {
      const { runId } = await ApiTerraformExecutionService.startDestroy(activeProject.id, state.activeEnvironment, selectedAccountId, buildBackend(), currentUser, confirmationToken, planId);
      try { localStorage.setItem(destroyRunKey(activeProject.id), runId); } catch { /* storage unavailable */ }
      pollDestroyRun(activeProject.id, runId);   // the teardown now runs in the background; this watches it
    } catch (err) {
      setDestroyError(err instanceof Error ? err.message : 'Teardown failed to start');
      setDestroying(false);
    }
  }

  function resetPlan() {
    setApplyRunId(null);
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    setPlan(null);
    setPlanError(null);
    setApplyJobId(null);
    setApplyStatus(null);
    setApplyError(null);
    setApplying(false);
    setCompletedCount(0);
    setStartedAt(null);
    setElapsedSeconds(0);
    setDestroySuccess(null);
    setDestroyError(null);
    setDestroyOutputTail(null);
    if (storageKey && typeof window !== 'undefined') {
      try {
        localStorage.removeItem(storageKey);
      } catch {}
    }
  }

  if (!isAdmin) return null;

  const resourceChanges = plan?.summary.resourceChanges ?? [];
  const totalResources = resourceChanges.length;
  const progress = applyStatus?.progress ?? null;
  const progressByAddress = new Map((progress?.resources ?? []).map((r) => [r.address, r]));
  const doneCount = progress ? progress.counts.done : completedCount;
  const isAllDone = applyStatus?.state === 'completed' || (!progress && completedCount >= totalResources);
  const progressPercent = totalResources > 0 ? Math.min(100, Math.round((doneCount / totalResources) * 100)) : 0;
  const rowStatus = (address: string, idx: number): { done: boolean; running: boolean; failed: boolean; stopped: boolean; seconds?: number; startedAt?: number } => {
    if (progress) {
      const r = progressByAddress.get(address);
      const st = r?.state ?? 'queued';
      return { done: isAllDone || st === 'done', running: st === 'running', failed: st === 'failed', stopped: st === 'stopped', seconds: r?.seconds, startedAt: r?.startedAt };
    }
    return { done: isAllDone || idx < completedCount, running: !!applying && idx === completedCount, failed: false, stopped: false };
  };

  const filteredResources = resourceChanges.filter((rc, idx) => {
    const { done: isDone, running: isRunning } = rowStatus(rc.address, idx);
    const isQueued = !isDone && !isRunning;

    if (filterMode === 'completed' && !isDone) return false;
    if (filterMode === 'in_progress' && !isRunning) return false;
    if (filterMode === 'queued' && !isQueued) return false;

    if (searchQuery.trim()) {
      return rc.address.toLowerCase().includes(searchQuery.toLowerCase()) || rc.type.toLowerCase().includes(searchQuery.toLowerCase());
    }
    return true;
  });

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  return (
    <div className="bg-gray-800/50 border border-emerald-900/40 rounded-xl p-4">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <CloudCog className="w-4 h-4 text-emerald-400" />
          <h3 className="text-white font-semibold text-sm">Real Infrastructure Deployment</h3>
          <span className="text-[10px] px-2 py-0.5 bg-emerald-900/40 text-emerald-300 border border-emerald-800 rounded-full font-medium">Live</span>
        </div>
      </div>
      <p className="text-gray-500 text-xs mb-4">
        Runs actual <code className="text-gray-400">terraform plan</code>, <code className="text-gray-400">apply</code>, or <code className="text-gray-400">destroy</code> against a connected cloud account using your remote state backend.
      </p>

      {!isApproved ? (
        <div className="p-3 rounded-lg bg-amber-950/40 border border-amber-500/40 text-amber-300 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>Formal Architecture Review approval is required before a Terraform plan can be generated.</span>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Provider + account selection */}
          <div className="flex items-center gap-2">
            <span className="text-gray-400 text-xs font-medium">Target Cloud:</span>
            {(['aws', 'azure'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setBackendProvider(p);
                  resetPlan();
                }}
                className={clsx(
                  'px-3 py-1 rounded-lg text-xs font-semibold border transition-all flex items-center gap-1.5',
                  backendProvider === p
                    ? (p === 'aws' ? 'bg-orange-950/80 border-orange-500 text-orange-300 ring-1 ring-orange-500/40' : 'bg-blue-950/80 border-blue-500 text-blue-300 ring-1 ring-blue-500/40')
                    : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-200',
                )}
              >
                <span className={clsx('w-1.5 h-1.5 rounded-full', p === 'aws' ? 'bg-orange-400' : 'bg-blue-400')} />
                {p.toUpperCase()}
              </button>
            ))}
          </div>

          <div>
            <label htmlFor="tf-account" className="block text-gray-400 text-xs mb-1">Cloud Account</label>
            {loadingAccounts ? (
              <div className="flex items-center gap-2 text-gray-500 text-xs"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading connected accounts…</div>
            ) : accounts.length === 0 ? (
              <p className="text-gray-600 text-xs">No connected {backendProvider.toUpperCase()} accounts that can run Terraform. Connect one with an IAM role from the Import panel first.{discoveryOnlyCount > 0 ? ` (${discoveryOnlyCount} account${discoveryOnlyCount === 1 ? '' : 's'} connected with an access key ${discoveryOnlyCount === 1 ? 'is' : 'are'} for discovery only.)` : ''}</p>
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
            <p className="text-gray-400 text-xs mb-1.5">Remote State Backend — use storage you already have, or let CloudCraft create it in your account</p>
            {backendProvider === 'aws' ? (
              <div className="grid grid-cols-2 gap-2">
                <input placeholder="S3 bucket (leave empty to auto-name)" value={awsBackend.bucket} onChange={(e) => setAwsBackend({ ...awsBackend, bucket: e.target.value })}
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

            <div className="mt-2 space-y-1.5">
              <button
                type="button"
                onClick={handleCreateStateBackend}
                disabled={!selectedAccountId || !canCreateBackend() || creatingBackend}
                title="Creates a private, encrypted, versioned bucket (and the lock table, if you named one) in the selected account. Nothing is deleted or changed if it already exists."
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 hover:bg-gray-700 border border-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-gray-200 transition-colors"
              >
                {creatingBackend ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5 text-emerald-400" />}
                {creatingBackend ? 'Creating state storage…' : 'Create state storage for me'}
              </button>
              {backendCreated && (
                <div className="rounded-lg border border-emerald-800/60 bg-emerald-950/30 px-3 py-2 text-[11px] text-emerald-200 space-y-0.5">
                  {backendCreated.map((s) => (
                    <p key={s.what}>{s.outcome === 'created' ? '✓ Created' : '• Already there'}: {s.what}</p>
                  ))}
                  <p className="text-emerald-300/70">The fields above now hold these names. You can generate the plan.</p>
                </div>
              )}
              {backendCreateError && (
                <p className="rounded-lg border border-rose-800/60 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-200">{backendCreateError}</p>
              )}
            </div>
          </div>

          {activeProject && (
            <TerraformLimitsBar
              projectId={activeProject.id}
              environment={state.activeEnvironment}
              user={currentUser}
              refreshKey={`${planning}|${applying}|${applyStatus?.state ?? ''}|${plan?.planId ?? ''}`}
            />
          )}

          {activeProject && <TerraformApprovalInbox projectId={activeProject.id} user={currentUser} />}

          {/* Main Action Buttons */}
          {!plan && !destroying && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                onClick={handleGeneratePlan}
                disabled={!selectedAccountId || !backendReady() || planning}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed text-white transition-colors"
              >
                {planning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRightLeft className="w-3.5 h-3.5" />}
                {planning ? 'Generating plan…' : 'Generate Terraform Plan'}
              </button>

              <button
                onClick={openDestroyModal}
                disabled={!selectedAccountId || !backendReady() || planning || destroying}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-rose-950/70 hover:bg-rose-900 border border-rose-800/80 disabled:opacity-40 disabled:cursor-not-allowed text-rose-300 transition-colors"
                title="Tear down and destroy all cloud infrastructure provisioned for this project"
              >
                <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                Teardown / Terminate All Services
              </button>
            </div>
          )}

          {/* Destroying Active State Banner */}
          {destroying && (
            <div className="p-4 rounded-xl bg-rose-950/40 border border-rose-500/40 text-white space-y-2.5 animate-pulse shadow-xl">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 text-rose-400 animate-spin" />
                  <span className="font-semibold text-rose-200">Tearing Down Infrastructure in {backendProvider.toUpperCase()}...</span>
                </div>
                <div className="flex items-center gap-1 text-rose-300 font-mono text-xs">
                  <Clock className="w-3.5 h-3.5 animate-spin" /> {formatDuration(elapsedSeconds)}
                </div>
              </div>
              <p className="text-[11px] text-gray-300">
                Running the destroy plan you reviewed against your remote state. It keeps running on the server if you leave this page. Azure and AWS delete resources one at a time, so several minutes is normal.
              </p>
              <pre className="bg-black/60 rounded-lg p-2 text-[10px] text-gray-300 font-mono whitespace-pre-wrap max-h-44 overflow-y-auto" data-testid="destroy-live-log">
                {destroyRun && destroyRun.logTail.length > 0 ? destroyRun.logTail.slice(-14).join('\n') : 'Starting…'}
              </pre>
            </div>
          )}

          {/* Destroy Success Banner */}
          {destroySuccess && (
            <div className="p-4 rounded-xl bg-emerald-950/60 border border-emerald-500/50 text-emerald-300 text-xs shadow-xl space-y-2">
              <div className="flex items-center gap-2 font-semibold text-sm">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                <span>All Infrastructure Successfully Terminated!</span>
              </div>
              <p className="text-[11px] text-emerald-300/90">{destroySuccess}</p>
              {destroyOutputTail && (
                <details className="mt-2 bg-gray-950/80 rounded-lg p-2 border border-emerald-900/40">
                  <summary className="cursor-pointer text-emerald-400/90 font-medium">View Teardown Log Output</summary>
                  <div className="mt-2 bg-black rounded-lg p-2.5 flex items-start gap-2 max-h-40 overflow-y-auto">
                    <Terminal className="w-3.5 h-3.5 text-gray-500 mt-0.5 shrink-0" />
                    <pre className="text-[10px] text-gray-300 font-mono whitespace-pre-wrap">{destroyOutputTail}</pre>
                  </div>
                </details>
              )}
              <button onClick={resetPlan} className="mt-2 px-3 py-1.5 rounded-lg bg-emerald-800 hover:bg-emerald-700 text-white font-medium text-xs transition-colors">
                Dismiss
              </button>
            </div>
          )}

          {/* Destroy Error Banner */}
          {destroyError && (
            <TerraformErrorBox
              message={destroyError}
              fallbackTitle="Teardown encountered an issue"
              onRetry={openDestroyModal}
              onDismiss={() => setDestroyError(null)}
              lock={activeProject && selectedAccountId && backendReady() ? { projectId: activeProject.id, cloudAccountId: selectedAccountId, stateBackend: buildBackend(), user: currentUser } : undefined}
            />
          )}

          {planError && (
            <TerraformErrorBox
              message={planError}
              fallbackTitle="The plan could not be generated"
              onRetry={handleGeneratePlan}
              onDismiss={() => setPlanError(null)}
              lock={activeProject && selectedAccountId && backendReady() ? { projectId: activeProject.id, cloudAccountId: selectedAccountId, stateBackend: buildBackend(), user: currentUser } : undefined}
            />
          )}

          {plan && (
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 shadow-xl">
              {/* Header */}
              <div className="flex items-center justify-between mb-3 border-b border-gray-800 pb-2.5">
                <div className="flex items-center gap-2">
                  <div className={clsx("w-2.5 h-2.5 rounded-full", applying ? "bg-blue-400 animate-ping" : isAllDone ? "bg-emerald-400" : "bg-emerald-400 animate-pulse")} />
                  <p className="text-white text-xs font-bold uppercase tracking-wider">
                    {applying ? 'Live Deployment In Progress' : isAllDone ? 'Deployment Completed' : 'Plan Ready for Apply'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-gray-500 bg-gray-950 px-2 py-0.5 rounded border border-gray-800">
                    SHA: {plan.planHash.slice(0, 10)}…
                  </span>
                  <button
                    onClick={resetPlan}
                    className="text-[11px] px-2.5 py-1 rounded bg-rose-950/60 hover:bg-rose-900 border border-rose-800/80 text-rose-300 transition-colors flex items-center gap-1 font-medium shadow-sm"
                    title={applying ? 'Closes this view only. It does NOT stop the deployment, which keeps running on the server.' : 'Clear plan and reset view'}
                  >
                    <XCircle className="w-3.5 h-3.5 text-rose-400" />
                    {applying ? 'Hide this view' : 'Clear / Discard'}
                  </button>
                </div>
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
                          <span>Provisioning Infrastructure ({doneCount} of {totalResources} Complete{progress && progress.counts.running > 0 ? `, ${progress.counts.running} in progress` : ''}{progress && progress.counts.failed > 0 ? `, ${progress.counts.failed} failed` : ''})</span>
                        </>
                      )}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-xs text-white">{progressPercent}%</span>
                      {!isAllDone && (
                        <button
                          onClick={resetPlan}
                          className="text-[10px] px-2 py-0.5 rounded bg-rose-950/80 hover:bg-rose-900 border border-rose-800 text-rose-300 transition-colors font-medium"
                          title="Closes this view only. It does NOT stop the deployment."
                        >
                          Hide
                        </button>
                      )}
                    </div>
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

              {applyStatus?.diagnosis && (
                <div className="mb-3 p-3 rounded-lg bg-amber-950/40 border border-amber-700/50 text-amber-200 text-xs" data-testid="apply-diagnosis">
                  <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" /> {applyStatus.diagnosis.title}</p>
                  <p className="mt-1 text-amber-200/90 leading-relaxed">{applyStatus.diagnosis.message}</p>
                </div>
              )}
              {progress?.status === 'queued' && !applyStatus?.diagnosis && (
                <p className="mb-3 text-xs text-gray-400">Queued — waiting for the worker to start Terraform…</p>
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
                    const row = rowStatus(rc.address, originalIdx);
                    const isDone = row.done;
                    const isRunning = row.running;
                    const isFailed = row.failed;
                    const isStopped = row.stopped;
                    const runningFor = isRunning && row.startedAt ? Math.max(row.seconds ?? 0, Math.floor((Date.now() - row.startedAt) / 1000)) : row.seconds;
                    const Icon = getResourceIcon(rc.type, rc.address);

                    return (
                      <div
                        key={rc.address}
                        className={clsx(
                          'flex items-center justify-between p-2 rounded-lg border text-xs transition-all',
                          isFailed
                            ? 'bg-rose-950/30 border-rose-500/40 text-rose-200'
                            : isDone
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
                          {isFailed ? (
                            <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-rose-900/50 border border-rose-500/40 text-rose-300 text-[10px] font-semibold">
                              <XCircle className="w-3 h-3 text-rose-400" /> Failed
                            </span>
                          ) : isDone ? (
                            <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-900/50 border border-emerald-500/40 text-emerald-300 text-[10px] font-semibold">
                              <CheckCircle2 className="w-3 h-3 text-emerald-400" /> Done{runningFor !== undefined && runningFor > 0 ? ` · ${formatDuration(runningFor)}` : ''}
                            </span>
                          ) : isRunning ? (
                            <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-900/60 border border-blue-500/50 text-blue-300 text-[10px] font-semibold animate-pulse">
                              <Loader2 className="w-3 h-3 animate-spin text-blue-400" /> Applying{runningFor !== undefined && runningFor > 0 ? ` · ${formatDuration(runningFor)}` : ''}
                            </span>
                          ) : isStopped ? (
                            <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-900 border border-gray-700 text-gray-400 text-[10px]">
                              <AlertTriangle className="w-3 h-3" /> Did not finish
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

              {progress && <CreatedResourcesList progress={progress} cloud={backendProvider.toUpperCase()} />}

              {!applyJobId && activeProject && <TerraformWorkerNotice projectId={activeProject.id} environment={state.activeEnvironment} />}

              {/* Approval: a plan only runs once an owner/admin has approved exactly this plan */}
              {!applyJobId && activeProject && (
                <TerraformApprovalBar projectId={activeProject.id} action="apply" planId={plan.planId} planHash={plan.planHash} user={currentUser} onReady={setApplyApproved} />
              )}

              {/* Action Buttons */}
              {!applyJobId ? (
                <div className="flex items-center justify-between gap-2 pt-1">
                  <div className="flex gap-2">
                    <button
                      onClick={handleConfirmApply}
                      disabled={applying || !applyApproved}
                      title={applyApproved ? undefined : 'Needs an approval from an owner or admin first'}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white transition-all shadow-lg shadow-emerald-600/20"
                    >
                      {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                      Confirm &amp; Apply to {backendProvider.toUpperCase()}
                    </button>
                    <button onClick={resetPlan} className="px-3 py-2 rounded-lg text-xs font-medium bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400">
                      Discard / Reset
                    </button>
                  </div>
                  <button
                    onClick={openDestroyModal}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-rose-400 hover:text-rose-200 bg-rose-950/40 hover:bg-rose-900/60 border border-rose-900/60 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-rose-400" /> Teardown
                  </button>
                </div>
              ) : (
                <div className="pt-2">
                  {applyStatus?.state === 'completed' && (
                    <div className="p-3.5 rounded-xl bg-emerald-950/60 border border-emerald-500/50 text-emerald-300 text-xs shadow-lg">
                      <div className="flex items-center gap-2 mb-1.5 font-semibold text-sm">
                        <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                        <span>All Infrastructure Successfully Provisioned in {backendProvider.toUpperCase()}!</span>
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
                      <div className="mt-3 flex items-center justify-between">
                        <button onClick={resetPlan} className="px-3 py-1.5 rounded-lg bg-emerald-800 hover:bg-emerald-700 text-white font-medium text-xs transition-colors">
                          Start a new deployment
                        </button>
                        <button
                          onClick={openDestroyModal}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-950/80 hover:bg-rose-900 border border-rose-800 text-rose-300 font-semibold text-xs transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" /> Teardown All Services
                        </button>
                      </div>
                    </div>
                  )}
                  {(applyStatus?.state === 'failed' || applyError) && (
                    <div className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-500/50 text-rose-300 text-xs shadow-lg">
                      <div className="flex items-center gap-2 mb-1.5 font-semibold">
                        <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
                        <span>Deployment encountered an issue</span>
                      </div>
                      <TerraformPermissionHelp
                        message={`${applyStatus?.output?.message ?? applyError ?? ''}\n${progress?.error ?? ''}\n${(progress?.logTail ?? []).join('\n')}`}
                        resourceTypes={resourceChanges.map((c) => c.type)}
                      />
                      <details className="text-[11px] text-rose-300/90">
                        <summary className="cursor-pointer text-rose-300 font-medium">Show Terraform&apos;s own message</summary>
                        <p className="mt-1.5 bg-black/40 p-2 rounded border border-rose-900/30 font-mono whitespace-pre-wrap break-words max-h-60 overflow-auto">
                          {applyStatus?.output?.message ?? applyError}
                        </p>
                      </details>
                      <div className="mt-2.5 flex items-center justify-between">
                        <button onClick={resetPlan} className="text-xs text-rose-400 hover:text-rose-200 underline font-medium">
                          Re-plan and try again
                        </button>
                        <button
                          onClick={openDestroyModal}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-rose-950/80 hover:bg-rose-900 border border-rose-800 text-rose-300 font-medium text-[11px]"
                        >
                          <Trash2 className="w-3 h-3" /> Teardown partially created resources
                        </button>
                      </div>
                    </div>
                  )}
                  {(!applyStatus || applyStatus.state === 'active' || applyStatus.state === 'pending') && !applyError && (
                    <div className="p-3 rounded-xl bg-gray-950 border border-gray-800 flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs text-gray-300">
                        <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                        <span>Deployment in progress in {backendProvider.toUpperCase()}...</span>
                      </div>
                      <button
                        onClick={resetPlan}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-950/80 hover:bg-rose-900 border border-rose-800 text-rose-300 font-semibold text-xs transition-colors"
                      >
                        <XCircle className="w-3.5 h-3.5 text-rose-400" />
                        Hide this view (does not stop the deployment)
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Teardown Safety Confirmation Modal */}
          {showDestroyModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
              <div className="bg-gray-900 border border-rose-500/50 rounded-2xl p-5 max-w-md w-full shadow-2xl shadow-rose-950/50 space-y-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-rose-950/80 border border-rose-500/50 flex items-center justify-center text-rose-400 shrink-0">
                    <AlertOctagon className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-white font-bold text-sm">Terminate All Cloud Infrastructure</h4>
                    <p className="text-gray-400 text-xs mt-0.5">
                      This action will run <code className="text-rose-300 font-mono">terraform destroy</code> against your live cloud account.
                    </p>
                  </div>
                </div>

                <div className="bg-gray-950/80 rounded-xl p-3 border border-gray-800 text-xs space-y-1.5">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Project:</span>
                    <span className="text-white font-medium">{activeProject.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Account:</span>
                    <span className="text-white font-medium">{selectedAccount?.name ?? 'Connected Cloud Account'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Remote State:</span>
                    <span className="text-emerald-400 font-mono text-[11px]">{backendProvider === 'aws' ? awsBackend.bucket : azureBackend.storageAccountName}</span>
                  </div>
                </div>

                <div className="bg-gray-950/80 rounded-xl p-3 border border-gray-800 text-xs space-y-1.5" data-testid="destroy-preview">
                  {destroyPreviewLoading && <p className="text-gray-400 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />Planning the teardown against your real state — this takes a minute or two…</p>}
                  {destroyPreviewError && <TerraformErrorBox message={destroyPreviewError} fallbackTitle="The teardown could not be prepared" lock={activeProject && selectedAccountId && backendReady() ? { projectId: activeProject.id, cloudAccountId: selectedAccountId, stateBackend: buildBackend(), user: currentUser } : undefined} />}
                  {destroyPreview?.status === 'nothing_to_destroy' && <p className="text-emerald-300">The remote state holds no resources, so there is nothing to destroy.</p>}
                  {destroyPreview?.status === 'confirmation_required' && (
                    <>
                      <p className="text-white font-medium">{destroyPreview.resourceCount} resource{destroyPreview.resourceCount === 1 ? '' : 's'} in your remote state will be destroyed:</p>
                      <ul className="max-h-36 overflow-y-auto text-[11px] text-gray-300 space-y-0.5 font-mono">
                        {destroyPreview.resources.map((r) => <li key={r.address}>{r.address} <span className="text-gray-500">({r.type})</span></li>)}
                        {destroyPreview.resourceCount > destroyPreview.resources.length && <li className="text-gray-500">…and {destroyPreview.resourceCount - destroyPreview.resources.length} more</li>}
                      </ul>
                      <p className="text-[10px] text-gray-500">This is the real plan Terraform made from your state. Confirming runs exactly this plan; the confirmation expires in 5 minutes and works once.</p>
                    </>
                  )}
                </div>

                <div className="p-3 bg-rose-950/30 border border-rose-900/50 rounded-xl text-rose-300 text-xs space-y-2">
                  <p className="font-semibold flex items-center gap-1.5">
                    <Flame className="w-4 h-4 text-rose-400" /> Irreversible Action
                  </p>
                  <p className="text-[11px] text-rose-300/80 leading-relaxed">
                    All VPCs, subnets, compute instances, database clusters, load balancers, and caches provisioned for this project will be deleted.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-gray-400 text-xs">
                    Type <span className="text-white font-bold font-mono">DESTROY</span> to confirm:
                  </label>
                  <input
                    type="text"
                    value={destroyConfirmInput}
                    onChange={(e) => setDestroyConfirmInput(e.target.value)}
                    placeholder="DESTROY"
                    className="w-full bg-black/60 border border-gray-700 rounded-lg px-3 py-2 text-white font-mono text-xs focus:outline-none focus:ring-2 focus:ring-rose-500"
                  />
                </div>

                {activeProject && destroyPreview?.planId && destroyPreview.planHash && (
                  <TerraformApprovalBar projectId={activeProject.id} action="destroy" planId={destroyPreview.planId} planHash={destroyPreview.planHash} user={currentUser} onReady={setDestroyApproved} />
                )}

                <div className="flex justify-end gap-2 pt-2 border-t border-gray-800">
                  <button
                    onClick={() => {
                      setShowDestroyModal(false);
                      setDestroyConfirmInput('');
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleExecuteDestroy}
                    disabled={destroyConfirmInput !== 'DESTROY' || destroying || !destroyPreview?.confirmationToken || !destroyApproved}
                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-500 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed text-white transition-all shadow-lg shadow-rose-600/30"
                  >
                    {destroying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    Confirm &amp; Destroy All Services
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
