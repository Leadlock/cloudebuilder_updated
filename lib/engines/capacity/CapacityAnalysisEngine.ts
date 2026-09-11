/**
 * Architecture Capacity Analysis Engine
 *
 * Estimates throughput and concurrent user capacity based on real workload characteristics:
 * - Application tier throughput (vCPU, memory, instance counts, auto-scaling)
 * - Database connection pools and IOPS throughput
 * - Cache offloading efficiency (Redis caching 70-80% of read traffic)
 * - CDN edge offloading (CloudFront / Front Door absorbing 85%+ static traffic)
 *
 * Explicitly exposes all assumptions under "Architecture capacity estimate".
 */

import { CanvasNode, CapacityEstimate, WorkloadProfile } from '@/types';

export const DEFAULT_WORKLOAD_PROFILE: WorkloadProfile = {
  targetConcurrentUsers: 1000,
  targetRequestsPerSec: 100, // Avg 10 requests/min per active user = 100 RPS
  readWriteRatio: { read: 80, write: 20 },
  availabilityTarget: 99.99,
  environment: 'production',
  workloadType: 'web',
  expectedDataSizeGb: 100,
  storageRequirements: 'General Purpose SSD (gp3) + Object Storage',
  region: 'us-east-1',
};

export class CapacityAnalysisEngine {
  private static instance: CapacityAnalysisEngine;

  public static getInstance(): CapacityAnalysisEngine {
    if (!CapacityAnalysisEngine.instance) {
      CapacityAnalysisEngine.instance = new CapacityAnalysisEngine();
    }
    return CapacityAnalysisEngine.instance;
  }

