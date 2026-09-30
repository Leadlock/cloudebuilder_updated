import type { PlanSummary, TerraformStateBackendConfig, ApplyJobOutput } from '@/lib/terraform/execution/types';

function parseErrorMessage(err: unknown, fallback: string): string {
  if (!err || typeof err !== 'object') return fallback;
  const e = err as Record<string, unknown>;
  if (typeof e.error === 'string') return e.error;
  if (typeof e.error === 'object' && e.error !== null) {
    const errorObj = e.error as Record<string, unknown>;
    return String(errorObj.message || errorObj.code || JSON.stringify(e.error));
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
}

export class ApiTerraformExecutionService {
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
  ): Promise<TerraformApplyStatus> {
    const headers: Record<string, string> = {};
    if (user?.id) {
      headers['x-user-id'] = user.id;
      if (user.role) headers['x-user-role'] = user.role;
    }
    const res = await fetch(`/api/projects/${projectId}/terraform/apply?jobId=${encodeURIComponent(jobId)}`, {
      headers,
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parseErrorMessage(data, `Failed to fetch apply status (${res.status})`));
    return data.data;
  }

  static async destroyInfrastructure(
    projectId: string,
    environment: string,
    cloudAccountId: string,
    stateBackend: TerraformStateBackendConfig,
    user?: { id: string; role?: string },
  ): Promise<{ status: string; message: string; outputTail?: string }> {
    const res = await fetch(`/api/projects/${projectId}/terraform/destroy`, {
      method: 'POST',
      headers: authHeaders(user),
      credentials: 'include',
      body: JSON.stringify({ environment, cloudAccountId, stateBackend }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(parseErrorMessage(data, `Teardown failed (${res.status})`));
    return data.data;
  }
}
