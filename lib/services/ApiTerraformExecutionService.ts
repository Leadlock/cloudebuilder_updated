import type { PlanSummary, TerraformStateBackendConfig, ApplyJobOutput } from '@/lib/terraform/execution/types';
import type { RunProgressRecord, WorkerStatus, ApplyDiagnosis } from '@/lib/terraform/execution/applyProgress';

function parseErrorMessage(err: unknown, fallback: string): string {
  if (!err || typeof err !== 'object') return fallback;
  const e = err as Record<string, unknown>;
  if (typeof e.error === 'string') return e.error;
  if (typeof e.error === 'object' && e.error !== null) {
    const errorObj = e.error as Record<string, unknown>;
    const base = String(errorObj.message || errorObj.code || JSON.stringify(e.error));
    // A validation failure carries which fields were wrong; "Validation failed" alone tells the user nothing.
    const fields = (errorObj.details as { fieldErrors?: Record<string, unknown> } | undefined)?.fieldErrors;
    const reasons = fields && typeof fields === 'object'
      ? Object.values(fields).flatMap((v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])).slice(0, 4)
      : [];
    return reasons.length > 0 ? `${base}: ${reasons.join('; ')}` : base;
  }
  if (typeof e.message === 'string') return e.message;
  return fallback;
}

function authHeaders(user?: { id: string; role?: string }): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (user?.id) {
    headers['x-user-id'] = user.id;
    if (user.role) headers['x-user-role'] = user.role;
  }
  return headers;
}

export interface TerraformPlanResult {
  planId: string;
  planHash: string;
  summary: PlanSummary;
  expiresAt: string;
}

export interface TerraformApplyStatus {
  state: 'pending' | 'active' | 'completed' | 'failed' | 'unknown';
  output: ApplyJobOutput | null;
  /** What Terraform is really doing, read from its own output (absent for runs started before this existed). */
  progress?: RunProgressRecord | null;
  /** Whether the deployment worker that runs applies is up. */
  worker?: WorkerStatus;
  /** A plain-language reason the run looks stuck (no worker, worker stopped, Terraform silent), or null. */
  diagnosis?: ApplyDiagnosis | null;
}

/** Result of the teardown preview: a real `terraform plan -destroy` of what the state holds. */
export interface TerraformDestroyPreview {
  status: 'confirmation_required' | 'nothing_to_destroy';
  confirmationToken?: string;
  expiresAt?: string;
  planId?: string;
  planHash?: string;
  resourceCount: number;
  resources: { address: string; type: string }[];
  /** Resources whose deletion protection will be switched off when the teardown is confirmed. */
  deletionProtection?: { address: string; type: string }[];
}

/** Live view of a background teardown. */
export interface TerraformRunSnapshot {
  runId: string;
  state: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  elapsedSeconds: number;
  logTail: string[];
  message?: string;
  error?: string;
}

/** What "Check lock" found. */
export interface TerraformLockInspection {
  locked: boolean;
  lock?: { id: string; who?: string; operation?: string; createdAt?: string; ageMinutes?: number; path?: string };
  releasable?: boolean;
  reason?: string;
}

/** One request for approval of a plan (apply) or a teardown preview (destroy). */
export interface TerraformApproval {
  id: string;
  action: 'apply' | 'destroy';
  planId: string;
  planHash: string;
  summary: string | null;
  requestedBy: string;
  status: 'pending' | 'approved' | 'rejected' | 'used' | 'expired';
  decidedBy: string | null;
  comment: string | null;
  createdAt: string;
  expiresAt: string;
}
export interface TerraformApprovals {
  /** required = a different owner/admin must approve; self-ok = the requester may approve; off = no approval needed. */
  mode: 'password' | 'required' | 'self-ok' | 'off';
  you: string;
  /** The signed-in person has an authenticator app set up, so confirming needs a code as well as the password. */
  totpEnabled?: boolean;
  approvals: TerraformApproval[];
}

export interface TerraformExecutionStatus {
  /** False when the server's access rules or kill switch stop this caller from running Terraform. */
  enabled: boolean;
  reason?: string;
  plans: { limit: number; remaining: number; resetsInSeconds: number; windowMinutes: number };
  /** True while an apply is running for this project (only one can run at a time). */
  applyRunning: boolean;
}

export interface RequiredPermissionsInfo {
  /** False for an account whose own key can deploy: nothing to add. */
  needed: boolean;
  authMethod?: string;
  roleArn?: string | null;
  /** The IAM policy to paste on the role (JSON text). */
  policy?: string;
  services?: string[];
  unknownTypes?: string[];
  includesIam?: boolean;
  terraformTypeCount?: number;
  access?: { state: 'ok' | 'partial' | 'cannot-check'; services: { service: string; allowed: boolean | null }[]; message?: string };
}

