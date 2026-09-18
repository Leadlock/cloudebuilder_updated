/**
 * Phase 2D Tests — Security Engine, Cost Engine, Architecture Advisor, Terraform Generator
 *
 * Unit tests covering:
 * - Security: AWS/Azure rules, severity, deterministic rule IDs, no false positives
 * - Cost: AWS/Azure pricing calculations, hourly/monthly, assumptions, multi-cloud
 * - Optimization: security recs, HA recs, cost recs, deterministic results
 * - Terraform: AWS generation, Azure generation, multi-cloud, resource references,
 *              deterministic names, valid HCL structure, warnings, no credentials
 * - API: org isolation, auth, invalid IDs (via DB mock)
 */

// ─── Setup ────────────────────────────────────────────────────────────────────

process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/cloudcraft_test';

// ─── DB Mock ──────────────────────────────────────────────────────────────────

interface Row { [key: string]: unknown }
type Store = Map<string, Row>;

function makeTable(store: Store) {
  return {
    where(filter: Record<string, unknown>) {
      const getMatches = () =>
        [...store.values()].filter((row) =>
          Object.entries(filter).every(([k, v]) => row[k] === v),
        );
      return {
        select(..._fields: string[]) {
          return {
            async first() { return getMatches()[0] ?? null; },
            async all()  { return getMatches(); },
          };
        },
        async first() { return getMatches()[0] ?? null; },
        async all()   { return getMatches(); },
        async update(data: Record<string, unknown>) {
          for (const row of getMatches()) Object.assign(row, data);
        },
        async delete() {
          for (const row of getMatches()) store.delete(row['id'] as string);
        },
      };
    },
    async create(row: Record<string, unknown>) {
      store.set(row['id'] as string, { ...row });
    },
    select(..._fields: string[]) {
      const all = () => [...store.values()];
      return {
        async first() { return all()[0] ?? null; },
        async all()   { return all(); },
      };
    },
    async first() { return [...store.values()][0] ?? null; },
  };
}

function buildMockDb() {
  const stores: Record<string, Store> = {
    Organization: new Map(), OrgMember: new Map(), User: new Map(),
    Project: new Map(), Environment: new Map(),
    Architecture: new Map(), ArchitectureResource: new Map(), ArchitectureConnection: new Map(),
    ArchitectureVersion: new Map(),
    SecurityScan: new Map(), SecurityFinding: new Map(),
    CostEstimate: new Map(), ArchOptimization: new Map(), TerraformGeneration: new Map(),
    CloudAccount: new Map(), DiscoveryRun: new Map(),
  };
  const db = {
    orm: {
      public: Object.fromEntries(Object.entries(stores).map(([k, s]) => [k, makeTable(s)])),
    },
    _stores: stores,
    _reset() { for (const s of Object.values(stores)) s.clear(); },
  };
  return db;
}

const mockDb = buildMockDb();

// Executes one raw SQL statement against the in-memory mock store — mirrors
// the small, known set of statement shapes architectureRepository issues via
// rawExec/rawTransaction (real INSERT/UPDATE/DELETE, not ORM .create()/.update()).
async function mockExecSql(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
  const isInsert = /^\s*INSERT INTO/i.test(sql);
  const isUpdate = /^\s*UPDATE/i.test(sql);
  const isDelete = /^\s*DELETE FROM/i.test(sql);
  const isSelect = /^\s*SELECT/i.test(sql);

  if (isSelect && /FROM "architecture"/i.test(sql) && /"environmentId"/i.test(sql)) {
    const environmentId = params[0] as string;
    const row = [...mockDb._stores['Architecture'].values()].find((r) => (r as Record<string, unknown>)['environmentId'] === environmentId);
    return { rows: row ? [row as Record<string, unknown>] : [] };
  }
  if (isDelete && /architectureResource/i.test(sql) && params[0]) {
    const archId = params[0] as string;
    for (const [k, v] of mockDb._stores['ArchitectureResource']) {
      if ((v as Record<string, unknown>)['architectureId'] === archId) mockDb._stores['ArchitectureResource'].delete(k);
    }
    return { rows: [] };
  }
  if (isDelete && /architectureConnection/i.test(sql) && params[0]) {
    const archId = params[0] as string;
    for (const [k, v] of mockDb._stores['ArchitectureConnection']) {
      if ((v as Record<string, unknown>)['architectureId'] === archId) mockDb._stores['ArchitectureConnection'].delete(k);
    }
    return { rows: [] };
  }
  if (isUpdate && /"architecture"/i.test(sql)) {
    const [updatedAt, revision, id] = params as [string, number, string];
    const row = mockDb._stores['Architecture'].get(id);
    if (row) mockDb._stores['Architecture'].set(id, { ...row, updatedAt, revision });
    return { rows: [] };
  }
  if (isInsert && /"architectureResource"/i.test(sql)) {
    const [id, resourceType, provider, label, positionX, positionY, configJson, region, groupId, locked, architectureId] = params;
    mockDb._stores['ArchitectureResource'].set(id as string, {
      id, resourceType, provider, label, positionX, positionY, configJson, region, groupId, locked, architectureId,
    });
    return { rows: [] };
  }
  if (isInsert && /"architectureConnection"/i.test(sql)) {
    const [id, label, edgeType, architectureId, sourceId, targetId] = params;
    mockDb._stores['ArchitectureConnection'].set(id as string, { id, label, edgeType, architectureId, sourceId, targetId });
    return { rows: [] };
  }
  if (isInsert && /"architecture"/i.test(sql)) {
    const [id, environmentId, createdAt, updatedAt, revision] = params;
    mockDb._stores['Architecture'].set(id as string, { id, environmentId, createdAt, updatedAt, revision });
    return { rows: [] };
  }
  // Unknown statement shapes are tolerated as no-ops here — this file's tests
  // don't exercise architectureRepository.saveCanvas directly beyond copyArchitecture.
  return { rows: [] };
}

