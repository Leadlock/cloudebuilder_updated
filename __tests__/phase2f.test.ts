/**
 * Phase 2F Regression Tests:
 * Removal of dangerous silent mock fallbacks from production frontend workflows.
 *
 * Proves that when each backend API fails:
 * - Security does not return fake findings / score 100
 * - Cost does not return fake successful pricing / $0.00
 * - Advisor does not return fake recommendations / score
 * - Terraform does not return fake generated output
 * - The frontend services explicitly reject and propagate failure
 * - Legitimate offline/test mock services remain intact and functional
 */

import {
  apiSecurityService,
  setSecurityProjectId,
  setSecurityEnvironment,
  securityService,
  apiCostService,
  setCostProjectId,
  setCostEnvironment,
  costService,
  apiAdvisorService,
  setAdvisorProjectId,
  setAdvisorEnvironment,
  apiTerraformService,
  setTerraformProjectId,
  setTerraformEnvironment,
  terraformService,
} from '@/lib/services';
import type { CanvasNode } from '@/types';

describe('Phase 2F — Security Workflow Backend Source of Truth', () => {
  const originalFetch = global.fetch;

  const testNodes: CanvasNode[] = [
    {
      id: 'node-ec2',
      type: 'cloudNode',
      resourceType: 'aws_ec2',
      provider: 'aws',
      label: 'Web Server',
      position: { x: 100, y: 100 },
      config: { instanceType: 't3.micro' },
    },
  ];

  afterEach(() => {
    global.fetch = originalFetch;
    setSecurityProjectId(null);
    setSecurityEnvironment('production');
  });

  test('ApiSecurityService.scan rejects when no active project context is configured', async () => {
    setSecurityProjectId(null);
    await expect(apiSecurityService.scan(testNodes)).rejects.toThrow('No active project context');
  });

  test('ApiSecurityService.scan rejects when backend responds with 500 error (does NOT return empty array)', async () => {
    setSecurityProjectId('proj-sec-fail');

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        ok: false,
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'Database connection failed during scan' },
      }),
    } as Response);

    let caughtError: Error | null = null;
    let result: unknown = null;

    try {
      result = await apiSecurityService.scan(testNodes);
    } catch (err) {
      caughtError = err as Error;
    }

    // Must NOT return empty array (which would falsely indicate score 100 / All Clear)
    expect(result).toBeNull();
    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain('Database connection failed during scan');
  });

  test('ApiSecurityService.scan rejects when network/fetch throws', async () => {
    setSecurityProjectId('proj-sec-net');

    global.fetch = jest.fn().mockRejectedValue(new Error('Network offline'));

    await expect(apiSecurityService.scan(testNodes)).rejects.toThrow('Network offline');
  });

  test('ApiSecurityService.scan passes active environment and maps findings on success', async () => {
    setSecurityProjectId('proj-sec-ok');
    setSecurityEnvironment('staging');

    const mockApiResponse = {
      scanId: 'scan-1',
      architectureId: 'arch-1',
      score: 75,
      findingCount: 1,
      findings: [
        {
          id: 'find-1',
          ruleId: 'AWS-EC2-PUBLIC-IP',
          severity: 'high' as const,
          title: 'EC2 instance has public IP',
          description: 'Web Server is publicly reachable',
          resourceId: 'node-ec2',
          provider: 'aws',
          resourceType: 'aws_ec2',
          remediation: 'Place EC2 behind ALB in private subnet',
          meta: {},
        },
      ],
      createdAt: '2026-09-09T12:00:00.000Z',
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, data: mockApiResponse }),
    } as Response);

    const issues = await apiSecurityService.scan(testNodes);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-sec-ok/security-scans'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ env: 'staging' }),
      }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe('find-1');
    expect(issues[0].severity).toBe('high');
    expect(issues[0].nodeLabel).toBe('Web Server');
    expect(issues[0].message).toBe('EC2 instance has public IP');
  });
});

