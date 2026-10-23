/**
 * Drift detection & reconciliation types for CloudBuilder.
 */

export type DriftStatus = 'in_sync' | 'drifted' | 'missing' | 'unmanaged';

export interface DriftDifference {
  field: string;
  expected: unknown;
  actual: unknown;
  description: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface ResourceDrift {
  resourceId: string;
  resourceType: string;
  nodeLabel: string;
  provider: 'aws' | 'azure';
  status: DriftStatus;
  cloudResourceId?: string;
  differences: DriftDifference[];
  detectedAt: string;
}

export interface DriftReport {
  id: string;
  projectId: string;
  environment: string;
  provider: 'aws' | 'azure';
  checkedAt: string;
  inSyncCount: number;
  driftedCount: number;
  missingCount: number;
  unmanagedCount: number;
  resources: ResourceDrift[];
  summary: {
    status: 'in_sync' | 'drift_detected';
    message: string;
  };
}

export type ReconciliationMode = 'align_cloud_to_canvas' | 'import_drift_to_canvas';

export interface ReconciliationRequest {
  projectId: string;
  environment: string;
  mode: ReconciliationMode;
  resourceIds?: string[];
}

export interface ReconciliationResult {
  success: boolean;
  mode: ReconciliationMode;
  reconciledCount: number;
  message: string;
  updatedNodes?: Array<{
    id: string;
    config: Record<string, unknown>;
  }>;
}