jest.mock('@/src/prisma/db', () => ({
  db: mockDb,
  rawExec: jest.fn().mockImplementation(async (sql: string, params: unknown[]) => { await mockExecSql(sql, params); }),
  rawTransaction: jest.fn().mockImplementation(async (fn: (query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<unknown>) => {
    return fn(async (sql: string, params?: unknown[]) => mockExecSql(sql, params ?? []));
  }),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { SecurityAnalyzer } from '@/lib/engines/security/SecurityAnalyzer';
import { CostEstimator } from '@/lib/engines/cost/CostEstimator';
import { AwsPricingProvider } from '@/lib/engines/cost/awsPricing';
import { AzurePricingProvider } from '@/lib/engines/cost/azurePricing';
import { ArchitectureAdvisor } from '@/lib/engines/advisor/ArchitectureAdvisor';
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { SecurityAnalysisInput } from '@/lib/engines/security/types';
import type { CostEstimationInput } from '@/lib/engines/cost/types';
import type { OptimizationInput } from '@/lib/engines/advisor/ArchitectureAdvisor';
import type { TerraformGenerationInput } from '@/lib/engines/terraform/TerraformGenerator';
import { architectureRepository, type DbArchitectureResource, type DbArchitectureConnection } from '@/lib/repositories/architectureRepository';
import { isRuleFixable, applyRuleRemediation } from '@/lib/engines/security/remediation';
import { apiSecurityService } from '@/lib/services/ApiSecurityService';
import { securityService } from '@/lib/services/SecurityService';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeResource(
  overrides: Partial<DbArchitectureResource> & { resourceType: string; provider: string; configJson?: string },
): DbArchitectureResource {
  return {
    id: overrides.id ?? `res-${Math.random().toString(36).slice(2)}`,
    resourceType: overrides.resourceType,
    provider: overrides.provider,
    label: overrides.label ?? `${overrides.resourceType}-label`,
    positionX: 0,
    positionY: 0,
    configJson: overrides.configJson ?? '{}',
    region: overrides.region ?? null,
    groupId: null,
    locked: false,
    architectureId: 'arch-1',
  };
}

function makeConnection(sourceId: string, targetId: string): DbArchitectureConnection {
  return {
    id: `conn-${sourceId}-${targetId}`,
    label: null,
    edgeType: null,
    architectureId: 'arch-1',
    sourceId,
    targetId,
  };
}

function baseSecurityInput(resources: DbArchitectureResource[], connections: DbArchitectureConnection[] = []): SecurityAnalysisInput {
  return { architectureId: 'arch-1', projectId: 'proj-1', resources, connections };
}

// ─── SECURITY ENGINE TESTS ────────────────────────────────────────────────────

describe('SecurityAnalyzer — AWS rules', () => {
  const analyzer = new SecurityAnalyzer();

  test('AWS-S3-PUBLIC: fires when publicAccess=true', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ publicAccess: true }) });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.findings.some((f) => f.ruleId === 'AWS-S3-PUBLIC')).toBe(true);
  });

  test('AWS-S3-PUBLIC: does NOT fire when publicAccess=false', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ publicAccess: false }) });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.findings.some((f) => f.ruleId === 'AWS-S3-PUBLIC')).toBe(false);
  });

  test('AWS-S3-PUBLIC: does NOT fire when publicAccess is absent (unknown)', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: '{}' });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.findings.some((f) => f.ruleId === 'AWS-S3-PUBLIC')).toBe(false);
  });

  test('AWS-S3-NO-ENCRYPTION: fires when encryption=false', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ encryption: false }) });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.findings.some((f) => f.ruleId === 'AWS-S3-NO-ENCRYPTION')).toBe(true);
  });

  test('AWS-S3-NO-ENCRYPTION: does NOT fire when encryption is absent', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: '{}' });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.findings.some((f) => f.ruleId === 'AWS-S3-NO-ENCRYPTION')).toBe(false);
  });

  test('AWS-RDS-PUBLICLY-ACCESSIBLE: fires when publiclyAccessible=true', () => {
    const r = makeResource({ resourceType: 'aws_rds', provider: 'aws', configJson: JSON.stringify({ publiclyAccessible: true }) });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.findings.some((f) => f.ruleId === 'AWS-RDS-PUBLICLY-ACCESSIBLE')).toBe(true);
  });

  test('AWS-RDS-NO-ENCRYPTION: fires when encrypted=false', () => {
    const r = makeResource({ resourceType: 'aws_rds', provider: 'aws', configJson: JSON.stringify({ encrypted: false }) });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.findings.some((f) => f.ruleId === 'AWS-RDS-NO-ENCRYPTION')).toBe(true);
  });

  test('AWS-RDS-NO-ENCRYPTION: does NOT fire when encrypted=true', () => {
    const r = makeResource({ resourceType: 'aws_rds', provider: 'aws', configJson: JSON.stringify({ encrypted: true }) });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.findings.some((f) => f.ruleId === 'AWS-RDS-NO-ENCRYPTION')).toBe(false);
  });

  test('Severity: critical for AWS-S3-PUBLIC', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ publicAccess: true }) });
    const result = analyzer.analyze(baseSecurityInput([r]));
    const finding = result.findings.find((f) => f.ruleId === 'AWS-S3-PUBLIC');
    expect(finding?.severity).toBe('critical');
  });

  test('Severity: high for AWS-RDS-NO-ENCRYPTION', () => {
    const r = makeResource({ resourceType: 'aws_rds', provider: 'aws', configJson: JSON.stringify({ encrypted: false }) });
    const result = analyzer.analyze(baseSecurityInput([r]));
    const finding = result.findings.find((f) => f.ruleId === 'AWS-RDS-NO-ENCRYPTION');
    expect(finding?.severity).toBe('high');
  });

  test('Deterministic rule IDs: same input produces same finding IDs', () => {
    const r = makeResource({ id: 'fixed-id-1', resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ publicAccess: true }) });
    const a = analyzer.analyze(baseSecurityInput([r]));
    const b = analyzer.analyze(baseSecurityInput([r]));
    expect(a.findings[0]!.id).toBe(b.findings[0]!.id);
  });

  test('Score: 100 with no findings', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: '{}' });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.score).toBe(100);
  });

  test('Score: reduces with critical findings', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ publicAccess: true }) });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.score).toBeLessThan(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});

describe('SecurityAnalyzer — Azure rules', () => {
  const analyzer = new SecurityAnalyzer();

  test('AZ-STORAGE-NO-HTTPS: fires when httpsOnly=false', () => {
    const r = makeResource({ resourceType: 'azure_storage', provider: 'azure', configJson: JSON.stringify({ httpsOnly: false }) });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.findings.some((f) => f.ruleId === 'AZ-STORAGE-NO-HTTPS')).toBe(true);
  });

  test('AZ-STORAGE-NO-HTTPS: does NOT fire when httpsOnly=true', () => {
    const r = makeResource({ resourceType: 'azure_storage', provider: 'azure', configJson: JSON.stringify({ httpsOnly: true }) });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.findings.some((f) => f.ruleId === 'AZ-STORAGE-NO-HTTPS')).toBe(false);
  });

  test('AZ-STORAGE-NO-HTTPS: does NOT fire when httpsOnly is absent', () => {
    const r = makeResource({ resourceType: 'azure_storage', provider: 'azure', configJson: '{}' });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.findings.some((f) => f.ruleId === 'AZ-STORAGE-NO-HTTPS')).toBe(false);
  });

  test('AZ-NSG-OPEN-RDP: fires when allowRdp=true, severity critical', () => {
    const r = makeResource({ resourceType: 'azure_nsg', provider: 'azure', configJson: JSON.stringify({ allowRdp: true }) });
    const result = analyzer.analyze(baseSecurityInput([r]));
    const finding = result.findings.find((f) => f.ruleId === 'AZ-NSG-OPEN-RDP');
    expect(finding?.severity).toBe('critical');
  });

  test('AZ-NSG-OPEN-SSH: fires when allowSsh=true, severity high', () => {
    const r = makeResource({ resourceType: 'azure_nsg', provider: 'azure', configJson: JSON.stringify({ allowSsh: true }) });
    const result = analyzer.analyze(baseSecurityInput([r]));
    const finding = result.findings.find((f) => f.ruleId === 'AZ-NSG-OPEN-SSH');
    expect(finding?.severity).toBe('high');
  });
});

