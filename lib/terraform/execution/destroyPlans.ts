/**
 * Destroy plans that have been prepared (previewed) and are waiting for the user's confirmation.
 *
 * Preparing a teardown runs `terraform plan -destroy` and keeps the plan file and its working folder here. Confirming
 * runs exactly THAT plan, so what the user reviewed is what gets destroyed — if the state changed in between, Terraform
 * refuses the stale plan instead of destroying something new. A prepared plan expires after ten minutes and can be used
 * once; its folder is deleted when it is used, expires, or is discarded.
 *
 * Held in this server process (same tier as plan records — see planStore.ts).
 */
import { rm } from 'fs/promises';

export const DESTROY_PLAN_TTL_MS = 10 * 60 * 1000;

export interface PreparedDestroyPlan {
  planId: string;
  planHash: string;
  workDir: string;
  orgId: string;
  projectId: string;
  userId: string;
  environment: string;
  cloudAccountId: string;
  stateBackend: unknown;
  resources: { address: string; type: string }[];
  /** Resources the plan deletes that have deletion protection on: it is switched off just before the confirmed teardown runs. */
  protectedResources?: { type: 'aws_lb' | 'aws_db_instance' | 'aws_dynamodb_table'; id: string }[];
  /** The AWS region of the deployment (for switching protection off). */
  region?: string;
  expiresAtMs: number;
}

const g = globalThis as unknown as { __cloudcraft_destroy_plans__?: Map<string, PreparedDestroyPlan> };
const plans = (): Map<string, PreparedDestroyPlan> => (g.__cloudcraft_destroy_plans__ ??= new Map());

async function discardDir(dir: string): Promise<void> { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }

/** Removes expired plans (and their folders). */
export async function pruneDestroyPlans(now = Date.now()): Promise<void> {
  for (const [id, p] of plans()) if (p.expiresAtMs <= now) { plans().delete(id); await discardDir(p.workDir); }
}

export async function savePreparedDestroy(p: Omit<PreparedDestroyPlan, 'expiresAtMs'>): Promise<PreparedDestroyPlan> {
  await pruneDestroyPlans();
  const rec = { ...p, expiresAtMs: Date.now() + DESTROY_PLAN_TTL_MS };
  plans().set(p.planId, rec);
  return rec;
}

/** Looks a plan up without using it (for checking the confirmation token against what was previewed). */
export function peekPreparedDestroy(planId: string): PreparedDestroyPlan | null {
  const p = plans().get(planId);
  return p && p.expiresAtMs > Date.now() ? p : null;
}

/** Takes the plan for execution: it can never be used twice. Its folder is now the caller's to clean up. */
export function takePreparedDestroy(planId: string): PreparedDestroyPlan | null {
  const p = peekPreparedDestroy(planId);
  if (p) plans().delete(planId);
  return p;
}

export async function discardPreparedDestroy(planId: string): Promise<void> {
  const p = plans().get(planId);
  if (p) { plans().delete(planId); await discardDir(p.workDir); }
}

/** For tests. */
export async function _clearDestroyPlansForTests(): Promise<void> {
  for (const p of plans().values()) await discardDir(p.workDir);
  plans().clear();
}
