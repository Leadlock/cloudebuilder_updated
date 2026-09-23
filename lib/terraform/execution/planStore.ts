/**
 * In-memory store for generated Terraform plans, awaiting apply confirmation.
 *
 * Same persistence model as ArchitectureReviewService's REVIEWS/DEPLOYMENTS
 * maps (attached to globalThis to survive Next.js dev rebuilds within one
 * process) — not durable across a process restart or multiple instances.
 * That's an accepted limitation carried over from the existing review
 * system, not a new one introduced here: a plan is short-lived by design
 * (PLAN_TTL_MS) and re-generating one is cheap and safe (plan is
 * non-mutating), so losing an unconfirmed plan on restart just means the
 * admin re-runs plan and gets a fresh hash to confirm — never a silent
 * state-loss the way a lost discovery run would be.
 */
import type { PlanRecord } from './types';

const PLAN_TTL_MS = 30 * 60 * 1000; // 30 minutes

const globalForPlans = globalThis as unknown as {
  __cloudcraft_terraform_plans__?: Map<string, PlanRecord>;
};
const PLANS = globalForPlans.__cloudcraft_terraform_plans__ ?? new Map<string, PlanRecord>();
if (process.env['NODE_ENV'] !== 'production') {
  globalForPlans.__cloudcraft_terraform_plans__ = PLANS;
}

export function planTtlMs(): number {
  return PLAN_TTL_MS;
}

export function savePlan(record: PlanRecord): void {
  PLANS.set(record.planId, record);
}

/** Returns the plan if it exists and hasn't expired; expired plans are evicted on read. */
export function getPlan(planId: string): PlanRecord | null {
  const record = PLANS.get(planId);
  if (!record) return null;
  if (new Date(record.expiresAt).getTime() < Date.now()) {
    PLANS.delete(planId);
    return null;
  }
  return record;
}

/** Removes a plan — called once it's been consumed by a successful apply (single-use). */
export function deletePlan(planId: string): void {
  PLANS.delete(planId);
}