export class ApiTerraformExecutionService {
  static async listApprovals(projectId: string, user?: { id: string; role?: string }): Promise<TerraformApprovals> {
    const res = await fetch(`/api/projects/${projectId}/terraform/approvals`, { headers: authHeaders(user), credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parseErrorMessage(data, `Could not load approvals (${res.status})`));
    return data.data;
  }

  /** Confirm a deploy or teardown with the signed-in person's own password. The password is sent once and never kept. */
  static async confirmWithPassword(projectId: string, action: 'apply' | 'destroy', planId: string, planHash: string, password: string, user?: { id: string; role?: string }, code?: string): Promise<TerraformApproval> {
    const res = await fetch(`/api/projects/${projectId}/terraform/confirm`, { method: 'POST', headers: authHeaders(user), credentials: 'include', body: JSON.stringify({ action, planId, planHash, password, ...(code ? { code } : {}) }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parseErrorMessage(data, `Could not confirm (${res.status})`));
    return data.data.approval;
  }

  static async requestApproval(projectId: string, action: 'apply' | 'destroy', planId: string, planHash: string, user?: { id: string; role?: string }): Promise<TerraformApproval> {
    const res = await fetch(`/api/projects/${projectId}/terraform/approvals`, { method: 'POST', headers: authHeaders(user), credentials: 'include', body: JSON.stringify({ action, planId, planHash }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parseErrorMessage(data, `Could not request approval (${res.status})`));
    return data.data.approval;
  }

  static async decideApproval(projectId: string, approvalId: string, decision: 'approve' | 'reject', user?: { id: string; role?: string }, comment?: string): Promise<TerraformApproval> {
    const res = await fetch(`/api/projects/${projectId}/terraform/approvals/${encodeURIComponent(approvalId)}`, { method: 'POST', headers: authHeaders(user), credentials: 'include', body: JSON.stringify({ decision, comment }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parseErrorMessage(data, `Could not record the decision (${res.status})`));
    return data.data.approval;
  }

  /** Read-only: how many plans are left in the current window and whether an apply is running. Uses none of the budget. */
  static async getStatus(projectId: string, environment: string, user?: { id: string; role?: string }): Promise<TerraformExecutionStatus> {
    const res = await fetch(`/api/projects/${projectId}/terraform/status?env=${encodeURIComponent(environment)}`, { headers: authHeaders(user), credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parseErrorMessage(data, `Failed to load Terraform limits (${res.status})`));
    return data.data;
  }

  static async generatePlan(
    projectId: string,
    environment: string,
    cloudAccountId: string,
    stateBackend: TerraformStateBackendConfig,
    user?: { id: string; role?: string },
  ): Promise<TerraformPlanResult> {
    const res = await fetch(`/api/projects/${projectId}/terraform/plan`, {
      method: 'POST',
      headers: authHeaders(user),
      credentials: 'include',
      body: JSON.stringify({ environment, cloudAccountId, stateBackend }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parseErrorMessage(data, `Plan generation failed (${res.status})`));
    return data.data;
  }

  /**
   * What the connected AWS role needs to deploy the saved architecture: the services, and a least-privilege policy to paste on the role.
   * With check: true CloudCraft also asks AWS (read-only) whether the role can already create in those services.
   */
  static async getRequiredPermissions(
    projectId: string,
    environment: string,
    cloudAccountId: string,
    check: boolean,
    user?: { id: string; role?: string },
  ): Promise<RequiredPermissionsInfo> {
    const res = await fetch(`/api/projects/${projectId}/terraform/permissions`, {
      method: 'POST', headers: authHeaders(user), credentials: 'include',
      body: JSON.stringify({ environment, cloudAccountId, check }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parseErrorMessage(data, `Could not work out the permissions (${res.status})`));
    return data.data;
  }

  /** Creates the remote state storage in the user's own account (idempotent). Empty bucket name = CloudCraft picks a unique one. */
  static async createStateBackend(
    projectId: string,
    cloudAccountId: string,
    stateBackend: Record<string, unknown>,
    user?: { id: string; role?: string },
  ): Promise<{ bucket?: string; dynamodbTable?: string; storageAccountName?: string; steps: { what: string; outcome: 'created' | 'already-exists' }[] }> {
    const res = await fetch(`/api/projects/${projectId}/terraform/state-backend`, {
      method: 'POST',
      headers: authHeaders(user),
      credentials: 'include',
      body: JSON.stringify({ cloudAccountId, stateBackend }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parseErrorMessage(data, `Could not create the state storage (${res.status})`));
    return data.data;
  }

  static async confirmApply(
    projectId: string,
    planId: string,
    planHash: string,
    user?: { id: string; role?: string },
  ): Promise<{ applyRunId: string; jobId: string; status: string }> {
    const res = await fetch(`/api/projects/${projectId}/terraform/apply`, {
      method: 'POST',
      headers: authHeaders(user),
      credentials: 'include',
      body: JSON.stringify({ planId, planHash }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parseErrorMessage(data, `Apply failed to start (${res.status})`));
    return data.data;
  }

  static async getApplyStatus(
    projectId: string,
    jobId: string,
    user?: { id: string; role?: string },
    applyRunId?: string | null,
  ): Promise<TerraformApplyStatus> {
    const headers: Record<string, string> = {};
    if (user?.id) {
      headers['x-user-id'] = user.id;
      if (user.role) headers['x-user-role'] = user.role;
    }
    const res = await fetch(`/api/projects/${projectId}/terraform/apply?jobId=${encodeURIComponent(jobId)}${applyRunId ? `&applyRunId=${encodeURIComponent(applyRunId)}` : ''}`, {
      headers,
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parseErrorMessage(data, `Failed to fetch apply status (${res.status})`));
    return data.data;
  }

  /** Step 1 of teardown: what would be removed, plus the one-time token that step 2 must present. Destroys nothing. */
  static async previewDestroy(
    projectId: string,
    environment: string,
    cloudAccountId: string,
    stateBackend: TerraformStateBackendConfig,
    user?: { id: string; role?: string },
  ): Promise<TerraformDestroyPreview> {
    const res = await fetch(`/api/projects/${projectId}/terraform/destroy`, {
      method: 'POST',
      headers: authHeaders(user),
      credentials: 'include',
      body: JSON.stringify({ environment, cloudAccountId, stateBackend }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parseErrorMessage(data, `Could not prepare the teardown (${res.status})`));
    return data.data;
  }

  /** Step 2: starts the destroy of exactly the previewed plan, in the background. Returns a run id at once. */
  static async startDestroy(
    projectId: string,
    environment: string,
    cloudAccountId: string,
    stateBackend: TerraformStateBackendConfig,
    user: { id: string; role?: string } | undefined,
    confirmationToken: string,
    planId: string,
    /** Switch deletion protection off on the protected resources the teardown deletes (default), or leave them protected. */
    disableProtection = true,
  ): Promise<{ status: 'started'; runId: string }> {
    const res = await fetch(`/api/projects/${projectId}/terraform/destroy`, {
      method: 'POST',
      headers: authHeaders(user),
      credentials: 'include',
      body: JSON.stringify({ environment, cloudAccountId, stateBackend, confirmationToken, planId, disableProtection }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parseErrorMessage(data, `Teardown failed to start (${res.status})`));
    return data.data;
  }

  /** Progress and the live tail of Terraform's output for a background teardown. */
  static async getDestroyRun(projectId: string, runId: string, user?: { id: string; role?: string }): Promise<TerraformRunSnapshot> {
    const res = await fetch(`/api/projects/${projectId}/terraform/destroy?runId=${encodeURIComponent(runId)}`, { headers: authHeaders(user), credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(parseErrorMessage(data, `Failed to read teardown progress (${res.status})`)), { status: res.status });
    return data.data;
  }

  private static async lockCall(projectId: string, body: Record<string, unknown>, user?: { id: string; role?: string }) {
    const res = await fetch(`/api/projects/${projectId}/terraform/unlock`, { method: 'POST', headers: authHeaders(user), credentials: 'include', body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parseErrorMessage(data, `Lock request failed (${res.status})`));
    return data.data;
  }

  /** "Check lock": who holds the state lock, since when, and whether CloudCraft is willing to release it. Changes nothing. */
  static async inspectLock(projectId: string, cloudAccountId: string, stateBackend: TerraformStateBackendConfig, user?: { id: string; role?: string }): Promise<TerraformLockInspection> {
    return this.lockCall(projectId, { action: 'inspect', cloudAccountId, stateBackend }, user);
  }

  /** "Release lock": only succeeds when the server re-checks that it is that lock and it is safe. */
  static async releaseLock(projectId: string, cloudAccountId: string, stateBackend: TerraformStateBackendConfig, lockId: string, user?: { id: string; role?: string }): Promise<{ released: true }> {
    return this.lockCall(projectId, { action: 'release', cloudAccountId, stateBackend, lockId }, user);
  }
}
