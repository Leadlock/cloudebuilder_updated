import * as fs from 'fs';
import * as path from 'path';
import { autoLayoutArchitecture } from '@/lib/canvas/autoLayout';
import { CanvasNode } from '@/types';

describe('PRISM & Heavy Architecture Layout Optimization', () => {
  it('optimizes bounds and avoids excessive vertical stacking in PRISM architecture', () => {
    const raw = fs.readFileSync(path.resolve(__dirname, '../prism-architecture.json'), 'utf8');
    const prism = JSON.parse(raw);
    const laid = autoLayoutArchitecture(prism.nodes as CanvasNode[], prism.edges || []);

    const boundary = laid.nodes.find((n) => n.resourceType === 'aws_cloud_boundary');
    expect(boundary).toBeDefined();

    // Ensure the overall layout height is compact and well-proportioned (under 1300px, not 3500px+)
    const maxY = Math.max(...laid.nodes.map((n) => n.position.y + (n.height || 100)));
    const minY = Math.min(...laid.nodes.map((n) => n.position.y));
    const totalHeight = maxY - minY;

    expect(totalHeight).toBeLessThan(2200);

    // Verify custom containers like secgrp, s3grp, loggrp preserve their children
    const secChildren = laid.nodes.filter((n) => n.groupId === 'secgrp');
    expect(secChildren.length).toBeGreaterThan(0);

    const s3Children = laid.nodes.filter((n) => n.groupId === 's3grp');
    expect(s3Children.length).toBeGreaterThan(0);
  });

  it('lays out loose remaining services in a multi-column 2D grid instead of a 1D column', () => {
    // Construct an architecture with 1 VPC, 2 subnets, and 20 loose services
    const nodes: CanvasNode[] = [
      { id: 'vpc-1', type: 'containerNode', resourceType: 'aws_vpc', provider: 'aws', label: 'VPC', position: { x: 0, y: 0 }, config: {} },
      { id: 'sub-1', type: 'containerNode', resourceType: 'aws_subnet', provider: 'aws', label: 'Public Subnet', position: { x: 0, y: 0 }, groupId: 'vpc-1', config: {} },
      { id: 'sub-2', type: 'containerNode', resourceType: 'aws_subnet', provider: 'aws', label: 'Private Subnet', position: { x: 0, y: 0 }, groupId: 'vpc-1', config: {} },
    ];

    for (let i = 1; i <= 20; i++) {
      nodes.push({
        id: `svc-${i}`,
        type: 'cloudNode',
        resourceType: i % 2 === 0 ? 'aws_iam_role' : 'aws_s3',
        provider: 'aws',
        label: `Service ${i}`,
        position: { x: 0, y: 0 },
        config: {},
      });
    }

    const laid = autoLayoutArchitecture(nodes, []);
    const loose = laid.nodes.filter((n) => n.id.startsWith('svc-'));
    expect(loose.length).toBe(20);

    // Check distinct X coordinates: should have at least 2 distinct columns (not a single column of 20 nodes!)
    const uniqueXs = new Set(loose.map((n) => n.position.x));
    expect(uniqueXs.size).toBeGreaterThanOrEqual(2);

    // Total height of the 20 nodes should not exceed 1000px
    const maxY = Math.max(...loose.map((n) => n.position.y));
    const minY = Math.min(...loose.map((n) => n.position.y));
    expect(maxY - minY).toBeLessThan(1000);
  });

  it('generates production-ready Terraform for PRISM without false aws_cloud_boundary warnings', () => {
    const raw = fs.readFileSync(path.resolve(__dirname, '../prism-architecture.json'), 'utf8');
    const prism = JSON.parse(raw);
    const { apiTerraformService } = require('@/lib/services/ApiTerraformService');

    const { files, warnings } = apiTerraformService.generateFilesWithWarnings(
      prism.nodes,
      prism.edges,
      'aws',
      'PRISM - Production Architecture'
    );

    expect(files['main.tf']).toBeDefined();
    expect(files['variables.tf']).toBeDefined();
    expect(files['terraform.tfvars']).toBeDefined();

    // Verify canvas containers and supported services are not flagged as unsupported
    const boundaryWarn = warnings.find((w: string) => w.includes('aws_cloud_boundary'));
    expect(boundaryWarn).toBeUndefined();
    const containerWarn = warnings.find((w: string) => w.includes('containerNode') || w.includes('invalid_resource_type'));
    expect(containerWarn).toBeUndefined();
    const secretsWarn = warnings.find((w: string) => w.includes('aws_secrets_manager') || w.includes('aws_secretsmanager'));
    expect(secretsWarn).toBeUndefined();
    const guarddutyWarn = warnings.find((w: string) => w.includes('aws_guardduty'));
    expect(guarddutyWarn).toBeUndefined();
    const bedrockWarn = warnings.find((w: string) => w.includes('aws_bedrock'));
    expect(bedrockWarn).toBeUndefined();
    const secHubWarn = warnings.find((w: string) => w.includes('aws_security_hub'));
    expect(secHubWarn).toBeUndefined();

    // Verify project_name variable is dynamically set from project name
    expect(files['variables.tf']).toContain('default     = "prism-production-architecture"');
    expect(files['terraform.tfvars']).toContain('project_name = "prism-production-architecture"');
  });
});

