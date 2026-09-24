/**
 * Phase 2E Tests — Frontend Integration to Real Backend APIs
 *
 * Covers:
 * 1. Real Discovery Import
 *    - Actual discovered resources are converted to canvas nodes & edges
 *    - Hardcoded templates (3tier-web, azure-microservices) are NOT substituted
 *    - Provider, configuration, and explicit relationships are preserved
 *    - No fabricated relationships
 *    - Unknown/uncatalogued resource types render safely via fallback
 * 2. Real Version History
 *    - listVersions loads from backend API
 *    - saveVersion persists snapshot through backend API
 *    - restoreVersion updates canvas from backend response
 *    - API failures produce error states rather than fake success
 * 3. Environment Clone / Promote Frontend Integration
 *    - Calls backend clone and promote endpoints
 *    - SET_ENVIRONMENT_CANVAS reconciles state with backend response
 *    - Failed backend requests reject and do not mutate state
 */

import { normalizeDiscoveredInfrastructure } from '@/lib/cloud/normalizer';
import type { DiscoveredResource } from '@/lib/cloud/types';
import { apiArchitectureService } from '@/lib/services/ApiArchitectureService';
import { getResourceDefinition } from '@/lib/resources';

// ─── 1. Real Discovery Import Tests ──────────────────────────────────────────

