/**
 * CloudCraft — Adaptive Workload Scale Engine
 *
 * Dynamically resizes compute, database, caching, autoscaling, load-balancing,
 * and security postures based on multi-dimensional workload scale profiles:
 * - Expected users (100 to 1,000,000+)
 * - User-provided vs estimated requests per second (RPS)
 * - Peak throughput & burst traffic multipliers
 * - Availability SLA targets (e.g. 99.0%, 99.9%, 99.99%)
 * - Geographic distribution (single-region, multi-region, global)
 * - Data growth & storage expansion models (low, moderate, rapid, extreme)
 * - Traffic patterns (steady, bursty, seasonal, periodic)
 *
 * Avoids crude linear multiplication — applies deterministic cloud capacity models.
 */

import { CanvasNode, CanvasEdge, ScaleProfile, CloudProvider } from '@/types';
import { toCanonicalGraph, validateCanonicalArchitecture } from '@/lib/domain/canonicalArchitecture';

export interface ScaleTelemetry {
  userProvided: {
    expectedUsers: number;
    requestsPerSecond?: number;
    peakRequestsPerSecond?: number;
    availabilityTarget?: number | string;
    geographicDistribution?: string;
    dataGrowth?: string;
    trafficPattern?: string;
  };
  calculatedAssumptions: {
    isUserRpsProvided: boolean;
    isUserPeakRpsProvided: boolean;
    effectiveRps: number;
    calculatedPeakRps: number;
    burstMultiplier: number;
    availabilitySlaPercent: number;
    concurrentUserRatio: number;
  };
  recommendations: {
    computeTier: string;
    azureVmTier: string;
    asgRange: [number, number, number]; // min, desired, max
    databaseTier: string;
    azureSqlTier: string;
    dbStorageGb: number;
    multiAzRequired: boolean;
    cachingRequired: boolean;
    cdnRequired: boolean;
    wafRequired: boolean;
    readReplicas: number;
  };
}

export interface ScaleAdaptationResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  scaleProfile: ScaleProfile;
  appliedChanges: string[];
  telemetry?: ScaleTelemetry;
}

export class AdaptiveScaleEngine {
  private static instance: AdaptiveScaleEngine;

  public static getInstance(): AdaptiveScaleEngine {
    if (!AdaptiveScaleEngine.instance) {
      AdaptiveScaleEngine.instance = new AdaptiveScaleEngine();
    }
    return AdaptiveScaleEngine.instance;
  }

