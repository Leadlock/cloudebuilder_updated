import { driftDetector } from '@/lib/drift/driftDetector';
import { reconciler } from '@/lib/drift/reconciler';
import type { CanvasNode } from '@/types';

describe('Automated Drift Detection & Canvas Reconciliation Engine', () => {
  const sampleNodes: CanvasNode[] = [
    {
      id: 'node-ec2-app',
      type: 'cloudNode',
      resourceType: 'aws_ec2',
      provider: 'aws',
      label: 'App Server',
      position: { x: 100, y: 100 },
      config: {
        instanceType: 't3.medium',
        storageGb: 50,
      },
    },
    {
      id: 'node-rds-db',
      type: 'cloudNode',
      resourceType: 'aws_rds',
      provider: 'aws',
      label: 'Postgres DB',
      position: { x: 300, y: 100 },
      config: {
        instanceClass: 'db.t3.medium',
        multiAz: true,
      },
    },
  ];

  it('detects attribute drift when live cloud data differs from canvas', async () => {
    const report = await driftDetector.detectDrift({
      projectId: 'proj-123',
      environment: 'development',
      provider: 'aws',
      nodes: sampleNodes,
      liveCloudData: [
        {
          resourceId: 'node-ec2-app',
          resourceType: 'aws_ec2',
          exists: true,
          attributes: {
            instanceType: 't3.xlarge', // DRIFT: t3.medium -> t3.xlarge
          },
        },
        {
          resourceId: 'node-rds-db',
          resourceType: 'aws_rds',
          exists: true,
          attributes: {
            instanceClass: 'db.t3.medium',
            multiAz: true,
          },
        },
      ],
    });

    expect(report.summary.status).toBe('drift_detected');
    expect(report.driftedCount).toBe(1);
    expect(report.inSyncCount).toBe(1);

    const drifted = report.resources.find((r) => r.resourceId === 'node-ec2-app')!;
    expect(drifted.status).toBe('drifted');
    expect(drifted.differences[0].field).toBe('instanceType');
    expect(drifted.differences[0].expected).toBe('t3.medium');
    expect(drifted.differences[0].actual).toBe('t3.xlarge');
  });

  it('detects missing cloud resources deleted out-of-band', async () => {
    const report = await driftDetector.detectDrift({
      projectId: 'proj-123',
      environment: 'development',
      provider: 'aws',
      nodes: sampleNodes,
      liveCloudData: [
        {
          resourceId: 'node-ec2-app',
          resourceType: 'aws_ec2',
          exists: false, // DELETED
          attributes: {},
        },
      ],
    });

    expect(report.missingCount).toBe(1);
    const missing = report.resources.find((r) => r.resourceId === 'node-ec2-app')!;
    expect(missing.status).toBe('missing');
  });

  it('reconciles drift by importing live cloud attributes into canvas', async () => {
    // Setup drift first
    await driftDetector.detectDrift({
      projectId: 'proj-123',
      environment: 'development',
      provider: 'aws',
      nodes: sampleNodes,
      liveCloudData: [
        {
          resourceId: 'node-ec2-app',
          resourceType: 'aws_ec2',
          exists: true,
          attributes: { instanceType: 't3.xlarge' },
        },
      ],
    });

    const result = await reconciler.reconcile(
      {
        projectId: 'proj-123',
        environment: 'development',
        mode: 'import_drift_to_canvas',
      },
      sampleNodes,
    );

    expect(result.success).toBe(true);
    expect(result.reconciledCount).toBe(1);
    expect(result.updatedNodes?.[0].config.instanceType).toBe('t3.xlarge');
  });

  it('reconciles drift by queuing alignment plan when aligning cloud to canvas', async () => {
    // Setup drift first
    await driftDetector.detectDrift({
      projectId: 'proj-123',
      environment: 'development',
      provider: 'aws',
      nodes: sampleNodes,
      liveCloudData: [
        {
          resourceId: 'node-ec2-app',
          resourceType: 'aws_ec2',
          exists: true,
          attributes: { instanceType: 't3.xlarge' },
        },
      ],
    });

    const result = await reconciler.reconcile(
      {
        projectId: 'proj-123',
        environment: 'development',
        mode: 'align_cloud_to_canvas',
      },
      sampleNodes,
    );

    expect(result.success).toBe(true);
    expect(result.reconciledCount).toBe(1);
    expect(result.message).toContain('Reconciliation Terraform plan queued');
  });
});
