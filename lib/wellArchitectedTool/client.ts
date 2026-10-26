/**
 * The AWS Well-Architected Tool, behind a small interface so the sync can be tested without AWS.
 * `createWaToolClient` is the real one (AWS SDK v3); tests pass their own object.
 */
import {
  WellArchitectedClient, ListWorkloadsCommand, CreateWorkloadCommand, ListAnswersCommand, GetAnswerCommand, UpdateAnswerCommand, CreateMilestoneCommand,
} from '@aws-sdk/client-wellarchitected';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@aws-sdk/types';
import { randomUUID } from 'crypto';
import type { ToolAnswer } from './plan';

export const FRAMEWORK_LENS = 'wellarchitected';

export interface WorkloadInput {
  name: string;
  description: string;
  environment: 'PRODUCTION' | 'PREPRODUCTION';
  reviewOwner: string;
  regions: string[];
  accountIds: string[];
  notes: string;
}

export interface WaToolClient {
  findWorkload(name: string): Promise<{ id: string } | null>;
  createWorkload(input: WorkloadInput): Promise<{ id: string }>;
  listAnswers(workloadId: string): Promise<ToolAnswer[]>;
  getNotes(workloadId: string, questionId: string): Promise<string>;
  updateAnswer(workloadId: string, questionId: string, change: { selectedChoices?: string[]; notes: string }): Promise<void>;
  createMilestone(workloadId: string, name: string): Promise<number>;
}

export function createWaToolClient(region: string, credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider): WaToolClient {
  const sdk = new WellArchitectedClient({ region, credentials });
  return {
    async findWorkload(name) {
      let next: string | undefined;
      do {
        const r = await sdk.send(new ListWorkloadsCommand({ WorkloadNamePrefix: name, NextToken: next, MaxResults: 50 }));
        // The Tool ignores spaces and capitalisation when it checks that names are unique, so do the same here.
        const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
        const hit = (r.WorkloadSummaries ?? []).find((w) => w.WorkloadName && w.WorkloadId && norm(w.WorkloadName) === norm(name));
        if (hit?.WorkloadId) return { id: hit.WorkloadId };
        next = r.NextToken;
      } while (next);
      return null;
    },
    async createWorkload(i) {
      const r = await sdk.send(new CreateWorkloadCommand({
        WorkloadName: i.name, Description: i.description, Environment: i.environment, ReviewOwner: i.reviewOwner, AwsRegions: i.regions,
        ...(i.accountIds.length > 0 ? { AccountIds: i.accountIds } : {}), Lenses: [FRAMEWORK_LENS], Notes: i.notes,
        Tags: { 'cloudbuilder:managed': 'true' }, ClientRequestToken: randomUUID(),
      }));
      if (!r.WorkloadId) throw new Error('The Well-Architected Tool did not return a workload id.');
      return { id: r.WorkloadId };
    },
    async listAnswers(workloadId) {
      const out: ToolAnswer[] = [];
      let next: string | undefined;
      do {
        const r = await sdk.send(new ListAnswersCommand({ WorkloadId: workloadId, LensAlias: FRAMEWORK_LENS, NextToken: next, MaxResults: 50 }));
        for (const a of r.AnswerSummaries ?? []) {
          if (!a.QuestionId) continue;
          out.push({
            questionId: a.QuestionId, questionTitle: a.QuestionTitle ?? a.QuestionId,
            choices: (a.Choices ?? []).filter((c) => c.ChoiceId).map((c) => ({ id: c.ChoiceId as string, title: c.Title ?? '' })),
            selected: a.SelectedChoices ?? [],
          });
        }
        next = r.NextToken;
      } while (next);
      return out;
    },
    async getNotes(workloadId, questionId) {
      const r = await sdk.send(new GetAnswerCommand({ WorkloadId: workloadId, LensAlias: FRAMEWORK_LENS, QuestionId: questionId }));
      return r.Answer?.Notes ?? '';
    },
    async updateAnswer(workloadId, questionId, change) {
      await sdk.send(new UpdateAnswerCommand({
        WorkloadId: workloadId, LensAlias: FRAMEWORK_LENS, QuestionId: questionId, Notes: change.notes,
        ...(change.selectedChoices ? { SelectedChoices: change.selectedChoices } : {}),
      }));
    },
    async createMilestone(workloadId, name) {
      const r = await sdk.send(new CreateMilestoneCommand({ WorkloadId: workloadId, MilestoneName: name, ClientRequestToken: randomUUID() }));
      if (typeof r.MilestoneNumber !== 'number') throw new Error('The Well-Architected Tool did not return a milestone number.');
      return r.MilestoneNumber;
    },
  };
}