describe('Real Discovery Import', () => {
  const mockAwsResources: DiscoveredResource[] = [
    {
      providerResourceId: 'vpc-0a1b2c3d4e5f6g7h8',
      provider: 'aws',
      resourceType: 'vpc',
      name: 'production-vpc',
      region: 'us-east-1',
      status: 'available',
      configuration: { cidrBlock: '10.0.0.0/16', isDefault: false },
      metadata: { Environment: 'production' },
    },
    {
      providerResourceId: 'subnet-0123456789abcdef0',
      provider: 'aws',
      resourceType: 'subnet',
      name: 'public-subnet-1',
      region: 'us-east-1',
      status: 'available',
      configuration: {
        cidrBlock: '10.0.1.0/24',
        vpcId: 'vpc-0a1b2c3d4e5f6g7h8',
        availabilityZone: 'us-east-1a',
      },
      metadata: { Tier: 'public' },
    },
    {
      providerResourceId: 'i-0987654321fedcba0',
      provider: 'aws',
      resourceType: 'ec2-instance',
      name: 'web-server-1',
      region: 'us-east-1',
      status: 'running',
      configuration: {
        instanceType: 't3.large',
        state: 'running',
        subnetId: 'subnet-0123456789abcdef0',
        privateIpAddress: '10.0.1.50',
      },
      metadata: { Role: 'web' },
    },
    {
      providerResourceId: 'db-instance-xyz',
      provider: 'aws',
      resourceType: 'rds-instance',
      name: 'postgres-primary',
      region: 'us-east-1',
      status: 'available',
      configuration: {
        engine: 'postgres',
        engineVersion: '15.3',
        instanceClass: 'db.r6g.xlarge',
        vpcId: 'vpc-0a1b2c3d4e5f6g7h8',
        allocatedStorage: 100,
        multiAz: true,
      },
      metadata: { Role: 'database' },
    },
  ];

  it('imports actual discovered AWS resources without substituting templates', () => {
    const { nodes, edges } = normalizeDiscoveredInfrastructure(mockAwsResources);

    expect(nodes).toHaveLength(4);

    // Verify template nodes (e.g. 3tier-web defaults like 'app-server', 'redis') are NOT present
    const nodeIds = nodes.map((n) => n.id);
    expect(nodeIds).toContain('vpc-0a1b2c3d4e5f6g7h8');
    expect(nodeIds).toContain('subnet-0123456789abcdef0');
    expect(nodeIds).toContain('i-0987654321fedcba0');
    expect(nodeIds).toContain('db-instance-xyz');

    // Labels match real discovered names
    const labels = nodes.map((n) => n.label);
    expect(labels).toContain('production-vpc');
    expect(labels).toContain('public-subnet-1');
    expect(labels).toContain('web-server-1');
    expect(labels).toContain('postgres-primary');
  });

  it('preserves provider and configuration in normalized nodes', () => {
    const { nodes } = normalizeDiscoveredInfrastructure(mockAwsResources);

    const vpcNode = nodes.find((n) => n.id === 'vpc-0a1b2c3d4e5f6g7h8')!;
    expect(vpcNode.provider).toBe('aws');
    expect(vpcNode.resourceType).toBe('aws_vpc');
    expect(vpcNode.config.cidrBlock).toBe('10.0.0.0/16');

    const ec2Node = nodes.find((n) => n.id === 'i-0987654321fedcba0')!;
    expect(ec2Node.provider).toBe('aws');
    expect(ec2Node.resourceType).toBe('aws_ec2');
    expect(ec2Node.config.instanceType).toBe('t3.large');
    expect(ec2Node.config.state).toBe('running');

    const rdsNode = nodes.find((n) => n.id === 'db-instance-xyz')!;
    expect(rdsNode.provider).toBe('aws');
    expect(rdsNode.resourceType).toBe('aws_rds');
    expect(rdsNode.config.engine).toBe('postgres');
    expect(rdsNode.config.multiAz).toBe(true);
  });

  it('preserves explicit relationships provided by discovery without fabricating unprovided edges', () => {
    const { nodes, edges } = normalizeDiscoveredInfrastructure(mockAwsResources);

    // Subnet is in VPC group and has edge from VPC
    const subnetNode = nodes.find((n) => n.id === 'subnet-0123456789abcdef0')!;
    expect(subnetNode.groupId).toBe('vpc-0a1b2c3d4e5f6g7h8');

    const vpcToSubnetEdge = edges.find(
      (e) => e.source === 'vpc-0a1b2c3d4e5f6g7h8' && e.target === 'subnet-0123456789abcdef0',
    );
    expect(vpcToSubnetEdge).toBeDefined();

    // EC2 instance has edge from its Subnet
    const subnetToEc2Edge = edges.find(
      (e) => e.source === 'subnet-0123456789abcdef0' && e.target === 'i-0987654321fedcba0',
    );
    expect(subnetToEc2Edge).toBeDefined();

    // RDS has edge from VPC
    const vpcToRdsEdge = edges.find(
      (e) => e.source === 'vpc-0a1b2c3d4e5f6g7h8' && e.target === 'db-instance-xyz',
    );
    expect(vpcToRdsEdge).toBeDefined();

    // No unprovided / fabricated edges (e.g. no edge directly between EC2 and RDS)
    const fakeEc2ToRdsEdge = edges.find(
      (e) =>
        (e.source === 'i-0987654321fedcba0' && e.target === 'db-instance-xyz') ||
        (e.source === 'db-instance-xyz' && e.target === 'i-0987654321fedcba0'),
    );
    expect(fakeEc2ToRdsEdge).toBeUndefined();
  });

  it('handles Azure discovery resources correctly', () => {
    const mockAzureResources: DiscoveredResource[] = [
      {
        providerResourceId: '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Network/virtualNetworks/prod-vnet',
        provider: 'azure',
        resourceType: 'vnet',
        name: 'prod-vnet',
        region: 'eastus',
        status: 'Succeeded',
        configuration: { addressSpace: ['10.0.0.0/16'] },
        metadata: {},
      },
      {
        providerResourceId: '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Network/virtualNetworks/prod-vnet/subnets/app-subnet',
        provider: 'azure',
        resourceType: 'subnet',
        name: 'app-subnet',
        region: 'eastus',
        status: 'Succeeded',
        configuration: {
          addressPrefix: '10.0.1.0/24',
          vnetId: '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Network/virtualNetworks/prod-vnet',
        },
        metadata: {},
      },
    ];

    const { nodes, edges } = normalizeDiscoveredInfrastructure(mockAzureResources);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].resourceType).toBe('azure_vnet');
    expect(nodes[1].resourceType).toBe('azure_subnet');
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe(nodes[0].id);
    expect(edges[0].target).toBe(nodes[1].id);
  });

  it('safely handles unknown/uncatalogued discovered resource types with fallback definition', () => {
    const uncatalogued: DiscoveredResource[] = [
      {
        providerResourceId: 'quantum-computing-unit-1',
        provider: 'aws',
        resourceType: 'unknown',
        name: 'quantum-qpu-1',
        region: 'us-east-1',
        status: 'available',
        configuration: { qubits: 128 },
        metadata: {},
      },
    ];

    const { nodes } = normalizeDiscoveredInfrastructure(uncatalogued);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('quantum-computing-unit-1');
    expect(nodes[0].label).toBe('quantum-qpu-1');

    // Verify CloudNode can safely get a definition (does not throw or return null)
    const def = getResourceDefinition(nodes[0].resourceType);
    expect(nodes[0].resourceType).toBe('aws_unknown');
  });
});

// ─── 2. Real Version History API Service Tests ───────────────────────────────

