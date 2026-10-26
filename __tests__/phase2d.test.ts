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
  if (isSelect && /= ANY\(\$1::text\[\]\)/.test(sql)) {
    // saveCanvas guard: IDs already owned by a different architecture (global PK).
    const [nodeIds, archId, edgeIds] = params as [string[], string, string[]];
    const owned = (store: string, ids: string[]) => [...mockDb._stores[store].values()]
      .filter((r) => ids.includes((r as Record<string, unknown>)['id'] as string) && (r as Record<string, unknown>)['architectureId'] !== archId)
      .map((r) => ({ id: (r as Record<string, unknown>)['id'] }));
    return { rows: [...owned('ArchitectureResource', nodeIds), ...owned('ArchitectureConnection', edgeIds)] };
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

describe('SecurityAnalyzer — AWS rules (unified assessment engine)', () => {
  const analyzer = new SecurityAnalyzer();

  test('AWS-S3-001: fires when publicAccess=true (Block Public Access not enforced)', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ publicAccess: true, blockPublicAcls: false, blockPublicPolicy: false }) });
    const result = analyzer.analyze(baseSecurityInput([r]));
    const f = result.findings.find((x) => x.ruleId === 'AWS-S3-001');
    expect(f?.severity).toBe('critical');
    expect(f?.resourceId).toBe(r.id);
  });

  test('AWS-S3-001: severity is HIGH (not CRITICAL) when public ACLs and policies are still blocked', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ publicAccess: true, blockPublicAcls: true, blockPublicPolicy: true }) });
    const f = analyzer.analyze(baseSecurityInput([r])).findings.find((x) => x.ruleId === 'AWS-S3-001');
    expect(f?.severity).toBe('high');
  });

  test('AWS-S3-001: does NOT fire when publicAccess=false', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ publicAccess: false }) });
    expect(analyzer.analyze(baseSecurityInput([r])).findings.some((f) => f.ruleId === 'AWS-S3-001')).toBe(false);
  });

  test('AWS-S3-001: absent publicAccess is INSUFFICIENT_DATA — never a pass and never a finding', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: '{}' });
    const a = analyzer.assess(baseSecurityInput([r]));
    expect(a.findings.some((f) => f.ruleId === 'AWS-S3-001')).toBe(false);
    expect(a.evaluations.find((e) => e.ruleId === 'AWS-S3-001')?.status).toBe('INSUFFICIENT_DATA');
  });

  test('AWS-S3-002: encryption=false is a LOW warning because S3 applies SSE-S3 by default', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ encryption: false }) });
    const f = analyzer.assess(baseSecurityInput([r])).findings.find((x) => x.ruleId === 'AWS-S3-002');
    expect(f?.status).toBe('WARNING');
    expect(f?.severity).toBe('LOW');
  });

  test('AWS-RDS-001 / AWS-RDS-002: public and unencrypted RDS produce critical and high findings with evidence', () => {
    const r = makeResource({ resourceType: 'aws_rds', provider: 'aws', configJson: JSON.stringify({ publiclyAccessible: true, encrypted: false }) });
    const a = analyzer.assess(baseSecurityInput([r]));
    const pub = a.findings.find((f) => f.ruleId === 'AWS-RDS-001')!;
    const enc = a.findings.find((f) => f.ruleId === 'AWS-RDS-002')!;
    expect(pub.severity).toBe('CRITICAL');
    expect(pub.evidence.find((e) => e.field === 'publiclyAccessible')?.observed).toBe('Enabled / Yes');
    expect(pub.references.some((ref) => ref.identifier === 'RDS.2')).toBe(true);
    expect(enc.severity).toBe('HIGH');
  });

  test('AWS-SG-001: SSH open only fails when the source is 0.0.0.0/0', () => {
    const open = makeResource({ resourceType: 'aws_sg', provider: 'aws', configJson: JSON.stringify({ allowSsh: true, sourceCidr: '0.0.0.0/0' }) });
    const restricted = makeResource({ resourceType: 'aws_sg', provider: 'aws', configJson: JSON.stringify({ allowSsh: true, sourceCidr: '10.20.0.0/16' }) });
    const a = analyzer.assess(baseSecurityInput([open, restricted]));
    expect(a.findings.filter((f) => f.ruleId === 'AWS-SG-001').map((f) => f.resourceIds[0])).toEqual([open.id]);
    expect(a.evaluations.find((e) => e.ruleId === 'AWS-SG-001' && e.resourceIds[0] === restricted.id)?.status).toBe('PASS');
  });

  test('Deterministic, stable finding IDs: same input produces same IDs across runs', () => {
    const r = makeResource({ id: 'fixed-id-1', resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ publicAccess: true }) });
    const a = analyzer.analyze(baseSecurityInput([r]));
    const b = analyzer.analyze(baseSecurityInput([r]));
    expect(a.findings[0]!.id).toBe(b.findings[0]!.id);
    expect(a.findings[0]!.id).toMatch(/^AWS-S3-001-[0-9A-F]{6}$/);
  });

  test('Score is NOT 100 when nothing could be evaluated (null = not scored)', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: '{}' });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.score).toBeNull();
  });

  test('Score: reduces with critical findings and is capped at 40', () => {
    const r = makeResource({ resourceType: 'aws_s3', provider: 'aws', configJson: JSON.stringify({ publicAccess: true, encryption: true, loggingEnabled: true, objectOwnership: 'BucketOwnerEnforced' }) });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.score).not.toBeNull();
    expect(result.score!).toBeLessThanOrEqual(40);
  });
});

describe('SecurityAnalyzer — Azure rules (provider-native, MCSB-mapped)', () => {
  const analyzer = new SecurityAnalyzer();

  test('AZ-STG-001: fires when httpsOnly=false; not when true; INSUFFICIENT_DATA when absent', () => {
    const bad = makeResource({ resourceType: 'azure_storage', provider: 'azure', configJson: JSON.stringify({ httpsOnly: false }) });
    const good = makeResource({ resourceType: 'azure_storage', provider: 'azure', configJson: JSON.stringify({ httpsOnly: true }) });
    const unknown = makeResource({ resourceType: 'azure_storage', provider: 'azure', configJson: '{}' });
    const a = analyzer.assess(baseSecurityInput([bad, good, unknown]));
    const byRes = (id: string) => a.evaluations.find((e) => e.ruleId === 'AZ-STG-001' && e.resourceIds[0] === id)?.status;
    expect(byRes(bad.id)).toBe('FAIL');
    expect(byRes(good.id)).toBe('PASS');
    expect(byRes(unknown.id)).toBe('INSUFFICIENT_DATA');
    expect(a.findings.find((f) => f.ruleId === 'AZ-STG-001')?.references.some((r) => r.identifier === 'DP-3')).toBe(true);
  });

  test('AZ-NSG-002: RDP from "*" is HIGH; RDP from a specific range passes (previous rule ignored the source)', () => {
    const open = makeResource({ resourceType: 'azure_nsg', provider: 'azure', configJson: JSON.stringify({ allowRdp: true, sourceCidr: '*' }) });
    const restricted = makeResource({ resourceType: 'azure_nsg', provider: 'azure', configJson: JSON.stringify({ allowRdp: true, sourceCidr: '203.0.113.0/24' }) });
    const a = analyzer.assess(baseSecurityInput([open, restricted]));
    const f = a.findings.filter((x) => x.ruleId === 'AZ-NSG-002');
    expect(f).toHaveLength(1);
    expect(f[0].resourceIds[0]).toBe(open.id);
    expect(f[0].severity).toBe('HIGH');
  });

  test('AZ-SQL-002: reads the real transparentDataEncryptionEnabled key (previous rule read a non-existent key)', () => {
    const r = makeResource({ resourceType: 'azure_sql', provider: 'azure', configJson: JSON.stringify({ transparentDataEncryptionEnabled: false }) });
    expect(analyzer.assess(baseSecurityInput([r])).findings.some((f) => f.ruleId === 'AZ-SQL-002')).toBe(true);
  });
});

