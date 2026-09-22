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

describe('aws_dynamodb — deepened config schema', () => {
  const def = getResourceDefinition('aws_dynamodb')!;

  test('readCapacity/writeCapacity are only visible in PROVISIONED billing mode', () => {
    const field = def.configSchema.find((f) => f.key === 'readCapacity')!;
    expect(field.visibleWhen!({ billingMode: 'PROVISIONED' })).toBe(true);
    expect(field.visibleWhen!({ billingMode: 'PAY_PER_REQUEST' })).toBe(false);
  });

  test('has security rules for encryption and point-in-time recovery', () => {
    expect(def.securityRules!.some((r) => r.id === 'dynamodb-encryption')).toBe(true);
    expect(def.securityRules!.some((r) => r.id === 'dynamodb-pitr')).toBe(true);
  });
});

describe('aws_elasticache — deepened config schema', () => {
  const def = getResourceDefinition('aws_elasticache')!;

  test('automaticFailoverEnabled and multiAzEnabled are only visible for multi-node clusters', () => {
    const field = def.configSchema.find((f) => f.key === 'automaticFailoverEnabled')!;
    expect(field.visibleWhen!({ numNodes: 3 })).toBe(true);
    expect(field.visibleWhen!({ numNodes: 1 })).toBe(false);
  });
});

describe('aws_sqs — deepened config schema', () => {
  const def = getResourceDefinition('aws_sqs')!;

  test('contentBasedDeduplication is only visible for FIFO queues', () => {
    const field = def.configSchema.find((f) => f.key === 'contentBasedDeduplication')!;
    expect(field.visibleWhen!({ fifoQueue: true })).toBe(true);
    expect(field.visibleWhen!({ fifoQueue: false })).toBe(false);
  });

  test('maxReceiveCount is only visible once a dead-letter queue ARN is set', () => {
    const field = def.configSchema.find((f) => f.key === 'maxReceiveCount')!;
    expect(field.visibleWhen!({ deadLetterTargetArn: 'arn:aws:sqs:us-east-1:123456789012:dlq' })).toBe(true);
    expect(field.visibleWhen!({})).toBe(false);
  });
});

describe('aws_ecs — deepened config schema', () => {
  const def = getResourceDefinition('aws_ecs')!;

  test('alwaysOn-style autoscaling and health check fields are advanced but core launch settings stay in Basic', () => {
    const basicKeys = def.configSchema.filter((f) => !f.advanced).map((f) => f.key);
    expect(basicKeys).toEqual(expect.arrayContaining(['containerImage', 'containerPort', 'desiredCount']));
  });

  test('has a security rule for public IP assignment', () => {
    expect(def.securityRules!.some((r) => r.id === 'ecs-public-ip')).toBe(true);
  });
});

describe('aws_eks — deepened config schema', () => {
  const def = getResourceDefinition('aws_eks')!;

  test('publicAccessCidrs is only visible when the public endpoint is enabled', () => {
    const field = def.configSchema.find((f) => f.key === 'publicAccessCidrs')!;
    expect(field.visibleWhen!({ endpointPublicAccess: true })).toBe(true);
    expect(field.visibleWhen!({ endpointPublicAccess: false })).toBe(false);
  });

  test('clusterLogTypes uses the multiselect type', () => {
    const field = def.configSchema.find((f) => f.key === 'clusterLogTypes')!;
    expect(field.type).toBe('multiselect');
  });

  test('has a security rule for an open public endpoint', () => {
    expect(def.securityRules!.some((r) => r.id === 'eks-public-endpoint-open')).toBe(true);
  });
});

describe('azure_aks — deepened config schema', () => {
  const def = getResourceDefinition('azure_aks')!;

  test('minNodeCount/maxNodeCount are only visible when the cluster autoscaler is enabled', () => {
    const field = def.configSchema.find((f) => f.key === 'minNodeCount')!;
    expect(field.visibleWhen!({ enableAutoScaling: true })).toBe(true);
    expect(field.visibleWhen!({ enableAutoScaling: false })).toBe(false);
  });

  test('has a security rule for disabled Azure AD RBAC', () => {
    expect(def.securityRules!.some((r) => r.id === 'aks-no-rbac')).toBe(true);
  });
});

describe('aws_route53 — deepened config schema', () => {
  const def = getResourceDefinition('aws_route53')!;

  test('weight is only visible for the Weighted routing policy', () => {
    const field = def.configSchema.find((f) => f.key === 'weight')!;
    expect(field.visibleWhen!({ routingPolicy: 'Weighted' })).toBe(true);
    expect(field.visibleWhen!({ routingPolicy: 'Simple' })).toBe(false);
  });
});

describe('aws_waf — deepened config schema', () => {
  const def = getResourceDefinition('aws_waf')!;

  test('rateLimitThreshold is only visible when rate-based rule is enabled', () => {
    const field = def.configSchema.find((f) => f.key === 'rateLimitThreshold')!;
    expect(field.visibleWhen!({ rateLimitEnabled: true })).toBe(true);
    expect(field.visibleWhen!({ rateLimitEnabled: false })).toBe(false);
  });

  test('managedRuleGroups uses the multiselect type', () => {
    const field = def.configSchema.find((f) => f.key === 'managedRuleGroups')!;
    expect(field.type).toBe('multiselect');
  });

  test('has a security rule for no managed rule groups', () => {
    expect(def.securityRules!.some((r) => r.id === 'waf-no-managed-rules')).toBe(true);
  });
});

