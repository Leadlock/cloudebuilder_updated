/**
 * Sends a project's Well-Architected evidence to the AWS Well-Architected Tool as a workload.
 * Creates the workload once (found again by its name on later runs), pre-fills the answers CloudBuilder has evidence for, and optionally saves a
 * milestone. Never removes a choice a person selected and never marks a practice as missing: see plan.ts.
 */
import type { Evaluation } from '@/lib/engines/assessment/types';
import type { WaToolClient } from './client';
import { mergeNotes, planSync, type SyncPlan } from './plan';

export interface SyncInput {
  client: WaToolClient;
  project: { id: string; name: string; environment: string };
  regions: string[];
  accountIds?: string[];
  reviewOwner: string;
  evaluations: readonly Evaluation[];
  rulesetVersion: string;
  evaluatedAt: string;
  milestone?: boolean;
}

export interface SyncResult {
  workloadId: string;
  workloadName: string;
  created: boolean;
  /** One entry per question changed: what was selected and which practices had no evidence. */
  answered: { questionId: string; questionTitle: string; added: string[] }[];
  notesOnly: number;
  unmatched: string[];
  milestone?: number;
  practices: SyncPlan['practices'];
}

/** The workload's name: the project's name plus a short id, so two projects with the same name do not collide. */
export function workloadNameFor(project: { id: string; name: string }): string {
  const suffix = ` (CloudBuilder ${project.id.replace(/-/g, '').slice(0, 8)})`;
  return `${project.name.trim().replace(/\s+/g, ' ').slice(0, 100 - suffix.length)}${suffix}`;
}

export async function syncWorkload(i: SyncInput): Promise<SyncResult> {
  const name = workloadNameFor(i.project);
  const existing = await i.client.findWorkload(name);
  const workload = existing ?? await i.client.createWorkload({
    name,
    description: `Architecture reviewed with CloudBuilder (${i.project.environment}); answers pre-filled from the design.`,
    environment: i.project.environment === 'production' ? 'PRODUCTION' : 'PREPRODUCTION',
    reviewOwner: i.reviewOwner,
    regions: i.regions,
    accountIds: i.accountIds ?? [],
    notes: 'Created by CloudBuilder. Answers marked in the notes were read from the architecture design and need a person to confirm them.',
  });

  const answers = await i.client.listAnswers(workload.id);
  const plan = planSync(i.evaluations, answers, { rulesetVersion: i.rulesetVersion, evaluatedAt: i.evaluatedAt });
  for (const u of plan.updates) {
    const notes = mergeNotes(await i.client.getNotes(workload.id, u.questionId), u.notesBlock);
    await i.client.updateAnswer(workload.id, u.questionId, { ...(u.selectedChoices ? { selectedChoices: u.selectedChoices } : {}), notes });
  }
  const milestone = i.milestone ? await i.client.createMilestone(workload.id, `CloudBuilder ${i.evaluatedAt.slice(0, 10)}`) : undefined;
  return {
    workloadId: workload.id,
    workloadName: name,
    created: !existing,
    answered: plan.updates.filter((u) => u.added.length > 0).map((u) => ({ questionId: u.questionId, questionTitle: u.questionTitle, added: u.added })),
    notesOnly: plan.updates.filter((u) => u.added.length === 0).length,
    unmatched: plan.unmatched.map((p) => `${p.bp} ${p.title}`),
    ...(milestone !== undefined ? { milestone } : {}),
    practices: plan.practices,
  };
}
