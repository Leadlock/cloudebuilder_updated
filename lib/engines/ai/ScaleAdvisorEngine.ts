/**
 * CloudBuilder — AI Scale Advisor & Workload Engine
 *
 * Interprets natural language architecture requirements, derives scale profiles,
 * and generates technically sound architectures through deterministic RDE validation.
 *
 * Architecture flow:
 * User Requirements -> AI Interpretation -> Scale Profile -> RDE ->
 * Canonical Graph -> Deterministic Validation -> Auto-Fix -> Canvas
 */

import { CanvasNode, CanvasEdge, CloudProvider, ScaleProfile, Region } from '@/types';
import { adaptiveScaleEngine } from '@/lib/engines/capacity/AdaptiveScaleEngine';
import { architectureAutoFixEngine } from '@/lib/engines/autofix/ArchitectureAutoFixEngine';
import { toCanonicalGraph, validateCanonicalArchitecture } from '@/lib/domain/canonicalArchitecture';

export interface ScaleRecommendation {
  scaleProfile: ScaleProfile;
  suggestedProvider: CloudProvider;
  suggestedRegion: Region;
  architectureSummary: string;
  rationale: string[];
  keyComponents: string[];
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  isValid: boolean;
}

export class ScaleAdvisorEngine {
  private static instance: ScaleAdvisorEngine;

  public static getInstance(): ScaleAdvisorEngine {
    if (!ScaleAdvisorEngine.instance) {
      ScaleAdvisorEngine.instance = new ScaleAdvisorEngine();
    }
    return ScaleAdvisorEngine.instance;
  }