describe('SecurityAnalyzer — no false positives with unknown config', () => {
  const analyzer = new SecurityAnalyzer();

  test('No findings for vpc with empty config', () => {
    const r = makeResource({ resourceType: 'aws_vpc', provider: 'aws', configJson: '{}' });
    const result = analyzer.analyze(baseSecurityInput([r]));
    // Only vpc-dns rule could fire but needs enableDnsSupport=false
    expect(result.findings.filter((f) => f.severity === 'critical' || f.severity === 'high')).toHaveLength(0);
  });

  test('No findings for azure_resource_group', () => {
    const r = makeResource({ resourceType: 'azure_resource_group', provider: 'azure', configJson: '{}' });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.findings).toHaveLength(0);
  });

  test('Empty architecture produces score 100', () => {
    const result = analyzer.analyze(baseSecurityInput([]));
    expect(result.score).toBe(100);
    expect(result.findings).toHaveLength(0);
  });
});

// ─── COST ENGINE TESTS ────────────────────────────────────────────────────────

describe('AwsPricingProvider', () => {
  const provider = new AwsPricingProvider();

  test('EC2 t3.micro pricing — positive hourly and monthly', () => {
    const r = makeResource({
      resourceType: 'aws_ec2', provider: 'aws',
      configJson: JSON.stringify({ instanceType: 't3.micro' }),
      region: 'us-east-1',
    });
    const item = provider.estimateResource(r, JSON.parse(r.configJson), 'us-east-1');
    expect(item).not.toBeNull();
    expect(item!.hourlyUsd).toBeGreaterThan(0);
    expect(item!.monthlyUsd).toBeGreaterThan(item!.hourlyUsd); // monthly > hourly
    expect(item!.pricingSource).toBeTruthy();
  });

  test('EC2 monthly ≈ hourly × 730', () => {
    const r = makeResource({
      resourceType: 'aws_ec2', provider: 'aws',
      configJson: JSON.stringify({ instanceType: 'm5.large' }),
    });
    const item = provider.estimateResource(r, JSON.parse(r.configJson), 'us-east-1');
    expect(item).not.toBeNull();
    expect(Math.abs(item!.hourlyUsd * 730 - item!.monthlyUsd)).toBeLessThan(20); // within storage assumption
  });

  test('RDS Multi-AZ costs more than Single-AZ', () => {
    const singleR = makeResource({ resourceType: 'aws_rds', provider: 'aws', configJson: JSON.stringify({ multiAz: false }) });
    const multiR  = makeResource({ resourceType: 'aws_rds', provider: 'aws', configJson: JSON.stringify({ multiAz: true }) });
    const single = provider.estimateResource(singleR, { multiAz: false }, 'us-east-1');
    const multi  = provider.estimateResource(multiR,  { multiAz: true  }, 'us-east-1');
    expect(multi!.monthlyUsd).toBeGreaterThan(single!.monthlyUsd);
  });

  test('S3 pricing with storage assumptions documented', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: '{}' });
    const item = provider.estimateResource(r, {}, 'us-east-1');
    expect(item).not.toBeNull();
    expect(item!.assumptions.length).toBeGreaterThan(0);
    expect(item!.confidence).toBe('estimate');
  });

  test('VPC returns null (no charge)', () => {
    const r = makeResource({ resourceType: 'aws_vpc', provider: 'aws', configJson: '{}' });
    const item = provider.estimateResource(r, {}, 'us-east-1');
    expect(item).toBeNull();
  });

  test('Unknown resource type marked unsupported', () => {
    const r = makeResource({ resourceType: 'aws_unknownxyz', provider: 'aws', configJson: '{}' });
    const item = provider.estimateResource(r, {}, 'us-east-1');
    expect(item!.confidence).toBe('unsupported');
    expect(item!.monthlyUsd).toBe(0);
  });
});

describe('AzurePricingProvider', () => {
  const provider = new AzurePricingProvider();

  test('VM Standard_B2s positive pricing', () => {
    const r = makeResource({
      resourceType: 'azure_vm', provider: 'azure',
      configJson: JSON.stringify({ size: 'Standard_B2s' }),
    });
    const item = provider.estimateResource(r, JSON.parse(r.configJson), 'eastus');
    expect(item!.monthlyUsd).toBeGreaterThan(0);
    expect(item!.pricingSource).toContain('azure');
  });

  test('Azure SQL includes storage assumptions', () => {
    const r = makeResource({ resourceType: 'azure_sql', provider: 'azure', configJson: JSON.stringify({ tier: 'S0' }) });
    const item = provider.estimateResource(r, { tier: 'S0' }, 'eastus');
    expect(item!.assumptions.some((a) => a.toLowerCase().includes('dtu') || a.toLowerCase().includes('storage'))).toBe(true);
  });

  test('Azure resource group returns null (no charge)', () => {
    const r = makeResource({ resourceType: 'azure_resource_group', provider: 'azure', configJson: '{}' });
    expect(provider.estimateResource(r, {}, 'eastus')).toBeNull();
  });
});

