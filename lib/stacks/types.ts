/**
 * Stack Dependencies & Multi-Stack DAG Orchestration types for CloudBuilder.
 */

export type StackLayer = 'network' | 'data' | 'compute' | 'app' | 'security';

export type StackExecutionStatus =
  | 'idle'
  | 'pending'
  | 'planning'
  | 'planned'
  | 'applying'
  | 'applied'
  | 'failed'
  | 'drifted';

export interface StackVariableBinding {
  name: string;
  fromStackId: string;
  fromOutput: string;
  currentValue?: unknown;
}

export interface StackOutputDefinition {
  name: string;
  description: string;
  valueType: 'string' | 'number' | 'list';
  exportValue?: unknown;
}

export interface StackDefinition {
  id: string;
  name: string;
  layer: StackLayer;
  description: string;
  nodeIds: string[];
  dependsOn: string[];
  inputs: StackVariableBinding[];
  outputs: StackOutputDefinition[];
  status: StackExecutionStatus;
  lastRunSummary?: {
    planId?: string;
    changesCount: number;
    error?: string;
    runTimeMs: number;
    updatedAt: string;
  };
}

export interface DagExecutionTier {
  tierIndex: number;
  stackIds: string[];
}

export interface DagValidationResult {
  isValid: boolean;
  tiers: DagExecutionTier[];
  cycles?: string[][];
  errors?: string[];
}

export interface ProjectStackGraph {
  projectId: string;
  environment: string;
  stacks: Record<string, StackDefinition>;
  tiers: DagExecutionTier[];
  updatedAt: string;
}

export interface MultiStackRunProgress {
  runId: string;
  projectId: string;
  status: 'planning' | 'applying' | 'completed' | 'failed';
  currentTier: number;
  totalTiers: number;
  stackStatuses: Record<string, StackExecutionStatus>;
  logs: string[];
  startedAt: string;
  completedAt?: string;
}