describe('aws_route_table — deepened config schema', () => {
  const def = getResourceDefinition('aws_route_table')!;

  test('destinationCidr is hidden when targetType is none', () => {
    const field = def.configSchema.find((f) => f.key === 'destinationCidr')!;
    expect(field.visibleWhen!({ targetType: 'none' })).toBe(false);
    expect(field.visibleWhen!({ targetType: 'internet_gateway' })).toBe(true);
  });
});

describe('aws_nacl — deepened config schema', () => {
  const def = getResourceDefinition('aws_nacl')!;

  test('inbound port fields are hidden for allow-all and for icmp/all protocols', () => {
    const field = def.configSchema.find((f) => f.key === 'inboundPortFrom')!;
    expect(field.visibleWhen!({ allowAllInbound: false, inboundProtocol: 'tcp' })).toBe(true);
    expect(field.visibleWhen!({ allowAllInbound: true, inboundProtocol: 'tcp' })).toBe(false);
    expect(field.visibleWhen!({ allowAllInbound: false, inboundProtocol: 'icmp' })).toBe(false);
  });
});

describe('aws_iam — deepened config schema', () => {
  const def = getResourceDefinition('aws_iam')!;

  test('has a security rule flagging AdministratorAccess', () => {
    expect(def.securityRules!.some((r) => r.id === 'iam-admin-access')).toBe(true);
  });

  test('managedPolicyArns uses the multiselect type', () => {
    const field = def.configSchema.find((f) => f.key === 'managedPolicyArns')!;
    expect(field.type).toBe('multiselect');
  });
});

describe('aws_kms — deepened config schema', () => {
  const def = getResourceDefinition('aws_kms')!;

  test('has security rules for key rotation and deletion window', () => {
    expect(def.securityRules!.some((r) => r.id === 'kms-key-rotation')).toBe(true);
    expect(def.securityRules!.some((r) => r.id === 'kms-short-deletion-window')).toBe(true);
  });
});

describe('aws_ebs — deepened config schema', () => {
  const def = getResourceDefinition('aws_ebs')!;

  test('iops is visible for io1/io2/gp3 but not st1/sc1', () => {
    const field = def.configSchema.find((f) => f.key === 'iops')!;
    expect(field.visibleWhen!({ volumeType: 'io2' })).toBe(true);
    expect(field.visibleWhen!({ volumeType: 'gp3' })).toBe(true);
    expect(field.visibleWhen!({ volumeType: 'st1' })).toBe(false);
  });
});

describe('aws_auto_scaling — deepened config schema', () => {
  const def = getResourceDefinition('aws_auto_scaling')!;

  test('targetCpuUtilization is only visible when the scaling policy is enabled', () => {
    const field = def.configSchema.find((f) => f.key === 'targetCpuUtilization')!;
    expect(field.visibleWhen!({ scalingPolicyEnabled: true })).toBe(true);
    expect(field.visibleWhen!({ scalingPolicyEnabled: false })).toBe(false);
  });
});

describe('azure_app_service — newly added resource', () => {
  const def = getResourceDefinition('azure_app_service')!;

  test('resource definition exists in the catalog', () => {
    expect(def).toBeDefined();
    expect(def.provider).toBe('azure');
  });

  test('alwaysOn is only visible off the Free (F1) tier', () => {
    const field = def.configSchema.find((f) => f.key === 'alwaysOn')!;
    expect(field.visibleWhen!({ skuName: 'B1' })).toBe(true);
    expect(field.visibleWhen!({ skuName: 'F1' })).toBe(false);
  });

  test('has security rules for HTTPS enforcement, FTP, and TLS version', () => {
    expect(def.securityRules!.some((r) => r.id === 'app-service-https-only')).toBe(true);
    expect(def.securityRules!.some((r) => r.id === 'app-service-ftp-enabled')).toBe(true);
    expect(def.securityRules!.some((r) => r.id === 'app-service-old-tls')).toBe(true);
  });

  test('is registered in allResources exactly once', () => {
    const matches = allResources.filter((r) => r.type === 'azure_app_service');
    expect(matches.length).toBe(1);
  });
});

describe('azure_functions — deepened config schema', () => {
  const def = getResourceDefinition('azure_functions')!;

  test('alwaysOn is only visible for non-Consumption plans', () => {
    const field = def.configSchema.find((f) => f.key === 'alwaysOn')!;
    expect(field.visibleWhen!({ planType: 'EP1' })).toBe(true);
    expect(field.visibleWhen!({ planType: 'Y1' })).toBe(false);
  });

  test('cost-estimation fields are only visible for the Consumption plan', () => {
    const field = def.configSchema.find((f) => f.key === 'estimatedInvocationsPerMonth')!;
    expect(field.visibleWhen!({ planType: 'Y1' })).toBe(true);
    expect(field.visibleWhen!({ planType: 'EP1' })).toBe(false);
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
