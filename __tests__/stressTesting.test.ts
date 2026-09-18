import { describe, it, expect } from '@jest/globals';
import {
  toCanonicalGraph,
  fromCanonicalGraph,
  validateCanonicalArchitecture,
} from '@/lib/domain/canonicalArchitecture';
import { architectureAutoFixEngine } from '@/lib/engines/autofix/ArchitectureAutoFixEngine';
import { calculateCosts, runSecurityScan, generateTerraform } from '@/lib/analysis';
import { CanvasNode, CanvasEdge, CloudProvider } from '@/types';

// Helper to generate synthetic architectures of N resources
function generateSyntheticArchitecture(size: number, provider: CloudProvider = 'aws'): {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
} {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  // Structure: 1 VPC, M Subnets, inside each Subnet we place Compute, DB, Storage, etc.
  const vpcId = 'vpc-stress-root';
  nodes.push({
    id: vpcId,
    type: 'containerNode',
    resourceType: provider === 'azure' ? 'azure_vnet' : 'aws_vpc',
    provider,
    label: `Root Network (${provider.toUpperCase()})`,
    position: { x: 0, y: 0 },
    config: { cidrBlock: '10.0.0.0/16' },
  });

  const numSubnets = Math.max(1, Math.min(10, Math.floor(size / 10)));
  const subnetIds: string[] = [];

  for (let s = 0; s < numSubnets; s++) {
    const subId = `subnet-${s}`;
    subnetIds.push(subId);
    nodes.push({
      id: subId,
      type: 'containerNode',
      resourceType: provider === 'azure' ? 'azure_subnet' : 'aws_subnet',
      provider,
      label: `Subnet ${s}`,
      position: { x: s * 300, y: 100 },
      parentId: vpcId,
      config: { cidrBlock: `10.0.${s}.0/24` },
    });
  }

  // Populate remaining resources
  let currentSubnetIdx = 0;
  while (nodes.length < size) {
    const i = nodes.length;
    const parentSubnet = subnetIds[currentSubnetIdx % subnetIds.length];
    currentSubnetIdx++;

    const resTypeMod = i % 5;
    let resourceType = 'aws_ec2';
    let label = `Compute-${i}`;
    let config: Record<string, any> = { instanceType: 't3.micro' };

    if (provider === 'azure') {
      if (resTypeMod === 0) {
        resourceType = 'azure_vm';
        label = `VM-${i}`;
        config = { vmSize: 'Standard_B2s' };
      } else if (resTypeMod === 1) {
        resourceType = 'azure_sql';
        label = `SQL-${i}`;
        config = { sku: 'GP_Gen5_2' };
      } else if (resTypeMod === 2) {
        resourceType = 'azure_blob';
        label = `Storage-${i}`;
        config = { storageTier: 'Hot' };
      } else if (resTypeMod === 3) {
        resourceType = 'azure_aks';
        label = `Cluster-${i}`;
        config = { nodeCount: 3 };
      } else {
        resourceType = 'azure_vm';
        label = `Worker-${i}`;
        config = { vmSize: 'Standard_D2s_v3' };
      }
    } else {
      if (resTypeMod === 0) {
        resourceType = 'aws_ec2';
        label = `EC2-${i}`;
        config = { instanceType: 't3.medium' };
      } else if (resTypeMod === 1) {
        resourceType = 'aws_rds';
        label = `RDS-${i}`;
        config = { instanceClass: 'db.t3.medium', multiAz: true };
      } else if (resTypeMod === 2) {
        resourceType = 'aws_s3';
        label = `S3-${i}`;
        config = { versioning: true };
      } else if (resTypeMod === 3) {
        resourceType = 'aws_alb';
        label = `ALB-${i}`;
        config = { scheme: 'internet-facing' };
      } else {
        resourceType = 'aws_lambda';
        label = `Fn-${i}`;
        config = { memorySize: 512 };
      }
    }

    const nodeId = `node-${i}`;
    nodes.push({
      id: nodeId,
      type: 'resourceNode',
      resourceType,
      provider,
      label,
      position: { x: (i % 10) * 120, y: Math.floor(i / 10) * 100 },
      parentId: parentSubnet,
      config,
    });

    // Create interconnected relationships
    if (i > numSubnets + 1) {
      const prevNodeId = `node-${i - 1}`;
      edges.push({
        id: `edge-${prevNodeId}-${nodeId}`,
        source: prevNodeId,
        target: nodeId,
      });
    }
  }

  return { nodes, edges };
}