describe('Phase 2F — Cost Workflow Backend Source of Truth', () => {
  const originalFetch = global.fetch;

  const testNodes: CanvasNode[] = [
    {
      id: 'node-nat',
      type: 'cloudNode',
      resourceType: 'aws_nat',
      provider: 'aws',
      label: 'NAT Gateway',
      position: { x: 100, y: 100 },
      config: {},
    },
  ];

  afterEach(() => {
    global.fetch = originalFetch;
    setCostProjectId(null);
    setCostEnvironment('production');
  });

  test('ApiCostService.calculateCosts rejects when no active project context is configured', async () => {
    setCostProjectId(null);
    await expect(apiCostService.calculateCosts(testNodes)).rejects.toThrow('No active project context');
  });

  test('ApiCostService.calculateCosts rejects when backend responds with 500 (does NOT return empty / $0.00)', async () => {
    setCostProjectId('proj-cost-fail');

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        ok: false,
        error: { code: 'PRICING_ENGINE_ERROR', message: 'Pricing database unavailable' },
      }),
    } as Response);

    let caughtError: Error | null = null;
    let result: unknown = null;

    try {
      result = await apiCostService.calculateCosts(testNodes);
    } catch (err) {
      caughtError = err as Error;
    }

    // Must NOT return empty array (which would falsely indicate $0.00 / free infrastructure)
    expect(result).toBeNull();
    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain('Pricing database unavailable');
  });

  test('ApiCostService.calculateCosts rejects on network failure', async () => {
    setCostProjectId('proj-cost-net');
    global.fetch = jest.fn().mockRejectedValue(new Error('Connection timed out'));

    await expect(apiCostService.calculateCosts(testNodes)).rejects.toThrow('Connection timed out');
  });

  test('ApiCostService.calculateCosts passes active environment and maps line items on success', async () => {
    setCostProjectId('proj-cost-ok');
    setCostEnvironment('staging');

    const mockEstimate = {
      estimateId: 'est-1',
      architectureId: 'arch-1',
      totalMonthlyUsd: 32.85,
      totalHourlyUsd: 0.045,
      currency: 'USD',
      items: [
        {
          resourceId: 'node-nat',
          resourceLabel: 'NAT Gateway',
          resourceType: 'aws_nat',
          provider: 'aws',
          region: 'us-east-1',
          hourlyUsd: 0.045,
          monthlyUsd: 32.85,
          breakdown: [{ label: 'Hourly base fee', monthlyUsd: 32.85 }],
          assumptions: [],
          pricingSource: 'static',
          confidence: 'exact',
        },
      ],
      assumptions: [],
      pricingSource: 'static',
      confidence: 'exact',
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, data: mockEstimate }),
    } as Response);

    const costItems = await apiCostService.calculateCosts(testNodes);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-cost-ok/cost-estimates'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ env: 'staging' }),
      }),
    );

    expect(costItems).toHaveLength(1);
    expect(costItems[0].nodeId).toBe('node-nat');
    expect(costItems[0].monthlyCost).toBe(32.85);
  });
});

describe('Phase 2F — Advisor Workflow Backend Source of Truth', () => {
  const originalFetch = global.fetch;

  const testNodes: CanvasNode[] = [
    {
      id: 'node-rds',
      type: 'cloudNode',
      resourceType: 'aws_rds',
      provider: 'aws',
      label: 'App DB',
      position: { x: 100, y: 100 },
      config: { multiAz: false },
    },
  ];

  afterEach(() => {
    global.fetch = originalFetch;
    setAdvisorProjectId(null);
    setAdvisorEnvironment('production');
  });

  test('ApiAdvisorService.analyze rejects when no active project context is configured', async () => {
    setAdvisorProjectId(null);
    await expect(apiAdvisorService.analyze(testNodes)).rejects.toThrow('No active project context');
  });

  test('ApiAdvisorService.analyze rejects when backend responds with 500 (does NOT fall back to local generator)', async () => {
    setAdvisorProjectId('proj-adv-fail');

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        ok: false,
        error: { code: 'ADVISOR_ENGINE_FAILED', message: 'Advisor rules engine timeout' },
      }),
    } as Response);

    let caughtError: Error | null = null;
    let result: unknown = null;

    try {
      result = await apiAdvisorService.analyze(testNodes);
    } catch (err) {
      caughtError = err as Error;
    }

    // Must NOT return local generator fallback results
    expect(result).toBeNull();
    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain('Advisor rules engine timeout');
  });

  test('ApiAdvisorService.analyze rejects on network failure', async () => {
    setAdvisorProjectId('proj-adv-net');
    global.fetch = jest.fn().mockRejectedValue(new Error('Connection reset by peer'));

    await expect(apiAdvisorService.analyze(testNodes)).rejects.toThrow('Connection reset by peer');
  });

  test('ApiAdvisorService.analyze passes active environment and returns backend results on success', async () => {
    setAdvisorProjectId('proj-adv-ok');
    setAdvisorEnvironment('staging');

    const mockResponse = {
      optimizationId: 'opt-rec-1',
      architectureId: 'arch-1',
      score: { overall: 70, reliability: 60, security: 80, performance: 75, cost: 65, scalability: 70 },
      recommendations: [
        {
          id: 'rec-multi-az',
          category: 'reliability' as const,
          severity: 'high' as const,
          title: 'Enable Multi-AZ for RDS',
          description: 'Single-AZ database is a single point of failure',
          affectedResourceIds: ['node-rds'],
          affectedResourceLabels: ['App DB'],
          rationale: 'Multi-AZ provides automatic failover',
          suggestedAction: 'Enable Multi-AZ in RDS configuration',
        },
      ],
      createdAt: '2026-09-09T12:00:00.000Z',
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, data: mockResponse }),
    } as Response);

    const result = await apiAdvisorService.analyze(testNodes);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-adv-ok/optimizations'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ env: 'staging' }),
      }),
    );

    expect(result.fromApi).toBe(true);
    expect(result.score.overall).toBe(70);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].id).toBe('rec-multi-az');
  });
});