  /**
   * Parses natural-language architecture intent and derives a complete, validated architecture.
   */
  public interpretRequirements(prompt: string, defaultProvider: CloudProvider = 'aws'): ScaleRecommendation {
    const lower = prompt.toLowerCase();

    // 1. Detect Scale / User Count
    // Try the precise numeric parse first (anchored to actual digits, not
    // loose substrings) so e.g. "25000 users" isn't misread as "500" just
    // because "500" happens to appear inside "25000".
    let expectedUsers = 10000;
    const userMatch = lower.match(/(\d+[\d,]*)\s*(k|m|million|thousand)?\s*(?:users|concurrent|visitors|clients|requests)/i) ||
                      lower.match(/(\d+)\s*(k|m)\b/i);

    if (userMatch) {
      const raw = parseInt(userMatch[1].replace(/,/g, ''), 10);
      const unit = (userMatch[2] || '').toLowerCase();
      if (!isNaN(raw)) {
        if (unit === 'm' || unit === 'million') expectedUsers = raw * 1000000;
        else if (unit === 'k' || unit === 'thousand') expectedUsers = raw * 1000;
        else expectedUsers = raw;
      }
    } else if (lower.includes('1m') || lower.includes('1 million') || lower.includes('million users')) {
      expectedUsers = 1000000;
    } else if (lower.includes('500k') || lower.includes('500,000')) {
      expectedUsers = 500000;
    } else if (lower.includes('250k') || lower.includes('250,000')) {
      expectedUsers = 250000;
    } else if (lower.includes('100k') || lower.includes('100,000')) {
      expectedUsers = 100000;
    } else if (lower.includes('50k') || lower.includes('50,000')) {
      expectedUsers = 50000;
    } else if (lower.includes('10k') || lower.includes('10,000')) {
      expectedUsers = 10000;
    } else if (lower.includes('5k') || lower.includes('5,000')) {
      expectedUsers = 5000;
    } else if (lower.includes('1k') || lower.includes('1,000')) {
      expectedUsers = 1000;
    } else if (lower.includes('500 users') || lower.includes('500')) {
      expectedUsers = 500;
    } else if (lower.includes('100 users') || lower.includes('starter') || lower.includes('hobby')) {
      expectedUsers = 100;
    }

    // 2. Detect Traffic Pattern
    let trafficPattern: ScaleProfile['trafficPattern'] = 'steady';
    if (lower.includes('weekend') || lower.includes('spiky') || lower.includes('burst') || lower.includes('flash sale') || lower.includes('black friday')) {
      trafficPattern = 'weekend-spikes';
    } else if (lower.includes('batch') || lower.includes('nightly') || lower.includes('etl')) {
      trafficPattern = 'batch';
    } else if (lower.includes('diurnal') || lower.includes('business hours') || lower.includes('daytime')) {
      trafficPattern = 'diurnal';
    }

    // 3. Availability Target
    let availabilityTarget = 99.9;
    if (lower.includes('99.99') || lower.includes('four nines') || lower.includes('mission critical') || lower.includes('disaster recovery') || lower.includes('financial')) {
      availabilityTarget = 99.99;
    } else if (lower.includes('internal') || lower.includes('dev') || lower.includes('test') || expectedUsers < 500) {
      availabilityTarget = 99.0;
    }

    // 4. Geographic Distribution
    let geographicDistribution: ScaleProfile['geographicDistribution'] = 'single-region';
    if (lower.includes('global') || lower.includes('worldwide') || lower.includes('latency-sensitive') || lower.includes('multi-region')) {
      geographicDistribution = 'global';
    } else if (expectedUsers >= 100000 || lower.includes('cross-region')) {
      geographicDistribution = 'multi-region';
    }

    // 5. Provider Selection
    let provider: CloudProvider = defaultProvider;
    if (lower.includes('aws and azure') || lower.includes('azure and aws') || lower.includes('multi-cloud') || lower.includes('hybrid')) {
      provider = 'multi';
    } else if (lower.includes('azure') && !lower.includes('aws')) {
      provider = 'azure';
    } else if (lower.includes('aws') && !lower.includes('azure')) {
      provider = 'aws';
    }

    // 6. Region Selection
    let region: Region = provider === 'azure' ? 'eastus' : 'us-east-1';
    if (lower.includes('europe') || lower.includes('frankfurt') || lower.includes('ireland')) {
      region = provider === 'azure' ? 'westeurope' : 'eu-central-1';
    } else if (lower.includes('asia') || lower.includes('tokyo') || lower.includes('singapore') || lower.includes('mumbai')) {
      region = provider === 'azure' ? 'japaneast' : 'ap-southeast-1';
    }

    const rps = Math.max(10, Math.round(expectedUsers * 0.12));
    const peakRps = Math.max(25, Math.round(rps * (trafficPattern === 'weekend-spikes' ? 3.5 : 2.2)));

    const scaleProfile: ScaleProfile = {
      expectedUsers,
      requestsPerSecond: rps,
      peakRequestsPerSecond: peakRps,
      availabilityTarget,
      geographicDistribution,
      dataGrowth: expectedUsers > 50000 ? 'high' : 'moderate',
      trafficPattern,
    };

    // 7. Synthesize Base Architecture Topology based on Cloud Provider
    const { nodes: baseNodes, edges: baseEdges, keyComponents, rationale } = this.buildBaseTopology(provider, region, scaleProfile);

    // 8. Deterministic Adaptive Scaling Pass
    const scaled = adaptiveScaleEngine.adaptArchitectureScale(baseNodes, baseEdges, scaleProfile);

    // 9. Deterministic Auto-Fix and Validation Pass
    const repaired = architectureAutoFixEngine.repairArchitecture(scaled.nodes, scaled.edges);

    // 10. Canonical Graph Validation
    const graph = toCanonicalGraph(repaired.nodes, repaired.edges, {
      provider,
      region,
      scaleProfile,
    });
    const report = validateCanonicalArchitecture(graph);

    return {
      scaleProfile,
      suggestedProvider: provider,
      suggestedRegion: region,
      architectureSummary: `Engineered for ${expectedUsers.toLocaleString()} users (${rps.toLocaleString()} avg RPS / ${peakRps.toLocaleString()} peak RPS) targeting ${availabilityTarget}% SLA with ${trafficPattern} traffic profiling.`,
      rationale: [...rationale, ...scaled.appliedChanges],
      keyComponents,
      nodes: repaired.nodes,
      edges: repaired.edges,
      isValid: report.isValid,
    };
  }