describe('Stress & Scale Benchmarking Suite (25, 100, 250, 500 Resources)', () => {
  const benchmarkResults: Record<number, Record<string, number>> = {};

  const scales = [25, 100, 250, 500];

  for (const scale of scales) {
    describe(`Scale Tier: ${scale} Resources`, () => {
      const { nodes, edges } = generateSyntheticArchitecture(scale, 'aws');
      const metrics: Record<string, number> = {};

      it(`1. Canonical Conversion (${scale} resources)`, () => {
        const start = performance.now();
        const canonical = toCanonicalGraph({
          id: `stress-${scale}`,
          name: `Stress Architecture ${scale}`,
          provider: 'aws',
          providerMode: 'AWS',
          nodes,
          edges,
        });
        const duration = performance.now() - start;
        metrics['canonicalConversionMs'] = duration;

        expect(canonical.resources.length).toBe(scale);
        expect(canonical.relationships.length).toBe(edges.length);
        expect(duration).toBeLessThan(500); // Must be < 500ms even for 500 nodes
      });

      it(`2. Canonical Architecture Validation (${scale} resources)`, () => {
        const canonical = toCanonicalGraph({
          id: `stress-${scale}`,
          name: `Stress Architecture ${scale}`,
          provider: 'aws',
          providerMode: 'AWS',
          nodes,
          edges,
        });

        const start = performance.now();
        const report = validateCanonicalArchitecture(canonical);
        const duration = performance.now() - start;
        metrics['validationMs'] = duration;

        expect(report).toBeDefined();
        expect(report.issues).toBeDefined();
        expect(duration).toBeLessThan(1000); // Validation must be fast
      });

      it(`3. Auto-Fix Engine Lifecycle (${scale} resources)`, () => {
        // Introduce a detached resource to test auto-fix under scale
        const testNodes = [
          ...nodes,
          {
            id: `detached-ec2-${scale}`,
            type: 'resourceNode',
            resourceType: 'aws_ec2',
            provider: 'aws' as CloudProvider,
            label: 'Detached EC2',
            position: { x: 50, y: 50 },
            config: {},
          },
        ];

        const start = performance.now();
        const result = architectureAutoFixEngine.autoFix(
          testNodes,
          edges,
          'aws',
          'AWS',
        );
        const duration = performance.now() - start;
        metrics['autoFixMs'] = duration;

        expect(result.fixed).toBe(true);
        expect(result.nodes.length).toBeGreaterThanOrEqual(testNodes.length);
        expect(duration).toBeLessThan(1500);
      });

      it(`4. Save / Serialize / Reload Parity (${scale} resources)`, () => {
        const start = performance.now();
        const canonical = toCanonicalGraph({
          id: `stress-${scale}`,
          name: `Stress Architecture ${scale}`,
          provider: 'aws',
          providerMode: 'AWS',
          nodes,
          edges,
        });

        const jsonSerialized = JSON.stringify(canonical);
        const parsed = JSON.parse(jsonSerialized);
        const restored = fromCanonicalGraph(parsed);
        const duration = performance.now() - start;
        metrics['serializeReloadMs'] = duration;

        expect(restored.nodes.length).toBe(scale);
        expect(restored.edges.length).toBe(edges.length);
        expect(duration).toBeLessThan(500);
      });

      it(`5. Live Analysis: Cost & Security Scan (${scale} resources)`, () => {
        const start = performance.now();
        const costs = calculateCosts(nodes);
        const secStart = performance.now();
        const secReport = runSecurityScan(nodes);
        const duration = performance.now() - start;
        metrics['costCalcMs'] = secStart - start;
        metrics['securityScanMs'] = performance.now() - secStart;
        metrics['totalAnalysisMs'] = duration;

        expect(costs.length).toBeGreaterThan(0);
        expect(secReport).toBeDefined();
        expect(duration).toBeLessThan(2000);
      });

      it(`6. Terraform Generation (${scale} resources)`, () => {
        const start = performance.now();
        const tfResult = generateTerraform(nodes, edges, 'aws');
        const duration = performance.now() - start;
        metrics['terraformGenMs'] = duration;

        expect(typeof tfResult).toBe('string');
        expect(tfResult.length).toBeGreaterThan(100);
        expect(duration).toBeLessThan(2000);
      });

      afterAll(() => {
        benchmarkResults[scale] = metrics;
        console.log(`\n=== Benchmark Results for ${scale} Resources ===`);
        for (const [k, v] of Object.entries(metrics)) {
          console.log(`  - ${k}: ${v.toFixed(2)} ms`);
        }
      });
    });
  }
});