describe('Phase 2F — Terraform Workflow Backend Source of Truth', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    setTerraformProjectId(null);
    setTerraformEnvironment('production');
  });

  test('ApiTerraformService.generateFilesFromApi rejects when no active project context is configured', async () => {
    setTerraformProjectId(null);
    await expect(apiTerraformService.generateFilesFromApi()).rejects.toThrow('No active project context');
  });

  test('ApiTerraformService.generateFilesFromApi rejects when backend responds with 500 (does NOT return null or local files)', async () => {
    setTerraformProjectId('proj-tf-fail');

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        ok: false,
        error: { code: 'TERRAFORM_GEN_ERROR', message: 'HCL generation failed' },
      }),
    } as Response);

    let caughtError: Error | null = null;
    let result: unknown = null;

    try {
      result = await apiTerraformService.generateFilesFromApi();
    } catch (err) {
      caughtError = err as Error;
    }

    // Must NOT return null or fake local files
    expect(result).toBeNull();
    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain('HCL generation failed');
  });

  test('ApiTerraformService.generateFilesFromApi rejects on network failure', async () => {
    setTerraformProjectId('proj-tf-net');
    global.fetch = jest.fn().mockRejectedValue(new Error('Backend unreachable'));

    await expect(apiTerraformService.generateFilesFromApi()).rejects.toThrow('Backend unreachable');
  });

  test('ApiTerraformService.generateFilesFromApi passes active environment and returns backend files on success', async () => {
    setTerraformProjectId('proj-tf-ok');
    setTerraformEnvironment('staging');

    const mockResponse = {
      generationId: 'gen-1',
      architectureId: 'arch-1',
      files: [
        { filename: 'main.tf', content: 'resource "aws_vpc" "main" {}', provider: 'aws' },
        { filename: 'providers.tf', content: 'provider "aws" {}', provider: 'aws' },
      ],
      warnings: [],
      resourceMap: {},
      providers: ['aws'],
      createdAt: '2026-09-09T12:00:00.000Z',
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, data: mockResponse }),
    } as Response);

    const files = await apiTerraformService.generateFilesFromApi();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-tf-ok/terraform'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ env: 'staging' }),
      }),
    );

    expect(files['main.tf']).toBe('resource "aws_vpc" "main" {}');
    expect(files['providers.tf']).toBe('provider "aws" {}');
  });
});

describe('Phase 2F — Legitimate Offline/Dev Mocks Preserved', () => {
  const sampleNodes: CanvasNode[] = [
    {
      id: 'mock-s3',
      type: 'cloudNode',
      resourceType: 'aws_s3',
      provider: 'aws',
      label: 'Storage',
      position: { x: 0, y: 0 },
      config: { encryption: false, publicAccess: true },
    },
  ];

  test('MockSecurityService remains functional for tests and offline usage', async () => {
    const issues = await securityService.scan(sampleNodes);
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBeGreaterThan(0);

    const score = securityService.score(issues);
    expect(typeof score).toBe('number');
    expect(score).toBeLessThanOrEqual(100);

    const fixed = securityService.applyFix(sampleNodes, 'mock-s3', 'AWS-S3-NO-ENCRYPTION');
    expect(fixed[0].config['encryption']).toBe(true);
  });

  test('MockCostService remains functional for tests and offline usage', async () => {
    const costs = await costService.calculateCosts(sampleNodes);
    expect(Array.isArray(costs)).toBe(true);

    const opts = costService.generateOptimizations(sampleNodes);
    expect(Array.isArray(opts)).toBe(true);
  });

  test('MockTerraformService remains functional for tests and offline usage', () => {
    const mainTf = terraformService.generateMain(sampleNodes, [], 'aws');
    expect(typeof mainTf).toBe('string');
    expect(mainTf).toContain('aws_s3_bucket');

    const files = terraformService.generateFiles(sampleNodes, [], 'aws');
    expect(files['main.tf']).toBeDefined();
    expect(files['providers.tf']).toBeDefined();
    expect(files['variables.tf']).toBeDefined();
    expect(files['outputs.tf']).toBeDefined();
    expect(files['terraform.tfvars']).toBeDefined();
  });
});