  public analyzeCapacity(
    nodes: CanvasNode[],
    profile: WorkloadProfile = DEFAULT_WORKLOAD_PROFILE
  ): CapacityEstimate {
    const targetUsers = profile.targetConcurrentUsers || 1000;
    const targetRps = profile.targetRequestsPerSec || Math.round(targetUsers * 0.1);

    // ── 1. Calculate App Tier Throughput ─────────────────────────────────────
    let totalVcpu = 0;
    let appInstanceCount = 0;
    let isAutoscaling = false;

    for (const node of nodes) {
      if (node.resourceType === 'aws_ec2' || node.resourceType === 'azure_vm') {
        appInstanceCount++;
        const instType = (node.config?.instanceType as string) || (node.config?.size as string) || '';
        if (instType.includes('xlarge') || instType.includes('4ms') || instType.includes('D4s')) totalVcpu += 4;
        else if (instType.includes('large') || instType.includes('2s') || instType.includes('B2s')) totalVcpu += 2;
        else if (instType.includes('medium')) totalVcpu += 2;
        else totalVcpu += 1;
      } else if (node.resourceType === 'aws_auto_scaling' || node.resourceType === 'azure_vmss') {
        isAutoscaling = true;
        const maxCapacity = Number(node.config?.maxSize || node.config?.capacity || 4);
        appInstanceCount += maxCapacity;
        totalVcpu += maxCapacity * 2; // Default 2 vCPU per worker
      } else if (node.resourceType === 'aws_ecs' || node.resourceType === 'azure_aks') {
        const tasks = Number(node.config?.desiredCount || node.config?.nodeCount || 3);
        appInstanceCount += tasks;
        totalVcpu += tasks * 2;
      }
    }

    // Baseline: 1 vCPU serves ~50-75 dynamic requests/sec with healthy headroom (<65% CPU)
    const rawAppRps = Math.max(20, totalVcpu * 60);

    // ── 2. Calculate Database Capacity ──────────────────────────────────────
    let dbInstanceCount = 0;
    let isMultiAzDb = false;
    let dbVcpu = 1;

    for (const node of nodes) {
      if (node.resourceType === 'aws_rds' || node.resourceType === 'azure_sql') {
        dbInstanceCount++;
        if (node.config?.multiAz === true || (node.config?.tier as string)?.includes('Business')) {
          isMultiAzDb = true;
        }
        const instClass = (node.config?.instanceClass as string) || '';
        if (instClass.includes('large')) dbVcpu = 4;
        else if (instClass.includes('medium')) dbVcpu = 2;
        else dbVcpu = 1;
      }
    }

    // Baseline RDS throughput: 1 dbVcpu serves ~120 IOPS / transactional queries per second
    const rawDbRps = Math.max(30, dbVcpu * 120);

    // ── 3. Caching & CDN Efficiency ─────────────────────────────────────────
    const hasRedis = nodes.some(
      (n) => n.resourceType === 'aws_elasticache' || n.resourceType === 'azure_redis'
    );
    const hasCdn = nodes.some(
      (n) => n.resourceType === 'aws_cloudfront' || n.resourceType === 'azure_front_door'
    );
    const hasAlb = nodes.some(
      (n) => n.resourceType === 'aws_alb' || n.resourceType === 'azure_app_gateway' || n.resourceType === 'azure_lb'
    );

    // CDN offloads ~85% of edge asset and SSL negotiation
    const cdnOffloadRatio = hasCdn ? 0.85 : 0.0;

    // Cache absorbs 75% of read queries
    const cacheHitRatio = hasRedis ? 0.75 : 0.0;

    // Effective database load is reduced by caching
    const effectiveDbRps = hasRedis
      ? rawDbRps / (1 - (profile.readWriteRatio.read / 100) * cacheHitRatio)
      : rawDbRps;

    // Effective application throughput: with load balancer & multi-AZ distribution
    const loadBalancerMultiplier = hasAlb ? 1.2 : 0.8;
    const effectiveAppRps = Math.round(rawAppRps * loadBalancerMultiplier);

    // System capacity is constrained by the lowest bottleneck tier
    const systemMaxRps = Math.min(effectiveAppRps, Math.round(effectiveDbRps));

    // Calculate supported concurrent users (10 user requests per minute avg = 0.1 RPS per user)
    // 1 user = 0.1 RPS -> Users = RPS * 10
    const calculatedCapacityUsers = Math.round(systemMaxRps * 10);
    const capacityBufferRatio = Number((calculatedCapacityUsers / Math.max(1, targetUsers)).toFixed(2));

    const bottlenecks: string[] = [];
    if (effectiveAppRps < targetRps) {
      bottlenecks.push(`Compute Tier (${effectiveAppRps} RPS supported vs ${targetRps} RPS required)`);
    }
    if (effectiveDbRps < targetRps) {
      bottlenecks.push(`Database Tier (${Math.round(effectiveDbRps)} RPS supported vs ${targetRps} RPS required)`);
    }
    if (!hasRedis && targetUsers >= 1000) {
      bottlenecks.push('Lack of In-Memory Caching (direct database query pressure under peak loads)');
    }
    if (!hasAlb && appInstanceCount > 1) {
      bottlenecks.push('Missing Load Balancer (traffic cannot be balanced across instances)');
    }

    const assumptions: string[] = [
      `Workload model: ${targetUsers} concurrent users averaging 0.1 req/sec each (~${targetRps} RPS total load).`,
      `Read/Write traffic mix: ${profile.readWriteRatio.read}% reads, ${profile.readWriteRatio.write}% writes.`,
      `Compute tier: ${appInstanceCount} application node(s) across ${totalVcpu} vCPUs with ${isAutoscaling ? 'elastic auto-scaling enabled' : 'fixed capacity'}.`,
      hasRedis
        ? `In-memory caching enabled (est. ${Math.round(cacheHitRatio * 100)}% cache hit ratio offloading DB queries).`
        : 'No caching layer: 100% of read operations hit the database.',
      hasCdn
        ? `Edge CDN enabled (est. ${Math.round(cdnOffloadRatio * 100)}% static and TLS offload).`
        : 'Origin servers serve static assets and terminate TLS directly.',
      isMultiAzDb
        ? 'Database has Multi-AZ standby replica with automatic failover.'
        : 'Database is single-AZ without synchronous standby replica.',
    ];

    const scalingStrategy = isAutoscaling
      ? 'Dynamic Horizontal Auto Scaling based on CPU/RequestCount metrics'
      : appInstanceCount >= 2
      ? 'Static N+1 instance redundancy behind Load Balancer'
      : 'Single instance (Non-redundant, manual scaling only)';

    const redundancyStrategy = isMultiAzDb
      ? 'Active-Standby Multi-AZ database failover with multi-zone compute'
      : 'Single-AZ (vulnerable to zone-level disruption)';

    // Verify whether architecture meets 1,000 target with at least a 1.25x - 1.5x buffer
    const isAdequate = calculatedCapacityUsers >= targetUsers * 1.25 && bottlenecks.length === 0;

    return {
      targetConcurrentUsers: targetUsers,
      calculatedCapacityUsers,
      capacityBufferRatio,
      estimatedRps: targetRps,
      appTierCapacityRps: effectiveAppRps,
      dbTierCapacityRps: Math.round(effectiveDbRps),
      cacheHitRatio,
      cdnOffloadRatio,
      isAdequate,
      bottlenecks,
      assumptions,
      scalingStrategy,
      redundancyStrategy,
    };
  }
}

export const capacityAnalysisEngine = CapacityAnalysisEngine.getInstance();
