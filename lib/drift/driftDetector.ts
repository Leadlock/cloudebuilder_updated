/**
 * Automated Drift Detection Engine for CloudBuilder.
 * Periodically or on-demand checks deployed infrastructure against canvas architecture.
 */

import { randomUUID } from 'crypto';
import type { CanvasNode } from '@/types';
import type { DriftDifference, DriftReport, ResourceDrift } from './types';

// In-memory cache for recent drift reports by projectId:environment
const reportCache = new Map<string, DriftReport>();

export class DriftDetector {
  /**
   * Compares the canvas architecture against cloud state to produce a comprehensive DriftReport.
   */
  public async detectDrift(params: {
    projectId: string;
    environment: string;
    provider: 'aws' | 'azure';
    nodes: CanvasNode[];
    liveCloudData?: Array<{
      resourceId: string;
      resourceType: string;
      attributes: Record<string, unknown>;
      exists: boolean;
    }>;
  }): Promise<DriftReport> {
    const { projectId, environment, provider, nodes, liveCloudData } = params;
    const now = new Date().toISOString();

    const resourceDrifts: ResourceDrift[] = [];

    // Map of live cloud data by resourceId
    const cloudMap = new Map<string, { attributes: Record<string, unknown>; exists: boolean }>();
    if (liveCloudData) {
      for (const item of liveCloudData) {
        cloudMap.set(item.resourceId, { attributes: item.attributes, exists: item.exists });
      }
    }

    for (const node of nodes) {
      const config = node.config || {};
      const cloudResId = (config.resourceId as string) || (config.providerResourceId as string) || node.id;
      const liveItem = cloudMap.get(cloudResId) ?? cloudMap.get(node.id);

      const differences: DriftDifference[] = [];
      let status: ResourceDrift['status'] = 'in_sync';

      if (liveItem) {
        if (!liveItem.exists) {
          status = 'missing';
          differences.push({
            field: 'resource',
            expected: 'Existing in cloud',
            actual: 'Deleted out-of-band in cloud console',
            description: `Resource was removed outside CloudBuilder`,
            severity: 'critical',
          });
        } else {
          // Compare attributes
          const diffs = this.compareAttributes(node.resourceType, config, liveItem.attributes);
          if (diffs.length > 0) {
            status = 'drifted';
            differences.push(...diffs);
          }
        }
      } else {
        // Fallback / simulated check when live cloud connection is simulated
        // Checks if node has simulateDrift or out-of-band modifications
        if (config._simulatedDrift) {
          status = 'drifted';
          const sim = config._simulatedDrift as Record<string, { expected: unknown; actual: unknown }>;
          for (const [key, val] of Object.entries(sim)) {
            differences.push({
              field: key,
              expected: val.expected,
              actual: val.actual,
              description: `Console modified ${key} from ${val.expected} to ${val.actual}`,
              severity: 'warning',
            });
          }
        }
      }

      resourceDrifts.push({
        resourceId: node.id,
        resourceType: node.resourceType,
        nodeLabel: node.label,
        provider: node.provider === 'azure' ? 'azure' : 'aws',
        status,
        cloudResourceId: cloudResId,
        differences,
        detectedAt: now,
      });
    }

    const driftedCount = resourceDrifts.filter((r) => r.status === 'drifted').length;
    const missingCount = resourceDrifts.filter((r) => r.status === 'missing').length;
    const unmanagedCount = resourceDrifts.filter((r) => r.status === 'unmanaged').length;
    const inSyncCount = resourceDrifts.filter((r) => r.status === 'in_sync').length;

    const hasDrift = driftedCount > 0 || missingCount > 0 || unmanagedCount > 0;

    const report: DriftReport = {
      id: randomUUID(),
      projectId,
      environment,
      provider,
      checkedAt: now,
      inSyncCount,
      driftedCount,
      missingCount,
      unmanagedCount,
      resources: resourceDrifts,
      summary: {
        status: hasDrift ? 'drift_detected' : 'in_sync',
        message: hasDrift
          ? `Detected drift on ${driftedCount} resource(s)${missingCount > 0 ? `, ${missingCount} missing` : ''}.`
          : 'All cloud infrastructure matches canvas architecture specifications.',
      },
    };

    reportCache.set(`${projectId}:${environment}`, report);
    return report;
  }

  /**
   * Retrieves the most recent drift report for the project.
   */
  public getLatestReport(projectId: string, environment: string): DriftReport | null {
    return reportCache.get(`${projectId}:${environment}`) || null;
  }

  private compareAttributes(
    resourceType: string,
    canvasConfig: Record<string, unknown>,
    liveAttrs: Record<string, unknown>,
  ): DriftDifference[] {
    const diffs: DriftDifference[] = [];

    // EC2 / Azure VM comparison
    if (resourceType === 'aws_ec2' || resourceType === 'azure_vm') {
      const typeKey = resourceType === 'aws_ec2' ? 'instanceType' : 'size';
      if (liveAttrs[typeKey] && liveAttrs[typeKey] !== canvasConfig[typeKey]) {
        diffs.push({
          field: typeKey,
          expected: canvasConfig[typeKey],
          actual: liveAttrs[typeKey],
          description: `Machine sizing changed out-of-band`,
          severity: 'warning',
        });
      }
    }

    // RDS / Azure SQL comparison
    if (resourceType === 'aws_rds' || resourceType === 'azure_sql') {
      const classKey = resourceType === 'aws_rds' ? 'instanceClass' : 'tier';
      if (liveAttrs[classKey] && liveAttrs[classKey] !== canvasConfig[classKey]) {
        diffs.push({
          field: classKey,
          expected: canvasConfig[classKey],
          actual: liveAttrs[classKey],
          description: `Database tier modified out-of-band`,
          severity: 'warning',
        });
      }
      if (liveAttrs['multiAz'] !== undefined && liveAttrs['multiAz'] !== canvasConfig['multiAz']) {
        diffs.push({
          field: 'multiAz',
          expected: canvasConfig['multiAz'],
          actual: liveAttrs['multiAz'],
          description: `Multi-AZ configuration toggled in console`,
          severity: 'critical',
        });
      }
    }

    // Storage comparison
    if (resourceType === 'aws_s3') {
      if (liveAttrs['encryption'] !== undefined && liveAttrs['encryption'] !== canvasConfig['encryption']) {
        diffs.push({
          field: 'encryption',
          expected: canvasConfig['encryption'],
          actual: liveAttrs['encryption'],
          description: `Storage encryption state altered`,
          severity: 'critical',
        });
      }
    }

    return diffs;
  }
}

export const driftDetector = new DriftDetector();