describe('CostEstimator — multi-cloud total', () => {
  const estimator = new CostEstimator();

  test('Multi-cloud total includes both AWS and Azure', () => {
    const resources = [
      makeResource({ resourceType: 'aws_ec2', provider: 'aws', configJson: JSON.stringify({ instanceType: 't3.medium' }), region: 'us-east-1' }),
      makeResource({ resourceType: 'azure_vm', provider: 'azure', configJson: JSON.stringify({ size: 'Standard_B2s' }), region: 'eastus' }),
    ];
    const result = estimator.estimate({ architectureId: 'a', projectId: 'p', resources });
    expect(result.totalMonthlyUsd).toBeGreaterThan(0);
    const providers = result.items.map((i) => i.provider);
    expect(providers).toContain('aws');
    expect(providers).toContain('azure');
  });

  test('Free resources are excluded from total', () => {
    const resources = [
      makeResource({ resourceType: 'aws_vpc', provider: 'aws', configJson: '{}' }),
      makeResource({ resourceType: 'azure_vnet', provider: 'azure', configJson: '{}' }),
    ];
    const result = estimator.estimate({ architectureId: 'a', projectId: 'p', resources });
    expect(result.totalMonthlyUsd).toBe(0);
  });

  test('Global assumptions always present', () => {
    const result = estimator.estimate({ architectureId: 'a', projectId: 'p', resources: [] });
    expect(result.assumptions.some((a) => a.toLowerCase().includes('list price'))).toBe(true);
  });
});

// ─── ARCHITECTURE ADVISOR TESTS ───────────────────────────────────────────────

describe('ArchitectureAdvisor', () => {
  const advisor = new ArchitectureAdvisor();

  function baseInput(resources: DbArchitectureResource[], connections: DbArchitectureConnection[] = []): OptimizationInput {
    return { architectureId: 'arch-1', projectId: 'proj-1', resources, connections };
  }

  test('R-01: recommends load balancer when EC2 present without ALB', () => {
    const ec2 = makeResource({ resourceType: 'aws_ec2', provider: 'aws', configJson: '{}' });
    const result = advisor.analyze(baseInput([ec2]));
    expect(result.recommendations.some((r) => r.id === 'R-01')).toBe(true);
  });

  test('R-01: NOT fired when ALB present', () => {
    const ec2 = makeResource({ resourceType: 'aws_ec2', provider: 'aws', configJson: '{}' });
    const alb = makeResource({ resourceType: 'aws_alb', provider: 'aws', configJson: '{}' });
    const result = advisor.analyze(baseInput([ec2, alb]));
    expect(result.recommendations.some((r) => r.id === 'R-01')).toBe(false);
  });

  test('R-02: recommends Multi-AZ when RDS without multiAz=true', () => {
    const rds = makeResource({ resourceType: 'aws_rds', provider: 'aws', configJson: JSON.stringify({ multiAz: false }) });
    const result = advisor.analyze(baseInput([rds]));
    expect(result.recommendations.some((r) => r.id === 'R-02')).toBe(true);
  });

  test('S-04: security recommendation for public S3 bucket', () => {
    const s3 = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ publicAccess: true }) });
    const result = advisor.analyze(baseInput([s3]));
    const secRec = result.recommendations.find((r) => r.id === 'S-04');
    expect(secRec).toBeDefined();
    expect(secRec!.category).toBe('security');
    expect(secRec!.severity).toBe('critical');
  });

  test('C-02: cost recommendation for multiple NAT gateways', () => {
    const nat1 = makeResource({ resourceType: 'aws_nat', provider: 'aws', configJson: '{}' });
    const nat2 = makeResource({ resourceType: 'aws_nat', provider: 'aws', configJson: '{}' });
    const result = advisor.analyze(baseInput([nat1, nat2]));
    expect(result.recommendations.some((r) => r.id === 'C-02')).toBe(true);
  });

  test('Deterministic results: same input produces same recommendation IDs', () => {
    const ec2 = makeResource({ id: 'fixed-ec2', resourceType: 'aws_ec2', provider: 'aws', configJson: '{}' });
    const a = advisor.analyze(baseInput([ec2]));
    const b = advisor.analyze(baseInput([ec2]));
    const aIds = a.recommendations.map((r) => r.id).sort();
    const bIds = b.recommendations.map((r) => r.id).sort();
    expect(aIds).toEqual(bIds);
  });

  test('Score: all categories present', () => {
    const result = advisor.analyze(baseInput([]));
    expect(result.score).toHaveProperty('overall');
    expect(result.score).toHaveProperty('reliability');
    expect(result.score).toHaveProperty('security');
    expect(result.score).toHaveProperty('performance');
    expect(result.score).toHaveProperty('cost');
    expect(result.score).toHaveProperty('scalability');
  });

  test('HA recommendation for Azure VM without LB', () => {
    const vm = makeResource({ resourceType: 'azure_vm', provider: 'azure', configJson: '{}' });
    const result = advisor.analyze(baseInput([vm]));
    expect(result.recommendations.some((r) => r.id === 'R-04')).toBe(true);
  });

  // ── Scale-awareness (expectedUsers) ────────────────────────────────────────
  // Regression coverage for the fix addressing the audit finding that a
  // 2-node dev sandbox and a declared "10,000-user production" architecture
  // with identical resource shapes produced identical recommendations.

  test('R-03: single EC2 severity is "medium" when expectedUsers is not provided (unchanged default)', () => {
    const ec2 = makeResource({ resourceType: 'aws_ec2', provider: 'aws', configJson: '{}' });
    const result = advisor.analyze(baseInput([ec2]));
    const rec = result.recommendations.find((r) => r.id === 'R-03');
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe('medium');
  });

  test('R-03: single EC2 severity escalates to "critical" at declared 10,000+ users', () => {
    const ec2 = makeResource({ resourceType: 'aws_ec2', provider: 'aws', configJson: '{}' });
    const result = advisor.analyze({ ...baseInput([ec2]), expectedUsers: 10_000 });
    const rec = result.recommendations.find((r) => r.id === 'R-03');
    expect(rec!.severity).toBe('critical');
    expect(rec!.description).toContain('10,000');
  });

  test('R-03: single EC2 severity de-escalates to "low" at declared low scale (<100 users)', () => {
    const ec2 = makeResource({ resourceType: 'aws_ec2', provider: 'aws', configJson: '{}' });
    const result = advisor.analyze({ ...baseInput([ec2]), expectedUsers: 50 });
    const rec = result.recommendations.find((r) => r.id === 'R-03');
    expect(rec!.severity).toBe('low');
  });

  test('SC-01: fires at just 1 static EC2 instance when expectedUsers >= 10,000 (lower threshold at scale)', () => {
    const ec2 = makeResource({ resourceType: 'aws_ec2', provider: 'aws', configJson: '{}' });
    const noScale = advisor.analyze(baseInput([ec2]));
    expect(noScale.recommendations.some((r) => r.id === 'SC-01')).toBe(false); // below default >2 threshold

    const atScale = advisor.analyze({ ...baseInput([ec2]), expectedUsers: 20_000 });
    const rec = atScale.recommendations.find((r) => r.id === 'SC-01');
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe('high');
  });

  test('P-01: no-caching severity escalates from "low" to "high" at declared 10,000+ users', () => {
    const rds = makeResource({ resourceType: 'aws_rds', provider: 'aws', configJson: '{}' });
    const ec2 = makeResource({ resourceType: 'aws_ec2', provider: 'aws', configJson: '{}' });

    const noScale = advisor.analyze(baseInput([rds, ec2]));
    expect(noScale.recommendations.find((r) => r.id === 'P-01')!.severity).toBe('low');

    const atScale = advisor.analyze({ ...baseInput([rds, ec2]), expectedUsers: 15_000 });
    expect(atScale.recommendations.find((r) => r.id === 'P-01')!.severity).toBe('high');
  });

  test('Scale-awareness is deterministic: same expectedUsers produces same severities', () => {
    const ec2 = makeResource({ id: 'fixed-ec2-2', resourceType: 'aws_ec2', provider: 'aws', configJson: '{}' });
    const a = advisor.analyze({ ...baseInput([ec2]), expectedUsers: 5_000 });
    const b = advisor.analyze({ ...baseInput([ec2]), expectedUsers: 5_000 });
    expect(a.recommendations.find((r) => r.id === 'R-03')!.severity)
      .toBe(b.recommendations.find((r) => r.id === 'R-03')!.severity);
  });
});

