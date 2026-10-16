/**
 * Types for deploying a project from inside CloudCraft (see docs/IN_APP_DEPLOYMENT_DESIGN.md).
 *
 * A release is a short state machine: a list of steps run in order by a worker. Nothing in a release record is secret: it holds names, tags,
 * the compose file (which only references secrets) and the ids of the resources that were created. Credentials and secret values never appear here.
 */

export type ReleaseTarget = 'azure-vm' | 'ec2' | 'ecs' | 'container-apps';

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

export type ReleaseStatus = 'planned' | 'approved' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'rolled_back' | 'cancelled' | 'destroyed';

/** What Terraform created on Azure, as the steps need it. Older records have no `kind`: they are Azure. */
export interface AzureOutputs {
  kind?: 'azure-vm';
  resourceGroup: string;
  vmName: string;
  /** Registry name (without .azurecr.io). Empty when nothing is built. */
  acrName: string;
  vaultName: string;
  /** The address of the public service, for the health check. */
  url: string;
}

/** What Terraform created on AWS, as the steps need it. */
export interface AwsOutputs {
  kind: 'ec2';
  region: string;
  instanceId: string;
  /** The private bucket that holds the compose file and the image tag the server reads when it starts. */
  releaseBucket: string;
  /** The private bucket the source of a build is put in for CodeBuild. */
  sourceBucket: string;
  codebuildProject: string;
  /** <account>.dkr.ecr.<region>.amazonaws.com */
  registry: string;
  /** Where the secrets are in Parameter Store: /<project>. */
  ssmPrefix: string;
  url: string;
}

/** What Terraform created on AWS ECS Fargate, as the steps need it. */
export interface EcsOutputs {
  kind: 'ecs';
  region: string;
  cluster: string;
  /** The ECS services, one per service of the project. Their task definitions are `<project>-<service>`. */
  services: string[];
  /** Tasks per service once started. */
  desiredCount: number;
  /** Empty when nothing is built. */
  sourceBucket: string;
  codebuildProject: string;
  registry: string;
  ssmPrefix: string;
  url: string;
}

/** What Terraform created for a project on Azure Container Apps, as the steps need it. */
export interface AcaOutputs {
  kind: 'aca';
  resourceGroup: string;
  /** The Container Apps, one per service of the project (named `<project>-<service>`). */
  apps: string[];
  /** Replicas each app is given once started. */
  minReplicas: number;
  /** Registry name (without .azurecr.io). Empty when nothing is built. */
  acrName: string;
  /** Empty when there are no secrets. */
  vaultName: string;
  url: string;
}

export type ReleaseOutputs = AzureOutputs | AwsOutputs | EcsOutputs | AcaOutputs;
export const isAwsOutputs = (o: ReleaseOutputs): o is AwsOutputs => o.kind === 'ec2';
export const isEcsOutputs = (o: ReleaseOutputs): o is EcsOutputs => o.kind === 'ecs';
export const isAcaOutputs = (o: ReleaseOutputs): o is AcaOutputs => o.kind === 'aca';
export const isAzureOutputs = (o: ReleaseOutputs): o is AzureOutputs => o.kind !== 'ec2' && o.kind !== 'ecs' && o.kind !== 'aca';

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
  /** Services built from the person's own code (an uploaded zip) instead of the generated sample: the stored source and the SHA-256 of the zip the approval covers. */
  sources: Record<string, { id: string; sha256: string }>;
  status: ReleaseStatus;
  steps: StepRecord[];
  outputs: ReleaseOutputs | null;
  /** The release this one replaced (the rollback target). */
  previousReleaseId: string | null;
  /** Set when this release puts an earlier one back: the release it is a copy of. */
  rollbackOf: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  /** The last lines of progress shown to the person: short, safe sentences (never a value, a token or the output of a tool). */
  log: string[];
}

export const newSteps = (built: boolean): StepRecord[] => STEP_ORDER.map((name) => ({ name, state: name === 'build' && !built ? 'skipped' : 'pending' }));
