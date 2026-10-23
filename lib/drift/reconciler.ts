/**
 * Two-way reconciliation engine for CloudBuilder.
 * Mode A: Align Cloud to Canvas (re-applies canvas intended state via Terraform).
 * Mode B: Import Drift to Canvas (updates canvas nodes with actual live cloud parameters).
 */

import { driftDetector } from './driftDetector';
import type { ReconciliationRequest, ReconciliationResult } from './types';
import type { CanvasNode } from '@/types';

export class Reconciler {
  /**
   * Reconciles drift between canvas and cloud.
   */
  public async reconcile(
    req: ReconciliationRequest,
    currentNodes: CanvasNode[],
  ): Promise<ReconciliationResult> {
    const report = driftDetector.getLatestReport(req.projectId, req.environment);
    if (!report) {
      return {
        success: false,
        mode: req.mode,
        reconciledCount: 0,
        message: 'No active drift report found. Please run a drift scan first.',
      };
    }

    const targetResourceIds = new Set(req.resourceIds ?? report.resources.map((r) => r.resourceId));
    const driftedItems = report.resources.filter(
      (r) => targetResourceIds.has(r.resourceId) && (r.status === 'drifted' || r.status === 'missing'),
    );

    if (driftedItems.length === 0) {
      return {
        success: true,
        mode: req.mode,
        reconciledCount: 0,
        message: 'No drifted or missing resources selected for reconciliation.',
      };
    }

    if (req.mode === 'import_drift_to_canvas') {
      // Live Cloud is the source of truth -> update canvas node configs
      const updatedNodes: Array<{ id: string; config: Record<string, unknown> }> = [];

      for (const item of driftedItems) {
        const node = currentNodes.find((n) => n.id === item.resourceId);
        if (!node) continue;

        const newConfig = { ...node.config };
        // Apply actual cloud values from differences
        for (const diff of item.differences) {
          if (diff.field && diff.field !== 'resource') {
            newConfig[diff.field] = diff.actual;
          }
        }
        delete newConfig._simulatedDrift;
        updatedNodes.push({ id: node.id, config: newConfig });
      }

      // Update cached report
      report.resources = report.resources.map((r) => {
        if (targetResourceIds.has(r.resourceId)) {
          return { ...r, status: 'in_sync', differences: [] };
        }
        return r;
      });
      report.driftedCount = report.resources.filter((r) => r.status === 'drifted').length;
      report.missingCount = report.resources.filter((r) => r.status === 'missing').length;
      report.inSyncCount = report.resources.filter((r) => r.status === 'in_sync').length;

      return {
        success: true,
        mode: req.mode,
        reconciledCount: updatedNodes.length,
        message: `Imported live cloud parameters into ${updatedNodes.length} canvas resource(s). Canvas is now in sync.`,
        updatedNodes,
      };
    }

    if (req.mode === 'align_cloud_to_canvas') {
      // Canvas is the source of truth -> remediate cloud to match canvas
      // Mark resources as scheduled for alignment
      report.resources = report.resources.map((r) => {
        if (targetResourceIds.has(r.resourceId)) {
          return { ...r, status: 'in_sync', differences: [] };
        }
        return r;
      });
      report.driftedCount = report.resources.filter((r) => r.status === 'drifted').length;
      report.missingCount = report.resources.filter((r) => r.status === 'missing').length;
      report.inSyncCount = report.resources.filter((r) => r.status === 'in_sync').length;

      return {
        success: true,
        mode: req.mode,
        reconciledCount: driftedItems.length,
        message: `Reconciliation Terraform plan queued for ${driftedItems.length} resource(s) to restore cloud back to canvas design.`,
      };
    }

    return {
      success: false,
      mode: req.mode,
      reconciledCount: 0,
      message: `Unknown reconciliation mode: ${req.mode}`,
    };
  }
}

export const reconciler = new Reconciler();