  private buildBaseTopology(
    provider: CloudProvider,
    region: Region,
    profile: ScaleProfile
  ): { nodes: CanvasNode[]; edges: CanvasEdge[]; keyComponents: string[]; rationale: string[] } {
    const nodes: CanvasNode[] = [];
    const edges: CanvasEdge[] = [];
    const keyComponents: string[] = [];
    const rationale: string[] = [];

    const isMulti = provider === 'multi';
    const hasAws = provider === 'aws' || isMulti;
    const hasAzure = provider === 'azure' || isMulti;

    if (hasAws) {
      const vpcId = `aws-vpc-${Date.now()}`;
      const pubSubnetId = `aws-pub-sub-${Date.now()}`;
      const appSubnetId = `aws-app-sub-${Date.now()}`;
      const dbSubnetId = `aws-db-sub-${Date.now()}`;

      // AWS Boundary & Containers
      nodes.push({
        id: 'aws-cloud',
        type: 'containerNode',
        resourceType: 'aws_cloud_boundary',
        provider: 'aws',
        label: `Amazon Web Services (${region})`,
        position: { x: 30, y: 20 },
        config: { region },
        width: isMulti ? 840 : 1080,
        height: 720,
      });

      nodes.push({
        id: vpcId,
        type: 'containerNode',
        resourceType: 'aws_vpc',
        provider: 'aws',
        label: 'Production VPC (10.0.0.0/16)',
        parentId: 'aws-cloud',
        groupId: 'aws-cloud',
        position: { x: 60, y: 110 },
        config: { cidrBlock: '10.0.0.0/16', name: 'prod-vpc', enableDnsSupport: true, enableDnsHostnames: true },
        width: isMulti ? 780 : 1020,
        height: 590,
      });

      nodes.push({
        id: pubSubnetId,
        type: 'containerNode',
        resourceType: 'aws_subnet',
        provider: 'aws',
        label: 'Public Ingress Subnet (10.0.1.0/24)',
        parentId: vpcId,
        groupId: vpcId,
        position: { x: 90, y: 170 },
        config: { cidrBlock: '10.0.1.0/24', mapPublicIpOnLaunch: true },
        width: 380,
        height: 200,
      });

      nodes.push({
        id: appSubnetId,
        type: 'containerNode',
        resourceType: 'aws_subnet',
        provider: 'aws',
        label: 'Private App Subnet (10.0.10.0/24)',
        parentId: vpcId,
        groupId: vpcId,
        position: { x: 500, y: 170 },
        config: { cidrBlock: '10.0.10.0/24', mapPublicIpOnLaunch: false },
        width: 380,
        height: 200,
      });

      nodes.push({
        id: dbSubnetId,
        type: 'containerNode',
        resourceType: 'aws_subnet',
        provider: 'aws',
        label: 'Private Database Subnet (10.0.20.0/24)',
        parentId: vpcId,
        groupId: vpcId,
        position: { x: 500, y: 400 },
        config: { cidrBlock: '10.0.20.0/24', mapPublicIpOnLaunch: false },
        width: 380,
        height: 220,
      });

      // Workload instances
      const albId = `alb-${Date.now()}`;
      const ec2Id = `ec2-${Date.now()}`;
      const rdsId = `rds-${Date.now()}`;

      nodes.push({
        id: albId,
        type: 'cloudNode',
        resourceType: 'aws_alb',
        provider: 'aws',
        label: 'Application Load Balancer',
        parentId: pubSubnetId,
        groupId: pubSubnetId,
        position: { x: 120, y: 220 },
        config: { name: 'prod-alb', scheme: 'internet-facing' },
      });

      nodes.push({
        id: ec2Id,
        type: 'cloudNode',
        resourceType: 'aws_ec2',
        provider: 'aws',
        label: 'Web/API Compute Fleet',
        parentId: appSubnetId,
        groupId: appSubnetId,
        position: { x: 530, y: 220 },
        config: { instanceType: 't4g.medium', name: 'app-service' },
      });

      nodes.push({
        id: rdsId,
        type: 'cloudNode',
        resourceType: 'aws_rds',
        provider: 'aws',
        label: 'PostgreSQL Primary DB',
        parentId: dbSubnetId,
        groupId: dbSubnetId,
        position: { x: 530, y: 460 },
        config: { engine: 'postgres', instanceClass: 'db.t4g.medium', multiAz: profile.expectedUsers > 1000 },
      });

      // Connections
      edges.push({
        id: `${albId}:loadbalances:${ec2Id}`,
        source: albId,
        target: ec2Id,
        relationshipType: 'LOAD_BALANCES',
        protocol: 'HTTP',
        port: 80,
        direction: 'unidirectional',
        label: 'Distributes Traffic',
      });

      edges.push({
        id: `${ec2Id}:db:${rdsId}`,
        source: ec2Id,
        target: rdsId,
        relationshipType: 'DATABASE_CONNECTION',
        protocol: 'PostgreSQL',
        port: 5432,
        direction: 'unidirectional',
        label: 'Queries / Writes',
      });

      keyComponents.push('AWS VPC with Multi-Tier Subnet Isolation (Public, App, DB)');
      keyComponents.push('Application Load Balancer with Automated Health Checks');
      keyComponents.push('Compute Cluster sized for target concurrent load');
      keyComponents.push('Managed RDS PostgreSQL with Automated Storage Scaling');
      rationale.push('3-tier network topology enforces zero-trust database subnet isolation from the public Internet.');
    }

    if (hasAzure) {
      const azOffset = isMulti ? 920 : 30;
      const vnetId = `az-vnet-${Date.now()}`;
      const appSubId = `az-app-sub-${Date.now()}`;
      const dbSubId = `az-db-sub-${Date.now()}`;

      nodes.push({
        id: 'az-cloud',
        type: 'containerNode',
        resourceType: 'azure_cloud_boundary',
        provider: 'azure',
        label: `Microsoft Azure (${isMulti ? 'eastus' : region})`,
        position: { x: azOffset, y: 20 },
        config: { region: isMulti ? 'eastus' : region },
        width: 840,
        height: 720,
      });

      nodes.push({
        id: vnetId,
        type: 'containerNode',
        resourceType: 'azure_vnet',
        provider: 'azure',
        label: 'Azure Virtual Network (10.1.0.0/16)',
        parentId: 'az-cloud',
        groupId: 'az-cloud',
        position: { x: azOffset + 30, y: 110 },
        config: { addressSpace: '10.1.0.0/16', name: 'prod-vnet' },
        width: 780,
        height: 590,
      });

      nodes.push({
        id: appSubId,
        type: 'containerNode',
        resourceType: 'azure_subnet',
        provider: 'azure',
        label: 'Workload Subnet (10.1.1.0/24)',
        parentId: vnetId,
        groupId: vnetId,
        position: { x: azOffset + 60, y: 170 },
        config: { addressPrefix: '10.1.1.0/24' },
        width: 340,
        height: 200,
      });

      nodes.push({
        id: dbSubId,
        type: 'containerNode',
        resourceType: 'azure_subnet',
        provider: 'azure',
        label: 'Azure SQL Subnet (10.1.2.0/24)',
        parentId: vnetId,
        groupId: vnetId,
        position: { x: azOffset + 430, y: 170 },
        config: { addressPrefix: '10.1.2.0/24' },
        width: 340,
        height: 200,
      });

      const vmId = `az-vm-${Date.now()}`;
      const sqlId = `az-sql-${Date.now()}`;

      nodes.push({
        id: vmId,
        type: 'cloudNode',
        resourceType: 'azure_vm',
        provider: 'azure',
        label: 'Azure VM Workload',
        parentId: appSubId,
        groupId: appSubId,
        position: { x: azOffset + 90, y: 220 },
        config: { vmSize: 'Standard_B2s', name: 'az-vm-1' },
      });

      nodes.push({
        id: sqlId,
        type: 'cloudNode',
        resourceType: 'azure_sql',
        provider: 'azure',
        label: 'Azure SQL Database',
        parentId: dbSubId,
        groupId: dbSubId,
        position: { x: azOffset + 460, y: 220 },
        config: { sku: 'GP_Gen5_2', name: 'az-sql-prod' },
      });

      edges.push({
        id: `${vmId}:sql:${sqlId}`,
        source: vmId,
        target: sqlId,
        relationshipType: 'DATABASE_CONNECTION',
        protocol: 'TDS / SQL',
        port: 1433,
        direction: 'unidirectional',
        label: 'Encrypted SQL Link',
      });

      keyComponents.push('Azure Virtual Network and Managed Workload Subnets');
      keyComponents.push('Azure SQL Database Tier with Automated Backups');
    }

    if (isMulti) {
      // Connect cross-cloud interconnect
      const awsAlb = nodes.find((n) => n.resourceType === 'aws_alb');
      const azVm = nodes.find((n) => n.resourceType === 'azure_vm');
      if (awsAlb && azVm) {
        edges.push({
          id: `${awsAlb.id}:cross-cloud:${azVm.id}`,
          source: awsAlb.id,
          target: azVm.id,
          relationshipType: 'CONNECTS_TO',
          networkScope: 'cross-cloud',
          protocol: 'VPN / HTTPS',
          port: 443,
          direction: 'bidirectional',
          label: 'Cross-Cloud Disaster Recovery Interconnect',
        });
      }
      keyComponents.push('Multi-Cloud Cross-Provider Secure Bridge');
      rationale.push('Multi-cloud layout partitions AWS primary compute from Azure secondary with dedicated secure interconnect.');
    }

    return { nodes, edges, keyComponents, rationale };
  }
}

export const scaleAdvisorEngine = ScaleAdvisorEngine.getInstance();
