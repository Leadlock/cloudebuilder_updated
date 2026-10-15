/**
 * Types for real Terraform plan/apply execution.
 *
 * This is a genuinely different concern from lib/engines/terraform/TerraformGenerator.ts
 * (which only ever produces .tf file TEXT — a design-time artifact, no cloud
 * account, no credentials, no execution). Everything in lib/terraform/execution
 * takes that generated text and actually runs `terraform init/plan/apply`
 * against a real connected cloud account.
 */

export type TerraformStateBackendConfig =
  | {
      provider: 'aws';
      /** S3 bucket that already exists — CloudCraft does not provision it. */
      bucket: string;
      key: string;
      region: string;
      /** DynamoDB table for state locking — strongly recommended, not enforced. */
      dynamodbTable?: string;
    }
  | {
      provider: 'azure';
      /** Storage account + container that already exist — CloudCraft does not provision them. */
      resourceGroupName: string;
      storageAccountName: string;
      containerName: string;
      key: string;
    };

export type PlanResourceAction = 'create' | 'update' | 'delete' | 'no-op' | 'read';

export interface PlanResourceChange {
  address: string;
  type: string;
  actions: PlanResourceAction[];
}

import type { GuardrailReport } from './planGuardrails';

export interface PlanSummary {
  toAdd: number;
  toChange: number;
  toDestroy: number;
  resourceChanges: PlanResourceChange[];
  /** Things worth knowing before applying (for example "the private subnets have no route to the internet"). Advice only: never blocks. */
  notes?: string[];
  /** Result of the safety checks run on the plan; shown to the approver. A plan that failed them is never stored. */
  guardrails?: GuardrailReport;
  /** Set when the plan covers only some resources (and what they need): the Terraform addresses that were asked for. */
  targets?: string[];
}

export interface PlanRecord {
  planId: string;
  planHash: string;
  projectId: string;
  orgId: string;
  environment: string;
  cloudAccountId: string;
  provider: 'aws' | 'azure';
  workDir: string;
  summary: PlanSummary;
  createdBy: { id: string; name: string; email: string };
  createdAt: string;
  expiresAt: string;
}

export interface TerraformApplyJobData {
  applyRunId: string;
  /** Used to release the per-project apply lock and to label the audit trail. */
  projectId?: string;
  /** The user who requested the apply (audit trail). */
  requestedBy?: string;
  planId: string;
  accountId: string;
  orgId: string;
}

export interface ApplyJobOutput {
  status: 'success' | 'failed';
  message: string;
  /** Trailing lines of terraform's own output — truncated, never includes credential values (which are never printed by terraform, only read from env). */
  outputTail: string;
}