// ─── TERRAFORM GENERATOR TESTS ────────────────────────────────────────────────

describe('TerraformGenerator — AWS', () => {
  const gen = new TerraformGenerator();

  function awsInput(resources: DbArchitectureResource[], connections: DbArchitectureConnection[] = []): TerraformGenerationInput {
    return { architectureId: 'arch-1', projectId: 'proj-1', resources, connections };
  }

  test('Empty architecture produces comment', () => {
    const result = gen.generate(awsInput([]));
    expect(result.files[0]!.content).toContain('No resources');
  });

  test('VPC resource generates aws_vpc block', () => {
    const vpc = makeResource({ id: 'vpc-1', resourceType: 'aws_vpc', provider: 'aws', configJson: JSON.stringify({ name: 'main', cidrBlock: '10.0.0.0/16' }) });
    const result = gen.generate(awsInput([vpc]));
    const main = result.files.find((f) => f.filename === 'main.tf')!;
    expect(main.content).toContain('resource "aws_vpc"');
    expect(main.content).toContain('10.0.0.0/16');
  });

  test('Subnet references connected VPC', () => {
    const vpc    = makeResource({ id: 'vpc-1', resourceType: 'aws_vpc',    provider: 'aws', configJson: JSON.stringify({ name: 'main_vpc' }) });
    const subnet = makeResource({ id: 'sub-1', resourceType: 'aws_subnet', provider: 'aws', configJson: JSON.stringify({ name: 'main_subnet' }) });
    const conn   = makeConnection('vpc-1', 'sub-1');
    const result = gen.generate(awsInput([vpc, subnet], [conn]));
    const main = result.files.find((f) => f.filename === 'main.tf')!;
    expect(main.content).toContain('aws_vpc.main_vpc.id');
  });

  test('S3 generates encryption and public access block', () => {
    const s3 = makeResource({ id: 's3-1', resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ name: 'mybucket', publicAccess: false }) });
    const result = gen.generate(awsInput([s3]));
    const main = result.files.find((f) => f.filename === 'main.tf')!;
    expect(main.content).toContain('aws_s3_bucket_server_side_encryption_configuration');
    expect(main.content).toContain('aws_s3_bucket_public_access_block');
  });

  test('RDS uses variables for credentials (no hardcoded passwords)', () => {
    const rds = makeResource({ id: 'rds-1', resourceType: 'aws_rds', provider: 'aws', configJson: JSON.stringify({ name: 'mydb', encrypted: true }) });
    const result = gen.generate(awsInput([rds]));
    const main = result.files.find((f) => f.filename === 'main.tf')!;
    expect(main.content).toContain('var.db_password');
    expect(main.content).not.toMatch(/password\s*=\s*"[^v][^a][^r]/); // no literal passwords
  });

  test('Deterministic resource names from config.name', () => {
    const vpc = makeResource({ id: 'vpc-1', resourceType: 'aws_vpc', provider: 'aws', configJson: JSON.stringify({ name: 'prod_vpc' }) });
    const a = gen.generate(awsInput([vpc]));
    const b = gen.generate(awsInput([vpc]));
    expect(a.files[0]!.content).toBe(b.files[0]!.content);
  });

  test('providers.tf generated', () => {
    const vpc = makeResource({ id: 'vpc-1', resourceType: 'aws_vpc', provider: 'aws', configJson: '{}' });
    const result = gen.generate(awsInput([vpc]));
    const providers = result.files.find((f) => f.filename === 'providers.tf')!;
    expect(providers.content).toContain('hashicorp/aws');
    expect(providers.content).not.toContain('ARM_CLIENT_SECRET');
    expect(providers.content).not.toContain('access_key');
    expect(providers.content).not.toContain('secret_key');
  });

  test('Unsupported resource type generates warning', () => {
    const r = makeResource({ id: 'r1', resourceType: 'aws_xyzunknown', provider: 'aws', configJson: '{}' });
    const result = gen.generate(awsInput([r]));
    expect(result.warnings.some((w) => w.includes('aws_xyzunknown'))).toBe(true);
  });
});

describe('TerraformGenerator — Azure', () => {
  const gen = new TerraformGenerator();

  function azureInput(resources: DbArchitectureResource[], connections: DbArchitectureConnection[] = []): TerraformGenerationInput {
    return { architectureId: 'arch-1', projectId: 'proj-1', resources, connections };
  }

  test('Resource group generates azurerm_resource_group', () => {
    const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'my_rg', location: 'eastus' }) });
    const result = gen.generate(azureInput([rg]));
    const main = result.files.find((f) => f.filename === 'main.tf')!;
    expect(main.content).toContain('resource "azurerm_resource_group"');
  });

  test('VNet references connected resource group', () => {
    const rg   = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
    const vnet = makeResource({ id: 'vnet-1', resourceType: 'azure_vnet', provider: 'azure', configJson: JSON.stringify({ name: 'main_vnet' }) });
    const conn = makeConnection('rg-1', 'vnet-1');
    const result = gen.generate(azureInput([rg, vnet], [conn]));
    const main = result.files.find((f) => f.filename === 'main.tf')!;
    expect(main.content).toContain('azurerm_resource_group.main_rg');
  });

  test('SQL uses variables for credentials', () => {
    const sql = makeResource({ id: 'sql-1', resourceType: 'azure_sql', provider: 'azure', configJson: JSON.stringify({ name: 'mydb' }) });
    const result = gen.generate(azureInput([sql]));
    const main = result.files.find((f) => f.filename === 'main.tf')!;
    expect(main.content).toContain('var.sql_admin_password');
    expect(main.content).not.toMatch(/password\s*=\s*"[A-Za-z0-9]{3}/);
  });

  test('Storage sets enable_https_traffic_only', () => {
    const st = makeResource({ id: 'st-1', resourceType: 'azure_storage', provider: 'azure', configJson: JSON.stringify({ name: 'mystorage', httpsOnly: true }) });
    const result = gen.generate(azureInput([st]));
    const main = result.files.find((f) => f.filename === 'main.tf')!;
    expect(main.content).toContain('enable_https_traffic_only');
  });
});

