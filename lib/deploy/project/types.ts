/**
 * Types for deploying a project from inside CloudCraft (see docs/IN_APP_DEPLOYMENT_DESIGN.md).
 *
 * A release is a short state machine: a list of steps run in order by a worker. Nothing in a release record is secret: it holds names, tags,
 * the compose file (which only references secrets) and the ids of the resources that were created. Credentials and secret values never appear here.
 */

export type ReleaseTarget = 'azure-vm';

export const STEP_ORDER = ['infrastructure', 'secrets', 'build', 'publish', 'start', 'verify'] as const;
export type StepName = (typeof STEP_ORDER)[number];

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'waiting' | 'skipped' | 'rolled_back';

export interface StepRecord {
  name: StepName;
  state: StepState;
  startedAt?: number;
  finishedAt?: number;
  /** A short, safe sentence: what happened, or what is needed. */
  message?: string;
}

export type ReleaseStatus = 'planned' | 'approved' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'rolled_back' | 'cancelled';

/** What Terraform created, as the steps need it. */
export interface ReleaseOutputs {
  resourceGroup: string;
  vmName: string;
  /** Registry name (without .azurecr.io). Empty when nothing is built. */
  acrName: string;
  vaultName: string;
  /** The address of the public service, for the health check. */
  url: string;
}

export interface Release {
  id: string;
  orgId: string;
  projectId: string;
  environment: string;
  /** The connected cloud account the release is deployed with (its credentials are read by the worker, never stored here). */
  cloudAccountId: string;
  target: ReleaseTarget;
  /** SHA-256 over every generated file, the target, the tag and the source: what the approval is bound to. */
  bundleHash: string;
  planId: string | null;
  planHash: string | null;
  /** The project name; it names the service on the VM, the resource group and the images. */
  project: string;
  /** The project's settings the bundle is generated from (never a secret value: those are not part of the settings). The worker regenerates the bundle from this and refuses to run if its hash is not `bundleHash`. */
  settings: unknown;
  imageTag: string;
  /** The compose file this release runs. Kept so a rollback needs no rebuild and no plan. */
  compose: string;
  /** Services built from source, each pushed as <project>-<service>:<tag>. */
  built: string[];
  /** Every secret name the services read (never values). */
  secrets: string[];
  status: ReleaseStatus;
  steps: StepRecord[];
  outputs: ReleaseOutputs | null;
  /** The release this one replaced (the rollback target). */
  previousReleaseId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  /** The last lines of progress shown to the person: short, safe sentences (never a value, a token or the output of a tool). */
  log: string[];
}

export const newSteps = (built: boolean): StepRecord[] => STEP_ORDER.map((name) => ({ name, state: name === 'build' && !built ? 'skipped' : 'pending' }));