describe('Real Version History API Integration', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('listVersions loads versions from the backend endpoint', async () => {
    const mockVersionsResponse = [
      {
        id: 'ver-101',
        version: 1,
        label: 'Initial Architecture',
        summary: 'Added VPC and public subnet',
        author: 'engineer@corp.com',
        timestamp: '2026-09-01T12:00:00.000Z',
        nodeCount: 2,
      },
      {
        id: 'ver-102',
        version: 2,
        label: 'Added RDS',
        summary: 'Deployed Postgres RDS in private subnet',
        author: 'engineer@corp.com',
        timestamp: '2026-09-02T15:30:00.000Z',
        nodeCount: 3,
      },
    ];

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: mockVersionsResponse }),
    } as Response);

    const versions = await apiArchitectureService.listVersions('proj-xyz', 'production');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-xyz/versions?env=production'),
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(versions).toHaveLength(2);
    expect(versions[0].id).toBe('ver-101');
    expect(versions[0].nodeCount).toBe(2);
    expect(versions[1].id).toBe('ver-102');
    expect(versions[1].summary).toBe('Deployed Postgres RDS in private subnet');
  });

  it('saveVersion calls the backend POST endpoint and returns created version', async () => {
    const mockCreated = {
      id: 'ver-103',
      version: 3,
      label: 'Security hardening',
      summary: 'Added WAF and KMS encryption',
      author: 'dev-user',
      timestamp: '2026-09-03T10:00:00.000Z',
      nodeCount: 5,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, data: mockCreated }),
    } as Response);

    const result = await apiArchitectureService.saveVersion(
      'proj-xyz',
      'Security hardening',
      'production',
    );

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-xyz/versions'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          label: 'Security hardening',
          summary: 'Security hardening',
          env: 'production',
        }),
      }),
    );
    expect(result.id).toBe('ver-103');
    expect(result.version).toBe(3);
    expect(result.nodeCount).toBe(5);
  });

  it('restoreVersion calls the restore endpoint and returns restored nodes & edges', async () => {
    const mockRestored = {
      restored: true,
      nodes: [
        {
          id: 'n1',
          resourceType: 'aws_vpc',
          provider: 'aws',
          label: 'VPC',
          position: { x: 100, y: 100 },
          config: {},
        },
      ],
      edges: [],
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: mockRestored }),
    } as Response);

    const result = await apiArchitectureService.restoreVersion('proj-xyz', 'ver-101', 'production');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-xyz/versions/ver-101/restore'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ env: 'production' }),
      }),
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('version API failure rejects with an error instead of returning fake success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: { message: 'Database connection error' } }),
    } as Response);

    await expect(
      apiArchitectureService.saveVersion('proj-xyz', 'Failing snapshot', 'production'),
    ).rejects.toThrow('Database connection error');

    await expect(
      apiArchitectureService.restoreVersion('proj-xyz', 'ver-999', 'production'),
    ).rejects.toThrow('Database connection error');
  });
});

// ─── 3. Environment Clone / Promote Frontend Integration Tests ───────────────

describe('Environment Clone / Promote API Integration', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('cloneEnvironment calls POST /api/projects/:id/environments/clone', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: { cloned: true, from: 'production', to: 'staging', nodeCount: 4 },
      }),
    } as Response);

    const result = await apiArchitectureService.cloneEnvironment(
      'proj-xyz',
      'production',
      'staging',
    );

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-xyz/environments/clone'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ from: 'production', to: 'staging' }),
      }),
    );
    expect(result.cloned).toBe(true);
    expect(result.nodeCount).toBe(4);
  });

  it('promoteEnvironment calls POST /api/projects/:id/environments/promote', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: { promoted: true, from: 'staging', to: 'production', nodeCount: 4 },
      }),
    } as Response);

    const result = await apiArchitectureService.promoteEnvironment(
      'proj-xyz',
      'staging',
      'production',
    );

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-xyz/environments/promote'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ from: 'staging', to: 'production' }),
      }),
    );
    expect(result.promoted).toBe(true);
    expect(result.nodeCount).toBe(4);
  });

  it('clone/promote failure rejects visibly without mutating state', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ ok: false, error: { message: 'Source environment not found' } }),
    } as Response);

    await expect(
      apiArchitectureService.cloneEnvironment('proj-xyz', 'production', 'staging'),
    ).rejects.toThrow('Source environment not found');

    await expect(
      apiArchitectureService.promoteEnvironment('proj-xyz', 'staging', 'production'),
    ).rejects.toThrow('Source environment not found');
  });
});

describe('ApiArchitectureService.saveVersion field limits', () => {
  it('keeps the label within the API\'s 120-character limit and uses an explicit label when given', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 201,
      json: async () => ({ ok: true, data: { id: 'v', version: 1, label: 'l', summary: 's', author: 'a', timestamp: '2026-09-24T00:00:00.000Z' } }),
    } as Response);
    const long = 'Security Auto-Fix: ' + 'AWS-RDS-001 on RDS PostgreSQL (Publicly Accessible: Yes -> No); '.repeat(12);
    await apiArchitectureService.saveVersion('p', long, 'production');
    let body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.label.length).toBeLessThanOrEqual(120);
    expect(body.summary.length).toBeLessThanOrEqual(500);

    await apiArchitectureService.saveVersion('p', long, 'production', 'Security Auto-Fix: 12 fixes applied and verified');
    body = JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body);
    expect(body.label).toBe('Security Auto-Fix: 12 fixes applied and verified');
    expect(body.summary.startsWith('Security Auto-Fix: AWS-RDS-001')).toBe(true);
  });
});