describe('TerraformGenerator — multi-cloud (AWS + Azure)', () => {
  const gen = new TerraformGenerator();

  test('Mixed architecture generates both AWS and Azure blocks', () => {
    const vpc = makeResource({ id: 'vpc-1', resourceType: 'aws_vpc', provider: 'aws', configJson: JSON.stringify({ name: 'main_vpc' }) });
    const rg  = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
    const result = gen.generate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [vpc, rg], connections: [] });

    const main = result.files.find((f) => f.filename === 'main.tf')!;
    expect(main.content).toContain('aws_vpc');
    expect(main.content).toContain('azurerm_resource_group');

    const providers = result.files.find((f) => f.filename === 'providers.tf')!;
    expect(providers.content).toContain('hashicorp/aws');
    expect(providers.content).toContain('hashicorp/azurerm');

    expect(result.providers).toContain('aws');
    expect(result.providers).toContain('azure');
  });

  test('No credentials in any generated file', () => {
    const vpc = makeResource({ id: 'vpc-1', resourceType: 'aws_vpc', provider: 'aws', configJson: '{}' });
    const rg  = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: '{}' });
    const result = gen.generate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [vpc, rg], connections: [] });

    for (const file of result.files) {
      expect(file.content).not.toContain('AKID');
      expect(file.content).not.toContain('access_key =');
      expect(file.content).not.toContain('secret_key =');
      expect(file.content).not.toContain('client_secret =');
    }
  });

  test('Resource map populated for both providers', () => {
    const vpc = makeResource({ id: 'vpc-1', resourceType: 'aws_vpc', provider: 'aws', configJson: JSON.stringify({ name: 'my_vpc' }) });
    const rg  = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'my_rg' }) });
    const result = gen.generate({ architectureId: 'arch-1', projectId: 'proj-1', resources: [vpc, rg], connections: [] });
    expect(result.resourceMap['vpc-1']).toContain('aws_vpc');
    expect(result.resourceMap['rg-1']).toContain('azurerm_resource_group');
  });
});

// ─── API SECURITY: Org isolation (via mocked DB) ─────────────────────────────

import { NextRequest } from 'next/server';
import { POST as securityScanPost } from '@/app/api/projects/[id]/security-scans/route';
import { POST as costEstimatePost } from '@/app/api/projects/[id]/cost-estimates/route';
import { POST as terraformPost } from '@/app/api/projects/[id]/terraform/route';

