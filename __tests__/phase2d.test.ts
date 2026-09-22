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

  describe('S3 config depth round-trip', () => {
    test('encryption=false skips the SSE resource entirely (no silent override)', () => {
      const s3 = makeResource({ id: 's3-1', resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ name: 'unencrypted_bucket', encryption: false }) });
      const result = gen.generate(awsInput([s3]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).not.toContain('aws_s3_bucket_server_side_encryption_configuration');
    });

    test('SSE-KMS with a key ID flows into the encryption block', () => {
      const s3 = makeResource({
        id: 's3-1', resourceType: 'aws_s3', provider: 'aws',
        configJson: JSON.stringify({ name: 'kms_bucket', encryption: true, encryptionType: 'aws:kms', kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc' }),
      });
      const result = gen.generate(awsInput([s3]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('sse_algorithm     = "aws:kms"');
      expect(main.content).toContain('kms_master_key_id = "arn:aws:kms:us-east-1:123456789012:key/abc"');
    });

    test('blockPublicAcls/blockPublicPolicy are honored only when publicAccess is intentionally enabled', () => {
      const locked = makeResource({ id: 's3-1', resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ name: 'locked', publicAccess: false, blockPublicAcls: false, blockPublicPolicy: false }) });
      const lockedResult = gen.generate(awsInput([locked]));
      const lockedMain = lockedResult.files.find((f) => f.filename === 'main.tf')!;
      expect(lockedMain.content).toContain('block_public_acls       = true');

      const openIntentional = makeResource({ id: 's3-2', resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ name: 'open', publicAccess: true, blockPublicAcls: false, blockPublicPolicy: false }) });
      const openResult = gen.generate(awsInput([openIntentional]));
      const openMain = openResult.files.find((f) => f.filename === 'main.tf')!;
      expect(openMain.content).toContain('block_public_acls       = false');
    });

    test('lifecycle transition and expiration rules generate a lifecycle_configuration resource', () => {
      const s3 = makeResource({
        id: 's3-1', resourceType: 'aws_s3', provider: 'aws',
        configJson: JSON.stringify({ name: 'archived', lifecycleTransitionDays: 30, lifecycleTransitionStorageClass: 'GLACIER', lifecycleExpirationDays: 365 }),
      });
      const result = gen.generate(awsInput([s3]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_s3_bucket_lifecycle_configuration"');
      expect(main.content).toContain('days          = 30');
      expect(main.content).toContain('storage_class = "GLACIER"');
      expect(main.content).toContain('days = 365');
    });

    test('no lifecycle rules configured emits no lifecycle_configuration resource', () => {
      const s3 = makeResource({ id: 's3-1', resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ name: 'plain' }) });
      const result = gen.generate(awsInput([s3]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).not.toContain('aws_s3_bucket_lifecycle_configuration');
    });

    test('custom tags merge into the aws_s3_bucket tags block', () => {
      const s3 = makeResource({ id: 's3-1', resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ name: 'tagged', tags: { Team: 'platform' } }) });
      const result = gen.generate(awsInput([s3]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('Team = "platform"');
    });
  });

  describe('EC2 config depth round-trip', () => {
    test('root_block_device reflects storage type, size, and encryption', () => {
      const ec2 = makeResource({
        id: 'ec2-1', resourceType: 'aws_ec2', provider: 'aws',
        configJson: JSON.stringify({ name: 'app_server', storageGb: 100, storageType: 'io2', storageIops: 5000, encrypted: true }),
      });
      const result = gen.generate(awsInput([ec2]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('volume_size           = 100');
      expect(main.content).toContain('volume_type           = "io2"');
      expect(main.content).toContain('iops                  = 5000');
      expect(main.content).toContain('encrypted             = true');
    });

    test('gp3 root volume omits iops', () => {
      const ec2 = makeResource({ id: 'ec2-1', resourceType: 'aws_ec2', provider: 'aws', configJson: JSON.stringify({ name: 'app_server' }) });
      const result = gen.generate(awsInput([ec2]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).not.toMatch(/root_block_device[\s\S]*?iops/);
    });

    test('IAM instance profile and user data flow into the instance block', () => {
      const ec2 = makeResource({
        id: 'ec2-1', resourceType: 'aws_ec2', provider: 'aws',
        configJson: JSON.stringify({ name: 'worker', iamInstanceProfile: 'worker-profile', userData: 'echo hello' }),
      });
      const result = gen.generate(awsInput([ec2]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('iam_instance_profile        = "worker-profile"');
      expect(main.content).toContain('echo hello');
    });

    test('termination protection and shutdown behavior are always emitted', () => {
      const ec2 = makeResource({ id: 'ec2-1', resourceType: 'aws_ec2', provider: 'aws', configJson: JSON.stringify({ name: 'critical', terminationProtection: true, instanceInitiatedShutdownBehavior: 'terminate' }) });
      const result = gen.generate(awsInput([ec2]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('disable_api_termination     = true');
      expect(main.content).toContain('instance_initiated_shutdown_behavior = "terminate"');
    });
  });

  describe('Security Group config depth round-trip', () => {
    function sgWithVpc(sgConfig: Record<string, unknown>) {
      const vpc = makeResource({ id: 'vpc-1', resourceType: 'aws_vpc', provider: 'aws', configJson: JSON.stringify({ name: 'main_vpc' }) });
      const sg = makeResource({ id: 'sg-1', resourceType: 'aws_sg', provider: 'aws', configJson: JSON.stringify(sgConfig), groupId: 'vpc-1' });
      const conn = makeConnection('vpc-1', 'sg-1');
      return gen.generate(awsInput([vpc, sg], [conn]));
    }

    test('allowRdp actually generates an RDP ingress rule (previously silently dropped)', () => {
      const result = sgWithVpc({ name: 'rdp_sg', allowRdp: true, allowHttp: false, allowHttps: false });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('from_port   = 3389');
      expect(main.content).toContain('description = "RDP - RESTRICT THIS IN PRODUCTION"');
    });

    test('sourceCidr is applied to generated ingress rules instead of a hardcoded 0.0.0.0/0', () => {
      const result = sgWithVpc({ name: 'restricted_sg', allowSsh: true, sourceCidr: '203.0.113.0/24' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      const ingressBlock = main.content.match(/ingress \{[\s\S]*?\}/)![0];
      expect(ingressBlock).toContain('cidr_blocks = ["203.0.113.0/24"]');
      expect(ingressBlock).not.toContain('0.0.0.0/0');
    });

    test('allowAllOutbound=false restricts egress to the configured CIDR', () => {
      const result = sgWithVpc({ name: 'locked_egress_sg', allowAllOutbound: false, egressCidr: '10.0.0.0/8' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('cidr_blocks = ["10.0.0.0/8"]');
      expect(main.content).toContain('description = "Restricted outbound"');
    });

    test('custom description flows into the security group resource', () => {
      const result = sgWithVpc({ name: 'documented_sg', description: 'Allows web tier ingress only' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('description = "Allows web tier ingress only"');
    });
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

  test('Legacy GCP resources generate an explicit warning instead of silently vanishing', () => {
    const legacyGcp = makeResource({ id: 'gcp-1', resourceType: 'gcp_compute_instance', provider: 'gcp', configJson: '{}' });
    const result = gen.generate(awsInput([legacyGcp]));
    expect(result.warnings.some((w) => w.toLowerCase().includes('gcp') && w.toLowerCase().includes('no longer supported'))).toBe(true);
    expect(result.providers).not.toContain('gcp');
  });

  describe('RDS config depth round-trip', () => {
    test('storage type, IOPS, and KMS key flow into aws_db_instance', () => {
      const rds = makeResource({
        id: 'rds-1', resourceType: 'aws_rds', provider: 'aws',
        configJson: JSON.stringify({
          name: 'orders_db', storageType: 'io2', iops: 8000,
          encrypted: true, kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc',
          masterUsername: 'orders_admin', port: 5432,
        }),
      });
      const result = gen.generate(awsInput([rds]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('storage_type                   = "io2"');
      expect(main.content).toContain('iops                           = 8000');
      expect(main.content).toContain('kms_key_id                     = "arn:aws:kms:us-east-1:123456789012:key/abc"');
      expect(main.content).toContain('username                       = "orders_admin"');
      expect(main.content).toContain('port                            = 5432');
    });

    test('enhanced monitoring generates an IAM role for the monitoring interval', () => {
      const rds = makeResource({
        id: 'rds-1', resourceType: 'aws_rds', provider: 'aws',
        configJson: JSON.stringify({ name: 'monitored_db', monitoringInterval: 15 }),
      });
      const result = gen.generate(awsInput([rds]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('monitoring_interval            = 15');
      expect(main.content).toContain('resource "aws_iam_role" "monitored_db_monitoring"');
      expect(main.content).toContain('AmazonRDSEnhancedMonitoringRole');
    });

    test('read replicas generate one aws_db_instance per replica with replicate_source_db', () => {
      const rds = makeResource({
        id: 'rds-1', resourceType: 'aws_rds', provider: 'aws',
        configJson: JSON.stringify({ name: 'primary_db', readReplicas: 2 }),
      });
      const result = gen.generate(awsInput([rds]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_db_instance" "primary_db_replica_1"');
      expect(main.content).toContain('resource "aws_db_instance" "primary_db_replica_2"');
      expect(main.content).toContain('replicate_source_db    = aws_db_instance.primary_db.identifier');
    });

    test('zero read replicas emits no replica blocks', () => {
      const rds = makeResource({ id: 'rds-1', resourceType: 'aws_rds', provider: 'aws', configJson: JSON.stringify({ name: 'solo_db' }) });
      const result = gen.generate(awsInput([rds]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).not.toContain('_replica_');
    });

    test('CloudWatch log exports render as a Terraform list', () => {
      const rds = makeResource({
        id: 'rds-1', resourceType: 'aws_rds', provider: 'aws',
        configJson: JSON.stringify({ name: 'audited_db', enableCloudwatchLogsExports: ['error', 'general'] }),
      });
      const result = gen.generate(awsInput([rds]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('enabled_cloudwatch_logs_exports = ["error", "general"]');
    });

    test('custom tags merge into the aws_db_instance tags block', () => {
      const rds = makeResource({
        id: 'rds-1', resourceType: 'aws_rds', provider: 'aws',
        configJson: JSON.stringify({ name: 'tagged_db', tags: { CostCenter: 'eng-42', Env: 'prod' } }),
      });
      const result = gen.generate(awsInput([rds]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('CostCenter = "eng-42"');
      expect(main.content).toContain('Env = "prod"');
    });
  });

  describe('Lambda Terraform generation (previously completely unsupported)', () => {
    test('generates a function resource with its own IAM execution role', () => {
      const fn = makeResource({ id: 'fn-1', resourceType: 'aws_lambda', provider: 'aws', configJson: JSON.stringify({ name: 'process_orders', runtime: 'python3.13', memorySize: 1024, timeout: 30 }) });
      const result = gen.generate(awsInput([fn]));
      expect(result.warnings.some((w) => w.includes('aws_lambda') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_lambda_function" "process_orders"');
      expect(main.content).toContain('runtime       = "python3.13"');
      expect(main.content).toContain('memory_size   = 1024');
      expect(main.content).toContain('timeout       = 30');
      expect(main.content).toContain('resource "aws_iam_role" "process_orders_exec_role"');
      expect(main.content).toContain('AWSLambdaBasicExecutionRole');
    });

    test('VPC-attached function (connected to a subnet) gets a vpc_config block and the VPC access policy', () => {
      const subnet = makeResource({ id: 'sub-1', resourceType: 'aws_subnet', provider: 'aws', configJson: JSON.stringify({ name: 'private_subnet' }) });
      const fn = makeResource({ id: 'fn-1', resourceType: 'aws_lambda', provider: 'aws', configJson: JSON.stringify({ name: 'vpc_fn' }), groupId: 'sub-1' });
      const conn = makeConnection('sub-1', 'fn-1');
      const result = gen.generate(awsInput([subnet, fn], [conn]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('vpc_config {');
      expect(main.content).toContain('AWSLambdaVPCAccessExecutionRole');
    });

    test('environment variables flow into the environment block', () => {
      const fn = makeResource({ id: 'fn-1', resourceType: 'aws_lambda', provider: 'aws', configJson: JSON.stringify({ name: 'configured_fn', environmentVariables: { STAGE: 'prod', LOG_LEVEL: 'info' } }) });
      const result = gen.generate(awsInput([fn]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('STAGE = "prod"');
      expect(main.content).toContain('LOG_LEVEL = "info"');
    });

    test('provisioned concurrency publishes a version and generates a provisioned-concurrency config', () => {
      const fn = makeResource({ id: 'fn-1', resourceType: 'aws_lambda', provider: 'aws', configJson: JSON.stringify({ name: 'warm_fn', provisionedConcurrency: 5 }) });
      const result = gen.generate(awsInput([fn]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('publish = true');
      expect(main.content).toContain('resource "aws_lambda_provisioned_concurrency_config"');
      expect(main.content).toContain('provisioned_concurrent_executions = 5');
    });
  });

  describe('ALB target group and listener (previously never generated)', () => {
    function albWithVpc(albConfig: Record<string, unknown>) {
      const vpc = makeResource({ id: 'vpc-1', resourceType: 'aws_vpc', provider: 'aws', configJson: JSON.stringify({ name: 'main_vpc' }) });
      const subnetA = makeResource({ id: 'sub-a', resourceType: 'aws_subnet', provider: 'aws', configJson: JSON.stringify({ name: 'subnet_a' }), groupId: 'vpc-1' });
      const subnetB = makeResource({ id: 'sub-b', resourceType: 'aws_subnet', provider: 'aws', configJson: JSON.stringify({ name: 'subnet_b' }), groupId: 'vpc-1' });
      const alb = makeResource({ id: 'alb-1', resourceType: 'aws_alb', provider: 'aws', configJson: JSON.stringify(albConfig) });
      const conns = [makeConnection('vpc-1', 'sub-a'), makeConnection('vpc-1', 'sub-b'), makeConnection('sub-a', 'alb-1'), makeConnection('sub-b', 'alb-1')];
      return gen.generate(awsInput([vpc, subnetA, subnetB, alb], conns));
    }

    test('generates a target group and listener forwarding to it', () => {
      const result = albWithVpc({ name: 'web_alb', targetPort: 8080, targetProtocol: 'HTTP', listenerProtocol: 'HTTP', listenerPort: 80 });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_lb_target_group" "web_alb_tg"');
      expect(main.content).toContain('port        = 8080');
      expect(main.content).toContain('resource "aws_lb_listener" "web_alb_listener"');
      expect(main.content).toContain('target_group_arn = aws_lb_target_group.web_alb_tg.arn');
    });

    test('HTTPS listener without a certificate ARN gets an explicit warning comment instead of silently applying broken', () => {
      const result = albWithVpc({ name: 'unsecured_alb', listenerProtocol: 'HTTPS', certificateArn: '' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('WARNING: certificate_arn not set');
    });

    test('HTTPS listener with a certificate ARN configures it on the listener', () => {
      const result = albWithVpc({ name: 'secured_alb', listenerProtocol: 'HTTPS', certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('certificate_arn   = "arn:aws:acm:us-east-1:123456789012:certificate/abc"');
    });

    test('deletionProtection flows into enable_deletion_protection (previously hardcoded to false)', () => {
      const result = albWithVpc({ name: 'protected_alb', deletionProtection: true });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('enable_deletion_protection = true');
    });
  });

  describe('DynamoDB Terraform generation (previously completely unsupported)', () => {
    test('generates a table with the configured partition and sort keys', () => {
      const table = makeResource({ id: 'ddb-1', resourceType: 'aws_dynamodb', provider: 'aws', configJson: JSON.stringify({ name: 'orders', partitionKeyName: 'orderId', partitionKeyType: 'S', sortKeyName: 'createdAt', sortKeyType: 'N' }) });
      const result = gen.generate(awsInput([table]));
      expect(result.warnings.some((w) => w.includes('aws_dynamodb') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_dynamodb_table" "orders"');
      expect(main.content).toContain('hash_key     = "orderId"');
      expect(main.content).toContain('range_key    = "createdAt"');
    });

    test('PROVISIONED billing mode emits read/write capacity; PAY_PER_REQUEST omits it', () => {
      const provisioned = makeResource({ id: 'ddb-1', resourceType: 'aws_dynamodb', provider: 'aws', configJson: JSON.stringify({ name: 'provisioned_table', billingMode: 'PROVISIONED', readCapacity: 20, writeCapacity: 10 }) });
      const provisionedResult = gen.generate(awsInput([provisioned]));
      const provisionedMain = provisionedResult.files.find((f) => f.filename === 'main.tf')!;
      expect(provisionedMain.content).toContain('read_capacity  = 20');
      expect(provisionedMain.content).toContain('write_capacity = 10');

      const onDemand = makeResource({ id: 'ddb-2', resourceType: 'aws_dynamodb', provider: 'aws', configJson: JSON.stringify({ name: 'ondemand_table', billingMode: 'PAY_PER_REQUEST' }) });
      const onDemandResult = gen.generate(awsInput([onDemand]));
      const onDemandMain = onDemandResult.files.find((f) => f.filename === 'main.tf')!;
      expect(onDemandMain.content).not.toContain('read_capacity');
    });

    test('streamEnabled generates stream_enabled/stream_view_type', () => {
      const table = makeResource({ id: 'ddb-1', resourceType: 'aws_dynamodb', provider: 'aws', configJson: JSON.stringify({ name: 'streamed_table', streamEnabled: true, streamViewType: 'NEW_IMAGE' }) });
      const result = gen.generate(awsInput([table]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('stream_enabled   = true');
      expect(main.content).toContain('stream_view_type = "NEW_IMAGE"');
    });
  });

  describe('ElastiCache Terraform generation (previously completely unsupported)', () => {
    test('generates a replication group with the configured node type and count', () => {
      const cache = makeResource({ id: 'cache-1', resourceType: 'aws_elasticache', provider: 'aws', configJson: JSON.stringify({ name: 'session_cache', nodeType: 'cache.r6g.large', numNodes: 3 }) });
      const result = gen.generate(awsInput([cache]));
      expect(result.warnings.some((w) => w.includes('aws_elasticache') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_elasticache_replication_group" "session_cache"');
      expect(main.content).toContain('node_type             = "cache.r6g.large"');
      expect(main.content).toContain('num_cache_clusters    = 3');
      expect(main.content).toContain('automatic_failover_enabled = true');
    });

    test('single-node cluster disables automatic failover regardless of the config value', () => {
      const cache = makeResource({ id: 'cache-1', resourceType: 'aws_elasticache', provider: 'aws', configJson: JSON.stringify({ name: 'solo_cache', numNodes: 1, automaticFailoverEnabled: true }) });
      const result = gen.generate(awsInput([cache]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('automatic_failover_enabled = false');
    });
  });

  describe('SQS Terraform generation (previously completely unsupported)', () => {
    test('generates a queue with encryption and the configured retention/timeout', () => {
      const queue = makeResource({ id: 'sqs-1', resourceType: 'aws_sqs', provider: 'aws', configJson: JSON.stringify({ name: 'orders_queue', visibilityTimeoutSeconds: 60, messageRetentionSeconds: 86400 }) });
      const result = gen.generate(awsInput([queue]));
      expect(result.warnings.some((w) => w.includes('aws_sqs') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_sqs_queue" "orders_queue"');
      expect(main.content).toContain('visibility_timeout_seconds = 60');
      expect(main.content).toContain('message_retention_seconds  = 86400');
      expect(main.content).toContain('sqs_managed_sse_enabled    = true');
    });

    test('fifoQueue appends .fifo to the queue name and sets fifo_queue', () => {
      const queue = makeResource({ id: 'sqs-1', resourceType: 'aws_sqs', provider: 'aws', configJson: JSON.stringify({ name: 'ordered_events', fifoQueue: true, contentBasedDeduplication: true }) });
      const result = gen.generate(awsInput([queue]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('name                       = "ordered_events.fifo"');
      expect(main.content).toContain('fifo_queue                 = true');
      expect(main.content).toContain('content_based_deduplication = true');
    });

    test('dead-letter queue ARN generates a redrive_policy', () => {
      const queue = makeResource({ id: 'sqs-1', resourceType: 'aws_sqs', provider: 'aws', configJson: JSON.stringify({ name: 'monitored_queue', deadLetterTargetArn: 'arn:aws:sqs:us-east-1:123456789012:monitored-dlq', maxReceiveCount: 3 }) });
      const result = gen.generate(awsInput([queue]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('redrive_policy');
      expect(main.content).toContain('maxReceiveCount     = 3');
    });
  });

  describe('ECS Terraform generation (previously completely unsupported)', () => {
    function ecsWithSubnet(ecsConfig: Record<string, unknown>) {
      const subnet = makeResource({ id: 'sub-1', resourceType: 'aws_subnet', provider: 'aws', configJson: JSON.stringify({ name: 'app_subnet' }) });
      const svc = makeResource({ id: 'ecs-1', resourceType: 'aws_ecs', provider: 'aws', configJson: JSON.stringify(ecsConfig), groupId: 'sub-1' });
      const conn = makeConnection('sub-1', 'ecs-1');
      return gen.generate(awsInput([subnet, svc], [conn]));
    }

    test('generates a cluster, task definition, execution role, and service', () => {
      const result = ecsWithSubnet({ name: 'api_service', containerImage: 'myorg/api:v1', containerPort: 3000 });
      expect(result.warnings.some((w) => w.includes('aws_ecs') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_ecs_cluster" "api_service_cluster"');
      expect(main.content).toContain('resource "aws_ecs_task_definition" "api_service"');
      expect(main.content).toContain('resource "aws_iam_role" "api_service_exec_role"');
      expect(main.content).toContain('resource "aws_ecs_service" "api_service"');
      expect(main.content).toContain('image     = "myorg/api:v1"');
    });

    test('Fargate service gets awsvpc network_configuration; EC2 launch type omits it', () => {
      const fargate = ecsWithSubnet({ name: 'fargate_svc', launchType: 'FARGATE' });
      const fargateMain = fargate.files.find((f) => f.filename === 'main.tf')!;
      expect(fargateMain.content).toContain('network_mode             = "awsvpc"');
      expect(fargateMain.content).toContain('network_configuration {');

      const ec2 = ecsWithSubnet({ name: 'ec2_svc', launchType: 'EC2' });
      const ec2Main = ec2.files.find((f) => f.filename === 'main.tf')!;
      expect(ec2Main.content).toContain('network_mode             = "bridge"');
      expect(ec2Main.content).not.toContain('network_configuration {');
    });

    test('environment variables flow into the task definition container_definitions', () => {
      const result = ecsWithSubnet({ name: 'configured_svc', environmentVariables: { STAGE: 'prod' } });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('"name": "STAGE", "value": "prod"');
    });

    test('maxCapacity > minCapacity generates an autoscaling target', () => {
      const result = ecsWithSubnet({ name: 'scaled_svc', minCapacity: 2, maxCapacity: 20 });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_appautoscaling_target" "scaled_svc_scaling"');
      expect(main.content).toContain('max_capacity       = 20');
    });
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

  describe('Function App Terraform generation (previously completely unsupported)', () => {
    function functionsWithRg(fnConfig: Record<string, unknown>) {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const fn = makeResource({ id: 'fn-1', resourceType: 'azure_functions', provider: 'azure', configJson: JSON.stringify(fnConfig) });
      const conn = makeConnection('rg-1', 'fn-1');
      return gen.generate(azureInput([rg, fn], [conn]));
    }

    test('osType=Windows generates azurerm_windows_function_app; Linux (default) generates azurerm_linux_function_app', () => {
      const windows = functionsWithRg({ name: 'win_func', osType: 'Windows' });
      const windowsMain = windows.files.find((f) => f.filename === 'main.tf')!;
      expect(windowsMain.content).toContain('resource "azurerm_windows_function_app" "win_func"');

      const linux = functionsWithRg({ name: 'linux_func' });
      const linuxMain = linux.files.find((f) => f.filename === 'main.tf')!;
      expect(linuxMain.content).toContain('resource "azurerm_linux_function_app" "linux_func"');
    });

    test('generates a dedicated storage account and service plan the app depends on', () => {
      const result = functionsWithRg({ name: 'my_func' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_storage_account" "my_func_sa"');
      expect(main.content).toContain('resource "azurerm_service_plan" "my_func_plan"');
      expect(main.content).toContain('storage_account_name       = azurerm_storage_account.my_func_sa.name');
    });

    test('Consumption plan (Y1) omits always_on; Premium/Dedicated plans include it', () => {
      const consumption = functionsWithRg({ name: 'consumption_func', planType: 'Y1' });
      const consumptionMain = consumption.files.find((f) => f.filename === 'main.tf')!;
      expect(consumptionMain.content).not.toContain('always_on');

      const premium = functionsWithRg({ name: 'premium_func', planType: 'EP1', alwaysOn: true });
      const premiumMain = premium.files.find((f) => f.filename === 'main.tf')!;
      expect(premiumMain.content).toContain('always_on           = true');
      expect(premiumMain.content).toContain('sku_name            = "EP1"');
    });

    test('application settings flow into app_settings', () => {
      const result = functionsWithRg({ name: 'configured_func', appSettings: { FEATURE_FLAG: 'on' } });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('"FEATURE_FLAG" = "on"');
    });
  });

  describe('Storage account config depth round-trip', () => {
    test('account_kind reflects the configured kind (previously always defaulted, ignoring the field)', () => {
      const st = makeResource({ id: 'st-1', resourceType: 'azure_storage', provider: 'azure', configJson: JSON.stringify({ name: 'blobstore', kind: 'BlobStorage' }) });
      const result = gen.generate(azureInput([st]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('account_kind             = "BlobStorage"');
    });

    test('allowBlobPublicAccess=false actually sets allow_nested_items_to_be_public (previously never read by Terraform)', () => {
      const st = makeResource({ id: 'st-1', resourceType: 'azure_storage', provider: 'azure', configJson: JSON.stringify({ name: 'lockeddown', allowBlobPublicAccess: false }) });
      const result = gen.generate(azureInput([st]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('allow_nested_items_to_be_public = false');
    });

    test('minimumTlsVersion is honored instead of hardcoded to TLS1_2', () => {
      const st = makeResource({ id: 'st-1', resourceType: 'azure_storage', provider: 'azure', configJson: JSON.stringify({ name: 'legacycompat', minimumTlsVersion: 'TLS1_0' }) });
      const result = gen.generate(azureInput([st]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('min_tls_version          = "TLS1_0"');
    });

    test('blob versioning and soft delete generate a blob_properties block', () => {
      const st = makeResource({ id: 'st-1', resourceType: 'azure_storage', provider: 'azure', configJson: JSON.stringify({ name: 'versioned', blobVersioningEnabled: true, blobSoftDeleteRetentionDays: 14 }) });
      const result = gen.generate(azureInput([st]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('versioning_enabled = true');
      expect(main.content).toContain('days = 14');
    });

    test('networkDefaultAction=Deny generates a network_rules block; Allow (default) omits it', () => {
      const denied = makeResource({ id: 'st-1', resourceType: 'azure_storage', provider: 'azure', configJson: JSON.stringify({ name: 'restricted', networkDefaultAction: 'Deny' }) });
      const deniedResult = gen.generate(azureInput([denied]));
      const deniedMain = deniedResult.files.find((f) => f.filename === 'main.tf')!;
      expect(deniedMain.content).toContain('network_rules {');

      const open = makeResource({ id: 'st-2', resourceType: 'azure_storage', provider: 'azure', configJson: JSON.stringify({ name: 'open' }) });
      const openResult = gen.generate(azureInput([open]));
      const openMain = openResult.files.find((f) => f.filename === 'main.tf')!;
      expect(openMain.content).not.toContain('network_rules {');
    });
  });

  describe('VM config depth round-trip', () => {
    function vmWithRgAndSubnet(vmConfig: Record<string, unknown>) {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const subnet = makeResource({ id: 'subnet-1', resourceType: 'azure_subnet', provider: 'azure', configJson: JSON.stringify({ name: 'main_subnet' }) });
      const vm = makeResource({ id: 'vm-1', resourceType: 'azure_vm', provider: 'azure', configJson: JSON.stringify(vmConfig), groupId: 'subnet-1' });
      const conns = [makeConnection('rg-1', 'vm-1'), makeConnection('subnet-1', 'vm-1')];
      return gen.generate(azureInput([rg, subnet, vm], conns));
    }

    test('osType=Windows generates azurerm_windows_virtual_machine, not Linux (previously always generated Linux)', () => {
      const result = vmWithRgAndSubnet({ name: 'win_vm', osType: 'Windows' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_windows_virtual_machine" "win_vm"');
      expect(main.content).not.toContain('resource "azurerm_linux_virtual_machine" "win_vm"');
      expect(main.content).toContain('admin_password        = var.windows_admin_password');
      expect(main.content).not.toContain('admin_ssh_key');
    });

    test('osType=Linux (default) still generates azurerm_linux_virtual_machine with an SSH key block', () => {
      const result = vmWithRgAndSubnet({ name: 'linux_vm' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_linux_virtual_machine" "linux_vm"');
      expect(main.content).toContain('admin_ssh_key {');
    });

    test('publicIpEnabled generates a public IP resource and attaches it to the NIC (previously silently dropped)', () => {
      const withPip = vmWithRgAndSubnet({ name: 'public_vm', publicIpEnabled: true });
      const withPipMain = withPip.files.find((f) => f.filename === 'main.tf')!;
      expect(withPipMain.content).toContain('resource "azurerm_public_ip" "public_vm_pip"');
      expect(withPipMain.content).toContain('public_ip_address_id          = azurerm_public_ip.public_vm_pip.id');

      const withoutPip = vmWithRgAndSubnet({ name: 'private_vm', publicIpEnabled: false });
      const withoutPipMain = withoutPip.files.find((f) => f.filename === 'main.tf')!;
      expect(withoutPipMain.content).not.toContain('azurerm_public_ip');
    });

    test('Windows VM architecture generates a windows_admin_password variable, not admin_ssh_public_key', () => {
      const result = vmWithRgAndSubnet({ name: 'win_only_vm', osType: 'Windows' });
      const variables = result.files.find((f) => f.filename === 'variables.tf')!;
      expect(variables.content).toContain('variable "windows_admin_password"');
      expect(variables.content).not.toContain('variable "admin_ssh_public_key"');
    });

    test('custom tags merge into the VM tags block', () => {
      const result = vmWithRgAndSubnet({ name: 'tagged_vm', tags: { Owner: 'platform-team' } });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('Owner = "platform-team"');
    });
  });

  describe('SQL config depth round-trip', () => {
    test('minimumTlsVersion and zone/read-scale settings flow into the database resource', () => {
      const sql = makeResource({
        id: 'sql-1', resourceType: 'azure_sql', provider: 'azure',
        configJson: JSON.stringify({ name: 'critical_db', minimumTlsVersion: '1.2', zoneRedundant: true, readScale: true, requestedBackupStorageRedundancy: 'GeoZone' }),
      });
      const result = gen.generate(azureInput([sql]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('minimum_tls_version          = "1.2"');
      expect(main.content).toContain('zone_redundant               = true');
      expect(main.content).toContain('read_scale                   = true');
      expect(main.content).toContain('storage_account_type         = "GeoZone"');
    });

    test('transparentDataEncryptionEnabled=false is honored (previously hardcoded to always true)', () => {
      const sql = makeResource({ id: 'sql-1', resourceType: 'azure_sql', provider: 'azure', configJson: JSON.stringify({ name: 'legacy_db', transparentDataEncryptionEnabled: false }) });
      const result = gen.generate(azureInput([sql]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('transparent_data_encryption_enabled = false');
    });

    test('publicNetworkAccess + allowAzureServices generates the Azure-services firewall rule', () => {
      const withRule = gen.generate(azureInput([makeResource({ id: 'sql-1', resourceType: 'azure_sql', provider: 'azure', configJson: JSON.stringify({ name: 'public_db', publicNetworkAccess: true, allowAzureServices: true }) })]));
      const withRuleMain = withRule.files.find((f) => f.filename === 'main.tf')!;
      expect(withRuleMain.content).toContain('resource "azurerm_mssql_firewall_rule"');

      const withoutRule = gen.generate(azureInput([makeResource({ id: 'sql-2', resourceType: 'azure_sql', provider: 'azure', configJson: JSON.stringify({ name: 'private_db', publicNetworkAccess: false }) })]));
      const withoutRuleMain = withoutRule.files.find((f) => f.filename === 'main.tf')!;
      expect(withoutRuleMain.content).not.toContain('azurerm_mssql_firewall_rule');
    });
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
