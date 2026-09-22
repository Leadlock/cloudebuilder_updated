/**
 * Tests for the schema-driven resource configuration framework
 * (ConfigField.section/advanced/visibleWhen — see types/index.ts and
 * components/canvas/PropertiesPanel.tsx).
 */
import { allResources } from '@/lib/resources';
import { getResourceDefinition } from '@/lib/resources';

describe('Resource catalog — configSchema structural integrity', () => {
  test('no resource defines the same config key twice (silent overwrite risk)', () => {
    for (const def of allResources) {
      const keys = def.configSchema.map((f) => f.key);
      const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
      expect(dupes).toEqual([]);
    }
  });

  test('every field with visibleWhen evaluates without throwing on an empty config', () => {
    for (const def of allResources) {
      for (const field of def.configSchema) {
        if (!field.visibleWhen) continue;
        expect(() => field.visibleWhen!({})).not.toThrow();
      }
    }
  });

  test('every field with visibleWhen evaluates without throwing on the resource defaultConfig', () => {
    for (const def of allResources) {
      for (const field of def.configSchema) {
        if (!field.visibleWhen) continue;
        expect(() => field.visibleWhen!(def.defaultConfig)).not.toThrow();
      }
    }
  });

  test('select/multiselect fields declare at least one option', () => {
    for (const def of allResources) {
      for (const field of def.configSchema) {
        if (field.type === 'select' || field.type === 'multiselect') {
          expect(field.options && field.options.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('number fields with min/max have a defaultValue within bounds', () => {
    for (const def of allResources) {
      for (const field of def.configSchema) {
        if (field.type !== 'number') continue;
        const v = Number(field.defaultValue);
        if (field.min !== undefined) expect(v).toBeGreaterThanOrEqual(field.min);
        if (field.max !== undefined) expect(v).toBeLessThanOrEqual(field.max);
      }
    }
  });
});

describe('aws_rds — deepened config schema', () => {
  const def = getResourceDefinition('aws_rds')!;

  test('resource definition exists', () => {
    expect(def).toBeDefined();
  });

  test('fields are organized into the expected sections', () => {
    const sections = new Set(def.configSchema.map((f) => f.section || 'General'));
    expect(sections.has('General')).toBe(true);
    expect(sections.has('Storage')).toBe(true);
    expect(sections.has('Security')).toBe(true);
    expect(sections.has('Identity & Access')).toBe(true);
    expect(sections.has('Backup & Recovery')).toBe(true);
    expect(sections.has('Monitoring')).toBe(true);
  });

  test('kmsKeyId is only visible when encrypted is true', () => {
    const kmsField = def.configSchema.find((f) => f.key === 'kmsKeyId')!;
    expect(kmsField.visibleWhen!({ encrypted: true })).toBe(true);
    expect(kmsField.visibleWhen!({ encrypted: false })).toBe(false);
    expect(kmsField.visibleWhen!({})).toBe(false);
  });

  test('iops is only visible for io1/io2 storage types', () => {
    const iopsField = def.configSchema.find((f) => f.key === 'iops')!;
    expect(iopsField.visibleWhen!({ storageType: 'io1' })).toBe(true);
    expect(iopsField.visibleWhen!({ storageType: 'io2' })).toBe(true);
    expect(iopsField.visibleWhen!({ storageType: 'gp3' })).toBe(false);
  });

  test('storageThroughput is only visible for gp3', () => {
    const field = def.configSchema.find((f) => f.key === 'storageThroughput')!;
    expect(field.visibleWhen!({ storageType: 'gp3' })).toBe(true);
    expect(field.visibleWhen!({ storageType: 'io1' })).toBe(false);
  });

  test('performanceInsightsRetentionPeriod is only visible when insights are enabled', () => {
    const field = def.configSchema.find((f) => f.key === 'performanceInsightsRetentionPeriod')!;
    expect(field.visibleWhen!({ enablePerformanceInsights: true })).toBe(true);
    expect(field.visibleWhen!({ enablePerformanceInsights: false })).toBe(false);
  });

  test('advanced fields cover monitoring/maintenance internals without hiding core security controls', () => {
    const advancedKeys = def.configSchema.filter((f) => f.advanced).map((f) => f.key);
    expect(advancedKeys).toEqual(expect.arrayContaining(['monitoringInterval', 'parameterGroupName', 'preferredMaintenanceWindow']));
    // Core security/architecture controls must stay visible in Basic mode.
    const basicKeys = def.configSchema.filter((f) => !f.advanced).map((f) => f.key);
    expect(basicKeys).toEqual(expect.arrayContaining(['encrypted', 'publiclyAccessible', 'multiAz', 'deletionProtection']));
  });

  test('readReplicas defaults to 0 and is bounded', () => {
    const field = def.configSchema.find((f) => f.key === 'readReplicas')!;
    expect(field.defaultValue).toBe(0);
    expect(field.min).toBe(0);
  });

  test('tags field uses the keyvalue type', () => {
    const field = def.configSchema.find((f) => f.key === 'tags')!;
    expect(field.type).toBe('keyvalue');
  });
});

describe('aws_ec2 — deepened config schema', () => {
  const def = getResourceDefinition('aws_ec2')!;

  test('storageIops is only visible for io1/io2 root volumes', () => {
    const field = def.configSchema.find((f) => f.key === 'storageIops')!;
    expect(field.visibleWhen!({ storageType: 'io1' })).toBe(true);
    expect(field.visibleWhen!({ storageType: 'gp3' })).toBe(false);
  });

  test('core security controls (encryption, public IP) stay visible in Basic mode', () => {
    const basicKeys = def.configSchema.filter((f) => !f.advanced).map((f) => f.key);
    expect(basicKeys).toEqual(expect.arrayContaining(['encrypted', 'associatePublicIpAddress', 'keyName']));
  });

  test('userData and IAM instance profile are advanced', () => {
    const advancedKeys = def.configSchema.filter((f) => f.advanced).map((f) => f.key);
    expect(advancedKeys).toEqual(expect.arrayContaining(['userData', 'iamInstanceProfile', 'terminationProtection']));
  });
});

describe('aws_s3 — deepened config schema', () => {
  const def = getResourceDefinition('aws_s3')!;

  test('kmsKeyId is only visible for SSE-KMS with encryption enabled', () => {
    const field = def.configSchema.find((f) => f.key === 'kmsKeyId')!;
    expect(field.visibleWhen!({ encryption: true, encryptionType: 'aws:kms' })).toBe(true);
    expect(field.visibleWhen!({ encryption: true, encryptionType: 'AES256' })).toBe(false);
    expect(field.visibleWhen!({ encryption: false, encryptionType: 'aws:kms' })).toBe(false);
  });

  test('encryptionType is only visible when encryption is enabled', () => {
    const field = def.configSchema.find((f) => f.key === 'encryptionType')!;
    expect(field.visibleWhen!({ encryption: true })).toBe(true);
    expect(field.visibleWhen!({ encryption: false })).toBe(false);
  });

  test('lifecycleTransitionStorageClass is only visible once a transition window is set', () => {
    const field = def.configSchema.find((f) => f.key === 'lifecycleTransitionStorageClass')!;
    expect(field.visibleWhen!({ lifecycleTransitionDays: 30 })).toBe(true);
    expect(field.visibleWhen!({ lifecycleTransitionDays: 0 })).toBe(false);
    expect(field.visibleWhen!({})).toBe(false);
  });

  test('cost-estimation fields (estimatedStorageGb, estimatedRequestsPerMonth) are exposed to the user', () => {
    const keys = def.configSchema.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['estimatedStorageGb', 'estimatedRequestsPerMonth']));
  });
});

describe('aws_sg — deepened config schema', () => {
  const def = getResourceDefinition('aws_sg')!;

  test('egressCidr is only visible when outbound traffic is restricted', () => {
    const field = def.configSchema.find((f) => f.key === 'egressCidr')!;
    expect(field.visibleWhen!({ allowAllOutbound: false })).toBe(true);
    expect(field.visibleWhen!({ allowAllOutbound: true })).toBe(false);
    expect(field.visibleWhen!({})).toBe(false);
  });

  test('allowRdp exists in the schema and is a Basic (non-advanced) toggle', () => {
    const field = def.configSchema.find((f) => f.key === 'allowRdp')!;
    expect(field).toBeDefined();
    expect(field.advanced).toBeFalsy();
  });
});

describe('azure_vm — deepened config schema', () => {
  const def = getResourceDefinition('azure_vm')!;

  test('osType offers both Linux and Windows', () => {
    const field = def.configSchema.find((f) => f.key === 'osType')!;
    const values = field.options!.map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(['Linux', 'Windows']));
  });

  test('publicIpEnabled is a Basic (non-advanced) security-relevant toggle', () => {
    const field = def.configSchema.find((f) => f.key === 'publicIpEnabled')!;
    expect(field.advanced).toBeFalsy();
  });
});

describe('aws_lambda — deepened config schema', () => {
  const def = getResourceDefinition('aws_lambda')!;

  test('cost-estimation fields are exposed to the user', () => {
    const keys = def.configSchema.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['estimatedInvocationsPerMonth', 'estimatedAvgDurationMs']));
  });

  test('environmentVariables uses the keyvalue type', () => {
    const field = def.configSchema.find((f) => f.key === 'environmentVariables')!;
    expect(field.type).toBe('keyvalue');
  });

  test('has a security rule for disabled X-Ray tracing', () => {
    expect(def.securityRules!.some((r) => r.id === 'lambda-tracing-disabled')).toBe(true);
  });
});

describe('aws_alb — deepened config schema', () => {
  const def = getResourceDefinition('aws_alb')!;

  test('certificateArn and sslPolicy are only visible for HTTPS/TLS listeners', () => {
    const cert = def.configSchema.find((f) => f.key === 'certificateArn')!;
    expect(cert.visibleWhen!({ listenerProtocol: 'HTTPS' })).toBe(true);
    expect(cert.visibleWhen!({ listenerProtocol: 'HTTP' })).toBe(false);
  });

  test('has a security rule catching HTTPS without a certificate', () => {
    expect(def.securityRules!.some((r) => r.id === 'alb-https-no-cert')).toBe(true);
  });
});

describe('azure_storage — deepened config schema', () => {
  const def = getResourceDefinition('azure_storage')!;

  test('has a security rule for open network default action', () => {
    expect(def.securityRules!.some((r) => r.id === 'storage-network-open')).toBe(true);
  });

  test('blobSoftDeleteRetentionDays defaults to 0 (disabled) and is bounded', () => {
    const field = def.configSchema.find((f) => f.key === 'blobSoftDeleteRetentionDays')!;
    expect(field.defaultValue).toBe(0);
    expect(field.max).toBe(365);
  });
});

describe('azure_sql — deepened config schema', () => {
  const def = getResourceDefinition('azure_sql')!;

  test('allowAzureServices is only visible when public network access is enabled', () => {
    const field = def.configSchema.find((f) => f.key === 'allowAzureServices')!;
    expect(field.visibleWhen!({ publicNetworkAccess: true })).toBe(true);
    expect(field.visibleWhen!({ publicNetworkAccess: false })).toBe(false);
  });

  test('transparentDataEncryptionEnabled defaults to true and has a dedicated security rule', () => {
    const field = def.configSchema.find((f) => f.key === 'transparentDataEncryptionEnabled')!;
    expect(field.defaultValue).toBe(true);
    expect(def.securityRules!.some((r) => r.id === 'sql-tde-disabled')).toBe(true);
  });
});