function makeRequest(body: unknown, extraHeaders: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/projects/proj-1/security-scans?orgId=dev-org-id', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': 'dev-user-id',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function seedDevContext() {
  const now = new Date().toISOString();
  mockDb._stores['Organization'].set('dev-org-id', { id: 'dev-org-id', name: 'Dev', slug: 'dev-org', createdAt: now, updatedAt: now });
  mockDb._stores['User'].set('dev-user-id', { id: 'dev-user-id', email: 'dev@test.com', name: 'Dev', avatarUrl: null, createdAt: now, updatedAt: now });
  mockDb._stores['OrgMember'].set('member-1', { id: 'member-1', orgId: 'dev-org-id', userId: 'dev-user-id', role: 'owner' });
}

beforeEach(() => {
  mockDb._reset();
});

describe('API — organization isolation', () => {
  test('Security scan returns 401 without identity', async () => {
    const req = new NextRequest('http://localhost:3000/api/projects/proj-1/security-scans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // Remove NODE_ENV dev workaround by using production mock
    const originalEnv = process.env['NODE_ENV'];
    (process.env as Record<string, string>)['NODE_ENV'] = 'production';
    const res = await securityScanPost(req, { params: Promise.resolve({ id: 'proj-1' }) });
    (process.env as Record<string, string>)['NODE_ENV'] = originalEnv!;
    expect(res.status).toBe(401);
  });

  test('Security scan returns 403 when user not in org', async () => {
    seedDevContext();
    // Authenticated but no project → forbidden or not found
    const req = makeRequest({});
    // With dev context but no project with this org → 403 via getOrgRole (empty role)
    // Actually dev-user-id is in org, but we need to also test cross-org
    // Test: use a different userId that's NOT in the org
    const req2 = new NextRequest('http://localhost:3000/api/projects/proj-1/security-scans', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'other-user-not-in-org',
      },
      body: JSON.stringify({}),
    });
    const res = await securityScanPost(req2, { params: Promise.resolve({ id: 'proj-1' }) });
    expect([403, 400]).toContain(res.status); // forbidden or bad request (no orgId)
  });

  test('Cost estimate returns 401 without identity in production', async () => {
    const req = new NextRequest('http://localhost:3000/api/projects/proj-1/cost-estimates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const originalEnv = process.env['NODE_ENV'];
    (process.env as Record<string, string>)['NODE_ENV'] = 'production';
    const res = await costEstimatePost(req, { params: Promise.resolve({ id: 'proj-1' }) });
    (process.env as Record<string, string>)['NODE_ENV'] = originalEnv!;
    expect(res.status).toBe(401);
  });

  test('Terraform returns 401 without identity in production', async () => {
    const req = new NextRequest('http://localhost:3000/api/projects/proj-1/terraform', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const originalEnv = process.env['NODE_ENV'];
    (process.env as Record<string, string>)['NODE_ENV'] = 'production';
    const res = await terraformPost(req, { params: Promise.resolve({ id: 'proj-1' }) });
    (process.env as Record<string, string>)['NODE_ENV'] = originalEnv!;
    expect(res.status).toBe(401);
  });

  test('Security scan returns architecture_not_found gracefully for project with no arch', async () => {
    seedDevContext();
    const now = new Date().toISOString();

    // Create a project with environment but no architecture
    mockDb._stores['Project'].set('proj-noarch', { id: 'proj-noarch', name: 'No-Arch', orgId: 'dev-org-id', ownerId: 'dev-user-id', provider: 'aws', region: 'us-east-1', description: '', tags: '[]', createdAt: now, updatedAt: now });
    mockDb._stores['Environment'].set('env-noarch', { id: 'env-noarch', envKey: 'production', label: 'Production', region: 'us-east-1', projectId: 'proj-noarch', createdAt: now, updatedAt: now });

    const req = makeRequest({});
    const res = await securityScanPost(req, { params: Promise.resolve({ id: 'proj-noarch' }) });
    const body = await res.json() as { ok: boolean; data?: { message: string } };
    expect(body.ok).toBe(true);
    expect(body.data?.message).toContain('No architecture');
  });

  test('Non-existent project returns 404', async () => {
    seedDevContext();
    const req = makeRequest({});
    const res = await securityScanPost(req, { params: Promise.resolve({ id: 'does-not-exist' }) });
    const body = await res.json() as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('NOT_FOUND');
  });

  test('No secret leakage in API responses', async () => {
    seedDevContext();
    const now = new Date().toISOString();

    // Project + arch with S3
    mockDb._stores['Project'].set('proj-sec', { id: 'proj-sec', name: 'Sec', orgId: 'dev-org-id', ownerId: 'dev-user-id', provider: 'aws', region: 'us-east-1', description: '', tags: '[]', createdAt: now, updatedAt: now });
    mockDb._stores['Environment'].set('env-sec', { id: 'env-sec', envKey: 'production', label: 'Prod', region: 'us-east-1', projectId: 'proj-sec', createdAt: now, updatedAt: now });
    mockDb._stores['Architecture'].set('arch-sec', { id: 'arch-sec', environmentId: 'env-sec', createdAt: now, updatedAt: now });
    mockDb._stores['ArchitectureResource'].set('res-sec-1', {
      id: 'res-sec-1', architectureId: 'arch-sec', resourceType: 'aws_s3', provider: 'aws',
      label: 'My Bucket', positionX: 0, positionY: 0, configJson: JSON.stringify({ publicAccess: true }), region: null, groupId: null, locked: false,
    });

    const req = makeRequest({});
    const res = await securityScanPost(req, { params: Promise.resolve({ id: 'proj-sec' }) });
    const body = await res.text();

    // No credentials or secrets should appear in the response
    expect(body).not.toContain('credentialsJson');
    expect(body).not.toContain('AKIA');
    expect(body).not.toContain('ARM_CLIENT_SECRET');
  });
});

// ─── Regression Tests: Security Remediation & Rule ID Mismatch ──────────────

describe('Security Remediation & Rule-ID Matching', () => {
  const analyzer = new SecurityAnalyzer();

  test('All Phase 2D security rule IDs are fixable and remediations resolve findings', () => {
    const cases: Array<{
      ruleId: string;
      resourceType: string;
      provider: string;
      insecureConfig: Record<string, unknown>;
      extraContextResources?: DbArchitectureResource[];
    }> = [
      { ruleId: 'AWS-S3-PUBLIC', resourceType: 'aws_s3', provider: 'aws', insecureConfig: { publicAccess: true } },
      { ruleId: 'AWS-S3-NO-ENCRYPTION', resourceType: 'aws_s3', provider: 'aws', insecureConfig: { encryption: false } },
      { ruleId: 'AWS-S3-NO-PUBLIC-BLOCK', resourceType: 'aws_s3', provider: 'aws', insecureConfig: { blockPublicAccess: false } },
      { ruleId: 'AWS-RDS-NO-ENCRYPTION', resourceType: 'aws_rds', provider: 'aws', insecureConfig: { encrypted: false } },
      { ruleId: 'AWS-RDS-PUBLICLY-ACCESSIBLE', resourceType: 'aws_rds', provider: 'aws', insecureConfig: { publiclyAccessible: true } },
      { ruleId: 'AWS-RDS-NO-MULTI-AZ', resourceType: 'aws_rds', provider: 'aws', insecureConfig: { multiAz: false } },
      { ruleId: 'AWS-SG-OPEN-SSH', resourceType: 'aws_sg', provider: 'aws', insecureConfig: { allowSsh: true } },
      {
        ruleId: 'AWS-EC2-PUBLIC-SUBNET',
        resourceType: 'aws_subnet',
        provider: 'aws',
        insecureConfig: { mapPublicIpOnLaunch: true },
        extraContextResources: [makeResource({ resourceType: 'aws_ec2', provider: 'aws' })],
      },
      { ruleId: 'AWS-VPC-NO-DNS', resourceType: 'aws_vpc', provider: 'aws', insecureConfig: { enableDnsSupport: false } },
      { ruleId: 'AZ-STORAGE-NO-HTTPS', resourceType: 'azure_storage', provider: 'azure', insecureConfig: { httpsOnly: false } },
      { ruleId: 'AZ-STORAGE-PUBLIC-BLOB', resourceType: 'azure_storage', provider: 'azure', insecureConfig: { allowBlobPublicAccess: true } },
      { ruleId: 'AZ-SQL-PUBLIC-ACCESS', resourceType: 'azure_sql', provider: 'azure', insecureConfig: { publicNetworkAccess: true } },
      { ruleId: 'AZ-SQL-NO-TDE', resourceType: 'azure_sql', provider: 'azure', insecureConfig: { transparentDataEncryption: false } },
      { ruleId: 'AZ-NSG-OPEN-SSH', resourceType: 'azure_nsg', provider: 'azure', insecureConfig: { allowSsh: true } },
      { ruleId: 'AZ-NSG-OPEN-RDP', resourceType: 'azure_nsg', provider: 'azure', insecureConfig: { allowRdp: true } },
      { ruleId: 'AZ-VM-NO-DISK-ENCRYPTION', resourceType: 'azure_vm', provider: 'azure', insecureConfig: { diskEncryption: false } },
    ];

    for (const c of cases) {
      expect(isRuleFixable(c.ruleId)).toBe(true);

      const targetResource = makeResource({
        id: `res-${c.ruleId}`,
        resourceType: c.resourceType,
        provider: c.provider,
        configJson: JSON.stringify(c.insecureConfig),
      });

      const initialInput: SecurityAnalysisInput = {
        architectureId: 'arch-test',
        projectId: 'proj-test',
        resources: [targetResource, ...(c.extraContextResources ?? [])],
        connections: [],
      };

      // Ensure finding triggers before fix
      const beforeResult = analyzer.analyze(initialInput);
      const targetFindingBefore = beforeResult.findings.find((f) => f.ruleId === c.ruleId);
      expect(targetFindingBefore).toBeDefined();

      // Apply remediation
      const remediatedConfig = applyRuleRemediation(c.insecureConfig, c.ruleId);

      // Verify with fixed resource
      const fixedResource = {
        ...targetResource,
        configJson: JSON.stringify(remediatedConfig),
      };

      const afterResult = analyzer.analyze({
        ...initialInput,
        resources: [fixedResource, ...(c.extraContextResources ?? [])],
      });

      const targetFindingAfter = afterResult.findings.find((f) => f.ruleId === c.ruleId);
      expect(targetFindingAfter).toBeUndefined();
    }
  });

  test('Backwards compatibility: legacy rule IDs are fixable and remediate correctly', () => {
    const legacyRules = [
      { legacyId: 's3-encryption', config: { encryption: false }, expectedKey: 'encryption', expectedVal: true },
      { legacyId: 's3-public', config: { publicAccess: true }, expectedKey: 'publicAccess', expectedVal: false },
      { legacyId: 'rds-encryption', config: { encrypted: false }, expectedKey: 'encrypted', expectedVal: true },
      { legacyId: 'rds-multi-az', config: { multiAz: false }, expectedKey: 'multiAz', expectedVal: true },
      { legacyId: 'sg-open-ssh', config: { allowSsh: true }, expectedKey: 'allowSsh', expectedVal: false },
      { legacyId: 'nsg-open-ssh', config: { allowSsh: true }, expectedKey: 'allowSsh', expectedVal: false },
      { legacyId: 'nsg-open-rdp', config: { allowRdp: true }, expectedKey: 'allowRdp', expectedVal: false },
      { legacyId: 'storage-https', config: { httpsOnly: false }, expectedKey: 'httpsOnly', expectedVal: true },
    ];

    for (const lr of legacyRules) {
      expect(isRuleFixable(lr.legacyId)).toBe(true);
      const fixed = applyRuleRemediation(lr.config, lr.legacyId);
      expect(fixed[lr.expectedKey]).toBe(lr.expectedVal);
    }
  });

  test('ApiSecurityService and SecurityService applyFix apply the remediation properly', () => {
    const nodes = [
      {
        id: 'node-s3',
        type: 'cloudNode',
        resourceType: 'aws_s3',
        provider: 'aws' as const,
        label: 'Test Bucket',
        position: { x: 0, y: 0 },
        config: { encryption: false, publicAccess: true },
      },
    ];

    const fixedNodes1 = apiSecurityService.applyFix(nodes, 'node-s3', 'AWS-S3-NO-ENCRYPTION');
    expect(fixedNodes1[0].config['encryption']).toBe(true);

    const fixedNodes2 = securityService.applyFix(nodes, 'node-s3', 'AWS-S3-PUBLIC');
    expect(fixedNodes2[0].config['publicAccess']).toBe(false);
  });
});

// ─── Regression Tests: Environment Clone & Copy PK Collision Prevention ────

describe('Environment Clone & Architecture Copy (Unit)', () => {
  beforeEach(() => {
    mockDb._reset();
  });

  test('copyArchitecture creates fresh unique IDs and remaps connections', async () => {
    const now = new Date().toISOString();
    const srcEnvId = 'env-src';
    const dstEnvId = 'env-dst';

    mockDb._stores['Environment'].set(srcEnvId, { id: srcEnvId, envKey: 'development', label: 'Dev', region: 'us-east-1', projectId: 'p1', createdAt: now, updatedAt: now });
    mockDb._stores['Environment'].set(dstEnvId, { id: dstEnvId, envKey: 'staging', label: 'Staging', region: 'us-east-1', projectId: 'p1', createdAt: now, updatedAt: now });

    const srcArchId = 'arch-src';
    mockDb._stores['Architecture'].set(srcArchId, { id: srcArchId, environmentId: srcEnvId, createdAt: now, updatedAt: now });

    const srcRes1 = {
      id: 'res-src-vpc',
      architectureId: srcArchId,
      resourceType: 'aws_vpc',
      provider: 'aws',
      label: 'VPC',
      positionX: 10,
      positionY: 20,
      configJson: JSON.stringify({ cidr: '10.0.0.0/16' }),
      region: 'us-east-1',
      groupId: null,
      locked: false,
    };
    const srcRes2 = {
      id: 'res-src-subnet',
      architectureId: srcArchId,
      resourceType: 'aws_subnet',
      provider: 'aws',
      label: 'Subnet',
      positionX: 30,
      positionY: 40,
      configJson: JSON.stringify({ cidr: '10.0.1.0/24' }),
      region: 'us-east-1',
      groupId: 'res-src-vpc',
      locked: false,
    };
    mockDb._stores['ArchitectureResource'].set(srcRes1.id, srcRes1);
    mockDb._stores['ArchitectureResource'].set(srcRes2.id, srcRes2);

    const srcConn = {
      id: 'conn-src-1',
      architectureId: srcArchId,
      sourceId: srcRes1.id,
      targetId: srcRes2.id,
      edgeType: 'network',
      label: 'subnet-of',
    };
    mockDb._stores['ArchitectureConnection'].set(srcConn.id, srcConn);

    // Perform copyArchitecture
    const dstArch = await architectureRepository.copyArchitecture(srcEnvId, dstEnvId);

    // Verify destination architecture
    expect(dstArch).toBeDefined();
    expect(dstArch.environmentId).toBe(dstEnvId);
    expect(dstArch.resources).toHaveLength(2);
    expect(dstArch.connections).toHaveLength(1);

    // Verify all destination resource IDs are NEW and distinct from source IDs
    const dstVpc = dstArch.resources.find((r) => r.label === 'VPC')!;
    const dstSubnet = dstArch.resources.find((r) => r.label === 'Subnet')!;
    expect(dstVpc.id).not.toBe(srcRes1.id);
    expect(dstSubnet.id).not.toBe(srcRes2.id);
    expect(dstVpc.id).not.toBe(dstSubnet.id);

    // Verify group ID remapping
    expect(dstSubnet.groupId).toBe(dstVpc.id);

    // Verify connection remapping
    const dstConn = dstArch.connections[0];
    expect(dstConn.id).not.toBe(srcConn.id);
    expect(dstConn.sourceId).toBe(dstVpc.id);
    expect(dstConn.targetId).toBe(dstSubnet.id);

    // Verify source architecture remains completely unchanged
    const srcArchAfter = await architectureRepository.findByEnvironment(srcEnvId);
    expect(srcArchAfter!.resources).toHaveLength(2);
    expect(srcArchAfter!.resources.map((r) => r.id).sort()).toEqual([srcRes1.id, srcRes2.id].sort());
    expect(srcArchAfter!.connections).toHaveLength(1);
    expect(srcArchAfter!.connections[0].id).toBe(srcConn.id);
    expect(srcArchAfter!.connections[0].sourceId).toBe(srcRes1.id);
    expect(srcArchAfter!.connections[0].targetId).toBe(srcRes2.id);
  });
});