describe('SecurityAnalyzer — no false positives / no false passes', () => {
  const analyzer = new SecurityAnalyzer();

  test('No high/critical findings for a VPC with empty config', () => {
    const r = makeResource({ resourceType: 'aws_vpc', provider: 'aws', configJson: '{}' });
    const result = analyzer.analyze(baseSecurityInput([r]));
    expect(result.findings.filter((f) => f.severity === 'critical' || f.severity === 'high')).toHaveLength(0);
  });

  test('No findings for azure_resource_group', () => {
    const r = makeResource({ resourceType: 'azure_resource_group', provider: 'azure', configJson: '{}' });
    const a = analyzer.assess(baseSecurityInput([r]));
    expect(a.findings.filter((f) => f.resourceIds.includes(r.id))).toHaveLength(0);
  });

  test('Account-level AWS controls are NOT_EVALUATED, never PASS', () => {
    const r = makeResource({ resourceType: 'aws_vpc', provider: 'aws', configJson: JSON.stringify({ enableDnsSupport: true }) });
    const a = analyzer.assess(baseSecurityInput([r]));
    for (const id of ['AWS-ACCT-001', 'AWS-ACCT-002', 'AWS-ACCT-003', 'AWS-ACCT-004']) {
      expect(a.evaluations.find((e) => e.ruleId === id)?.status).toBe('NOT_EVALUATED');
    }
  });

  test('Empty architecture is not scored (no default 100)', () => {
    const result = analyzer.analyze(baseSecurityInput([]));
    expect(result.score).toBeNull();
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

  // Regression tests for a second instance of the "scale up/down, cost
  // stays the same" bug class, this time in the static Azure SQL fallback
  // (used when the live Azure Retail Prices API is unavailable): none of
  // the real tier dropdown values from lib/resources/azure.ts — Basic,
  // GeneralPurpose, BusinessCritical, GP_Gen5_2, GP_Gen5_8, BC_Gen5_16 —
  // matched _dtuFromTier's S0-S4/P1-P11-only map, so every one of them
  // fell through to the same default 10-DTU Standard price.
  test('Azure SQL: GP_Gen5_2/GP_Gen5_8/BC_Gen5_16 each price distinctly by vCore count', () => {
    const cfg2 = { tier: 'GP_Gen5_2' };
    const cfg8 = { tier: 'GP_Gen5_8' };
    const cfgBc = { tier: 'BC_Gen5_16' };
    const r2 = makeResource({ resourceType: 'azure_sql', provider: 'azure', configJson: JSON.stringify(cfg2) });
    const r8 = makeResource({ resourceType: 'azure_sql', provider: 'azure', configJson: JSON.stringify(cfg8) });
    const rBc = makeResource({ resourceType: 'azure_sql', provider: 'azure', configJson: JSON.stringify(cfgBc) });
    const item2 = provider.estimateResource(r2, cfg2, 'eastus')!;
    const item8 = provider.estimateResource(r8, cfg8, 'eastus')!;
    const itemBc = provider.estimateResource(rBc, cfgBc, 'eastus')!;

    expect(new Set([item2.monthlyUsd, item8.monthlyUsd, itemBc.monthlyUsd]).size).toBe(3);
    // GP_Gen5_8 has 4x the vCores of GP_Gen5_2 -> ~4x the compute cost (storage is identical/flat here, so allow some tolerance)
    expect(item8.monthlyUsd).toBeGreaterThan(item2.monthlyUsd * 3.5);
    // BC_Gen5_16 is priced at 2x per-vCore vs GP, at 8x the vCores of GP_Gen5_2 -> ~16x
    expect(itemBc.monthlyUsd).toBeGreaterThan(item2.monthlyUsd * 14);
  });

  test('Azure SQL: Basic tier prices far below GeneralPurpose/BusinessCritical, not the same 10-DTU default', () => {
    const cfgBasic = { tier: 'Basic', maxSizeGb: 2 };
    const cfgGp = { tier: 'GeneralPurpose', maxSizeGb: 2 };
    const rBasic = makeResource({ resourceType: 'azure_sql', provider: 'azure', configJson: JSON.stringify(cfgBasic) });
    const rGp = makeResource({ resourceType: 'azure_sql', provider: 'azure', configJson: JSON.stringify(cfgGp) });
    const itemBasic = provider.estimateResource(rBasic, cfgBasic, 'eastus')!;
    const itemGp = provider.estimateResource(rGp, cfgGp, 'eastus')!;

    expect(itemBasic.monthlyUsd).toBeLessThan(itemGp.monthlyUsd);
    expect(itemBasic.monthlyUsd).toBeGreaterThan(0);
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
    const rec = result.recommendations.find((r) => r.id === 'C-02');
    expect(rec).toBeDefined();
    // Real per-gateway static-list price (us-east-1) × 1 extra gateway — not
    // a flat "$32" constant regardless of what a NAT gateway actually costs.
    expect(rec!.estimatedMonthlySavingsUsd).toBeGreaterThan(0);
  });

  test('C-01: EC2 right-sizing savings scale with real instance cost, not a flat per-instance constant', () => {
    const small = makeResource({ resourceType: 'aws_ec2', provider: 'aws', configJson: JSON.stringify({ instanceType: 'm5.xlarge' }), region: 'us-east-1' });
    const huge = makeResource({ resourceType: 'aws_ec2', provider: 'aws', configJson: JSON.stringify({ instanceType: 'm5.4xlarge' }), region: 'us-east-1' });

    const smallSavings = advisor.analyze(baseInput([small])).recommendations.find((r) => r.id === 'C-01')!.estimatedMonthlySavingsUsd!;
    const hugeSavings = advisor.analyze(baseInput([huge])).recommendations.find((r) => r.id === 'C-01')!.estimatedMonthlySavingsUsd!;

    expect(smallSavings).toBeGreaterThan(0);
    // An m5.4xlarge costs 4x an m5.xlarge — its right-sizing savings must
    // reflect that, not report the same number for both sizes.
    expect(hugeSavings).toBeGreaterThan(smallSavings * 2);
  });

  test('C-04: RDS reserved-instance savings scale with real instance cost', () => {
    const small = makeResource({ resourceType: 'aws_rds', provider: 'aws', configJson: JSON.stringify({ instanceClass: 'db.t3.micro' }), region: 'us-east-1' });
    const large = makeResource({ resourceType: 'aws_rds', provider: 'aws', configJson: JSON.stringify({ instanceClass: 'db.r6g.4xlarge' }), region: 'us-east-1' });

    const smallSavings = advisor.analyze(baseInput([small])).recommendations.find((r) => r.id === 'C-04')!.estimatedMonthlySavingsUsd!;
    const largeSavings = advisor.analyze(baseInput([large])).recommendations.find((r) => r.id === 'C-04')!.estimatedMonthlySavingsUsd!;

    expect(smallSavings).toBeGreaterThan(0);
    expect(largeSavings).toBeGreaterThan(smallSavings * 10);
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

  test('Advisor security/reliability/performance/cost scores match the shared assessment engine (Security tab parity)', async () => {
    // A security group with SSH open to the world is exactly the kind of
    // finding that used to show up on the Security tab (score capped well
    // below 100) while Advisor's own narrow rule set reported a clean 100.
    const sg = makeResource({
      resourceType: 'aws_sg', provider: 'aws',
      configJson: JSON.stringify({ allowSsh: true, sourceCidr: '0.0.0.0/0' }),
    });
    const ec2 = makeResource({
      resourceType: 'aws_ec2', provider: 'aws',
      configJson: JSON.stringify({ instanceType: 't3.medium' }),
    });

    const result = advisor.analyze(baseInput([sg, ec2]));

    const { toCanvas } = await import('@/lib/domain/canvasMapping');
    const { runAssessment } = await import('@/lib/engines/assessment/AssessmentEngine');
    const { nodes, edges } = toCanvas([sg, ec2], []);
    const assessment = runAssessment({ nodes, edges });

    expect(result.score.security).toBe(assessment.securityScore.score ?? 100);
    expect(result.score.reliability).toBe(assessment.reliabilityScore.score ?? 100);
    expect(result.score.performance).toBe(assessment.performanceScore.score ?? 100);
    expect(result.score.cost).toBe(assessment.costScore.score ?? 100);
    // The bug this locks in: Advisor must NOT report a clean security score
    // when the shared engine found a real, serious issue.
    expect(result.score.security).toBeLessThan(100);
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

  describe('NAT Gateway config depth round-trip', () => {
    function natWithSubnet(natConfig: Record<string, unknown>) {
      const subnet = makeResource({ id: 'sub-1', resourceType: 'aws_subnet', provider: 'aws', configJson: JSON.stringify({ name: 'nat_subnet' }) });
      const nat = makeResource({ id: 'nat-1', resourceType: 'aws_nat', provider: 'aws', configJson: JSON.stringify(natConfig) });
      const conn = makeConnection('sub-1', 'nat-1');
      return gen.generate(awsInput([subnet, nat], [conn]));
    }

    test('public NAT with no eipAllocationId provisions its own aws_eip', () => {
      const result = natWithSubnet({ connectivityType: 'public' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_eip"');
      expect(main.content).toContain('allocation_id     = aws_eip.');
      expect(main.content).toContain('connectivity_type = "public"');
    });

    test('public NAT with a bring-your-own eipAllocationId skips aws_eip creation', () => {
      const result = natWithSubnet({ connectivityType: 'public', eipAllocationId: 'eipalloc-12345' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).not.toContain('resource "aws_eip"');
      expect(main.content).toContain('allocation_id     = "eipalloc-12345"');
    });

    test('private NAT does not create or reference any Elastic IP', () => {
      const result = natWithSubnet({ connectivityType: 'private' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).not.toContain('resource "aws_eip"');
      expect(main.content).not.toContain('allocation_id');
      expect(main.content).toContain('connectivity_type = "private"');
    });

    test('private NAT with a privateIpAddress sets private_ip', () => {
      const result = natWithSubnet({ connectivityType: 'private', privateIpAddress: '10.0.1.25' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('private_ip        = "10.0.1.25"');
    });

    test('secondary allocation IDs flow into secondary_allocation_ids on a public NAT', () => {
      const result = natWithSubnet({ connectivityType: 'public', secondaryAllocationIds: ['eipalloc-aaa', 'eipalloc-bbb'] });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('secondary_allocation_ids = ["eipalloc-aaa", "eipalloc-bbb"]');
    });
  });

  describe('CloudFront config depth round-trip', () => {
    test('viewerProtocolPolicy flows into the default_cache_behavior block', () => {
      const cf = makeResource({ id: 'cf-1', resourceType: 'aws_cloudfront', provider: 'aws', configJson: JSON.stringify({ name: 'cdn', viewerProtocolPolicy: 'https-only' }) });
      const result = gen.generate(awsInput([cf]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('viewer_protocol_policy = "https-only"');
    });

    test('useCustomCertificate with an ARN generates an acm_certificate_arn viewer_certificate block', () => {
      const cf = makeResource({
        id: 'cf-1', resourceType: 'aws_cloudfront', provider: 'aws',
        configJson: JSON.stringify({ name: 'cdn', useCustomCertificate: true, customCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc', minimumProtocolVersion: 'TLSv1.2_2021' }),
      });
      const result = gen.generate(awsInput([cf]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('acm_certificate_arn      = "arn:aws:acm:us-east-1:123456789012:certificate/abc"');
      expect(main.content).toContain('minimum_protocol_version = "TLSv1.2_2021"');
    });

    test('without a custom certificate, the default CloudFront certificate is used', () => {
      const cf = makeResource({ id: 'cf-1', resourceType: 'aws_cloudfront', provider: 'aws', configJson: JSON.stringify({ name: 'cdn' }) });
      const result = gen.generate(awsInput([cf]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('cloudfront_default_certificate = true');
    });

    test('geoRestrictionType with countries generates a geo_restriction block with locations', () => {
      const cf = makeResource({
        id: 'cf-1', resourceType: 'aws_cloudfront', provider: 'aws',
        configJson: JSON.stringify({ name: 'cdn', geoRestrictionType: 'whitelist', geoRestrictionCountries: ['US', 'CA'] }),
      });
      const result = gen.generate(awsInput([cf]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('restriction_type = "whitelist"');
      expect(main.content).toContain('locations         = ["US", "CA"]');
    });

    test('geoRestrictionType none generates a none restriction with no locations', () => {
      const cf = makeResource({ id: 'cf-1', resourceType: 'aws_cloudfront', provider: 'aws', configJson: JSON.stringify({ name: 'cdn', geoRestrictionType: 'none' }) });
      const result = gen.generate(awsInput([cf]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('restriction_type = "none"');
    });

    test('webAclId associates the distribution with a WAF ACL', () => {
      const cf = makeResource({
        id: 'cf-1', resourceType: 'aws_cloudfront', provider: 'aws',
        configJson: JSON.stringify({ name: 'cdn', webAclId: 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/my-acl/abc' }),
      });
      const result = gen.generate(awsInput([cf]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('web_acl_id          = "arn:aws:wafv2:us-east-1:123456789012:global/webacl/my-acl/abc"');
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

  describe('EKS Terraform generation (previously completely unsupported)', () => {
    function eksWithSubnets(eksConfig: Record<string, unknown>) {
      const subnetA = makeResource({ id: 'sub-a', resourceType: 'aws_subnet', provider: 'aws', configJson: JSON.stringify({ name: 'subnet_a' }) });
      const subnetB = makeResource({ id: 'sub-b', resourceType: 'aws_subnet', provider: 'aws', configJson: JSON.stringify({ name: 'subnet_b' }) });
      const cluster = makeResource({ id: 'eks-1', resourceType: 'aws_eks', provider: 'aws', configJson: JSON.stringify(eksConfig) });
      const conns = [makeConnection('sub-a', 'eks-1'), makeConnection('sub-b', 'eks-1')];
      return gen.generate(awsInput([subnetA, subnetB, cluster], conns));
    }

    test('generates a cluster, node group, and both IAM roles with their required policy attachments', () => {
      const result = eksWithSubnets({ name: 'prod_cluster', nodeInstanceType: 'm5.large', nodeCount: 4 });
      expect(result.warnings.some((w) => w.includes('aws_eks') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_eks_cluster" "prod_cluster"');
      expect(main.content).toContain('resource "aws_eks_node_group" "prod_cluster_nodes"');
      expect(main.content).toContain('AmazonEKSClusterPolicy');
      expect(main.content).toContain('AmazonEKSWorkerNodePolicy');
      expect(main.content).toContain('AmazonEKS_CNI_Policy');
      expect(main.content).toContain('instance_types  = ["m5.large"]');
      expect(main.content).toContain('desired_size = 4');
    });

    test('secretsEncryption=true generates a KMS key and encryption_config block', () => {
      const withEnc = eksWithSubnets({ name: 'encrypted_cluster', secretsEncryption: true });
      const withEncMain = withEnc.files.find((f) => f.filename === 'main.tf')!;
      expect(withEncMain.content).toContain('resource "aws_kms_key" "encrypted_cluster_secrets"');
      expect(withEncMain.content).toContain('encryption_config {');

      const withoutEnc = eksWithSubnets({ name: 'unencrypted_cluster', secretsEncryption: false });
      const withoutEncMain = withoutEnc.files.find((f) => f.filename === 'main.tf')!;
      expect(withoutEncMain.content).not.toContain('aws_kms_key');
    });

    test('enabled_cluster_log_types reflects the configured log types', () => {
      const result = eksWithSubnets({ name: 'audited_cluster', clusterLogTypes: ['api', 'audit', 'scheduler'] });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('enabled_cluster_log_types = ["api", "audit", "scheduler"]');
    });
  });

  describe('Route 53 Terraform generation (previously completely unsupported)', () => {
    test('generates a hosted zone and a record with the configured type/value/ttl', () => {
      const zone = makeResource({ id: 'r53-1', resourceType: 'aws_route53', provider: 'aws', configJson: JSON.stringify({ name: 'app_zone', domainName: 'app.example.com', recordType: 'CNAME', recordValue: 'target.example.com', ttl: 60 }) });
      const result = gen.generate(awsInput([zone]));
      expect(result.warnings.some((w) => w.includes('aws_route53') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_route53_zone" "app_zone"');
      expect(main.content).toContain('resource "aws_route53_record" "app_zone"');
      expect(main.content).toContain('type    = "CNAME"');
      expect(main.content).toContain('ttl     = 60');
      expect(main.content).toContain('records = ["target.example.com"]');
    });

    test('Weighted routing policy generates a weighted_routing_policy block; Simple omits it', () => {
      const weighted = makeResource({ id: 'r53-1', resourceType: 'aws_route53', provider: 'aws', configJson: JSON.stringify({ name: 'weighted_zone', routingPolicy: 'Weighted', weight: 50 }) });
      const weightedResult = gen.generate(awsInput([weighted]));
      const weightedMain = weightedResult.files.find((f) => f.filename === 'main.tf')!;
      expect(weightedMain.content).toContain('weighted_routing_policy {');
      expect(weightedMain.content).toContain('weight = 50');

      const simple = makeResource({ id: 'r53-2', resourceType: 'aws_route53', provider: 'aws', configJson: JSON.stringify({ name: 'simple_zone', routingPolicy: 'Simple' }) });
      const simpleResult = gen.generate(awsInput([simple]));
      const simpleMain = simpleResult.files.find((f) => f.filename === 'main.tf')!;
      expect(simpleMain.content).not.toContain('weighted_routing_policy');
    });
  });

  describe('WAF Terraform generation (previously completely unsupported)', () => {
    test('generates a Web ACL with a rule per configured managed rule group', () => {
      const acl = makeResource({ id: 'waf-1', resourceType: 'aws_waf', provider: 'aws', configJson: JSON.stringify({ name: 'api_waf', managedRuleGroups: ['AWSManagedRulesCommonRuleSet', 'AWSManagedRulesSQLiRuleSet'] }) });
      const result = gen.generate(awsInput([acl]));
      expect(result.warnings.some((w) => w.includes('aws_waf') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_wafv2_web_acl" "api_waf"');
      expect(main.content).toContain('name        = "AWSManagedRulesCommonRuleSet"');
      expect(main.content).toContain('name        = "AWSManagedRulesSQLiRuleSet"');
    });

    test('rateLimitEnabled adds a rate_based_statement rule with the configured threshold', () => {
      const withRateLimit = makeResource({ id: 'waf-1', resourceType: 'aws_waf', provider: 'aws', configJson: JSON.stringify({ name: 'rate_limited_waf', rateLimitEnabled: true, rateLimitThreshold: 500, managedRuleGroups: [] }) });
      const result = gen.generate(awsInput([withRateLimit]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('rate_based_statement {');
      expect(main.content).toContain('limit              = 500');
    });

    test('defaultAction=BLOCK generates a block default_action', () => {
      const acl = makeResource({ id: 'waf-1', resourceType: 'aws_waf', provider: 'aws', configJson: JSON.stringify({ name: 'strict_waf', defaultAction: 'BLOCK', managedRuleGroups: [] }) });
      const result = gen.generate(awsInput([acl]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('block {}');
    });
  });

  describe('Route Table Terraform generation (previously completely unsupported)', () => {
    function routeTableWithVpc(rtConfig: Record<string, unknown>, extra: DbArchitectureResource[] = [], extraConns: DbArchitectureConnection[] = []) {
      const vpc = makeResource({ id: 'vpc-1', resourceType: 'aws_vpc', provider: 'aws', configJson: JSON.stringify({ name: 'main_vpc' }) });
      const rt = makeResource({ id: 'rt-1', resourceType: 'aws_route_table', provider: 'aws', configJson: JSON.stringify(rtConfig) });
      const conns = [makeConnection('vpc-1', 'rt-1'), ...extraConns];
      return gen.generate(awsInput([vpc, rt, ...extra], conns));
    }

    test('internet_gateway target routes 0.0.0.0/0 to the connected IGW', () => {
      const igw = makeResource({ id: 'igw-1', resourceType: 'aws_igw', provider: 'aws', configJson: JSON.stringify({ name: 'main_igw' }) });
      const result = routeTableWithVpc({ name: 'public_rt', targetType: 'internet_gateway' }, [igw], [makeConnection('igw-1', 'rt-1')]);
      expect(result.warnings.some((w) => w.includes('aws_route_table') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_route_table" "public_rt"');
      expect(main.content).toContain('gateway_id = aws_internet_gateway.main_igw.id');
    });

    test('subnet connections generate aws_route_table_association resources', () => {
      const subnet = makeResource({ id: 'sub-1', resourceType: 'aws_subnet', provider: 'aws', configJson: JSON.stringify({ name: 'app_subnet' }) });
      const result = routeTableWithVpc({ name: 'assoc_rt' }, [subnet], [makeConnection('sub-1', 'rt-1')]);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_route_table_association" "assoc_rt_assoc_1"');
    });

    test('targetType=none omits the route block entirely', () => {
      const result = routeTableWithVpc({ name: 'local_only_rt', targetType: 'none' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).not.toContain('route {');
    });
  });

  describe('Network ACL Terraform generation (previously completely unsupported)', () => {
    test('generates ingress/egress rules from the configured protocol and port range', () => {
      const vpc = makeResource({ id: 'vpc-1', resourceType: 'aws_vpc', provider: 'aws', configJson: JSON.stringify({ name: 'main_vpc' }) });
      const nacl = makeResource({ id: 'nacl-1', resourceType: 'aws_nacl', provider: 'aws', configJson: JSON.stringify({ name: 'restrictive_nacl', allowAllInbound: false, inboundProtocol: 'tcp', inboundPortFrom: 8080, inboundPortTo: 8080, inboundCidr: '10.0.0.0/8' }) });
      const result = gen.generate(awsInput([vpc, nacl], [makeConnection('vpc-1', 'nacl-1')]));
      expect(result.warnings.some((w) => w.includes('aws_nacl') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_network_acl" "restrictive_nacl"');
      expect(main.content).toContain('from_port  = 8080');
      expect(main.content).toContain('cidr_block = "10.0.0.0/8"');
    });

    test('allowAllInbound=true generates an allow-all ingress rule regardless of protocol/port fields', () => {
      const vpc = makeResource({ id: 'vpc-1', resourceType: 'aws_vpc', provider: 'aws', configJson: JSON.stringify({ name: 'main_vpc' }) });
      const nacl = makeResource({ id: 'nacl-1', resourceType: 'aws_nacl', provider: 'aws', configJson: JSON.stringify({ name: 'open_nacl', allowAllInbound: true }) });
      const result = gen.generate(awsInput([vpc, nacl], [makeConnection('vpc-1', 'nacl-1')]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      const ingressBlock = main.content.match(/ingress \{[\s\S]*?\}/)![0];
      expect(ingressBlock).toContain('cidr_block = "0.0.0.0/0"');
      expect(ingressBlock).toContain('protocol   = "-1"');
    });
  });

  describe('IAM Role Terraform generation (previously completely unsupported)', () => {
    test('generates a role with the configured trusted service and one policy attachment per managed policy', () => {
      const role = makeResource({ id: 'iam-1', resourceType: 'aws_iam', provider: 'aws', configJson: JSON.stringify({ name: 'lambda_role', trustedService: 'lambda.amazonaws.com', managedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess', 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess'] }) });
      const result = gen.generate(awsInput([role]));
      expect(result.warnings.some((w) => w.includes('aws_iam') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_iam_role" "lambda_role"');
      expect(main.content).toContain('Service = "lambda.amazonaws.com"');
      expect(main.content).toContain('resource "aws_iam_role_policy_attachment" "lambda_role_policy_1"');
      expect(main.content).toContain('resource "aws_iam_role_policy_attachment" "lambda_role_policy_2"');
    });

    test('no managed policies generates no policy attachment resources', () => {
      const role = makeResource({ id: 'iam-1', resourceType: 'aws_iam', provider: 'aws', configJson: JSON.stringify({ name: 'bare_role', managedPolicyArns: [] }) });
      const result = gen.generate(awsInput([role]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).not.toContain('aws_iam_role_policy_attachment');
    });
  });

  describe('KMS Key Terraform generation (previously completely unsupported)', () => {
    test('generates a key and an alias with the configured rotation/spec/deletion window', () => {
      const key = makeResource({ id: 'kms-1', resourceType: 'aws_kms', provider: 'aws', configJson: JSON.stringify({ name: 'app_data_key', enableKeyRotation: true, keySpec: 'RSA_2048', deletionWindowDays: 14 }) });
      const result = gen.generate(awsInput([key]));
      expect(result.warnings.some((w) => w.includes('aws_kms') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_kms_key" "app_data_key"');
      expect(main.content).toContain('customer_master_key_spec = "RSA_2048"');
      expect(main.content).toContain('deletion_window_in_days  = 14');
      expect(main.content).toContain('resource "aws_kms_alias" "app_data_key_alias"');
      expect(main.content).toContain('name          = "alias/app_data_key"');
    });
  });

  describe('CloudWatch Terraform generation (previously completely unsupported)', () => {
    test('generates an alarm and a log group with the configured threshold/retention', () => {
      const alarm = makeResource({ id: 'cw-1', resourceType: 'aws_cloudwatch', provider: 'aws', configJson: JSON.stringify({ name: 'high_cpu_alarm', threshold: 90, comparisonOperator: 'GreaterThanThreshold', logRetentionDays: 14 }) });
      const result = gen.generate(awsInput([alarm]));
      expect(result.warnings.some((w) => w.includes('aws_cloudwatch') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_cloudwatch_metric_alarm" "high_cpu_alarm"');
      expect(main.content).toContain('threshold            = 90');
      expect(main.content).toContain('resource "aws_cloudwatch_log_group" "high_cpu_alarm_logs"');
      expect(main.content).toContain('retention_in_days = 14');
    });
  });

  describe('EBS Volume Terraform generation (previously completely unsupported)', () => {
    test('generates a volume with the configured type/size/AZ', () => {
      const vol = makeResource({ id: 'ebs-1', resourceType: 'aws_ebs', provider: 'aws', configJson: JSON.stringify({ name: 'data_volume', sizeGb: 500, volumeType: 'io2', iops: 10000, availabilityZone: 'us-west-2a' }) });
      const result = gen.generate(awsInput([vol]));
      expect(result.warnings.some((w) => w.includes('aws_ebs') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_ebs_volume" "data_volume"');
      expect(main.content).toContain('availability_zone = "us-west-2a"');
      expect(main.content).toContain('size              = 500');
      expect(main.content).toContain('iops              = 10000');
    });

    test('gp2 volume type omits iops (only io1/io2/gp3 support provisioned IOPS)', () => {
      const vol = makeResource({ id: 'ebs-1', resourceType: 'aws_ebs', provider: 'aws', configJson: JSON.stringify({ name: 'plain_volume', volumeType: 'gp2' }) });
      const result = gen.generate(awsInput([vol]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).not.toContain('iops');
    });
  });

  describe('Auto Scaling Terraform generation (previously completely unsupported)', () => {
    test('generates a launch template, ASG, and target-tracking policy', () => {
      const subnet = makeResource({ id: 'sub-1', resourceType: 'aws_subnet', provider: 'aws', configJson: JSON.stringify({ name: 'app_subnet' }) });
      const asg = makeResource({ id: 'asg-1', resourceType: 'aws_auto_scaling', provider: 'aws', configJson: JSON.stringify({ name: 'web_asg', instanceType: 'm5.large', minSize: 2, maxSize: 8, targetCpuUtilization: 70 }), groupId: 'sub-1' });
      const result = gen.generate(awsInput([subnet, asg], [makeConnection('sub-1', 'asg-1')]));
      expect(result.warnings.some((w) => w.includes('aws_auto_scaling') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "aws_launch_template" "web_asg_lt"');
      expect(main.content).toContain('instance_type = "m5.large"');
      expect(main.content).toContain('resource "aws_autoscaling_group" "web_asg"');
      expect(main.content).toContain('resource "aws_autoscaling_policy" "web_asg_target_tracking"');
      expect(main.content).toContain('target_value = 70');
    });

    test('scalingPolicyEnabled=false omits the autoscaling policy resource', () => {
      const asg = makeResource({ id: 'asg-1', resourceType: 'aws_auto_scaling', provider: 'aws', configJson: JSON.stringify({ name: 'static_asg', scalingPolicyEnabled: false }) });
      const result = gen.generate(awsInput([asg]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).not.toContain('aws_autoscaling_policy');
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

  describe('NSG config depth round-trip', () => {
    function nsgWithRg(nsgConfig: Record<string, unknown>) {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const nsg = makeResource({ id: 'nsg-1', resourceType: 'azure_nsg', provider: 'azure', configJson: JSON.stringify(nsgConfig) });
      const conn = makeConnection('rg-1', 'nsg-1');
      return gen.generate(azureInput([rg, nsg], [conn]));
    }

    test('sourceCidr is applied to every enabled inbound rule instead of a hardcoded "*"', () => {
      const result = nsgWithRg({ allowSsh: true, allowRdp: true, sourceCidr: '10.0.0.0/24' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      const inboundCount = (main.content.match(/direction\s+= "Inbound"/g) || []).length;
      expect(inboundCount).toBe(2);
      expect(main.content).toContain('source_address_prefix      = "10.0.0.0/24"');
    });

    test('default source "*" adds a production warning comment on SSH/RDP rules', () => {
      const result = nsgWithRg({ allowSsh: true, allowRdp: true });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('RESTRICT THIS IN PRODUCTION');
    });

    test('allowHttps generates a dedicated HTTPS inbound rule', () => {
      const result = nsgWithRg({ allowHttps: true });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('destination_port_range     = "443"');
    });

    test('allowAllOutbound=false generates a restricted outbound rule using egressCidr', () => {
      const result = nsgWithRg({ allowAllOutbound: false, egressCidr: '10.1.0.0/16' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('destination_address_prefix = "10.1.0.0/16"');
      expect(main.content).toContain('restricted-outbound');
    });

    test('allowAllOutbound=true (default) generates an allow-all outbound rule', () => {
      const result = nsgWithRg({});
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('allow-all-outbound');
    });

    test('tags flow into the tags block', () => {
      const result = nsgWithRg({ tags: { Env: 'prod' } });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('Env = "prod"');
    });
  });

  describe('AKS Terraform generation (previously completely unsupported)', () => {
    function aksWithRg(aksConfig: Record<string, unknown>) {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const cluster = makeResource({ id: 'aks-1', resourceType: 'azure_aks', provider: 'azure', configJson: JSON.stringify(aksConfig) });
      const conn = makeConnection('rg-1', 'aks-1');
      return gen.generate(azureInput([rg, cluster], [conn]));
    }

    test('generates a cluster with SystemAssigned identity and the configured node pool', () => {
      const result = aksWithRg({ name: 'prod_aks', nodeVmSize: 'Standard_D4s_v3', nodeCount: 5 });
      expect(result.warnings.some((w) => w.includes('azure_aks') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_kubernetes_cluster" "prod_aks"');
      expect(main.content).toContain('vm_size    = "Standard_D4s_v3"');
      expect(main.content).toContain('node_count = 5');
      expect(main.content).toContain('type = "SystemAssigned"');
    });

    test('enableAutoScaling adds min/max count to the default node pool', () => {
      const result = aksWithRg({ name: 'scaled_aks', enableAutoScaling: true, minNodeCount: 2, maxNodeCount: 8 });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('enable_auto_scaling = true');
      expect(main.content).toContain('min_count           = 2');
      expect(main.content).toContain('max_count           = 8');
    });

    test('rbacEnabled=true generates the Azure AD RBAC block', () => {
      const result = aksWithRg({ name: 'rbac_aks', rbacEnabled: true });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('azure_active_directory_role_based_access_control {');
    });
  });

  describe('App Service Terraform generation (newly added resource type)', () => {
    function appServiceWithRg(appConfig: Record<string, unknown>) {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const app = makeResource({ id: 'app-1', resourceType: 'azure_app_service', provider: 'azure', configJson: JSON.stringify(appConfig) });
      const conn = makeConnection('rg-1', 'app-1');
      return gen.generate(azureInput([rg, app], [conn]));
    }

    test('osType=Windows generates azurerm_windows_web_app; Linux (default) generates azurerm_linux_web_app', () => {
      const windows = appServiceWithRg({ name: 'win_app', osType: 'Windows' });
      const windowsMain = windows.files.find((f) => f.filename === 'main.tf')!;
      expect(windowsMain.content).toContain('resource "azurerm_windows_web_app" "win_app"');

      const linux = appServiceWithRg({ name: 'linux_app' });
      const linuxMain = linux.files.find((f) => f.filename === 'main.tf')!;
      expect(linuxMain.content).toContain('resource "azurerm_linux_web_app" "linux_app"');
    });

    test('generates a Service Plan with the configured SKU that the app depends on', () => {
      const result = appServiceWithRg({ name: 'my_app', skuName: 'P1v3' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_service_plan" "my_app_plan"');
      expect(main.content).toContain('sku_name            = "P1v3"');
      expect(main.content).toContain('service_plan_id            = azurerm_service_plan.my_app_plan.id');
    });

    test('Free (F1) tier omits always_on; paid tiers include it', () => {
      const free = appServiceWithRg({ name: 'free_app', skuName: 'F1' });
      const freeMain = free.files.find((f) => f.filename === 'main.tf')!;
      expect(freeMain.content).not.toContain('always_on');

      const paid = appServiceWithRg({ name: 'paid_app', skuName: 'S1', alwaysOn: true });
      const paidMain = paid.files.find((f) => f.filename === 'main.tf')!;
      expect(paidMain.content).toContain('always_on           = true');
    });

    test('application settings flow into app_settings', () => {
      const result = appServiceWithRg({ name: 'configured_app', appSettings: { API_URL: 'https://api.example.com' } });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('"API_URL" = "https://api.example.com"');
    });

    test('runtime stack maps to the correct application_stack key', () => {
      const result = appServiceWithRg({ name: 'python_app', runtime: 'python', runtimeVersion: '3.12' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('python_version = "3.12"');
    });
  });

  describe('Load Balancer Terraform generation (previously completely unsupported)', () => {
    function lbWithRgAndPip(lbConfig: Record<string, unknown>) {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const pip = makeResource({ id: 'pip-1', resourceType: 'azure_public_ip', provider: 'azure', configJson: JSON.stringify({ name: 'lb_pip' }) });
      const lb = makeResource({ id: 'lb-1', resourceType: 'azure_lb', provider: 'azure', configJson: JSON.stringify(lbConfig) });
      const conns = [makeConnection('rg-1', 'lb-1'), makeConnection('pip-1', 'lb-1')];
      return gen.generate(azureInput([rg, pip, lb], conns));
    }

    test('generates the LB, backend pool, probe, and rule', () => {
      const result = lbWithRgAndPip({ name: 'web_lb', backendPort: 8080 });
      expect(result.warnings.some((w) => w.includes('azure_lb') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_lb" "web_lb"');
      expect(main.content).toContain('resource "azurerm_lb_backend_address_pool" "web_lb_backend"');
      expect(main.content).toContain('resource "azurerm_lb_probe" "web_lb_probe"');
      expect(main.content).toContain('resource "azurerm_lb_rule" "web_lb_rule"');
      expect(main.content).toContain('frontend_port                  = 8080');
    });

    test('connected Public IP flows into the frontend configuration', () => {
      const result = lbWithRgAndPip({ name: 'public_lb' });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('public_ip_address_id          = azurerm_public_ip.lb_pip.id');
    });

    test('Internal type uses private_ip_address_allocation instead of a Public IP', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const lb = makeResource({ id: 'lb-1', resourceType: 'azure_lb', provider: 'azure', configJson: JSON.stringify({ name: 'internal_lb', type: 'Internal' }) });
      const result = gen.generate(azureInput([rg, lb], [makeConnection('rg-1', 'lb-1')]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('private_ip_address_allocation = "Dynamic"');
    });
  });

  describe('Key Vault Terraform generation (previously completely unsupported)', () => {
    test('generates the vault with a single shared client_config data source even with multiple vaults', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const kv1 = makeResource({ id: 'kv-1', resourceType: 'azure_key_vault', provider: 'azure', configJson: JSON.stringify({ name: 'vault_one' }) });
      const kv2 = makeResource({ id: 'kv-2', resourceType: 'azure_key_vault', provider: 'azure', configJson: JSON.stringify({ name: 'vault_two' }) });
      const result = gen.generate(azureInput([rg, kv1, kv2], [makeConnection('rg-1', 'kv-1'), makeConnection('rg-1', 'kv-2')]));
      expect(result.warnings.some((w) => w.includes('azure_key_vault') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_key_vault" "vault_one"');
      expect(main.content).toContain('resource "azurerm_key_vault" "vault_two"');
      const clientConfigMatches = main.content.match(/data "azurerm_client_config" "current"/g) ?? [];
      expect(clientConfigMatches.length).toBe(1);
    });

    test('publicNetworkAccessEnabled=true generates a network_acls block with the configured default action', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const kv = makeResource({ id: 'kv-1', resourceType: 'azure_key_vault', provider: 'azure', configJson: JSON.stringify({ name: 'open_vault', publicNetworkAccessEnabled: true, networkAclsDefaultAction: 'Deny' }) });
      const result = gen.generate(azureInput([rg, kv], [makeConnection('rg-1', 'kv-1')]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('network_acls {');
      expect(main.content).toContain('default_action = "Deny"');
    });
  });

  describe('Redis Terraform generation (previously completely unsupported)', () => {
    test('generates the cache with the configured SKU/family/capacity/TLS settings', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const redis = makeResource({ id: 'redis-1', resourceType: 'azure_redis', provider: 'azure', configJson: JSON.stringify({ name: 'session_cache', sku: 'Premium', family: 'P', capacity: 2, enableNonSslPort: false }) });
      const result = gen.generate(azureInput([rg, redis], [makeConnection('rg-1', 'redis-1')]));
      expect(result.warnings.some((w) => w.includes('azure_redis') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_redis_cache" "session_cache"');
      expect(main.content).toContain('sku_name                      = "Premium"');
      expect(main.content).toContain('family                        = "P"');
      expect(main.content).toContain('enable_non_ssl_port            = false');
    });
  });

  describe('Public IP Terraform generation (previously completely unsupported)', () => {
    test('generates the public IP with the configured allocation method and zone', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const pip = makeResource({ id: 'pip-1', resourceType: 'azure_public_ip', provider: 'azure', configJson: JSON.stringify({ name: 'app_pip', allocationMethod: 'Static', availabilityZone: '2' }) });
      const result = gen.generate(azureInput([rg, pip], [makeConnection('rg-1', 'pip-1')]));
      expect(result.warnings.some((w) => w.includes('azure_public_ip') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_public_ip" "app_pip"');
      expect(main.content).toContain('allocation_method   = "Static"');
      expect(main.content).toContain('zones               = ["2"]');
    });
  });

  describe('Network Interface Terraform generation (previously completely unsupported)', () => {
    test('generates the NIC with subnet_id resolved from a connected subnet', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const subnet = makeResource({ id: 'sub-1', resourceType: 'azure_subnet', provider: 'azure', configJson: JSON.stringify({ name: 'app_subnet' }) });
      const nic = makeResource({ id: 'nic-1', resourceType: 'azure_nic', provider: 'azure', configJson: JSON.stringify({ name: 'app_nic', enableAcceleratedNetworking: true }) });
      const result = gen.generate(azureInput([rg, subnet, nic], [makeConnection('rg-1', 'nic-1'), makeConnection('sub-1', 'nic-1')]));
      expect(result.warnings.some((w) => w.includes('azure_nic') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_network_interface" "app_nic"');
      expect(main.content).toContain('subnet_id                     = azurerm_subnet.app_subnet.id');
      expect(main.content).toContain('enable_accelerated_networking = true');
    });

    test('unconnected NIC generates a warning', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const nic = makeResource({ id: 'nic-1', resourceType: 'azure_nic', provider: 'azure', label: 'orphan_nic', configJson: JSON.stringify({ name: 'orphan_nic' }) });
      const result = gen.generate(azureInput([rg, nic], [makeConnection('rg-1', 'nic-1')]));
      expect(result.warnings.some((w) => w.includes('orphan_nic') && w.includes('subnet'))).toBe(true);
    });
  });

  describe('Route Table (Azure) Terraform generation (previously completely unsupported)', () => {
    test('generates a route table with a route matching the configured next hop', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const rt = makeResource({ id: 'rt-1', resourceType: 'azure_route_table', provider: 'azure', configJson: JSON.stringify({ name: 'nva_rt', nextHopType: 'VirtualAppliance', nextHopIpAddress: '10.0.5.4' }) });
      const result = gen.generate(azureInput([rg, rt], [makeConnection('rg-1', 'rt-1')]));
      expect(result.warnings.some((w) => w.includes('azure_route_table') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_route_table" "nva_rt"');
      expect(main.content).toContain('next_hop_type  = "VirtualAppliance"');
      expect(main.content).toContain('next_hop_in_ip_address = "10.0.5.4"');
    });

    test('nextHopType=None omits the route block', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const rt = makeResource({ id: 'rt-1', resourceType: 'azure_route_table', provider: 'azure', configJson: JSON.stringify({ name: 'no_route_rt', nextHopType: 'None' }) });
      const result = gen.generate(azureInput([rg, rt], [makeConnection('rg-1', 'rt-1')]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).not.toContain('route {');
    });
  });

  describe('Bastion Terraform generation (previously completely unsupported)', () => {
    test('generates a Bastion host with its own Public IP, gated by the connected subnet', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const subnet = makeResource({ id: 'sub-1', resourceType: 'azure_subnet', provider: 'azure', configJson: JSON.stringify({ name: 'AzureBastionSubnet' }) });
      const bastion = makeResource({ id: 'bas-1', resourceType: 'azure_bastion', provider: 'azure', configJson: JSON.stringify({ name: 'my_bastion', scaleUnits: 4 }) });
      const result = gen.generate(azureInput([rg, subnet, bastion], [makeConnection('rg-1', 'bas-1'), makeConnection('sub-1', 'bas-1')]));
      expect(result.warnings.some((w) => w.includes('azure_bastion') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_public_ip" "my_bastion_pip"');
      expect(main.content).toContain('resource "azurerm_bastion_host" "my_bastion"');
      expect(main.content).toContain('scale_units              = 4');
      expect(main.content).toContain('subnet_id            = azurerm_subnet.azurebastionsubnet.id');
    });

    test('Basic SKU omits Standard-only fields', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const bastion = makeResource({ id: 'bas-1', resourceType: 'azure_bastion', provider: 'azure', configJson: JSON.stringify({ name: 'basic_bastion', sku: 'Basic' }) });
      const result = gen.generate(azureInput([rg, bastion], [makeConnection('rg-1', 'bas-1')]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).not.toContain('scale_units');
    });
  });

  describe('Front Door Terraform generation (previously completely unsupported)', () => {
    test('generates the profile, endpoint, origin group, origin, and route chain', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const afd = makeResource({ id: 'afd-1', resourceType: 'azure_front_door', provider: 'azure', configJson: JSON.stringify({ name: 'global_frontdoor', originHostName: 'backend.example.com' }) });
      const result = gen.generate(azureInput([rg, afd], [makeConnection('rg-1', 'afd-1')]));
      expect(result.warnings.some((w) => w.includes('azure_front_door') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_cdn_frontdoor_profile" "global_frontdoor"');
      expect(main.content).toContain('resource "azurerm_cdn_frontdoor_endpoint" "global_frontdoor_endpoint"');
      expect(main.content).toContain('resource "azurerm_cdn_frontdoor_origin_group" "global_frontdoor_origin_group"');
      expect(main.content).toContain('host_name                     = "backend.example.com"');
      expect(main.content).toContain('resource "azurerm_cdn_frontdoor_route" "global_frontdoor_route"');
    });

    test('httpsOnly=false allows HTTP and disables the redirect', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const afd = makeResource({ id: 'afd-1', resourceType: 'azure_front_door', provider: 'azure', configJson: JSON.stringify({ name: 'insecure_frontdoor', httpsOnly: false }) });
      const result = gen.generate(azureInput([rg, afd], [makeConnection('rg-1', 'afd-1')]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('supported_protocols           = ["Http", "Https"]');
      expect(main.content).toContain('https_redirect_enabled        = false');
    });
  });

  describe('Azure WAF Policy Terraform generation (previously completely unsupported)', () => {
    test('generates a policy with the configured mode and OWASP rule set version', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const waf = makeResource({ id: 'waf-1', resourceType: 'azure_waf', provider: 'azure', configJson: JSON.stringify({ name: 'api_waf_policy', mode: 'Detection', managedRuleSetVersion: '3.1' }) });
      const result = gen.generate(azureInput([rg, waf], [makeConnection('rg-1', 'waf-1')]));
      expect(result.warnings.some((w) => w.includes('azure_waf') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_web_application_firewall_policy" "api_waf_policy"');
      expect(main.content).toContain('mode                        = "Detection"');
      expect(main.content).toContain('version = "3.1"');
    });
  });

  describe('VMSS Terraform generation (previously completely unsupported)', () => {
    function vmssWithRgAndSubnet(vmssConfig: Record<string, unknown>) {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const subnet = makeResource({ id: 'sub-1', resourceType: 'azure_subnet', provider: 'azure', configJson: JSON.stringify({ name: 'app_subnet' }) });
      const vmss = makeResource({ id: 'vmss-1', resourceType: 'azure_vmss', provider: 'azure', configJson: JSON.stringify(vmssConfig) });
      const conns = [makeConnection('rg-1', 'vmss-1'), makeConnection('sub-1', 'vmss-1')];
      return gen.generate(azureInput([rg, subnet, vmss], conns));
    }

    test('osType=Windows generates azurerm_windows_virtual_machine_scale_set; Linux generates the Linux variant', () => {
      const windows = vmssWithRgAndSubnet({ name: 'win_vmss', osType: 'Windows' });
      const windowsMain = windows.files.find((f) => f.filename === 'main.tf')!;
      expect(windowsMain.content).toContain('resource "azurerm_windows_virtual_machine_scale_set" "win_vmss"');
      expect(windowsMain.content).toContain('admin_password       = var.windows_admin_password');

      const linux = vmssWithRgAndSubnet({ name: 'linux_vmss' });
      const linuxMain = linux.files.find((f) => f.filename === 'main.tf')!;
      expect(linuxMain.content).toContain('resource "azurerm_linux_virtual_machine_scale_set" "linux_vmss"');
      expect(linuxMain.content).toContain('admin_ssh_key {');
    });

    test('autoscaleEnabled generates an azurerm_monitor_autoscale_setting with the configured min/max', () => {
      const result = vmssWithRgAndSubnet({ name: 'scaled_vmss', autoscaleEnabled: true, minCapacity: 3, maxCapacity: 15 });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_monitor_autoscale_setting" "scaled_vmss_autoscale"');
      expect(main.content).toContain('minimum = 3');
      expect(main.content).toContain('maximum = 15');
    });

    test('autoscaleEnabled=false omits the autoscale setting resource', () => {
      const result = vmssWithRgAndSubnet({ name: 'fixed_vmss', autoscaleEnabled: false });
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).not.toContain('azurerm_monitor_autoscale_setting');
    });
  });

  describe('Cosmos DB config depth round-trip (kind was previously always hardcoded)', () => {
    test('kind reflects the configured API instead of always defaulting to GlobalDocumentDB', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const cosmos = makeResource({ id: 'cosmos-1', resourceType: 'azure_cosmos_db', provider: 'azure', configJson: JSON.stringify({ name: 'mongo_account', kind: 'MongoDB' }) });
      const result = gen.generate(azureInput([rg, cosmos], [makeConnection('rg-1', 'cosmos-1')]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('kind                          = "MongoDB"');
    });

    test('Serverless throughput mode generates an EnableServerless capability', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const cosmos = makeResource({ id: 'cosmos-1', resourceType: 'azure_cosmos_db', provider: 'azure', configJson: JSON.stringify({ name: 'serverless_account', throughputMode: 'Serverless' }) });
      const result = gen.generate(azureInput([rg, cosmos], [makeConnection('rg-1', 'cosmos-1')]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('capabilities {');
      expect(main.content).toContain('name = "EnableServerless"');
    });
  });

  describe('App Gateway config depth round-trip', () => {
    test('WAF_v2 SKU with WAF enabled generates a waf_configuration block', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const subnet = makeResource({ id: 'sub-1', resourceType: 'azure_subnet', provider: 'azure', configJson: JSON.stringify({ name: 'gw_subnet' }) });
      const pip = makeResource({ id: 'pip-1', resourceType: 'azure_public_ip', provider: 'azure', configJson: JSON.stringify({ name: 'gw_pip' }) });
      const agw = makeResource({ id: 'agw-1', resourceType: 'azure_app_gateway', provider: 'azure', configJson: JSON.stringify({ name: 'waf_gateway', sku: 'WAF_v2', wafEnabled: true, wafMode: 'Detection' }) });
      const conns = [makeConnection('rg-1', 'agw-1'), makeConnection('sub-1', 'agw-1'), makeConnection('pip-1', 'agw-1')];
      const result = gen.generate(azureInput([rg, subnet, pip, agw], conns));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('waf_configuration {');
      expect(main.content).toContain('firewall_mode    = "Detection"');
    });

    test('autoscaleEnabled generates an autoscale_configuration block instead of a fixed capacity', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const agw = makeResource({ id: 'agw-1', resourceType: 'azure_app_gateway', provider: 'azure', configJson: JSON.stringify({ name: 'auto_gateway', autoscaleEnabled: true, minCapacity: 2, maxCapacity: 20 }) });
      const result = gen.generate(azureInput([rg, agw], [makeConnection('rg-1', 'agw-1')]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('autoscale_configuration {');
      expect(main.content).toContain('max_capacity = 20');
    });
  });

  describe('NAT Gateway (Azure) Terraform generation (previously completely unsupported)', () => {
    test('generates the gateway plus a Public IP association when connected', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const pip = makeResource({ id: 'pip-1', resourceType: 'azure_public_ip', provider: 'azure', configJson: JSON.stringify({ name: 'nat_pip' }) });
      const nat = makeResource({ id: 'nat-1', resourceType: 'azure_nat', provider: 'azure', configJson: JSON.stringify({ name: 'egress_nat', idleTimeoutMin: 10 }) });
      const result = gen.generate(azureInput([rg, pip, nat], [makeConnection('rg-1', 'nat-1'), makeConnection('pip-1', 'nat-1')]));
      expect(result.warnings.some((w) => w.includes('azure_nat') && w.toLowerCase().includes('unsupported'))).toBe(false);
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_nat_gateway" "egress_nat"');
      expect(main.content).toContain('idle_timeout_in_minutes = 10');
      expect(main.content).toContain('resource "azurerm_nat_gateway_public_ip_association" "egress_nat_pip_assoc"');
    });

    test('subnet connections generate azurerm_subnet_nat_gateway_association resources', () => {
      const rg = makeResource({ id: 'rg-1', resourceType: 'azure_resource_group', provider: 'azure', configJson: JSON.stringify({ name: 'main_rg' }) });
      const subnet = makeResource({ id: 'sub-1', resourceType: 'azure_subnet', provider: 'azure', configJson: JSON.stringify({ name: 'private_subnet' }) });
      const nat = makeResource({ id: 'nat-1', resourceType: 'azure_nat', provider: 'azure', configJson: JSON.stringify({ name: 'subnet_nat' }) });
      const result = gen.generate(azureInput([rg, subnet, nat], [makeConnection('rg-1', 'nat-1'), makeConnection('sub-1', 'nat-1')]));
      const main = result.files.find((f) => f.filename === 'main.tf')!;
      expect(main.content).toContain('resource "azurerm_subnet_nat_gateway_association" "subnet_nat_subnet_assoc_1"');
    });
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

    test('networkDefaultAction=Deny writes default_action Deny; Allow (default) writes Allow; both let Azure\'s own services through', () => {
      const denied = makeResource({ id: 'st-1', resourceType: 'azure_storage', provider: 'azure', configJson: JSON.stringify({ name: 'restricted', networkDefaultAction: 'Deny' }) });
      const deniedResult = gen.generate(azureInput([denied]));
      const deniedMain = deniedResult.files.find((f) => f.filename === 'main.tf')!;
      expect(deniedMain.content).toMatch(/network_rules \{\n\s+default_action = "Deny"\n\s+bypass\s+= \["AzureServices"\]/);

      const open = makeResource({ id: 'st-2', resourceType: 'azure_storage', provider: 'azure', configJson: JSON.stringify({ name: 'open' }) });
      const openResult = gen.generate(azureInput([open]));
      const openMain = openResult.files.find((f) => f.filename === 'main.tf')!;
      expect(openMain.content).toMatch(/network_rules \{\n\s+default_action = "Allow"\n\s+bypass\s+= \["AzureServices"\]/);
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

  // Regression tests for the "scale up/down the user count, cost stays the
  // same" bug: the client always computed cost from the PERSISTED
  // architecture, and the persisted architecture only updates via a
  // debounced (800ms) autosave that a fresh cost-estimate request routinely
  // outran. The fix lets the request body carry a live `resources` snapshot
  // that overrides the persisted read entirely, so cost always reflects
  // exactly what's on the canvas right now.
  test('Cost estimate uses the request body\'s live `resources` override instead of the persisted (stale) architecture', async () => {
    seedDevContext();
    const now = new Date().toISOString();
    mockDb._stores['Project'].set('proj-scale', { id: 'proj-scale', name: 'Scale', orgId: 'dev-org-id', ownerId: 'dev-user-id', provider: 'aws', region: 'us-east-1', description: '', tags: '[]', createdAt: now, updatedAt: now });
    mockDb._stores['Environment'].set('env-scale', { id: 'env-scale', envKey: 'production', label: 'Prod', region: 'us-east-1', projectId: 'proj-scale', createdAt: now, updatedAt: now });
    mockDb._stores['Architecture'].set('arch-scale', { id: 'arch-scale', environmentId: 'env-scale', createdAt: now, updatedAt: now });
    // Persisted (stale) state: a small instance — simulates the DB not
    // having caught up yet with a scale-up the user just made on the canvas.
    mockDb._stores['ArchitectureResource'].set('res-scale-1', {
      id: 'res-scale-1', architectureId: 'arch-scale', resourceType: 'aws_ec2', provider: 'aws',
      label: 'Web Server', positionX: 0, positionY: 0, configJson: JSON.stringify({ instanceType: 't3.micro' }), region: 'us-east-1', groupId: null, locked: false,
    });

    const reqNoOverride = new NextRequest('http://localhost:3000/api/projects/proj-scale/cost-estimates?orgId=dev-org-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'dev-user-id' },
      body: JSON.stringify({ env: 'production' }),
    });
    const resNoOverride = await costEstimatePost(reqNoOverride, { params: Promise.resolve({ id: 'proj-scale' }) });
    const bodyNoOverride = await resNoOverride.json() as { data: { items: Array<{ resourceType: string; monthlyUsd: number }> } };
    const staleMonthly = bodyNoOverride.data.items.find((i) => i.resourceType === 'aws_ec2')?.monthlyUsd ?? 0;

    // Live override: same resource, scaled up to a much larger instance —
    // as AdaptiveScaleEngine would write into the canvas node immediately,
    // well before autosave has persisted it.
    const reqWithOverride = new NextRequest('http://localhost:3000/api/projects/proj-scale/cost-estimates?orgId=dev-org-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'dev-user-id' },
      body: JSON.stringify({
        env: 'production',
        resources: [{
          id: 'res-scale-1', resourceType: 'aws_ec2', provider: 'aws', label: 'Web Server',
          region: 'us-east-1', config: { instanceType: 'c6g.4xlarge' },
        }],
      }),
    });
    const resWithOverride = await costEstimatePost(reqWithOverride, { params: Promise.resolve({ id: 'proj-scale' }) });
    const bodyWithOverride = await resWithOverride.json() as { data: { items: Array<{ resourceType: string; monthlyUsd: number }> } };
    const scaledMonthly = bodyWithOverride.data.items.find((i) => i.resourceType === 'aws_ec2')?.monthlyUsd ?? 0;

    // The persisted resource never changed — if the override were ignored
    // (the bug), both numbers would be identical.
    expect(scaledMonthly).toBeGreaterThan(staleMonthly);
  });

  test('Cost estimate falls back to the persisted architecture when no `resources` override is sent (backward compatible)', async () => {
    seedDevContext();
    const now = new Date().toISOString();
    mockDb._stores['Project'].set('proj-nooverride', { id: 'proj-nooverride', name: 'NoOverride', orgId: 'dev-org-id', ownerId: 'dev-user-id', provider: 'aws', region: 'us-east-1', description: '', tags: '[]', createdAt: now, updatedAt: now });
    mockDb._stores['Environment'].set('env-nooverride', { id: 'env-nooverride', envKey: 'production', label: 'Prod', region: 'us-east-1', projectId: 'proj-nooverride', createdAt: now, updatedAt: now });
    mockDb._stores['Architecture'].set('arch-nooverride', { id: 'arch-nooverride', environmentId: 'env-nooverride', createdAt: now, updatedAt: now });
    mockDb._stores['ArchitectureResource'].set('res-nooverride-1', {
      id: 'res-nooverride-1', architectureId: 'arch-nooverride', resourceType: 'aws_s3', provider: 'aws',
      label: 'Bucket', positionX: 0, positionY: 0, configJson: JSON.stringify({ estimatedStorageGb: 10 }), region: 'us-east-1', groupId: null, locked: false,
    });

    const req = new NextRequest('http://localhost:3000/api/projects/proj-nooverride/cost-estimates?orgId=dev-org-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'dev-user-id' },
      body: JSON.stringify({ env: 'production' }),
    });
    const res = await costEstimatePost(req, { params: Promise.resolve({ id: 'proj-nooverride' }) });
    const body = await res.json() as { ok: boolean; data: { items: Array<{ resourceType: string }> } };
    expect(body.ok).toBe(true);
    expect(body.data.items.some((i) => i.resourceType === 'aws_s3')).toBe(true);
  });
});

// ─── Regression Tests: Security Remediation & Rule ID Mismatch ──────────────

describe('Security Remediation & Rule-ID Matching', () => {
  const analyzer = new SecurityAnalyzer();

  test('Legacy SecurityAnalyzer rule IDs resolve to current rules and their remediation resolves the finding', () => {
    const cases: Array<{ legacyId: string; ruleId: string; resourceType: string; provider: string; insecureConfig: Record<string, unknown> }> = [
      { legacyId: 'AWS-S3-PUBLIC', ruleId: 'AWS-S3-001', resourceType: 'aws_s3', provider: 'aws', insecureConfig: { publicAccess: true } },
      { legacyId: 'AWS-S3-NO-ENCRYPTION', ruleId: 'AWS-S3-002', resourceType: 'aws_s3', provider: 'aws', insecureConfig: { encryption: false } },
      { legacyId: 'AWS-RDS-NO-ENCRYPTION', ruleId: 'AWS-RDS-002', resourceType: 'aws_rds', provider: 'aws', insecureConfig: { encrypted: false } },
      { legacyId: 'AWS-RDS-PUBLICLY-ACCESSIBLE', ruleId: 'AWS-RDS-001', resourceType: 'aws_rds', provider: 'aws', insecureConfig: { publiclyAccessible: true } },
      { legacyId: 'AWS-RDS-NO-MULTI-AZ', ruleId: 'AWS-RDS-006', resourceType: 'aws_rds', provider: 'aws', insecureConfig: { multiAz: false } },
      { legacyId: 'AWS-SG-OPEN-SSH', ruleId: 'AWS-SG-001', resourceType: 'aws_sg', provider: 'aws', insecureConfig: { allowSsh: true, sourceCidr: '0.0.0.0/0' } },
      { legacyId: 'AWS-EC2-PUBLIC-SUBNET', ruleId: 'AWS-VPC-001', resourceType: 'aws_subnet', provider: 'aws', insecureConfig: { mapPublicIpOnLaunch: true } },
      { legacyId: 'AWS-VPC-NO-DNS', ruleId: 'AWS-VPC-003', resourceType: 'aws_vpc', provider: 'aws', insecureConfig: { enableDnsSupport: false } },
      { legacyId: 'AZ-STORAGE-NO-HTTPS', ruleId: 'AZ-STG-001', resourceType: 'azure_storage', provider: 'azure', insecureConfig: { httpsOnly: false } },
      { legacyId: 'AZ-STORAGE-PUBLIC-BLOB', ruleId: 'AZ-STG-002', resourceType: 'azure_storage', provider: 'azure', insecureConfig: { allowBlobPublicAccess: true } },
      { legacyId: 'AZ-SQL-PUBLIC-ACCESS', ruleId: 'AZ-SQL-001', resourceType: 'azure_sql', provider: 'azure', insecureConfig: { publicNetworkAccess: true } },
      { legacyId: 'AZ-SQL-NO-TDE', ruleId: 'AZ-SQL-002', resourceType: 'azure_sql', provider: 'azure', insecureConfig: { transparentDataEncryptionEnabled: false } },
      { legacyId: 'AZ-NSG-OPEN-SSH', ruleId: 'AZ-NSG-001', resourceType: 'azure_nsg', provider: 'azure', insecureConfig: { allowSsh: true, sourceCidr: '*' } },
      { legacyId: 'AZ-NSG-OPEN-RDP', ruleId: 'AZ-NSG-002', resourceType: 'azure_nsg', provider: 'azure', insecureConfig: { allowRdp: true, sourceCidr: '*' } },
      { legacyId: 'AZ-VM-NO-DISK-ENCRYPTION', ruleId: 'AZ-VM-002', resourceType: 'azure_vm', provider: 'azure', insecureConfig: { encryptionAtHostEnabled: false } },
    ];

    for (const c of cases) {
      expect(isRuleFixable(c.legacyId)).toBe(true);
      const target = makeResource({ id: `res-${c.ruleId}`, resourceType: c.resourceType, provider: c.provider, configJson: JSON.stringify(c.insecureConfig) });
      const input: SecurityAnalysisInput = { architectureId: 'arch-test', projectId: 'proj-test', resources: [target], connections: [] };
      const before = analyzer.assess(input);
      expect(before.findings.some((f) => f.ruleId === c.ruleId)).toBe(true);
      const fixed = applyRuleRemediation(c.insecureConfig, c.legacyId);
      const after = analyzer.assess({ ...input, resources: [{ ...target, configJson: JSON.stringify(fixed) }] });
      expect(after.findings.some((f) => f.ruleId === c.ruleId)).toBe(false);
    }
  });

  test('Legacy RDE rule IDs remain resolvable and apply the same remediation', () => {
    const legacyRules = [
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
      expect(applyRuleRemediation(lr.config, lr.legacyId)[lr.expectedKey]).toBe(lr.expectedVal);
    }
  });

  test('Rules removed as incorrect are not fixable (e.g. "EC2 has no key pair")', () => {
    expect(isRuleFixable('ec2-key-pair')).toBe(false);
    expect(isRuleFixable('waf-default-allow')).toBe(false);
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

    const fixedNodes1 = apiSecurityService.applyFix(nodes, 'node-s3', 'AWS-S3-002');
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
