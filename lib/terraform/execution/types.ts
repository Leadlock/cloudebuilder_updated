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

export interface PlanSummary {
  toAdd: number;
  toChange: number;
  toDestroy: number;
  resourceChanges: PlanResourceChange[];
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