  public adaptArchitectureScale(
    inputNodes: CanvasNode[],
    inputEdges: CanvasEdge[],
    profile: ScaleProfile
  ): ScaleAdaptationResult {
    const nodes: CanvasNode[] = JSON.parse(JSON.stringify(inputNodes));
    const edges: CanvasEdge[] = JSON.parse(JSON.stringify(inputEdges));
    const appliedChanges: string[] = [];

    // ── 1. Separate User-Provided Values vs Calculated Assumptions ───────────
    const users = Math.max(1, profile.expectedUsers || 1000);
    const isUserRpsProvided = typeof profile.requestsPerSecond === 'number' && profile.requestsPerSecond > 0;
    const isUserPeakRpsProvided = typeof profile.peakRequestsPerSecond === 'number' && profile.peakRequestsPerSecond > 0;

    const trafficPattern = profile.trafficPattern || 'steady';
    const dataGrowth = profile.dataGrowth || 'moderate';
    const geographicDistribution = profile.geographicDistribution || (users >= 100000 ? 'multi-region' : 'single-region');

    // Parse availability target (e.g. 99.9, '99.99%', 99)
    let availabilitySlaPercent: number | null = null;
    if (profile.availabilityTarget !== undefined) {
      if (typeof profile.availabilityTarget === 'number') {
        availabilitySlaPercent = profile.availabilityTarget;
      } else if (typeof profile.availabilityTarget === 'string') {
        const parsed = parseFloat(profile.availabilityTarget.replace('%', ''));
        if (!isNaN(parsed)) availabilitySlaPercent = parsed;
      }
    }

    // Deterministic RPS derivation:
    // If not user-provided: assumes 8% active concurrency ratio for steady, 15% for bursty
    const concurrentUserRatio = trafficPattern === 'bursty' ? 0.15 : 0.08;
    const estimatedRps = Math.max(5, Math.round(users * concurrentUserRatio * 0.5));
    const rps = isUserRpsProvided ? profile.requestsPerSecond! : estimatedRps;

    // Peak multiplier determination:
    const burstMultiplier =
      trafficPattern === 'bursty' ? 4.0 :
      trafficPattern === 'seasonal' ? 3.0 :
      trafficPattern === 'periodic' ? 2.5 : 2.0;

    const estimatedPeakRps = Math.max(10, Math.round(rps * burstMultiplier));
    const peakRps = isUserPeakRpsProvided ? profile.peakRequestsPerSecond! : estimatedPeakRps;

    // Effective Capacity Demand = peak RPS + safety headroom
    const effectiveRps = Math.max(peakRps, rps * 1.5);

    appliedChanges.push(
      `Calibrated target load: ${users.toLocaleString()} users ` +
      `[${isUserRpsProvided ? 'User-Provided' : 'Estimated'} ~${rps.toLocaleString()} avg RPS, ` +
      `${isUserPeakRpsProvided ? 'User-Provided' : 'Estimated'} ~${peakRps.toLocaleString()} peak RPS (${burstMultiplier}x burst factor)]`
    );

    // ── 2. Workload-Derived Capacity Recommendations ─────────────────────────
    let ec2Type = 't4g.small';
    let azureVmSize = 'Standard_B1s';
    let asgMin = 1;
    let asgDesired = 1;
    let asgMax = 2;
    let vmssCap = 1;

    let rdsClass = 'db.t4g.micro';
    let rdsMultiAz = availabilitySlaPercent !== null ? availabilitySlaPercent >= 99.9 : users >= 10000;
    let rdsStorage = 30;
    let rdsReadReplicas = 0;
    let azureSqlSku = 'Basic';
    let azureSqlZoneRedundant = availabilitySlaPercent !== null ? availabilitySlaPercent >= 99.9 : users >= 100000;
    let azureSqlMaxGb = 50;

    let ecsDesired = 1;
    let ecsCpu = 256;
    let ecsMemory = 512;
    let aksNodeCount = 2;

    let requireCache = false;
    let requireCdn = false;
    let requireWaf = false;

    // High availability requirement checks
    if (availabilitySlaPercent !== null) {
      if (availabilitySlaPercent >= 99.99) {
        asgMin = Math.max(3, asgMin);
        asgDesired = Math.max(3, asgDesired);
        rdsMultiAz = true;
        azureSqlZoneRedundant = true;
        rdsReadReplicas = Math.max(1, rdsReadReplicas);
      } else if (availabilitySlaPercent >= 99.9) {
        asgMin = Math.max(2, asgMin);
        asgDesired = Math.max(2, asgDesired);
        rdsMultiAz = true;
        azureSqlZoneRedundant = true;
      }
    }

    // Capacity scaling driven by Effective Throughput (effectiveRps) and user volume
    if (effectiveRps < 50 && users < 500) {
      // Entry / Dev Scale
      ec2Type = 't4g.small';
      azureVmSize = 'Standard_B1s';
      asgMin = Math.min(asgMin, 2);
      asgDesired = Math.max(asgMin, 1);
      asgMax = 2;
      vmssCap = asgDesired;

      rdsClass = 'db.t4g.micro';
      azureSqlSku = 'Basic';
      azureSqlMaxGb = 50;
      rdsStorage = 30;

      ecsDesired = 1;
      ecsCpu = 256;
      ecsMemory = 512;
      aksNodeCount = 2;
    } else if (effectiveRps <= 250) {
      // Production Small / SMB
      ec2Type = 't4g.medium';
      azureVmSize = 'Standard_B2s';
      asgMin = Math.max(asgMin, 2);
      asgDesired = 2;
      asgMax = 4;
      vmssCap = 2;

      rdsClass = 'db.t4g.medium';
      azureSqlSku = 'GP_Gen5_2';
      azureSqlMaxGb = 100;
      rdsStorage = 50;

      ecsDesired = 2;
      ecsCpu = 512;
      ecsMemory = 1024;
      aksNodeCount = 3;
      requireCache = trafficPattern === 'bursty';
    } else if (effectiveRps <= 1500) {
      // Enterprise Mid-Tier
      ec2Type = 'c6g.xlarge';
      azureVmSize = 'Standard_D4s_v5';
      asgMin = Math.max(asgMin, 2);
      asgDesired = 4;
      asgMax = trafficPattern === 'bursty' ? 12 : 8;
      vmssCap = 4;

      rdsClass = 'db.r6g.xlarge';
      azureSqlSku = 'GP_Gen5_8';
      azureSqlMaxGb = 250;
      rdsStorage = 150;
      rdsReadReplicas = 1;

      ecsDesired = 4;
      ecsCpu = 1024;
      ecsMemory = 2048;
      aksNodeCount = 4;
      requireCache = true;
      requireCdn = true;
      requireWaf = true;
    } else if (effectiveRps <= 8000) {
      // High-Scale Enterprise
      ec2Type = 'c6g.2xlarge';
      azureVmSize = 'Standard_D8s_v5';
      asgMin = Math.max(asgMin, 4);
      asgDesired = 6;
      asgMax = trafficPattern === 'bursty' ? 24 : 16;
      vmssCap = 6;

      rdsClass = 'db.r6g.2xlarge';
      azureSqlSku = 'BC_Gen5_16';
      azureSqlMaxGb = 500;
      rdsStorage = 500;
      rdsReadReplicas = 2;

      ecsDesired = 6;
      ecsCpu = 2048;
      ecsMemory = 4096;
      aksNodeCount = 6;
      requireCache = true;
      requireCdn = true;
      requireWaf = true;
    } else {
      // Hyper-Scale Global (>8,000 peak RPS)
      ec2Type = 'c6g.4xlarge';
      azureVmSize = 'Standard_E8s_v5';
      asgMin = Math.max(asgMin, 6);
      asgDesired = 12;
      asgMax = 32;
      vmssCap = 12;

      rdsClass = 'db.r6g.4xlarge';
      azureSqlSku = 'BC_Gen5_16';
      azureSqlMaxGb = 1000;
      rdsStorage = 1000;
      rdsReadReplicas = Math.max(2, Math.min(4, Math.ceil(effectiveRps / 5000)));

      ecsDesired = 12;
      ecsCpu = 4096;
      ecsMemory = 8192;
      aksNodeCount = 10;
      requireCache = true;
      requireCdn = true;
      requireWaf = true;
    }

    // Data Growth adjustments for Database Storage & IOPS
    if (dataGrowth === 'rapid') {
      rdsStorage = Math.max(rdsStorage, 250);
      azureSqlMaxGb = Math.max(azureSqlMaxGb, 500);
      appliedChanges.push(`Adjusted storage provision for rapid data growth (~${rdsStorage}GB baseline)`);
    } else if (dataGrowth === 'extreme') {
      rdsStorage = Math.max(rdsStorage, 1000);
      azureSqlMaxGb = Math.max(azureSqlMaxGb, 1000);
      appliedChanges.push(`Adjusted storage provision for extreme data growth (~${rdsStorage}GB baseline + auto-expand)`);
    }

    // Geographic Distribution adjustments
    if (geographicDistribution === 'multi-region' || geographicDistribution === 'global') {
      requireCdn = true;
      requireWaf = true;
    }

    // ── 3. Adapt Compute Resources ───────────────────────────────────────────
    for (const node of nodes) {
      if (node.resourceType === 'aws_ec2') {
        const prev = node.config?.instanceType;
        node.config = { ...node.config, instanceType: ec2Type };
        if (prev !== ec2Type) {
          appliedChanges.push(`Adjusted EC2 instance "${node.label}" from ${prev || 'default'} to ${ec2Type}`);
        }
      } else if (node.resourceType === 'azure_vm') {
        // NOTE: the RDE's actual config field for VM size is "size", not
        // "vmSize" (see lib/resources/azure.ts) — this previously wrote to
        // an orphan key, so Azure VM scale changes never reached the stored
        // config, the Properties Panel, or Terraform generation at all.
        const prev = node.config?.size;
        node.config = { ...node.config, size: azureVmSize };
        if (prev !== azureVmSize) {
          appliedChanges.push(`Adjusted Azure VM "${node.label}" from ${prev || 'default'} to ${azureVmSize}`);
        }
      } else if (node.resourceType === 'aws_auto_scaling') {
        node.config = {
          ...node.config,
          minSize: asgMin,
          maxSize: asgMax,
          desiredCapacity: asgDesired,
        };
        appliedChanges.push(`Scaled Auto Scaling Group "${node.label}" to [min: ${asgMin}, desired: ${asgDesired}, max: ${asgMax}]`);
      } else if (node.resourceType === 'azure_vmss') {
        node.config = {
          ...node.config,
          capacity: vmssCap,
          sku: azureVmSize,
        };
        appliedChanges.push(`Scaled VM Scale Set "${node.label}" to capacity=${vmssCap} (${azureVmSize})`);
      } else if (node.resourceType === 'aws_ecs') {
        node.config = {
          ...node.config,
          desiredCount: ecsDesired,
          cpu: ecsCpu,
          memory: ecsMemory,
        };
        appliedChanges.push(`Sized ECS Fargate service "${node.label}" to count=${ecsDesired} (${ecsCpu} CPU, ${ecsMemory}MB RAM)`);
      } else if (node.resourceType === 'azure_aks') {
        node.config = {
          ...node.config,
          nodeCount: aksNodeCount,
          vmSize: azureVmSize,
        };
        appliedChanges.push(`Sized Azure AKS cluster "${node.label}" to nodeCount=${aksNodeCount} (${azureVmSize})`);
      }
    }

    // ── 4. Adapt Database Resources ──────────────────────────────────────────
    for (const node of nodes) {
      if (node.resourceType === 'aws_rds') {
        node.config = {
          ...node.config,
          instanceClass: rdsClass,
          multiAz: rdsMultiAz,
          allocatedStorage: rdsStorage,
          readReplicas: rdsReadReplicas,
        };
        appliedChanges.push(
          `Sized AWS RDS "${node.label}" to ${rdsClass} (${rdsStorage}GB, Multi-AZ: ${rdsMultiAz}, ${rdsReadReplicas} replicas)`
        );
      } else if (node.resourceType === 'azure_sql') {
        // NOTE: the RDE's actual config fields are "tier" and "maxSizeGb"
        // (see lib/resources/azure.ts and TerraformGenerator._sql, which
        // reads cfg['tier'] and cfg['maxSizeGb']) — this previously wrote
        // to "sku" and "maxSizeBytes", neither of which anything reads, so
        // Azure SQL scale changes never reached the stored config, the
        // Properties Panel, or Terraform generation at all.
        node.config = {
          ...node.config,
          tier: azureSqlSku,
          maxSizeGb: azureSqlMaxGb,
          zoneRedundant: azureSqlZoneRedundant,
        };
        appliedChanges.push(
          `Sized Azure SQL "${node.label}" to sku=${azureSqlSku} (${azureSqlMaxGb}GB, zone-redundant: ${azureSqlZoneRedundant})`
        );
      }
    }

    // ── 5. Cache Tier (ElastiCache / Azure Redis) ─────────────────────────────
    if (requireCache) {
      const hasAwsRedis = nodes.some((n) => n.resourceType === 'aws_elasticache');
      const hasAzureRedis = nodes.some((n) => n.resourceType === 'azure_redis');
      const hasAwsDb = nodes.some((n) => n.resourceType === 'aws_rds');
      const hasAzureDb = nodes.some((n) => n.resourceType === 'azure_sql');

      if (hasAwsDb && !hasAwsRedis) {
        const dbSub = nodes.find(
          (n) =>
            (n.resourceType === 'aws_subnet' && (n.label.toLowerCase().includes('db') || n.label.toLowerCase().includes('data')))
        );
        if (dbSub) {
          const redisNode: CanvasNode = {
            id: `scaled-redis-${Date.now()}`,
            type: 'cloudNode',
            resourceType: 'aws_elasticache',
            provider: 'aws',
            label: 'ElastiCache Redis (Cache Tier)',
            groupId: dbSub.id,
            parentId: dbSub.id,
            position: { x: dbSub.position.x + 220, y: dbSub.position.y + 30 },
            // 'cache.m5.large' isn't a real option in the aws_elasticache
            // resource's own nodeType dropdown (lib/resources/aws.ts) — the
            // catalog only offers t3.*/r6g.* — so it not only mispriced (no
            // matching CACHE_HOURLY_USD entry either) but would also render
            // as a blank/mismatched select in the Properties panel.
            config: { nodeType: effectiveRps > 1500 ? 'cache.r6g.xlarge' : 'cache.t3.medium', numNodes: 2 },
          };
          nodes.push(redisNode);
          appliedChanges.push('Introduced ElastiCache Redis cluster to offload database query load');
        }
      }

      if (hasAzureDb && !hasAzureRedis) {
        const dbSub = nodes.find(
          (n) =>
            (n.resourceType === 'azure_subnet' && (n.label.toLowerCase().includes('db') || n.label.toLowerCase().includes('data')))
        );
        if (dbSub) {
          const redisNode: CanvasNode = {
            id: `scaled-az-redis-${Date.now()}`,
            type: 'cloudNode',
            resourceType: 'azure_redis',
            provider: 'azure',
            label: 'Azure Cache for Redis',
            groupId: dbSub.id,
            parentId: dbSub.id,
            position: { x: dbSub.position.x + 220, y: dbSub.position.y + 30 },
            config: { sku: effectiveRps > 1500 ? 'Premium' : 'Standard', capacity: 1 },
          };
          nodes.push(redisNode);
          appliedChanges.push('Introduced Azure Cache for Redis to accelerate data query responses');
        }
      }
    }

    // ── 6. WAF Scaling ────────────────────────────────────────────────────────
    if (requireWaf) {
      const hasAwsWaf = nodes.some((n) => n.resourceType === 'aws_waf');
      const hasAzureWaf = nodes.some((n) => n.resourceType === 'azure_waf');
      const hasAwsDb = nodes.some((n) => n.resourceType === 'aws_rds');
      const hasAzureDb = nodes.some((n) => n.resourceType === 'azure_sql');

      for (const node of nodes) {
        if (node.resourceType === 'aws_waf' || node.resourceType === 'azure_waf') {
          node.config = { ...node.config, mode: 'Prevention', defaultAction: 'ALLOW', rateLimit: Math.max(2000, peakRps * 2) };
        }
      }

      if (!hasAwsWaf && hasAwsDb) {
        const cloudBoundary = nodes.find((n) => n.resourceType === 'aws_cloud_boundary');
        const wafNode: CanvasNode = {
          id: `scaled-waf-${Date.now()}`,
          type: 'cloudNode',
          resourceType: 'aws_waf',
          provider: 'aws',
          label: 'AWS WAF Shield (Enterprise)',
          groupId: cloudBoundary?.id,
          parentId: cloudBoundary?.id,
          position: { x: (cloudBoundary?.position.x || 0) + 560, y: (cloudBoundary?.position.y || 0) + 70 },
          config: { defaultAction: 'ALLOW', mode: 'Prevention', rateLimit: Math.max(2000, peakRps * 2) },
        };
        nodes.push(wafNode);
        appliedChanges.push('Provisioned enterprise AWS WAF Shield for Layer 7 DDoS mitigation and OWASP rule enforcement');
      }

      if (!hasAzureWaf && hasAzureDb) {
        const cloudBoundary = nodes.find((n) => n.resourceType === 'azure_cloud_boundary');
        const wafNode: CanvasNode = {
          id: `scaled-az-waf-${Date.now()}`,
          type: 'cloudNode',
          resourceType: 'azure_waf',
          provider: 'azure',
          label: 'Azure WAF Policy (Enterprise)',
          groupId: cloudBoundary?.id,
          parentId: cloudBoundary?.id,
          position: { x: (cloudBoundary?.position.x || 0) + 620, y: (cloudBoundary?.position.y || 0) + 65 },
          config: { mode: 'Prevention', defaultAction: 'ALLOW', rateLimit: Math.max(2000, peakRps * 2) },
        };
        nodes.push(wafNode);
        appliedChanges.push('Provisioned enterprise Azure WAF Policy for Layer 7 protection and custom rule enforcement');
      }
    }

    // ── 7. Edge CDN Provisioning ──────────────────────────────────────────────
    // requireCdn was previously computed at every scale tier from Enterprise
    // Mid-Tier upward but never acted on — the flag was returned in
    // telemetry only, so nothing was ever actually provisioned. This
    // mirrors the Cache/WAF injection pattern above: add the CDN in front
    // of the existing ALB/App Gateway when one exists, and wire a real
    // edge to it so Terraform generation (aws_cloudfront_distribution's
    // origin) resolves to the real load balancer instead of its
    // placeholder fallback.
    if (requireCdn) {
      const hasAwsCdn = nodes.some((n) => n.resourceType === 'aws_cloudfront');
      const hasAzureCdn = nodes.some((n) => n.resourceType === 'azure_front_door');
      const awsAlb = nodes.find((n) => n.resourceType === 'aws_alb');
      const azureAppGw = nodes.find((n) => n.resourceType === 'azure_app_gateway');

      if (!hasAwsCdn && awsAlb) {
        const cloudBoundary = nodes.find((n) => n.resourceType === 'aws_cloud_boundary');
        const cdnNode: CanvasNode = {
          id: `scaled-cdn-${Date.now()}`,
          type: 'cloudNode',
          resourceType: 'aws_cloudfront',
          provider: 'aws',
          label: 'CloudFront CDN (Enterprise)',
          groupId: cloudBoundary?.id,
          parentId: cloudBoundary?.id,
          position: { x: (cloudBoundary?.position.x || 0) + 560, y: (cloudBoundary?.position.y || 0) - 60 },
          config: { priceClass: geographicDistribution === 'global' ? 'PriceClass_All' : 'PriceClass_100' },
        };
        nodes.push(cdnNode);
        edges.push({
          id: `scaled-cdn-edge-${Date.now()}`,
          source: cdnNode.id,
          target: awsAlb.id,
          label: 'Origin HTTPS / 443',
          edgeType: 'network',
        });
        appliedChanges.push('Introduced CloudFront CDN in front of the Application Load Balancer for edge caching and reduced origin load');
      }

      if (!hasAzureCdn && azureAppGw) {
        const cloudBoundary = nodes.find((n) => n.resourceType === 'azure_cloud_boundary');
        const cdnNode: CanvasNode = {
          id: `scaled-az-cdn-${Date.now()}`,
          type: 'cloudNode',
          resourceType: 'azure_front_door',
          provider: 'azure',
          label: 'Azure Front Door (Enterprise)',
          groupId: cloudBoundary?.id,
          parentId: cloudBoundary?.id,
          position: { x: (cloudBoundary?.position.x || 0) + 620, y: (cloudBoundary?.position.y || 0) - 60 },
          config: { sku: 'Premium_AzureFrontDoor' },
        };
        nodes.push(cdnNode);
        edges.push({
          id: `scaled-az-cdn-edge-${Date.now()}`,
          source: cdnNode.id,
          target: azureAppGw.id,
          label: 'Origin HTTPS / 443',
          edgeType: 'network',
        });
        appliedChanges.push('Introduced Azure Front Door in front of the Application Gateway for global edge caching and reduced origin load');
      }
    }

    const telemetry: ScaleTelemetry = {
      userProvided: {
        expectedUsers: users,
        requestsPerSecond: profile.requestsPerSecond,
        peakRequestsPerSecond: profile.peakRequestsPerSecond,
        availabilityTarget: profile.availabilityTarget,
        geographicDistribution: profile.geographicDistribution,
        dataGrowth: profile.dataGrowth,
        trafficPattern: profile.trafficPattern,
      },
      calculatedAssumptions: {
        isUserRpsProvided,
        isUserPeakRpsProvided,
        effectiveRps,
        calculatedPeakRps: peakRps,
        burstMultiplier,
        availabilitySlaPercent: availabilitySlaPercent ?? 99.9,
        concurrentUserRatio,
      },
      recommendations: {
        computeTier: ec2Type,
        azureVmTier: azureVmSize,
        asgRange: [asgMin, asgDesired, asgMax],
        databaseTier: rdsClass,
        azureSqlTier: azureSqlSku,
        dbStorageGb: rdsStorage,
        multiAzRequired: rdsMultiAz,
        cachingRequired: requireCache,
        cdnRequired: requireCdn,
        wafRequired: requireWaf,
        readReplicas: rdsReadReplicas,
      },
    };

    return {
      nodes,
      edges,
      scaleProfile: {
        ...profile,
        expectedUsers: users,
        requestsPerSecond: rps,
        peakRequestsPerSecond: peakRps,
        availabilityTarget: availabilitySlaPercent ?? undefined,
        geographicDistribution,
        dataGrowth,
        trafficPattern,
      },
      appliedChanges,
      telemetry,
    };
  }

  public generateScalePlan(
    nodes: CanvasNode[],
    profile: ScaleProfile,
    provider: CloudProvider = 'aws'
  ) {
    const res = this.adaptArchitectureScale(nodes, [], profile);
    const tel = res.telemetry!;
    return {
      userInputs: tel.userProvided,
      assumptions: {
        effectiveRps: tel.calculatedAssumptions.effectiveRps,
        peakRps: tel.calculatedAssumptions.calculatedPeakRps,
        burstMultiplier: tel.calculatedAssumptions.burstMultiplier,
        concurrencyMultiplier: tel.calculatedAssumptions.concurrentUserRatio,
        explanation: res.appliedChanges.join('; '),
      },
      recommendations: res.nodes.map((n) => ({
        nodeId: n.id,
        recommendedConfig: n.config,
      })),
      appliedChanges: res.appliedChanges,
    };
  }
}

export const adaptiveScaleEngine = AdaptiveScaleEngine.getInstance();
