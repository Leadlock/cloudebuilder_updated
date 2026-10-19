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
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import type { PlanRecord } from './types';

const PLAN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PLANS_DIR = path.join(tmpdir(), 'cloudbuilder-plans');

try {
  if (!fs.existsSync(PLANS_DIR)) {
    fs.mkdirSync(PLANS_DIR, { recursive: true });
  }
} catch {}

const globalForPlans = globalThis as unknown as {
  __cloudbuilder_terraform_plans__?: Map<string, PlanRecord>;
};
const PLANS = globalForPlans.__cloudbuilder_terraform_plans__ ?? new Map<string, PlanRecord>();
if (process.env['NODE_ENV'] !== 'production') {
  globalForPlans.__cloudbuilder_terraform_plans__ = PLANS;
}

export function planTtlMs(): number {
  return PLAN_TTL_MS;
}

export function savePlan(record: PlanRecord): void {
  PLANS.set(record.planId, record);
  try {
    if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true });
    fs.writeFileSync(path.join(PLANS_DIR, `${record.planId}.json`), JSON.stringify(record), 'utf-8');
  } catch (err) {
    console.warn('[planStore] Failed to write plan to disk:', err);
  }
}

/** Returns the plan if it exists and hasn't expired; expired plans are evicted on read. */
export function getPlan(planId: string): PlanRecord | null {
  let record = PLANS.get(planId);
  if (!record) {
    try {
      const filePath = path.join(PLANS_DIR, `${planId}.json`);
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        record = JSON.parse(raw) as PlanRecord;
        PLANS.set(planId, record);
      }
    } catch {}
  }

  if (!record) return null;
  if (new Date(record.expiresAt).getTime() < Date.now()) {
    deletePlan(planId);
    return null;
  }
  return record;
}

/** Removes a plan — called once it's been consumed by a successful apply (single-use). */
export function deletePlan(planId: string): void {
  PLANS.delete(planId);
  try {
    const filePath = path.join(PLANS_DIR, `${planId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

