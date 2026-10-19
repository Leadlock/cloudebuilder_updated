/**
 * Centralized Architecture Validator
 *
 * The core validation and quality analysis engine for CloudBuilder.
 * Evaluates structural integrity, cloud networking, availability SPOFs,
 * security postures, scalability limits, and deployment safety.
 *
 * Generates deterministic architecture quality scores based on real findings.
 */

import { CanvasNode, CanvasEdge } from '@/types';
import { getResourceDefinition } from '@/lib/resources';
import { networkPathValidator, NetworkFinding } from './NetworkPathValidator';
import { relationshipEngine } from '../relationship/RelationshipEngine';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type FindingPillar =
  | 'structural'
  | 'networking'
  | 'availability'
  | 'security'
  | 'scalability'
  | 'performance'
  | 'cloud-correctness'
  | 'deployment-safety';

export interface ArchitectureFinding {
  id: string;
  pillar: FindingPillar;
  severity: FindingSeverity;
  title: string;
  description: string;
  affectedNodeIds: string[];
  affectedNodeLabels: string[];
  rationale: string;
  suggestedAction: string;
  autoFixAvailable?: boolean;
}

export interface ArchitectureQualityScore {
  overall: number;          // 0 - 100
  reliability: number;      // 0 - 100
  security: number;         // 0 - 100
  performance: number;      // 0 - 100
  cost: number;             // 0 - 100
  scalability: number;      // 0 - 100
  networkCorrectness: number; // 0 - 100
}

export interface ArchitectureValidationReport {
  isValid: boolean;
  score: ArchitectureQualityScore;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  findings: ArchitectureFinding[];
  summary: string;
}

export class ArchitectureValidator {
  private static instance: ArchitectureValidator;

  public static getInstance(): ArchitectureValidator {
    if (!ArchitectureValidator.instance) {
      ArchitectureValidator.instance = new ArchitectureValidator();
    }
    return ArchitectureValidator.instance;
  }

  public validate(nodes: CanvasNode[], edges: CanvasEdge[]): ArchitectureValidationReport {
    const findings: ArchitectureFinding[] = [];

    if (nodes.length === 0) {
      return {
        isValid: true,
        score: {
          overall: 100,
          reliability: 100,
          security: 100,
          performance: 100,
          cost: 100,
          scalability: 100,
          networkCorrectness: 100,
        },
        criticalCount: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
        findings: [],
        summary: 'Architecture canvas is empty.',
      };
    }

    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    // ── 1. Structural Integrity ─────────────────────────────────────────────
    for (const node of nodes) {
      // Check invalid groupId / parentId
      if (node.groupId && !nodeMap.has(node.groupId)) {
        findings.push({
          id: `struct-orphan-group-${node.id}`,
          pillar: 'structural',
          severity: 'high',
          title: `Broken Container Link on "${node.label}"`,
          description: `Resource references container ID "${node.groupId}" which does not exist on the canvas.`,
          affectedNodeIds: [node.id],
          affectedNodeLabels: [node.label],
          rationale: 'Dangling container pointers cause deployment graph failures in Terraform and incorrect subnet placement.',
          suggestedAction: 'Move the resource into an active container or un-parent it.',
        });
      }

      // Check Cross-Provider Containment
      if (node.groupId && nodeMap.has(node.groupId)) {
        const parent = nodeMap.get(node.groupId)!;
        const nodeProvider = node.provider ?? (node.resourceType.startsWith('azure_') ? 'azure' : 'aws');
        const parentProvider = parent.provider ?? (parent.resourceType.startsWith('azure_') ? 'azure' : 'aws');

        if (nodeProvider !== parentProvider) {
          findings.push({
            id: `struct-cross-provider-containment-${node.id}`,
            pillar: 'cloud-correctness',
            severity: 'critical',
            title: `Illegal Cross-Provider Containment`,
            description: `${nodeProvider.toUpperCase()} resource "${node.label}" cannot be placed inside ${parentProvider.toUpperCase()} container "${parent.label}".`,
            affectedNodeIds: [node.id, parent.id],
            affectedNodeLabels: [node.label, parent.label],
            rationale: 'Cloud infrastructures are physically isolated; an AWS resource cannot execute within an Azure Virtual Network or Resource Group.',
            suggestedAction: `Relocate "${node.label}" to an appropriate ${nodeProvider.toUpperCase()} container.`,
          });
        }
      }
    }

    // ── 2. Networking & Topology Validation ─────────────────────────────────
    const netReport = networkPathValidator.validate(nodes, edges);
    for (const netFind of netReport.findings) {
      findings.push({
        id: netFind.id,
        pillar: 'networking',
        severity: netFind.severity,
        title: netFind.title,
        description: netFind.message,
        affectedNodeIds: netFind.affectedNodeIds,
        affectedNodeLabels: netFind.affectedNodeIds.map((id) => nodeMap.get(id)?.label || id),
        rationale: 'Technical cloud networking requires compliant ingress/egress path continuity.',
        suggestedAction: netFind.recommendation,
      });
    }

    // Validate all existing edges with relationshipEngine
    for (const edge of edges) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (source && target) {
        const connResult = relationshipEngine.validateConnection(source, target, nodes, edges);
        if (!connResult.isValid && connResult.error) {
          findings.push({
            id: `rel-invalid-edge-${edge.id}`,
            pillar: 'networking',
            severity: 'critical',
            title: `Invalid Relationship: ${source.label} → ${target.label}`,
            description: connResult.error.message,
            affectedNodeIds: [source.id, target.id],
            affectedNodeLabels: [source.label, target.label],
            rationale: connResult.error.technicalReason,
            suggestedAction: connResult.error.suggestedAlternatives[0] || 'Remove or rewire this connection.',
          });
        }
      }
    }

    // ── 3. Availability & Single Points of Failure (SPOF) ────────────────────
    const ec2Nodes = nodes.filter((n) => n.resourceType === 'aws_ec2');
    const vmNodes = nodes.filter((n) => n.resourceType === 'azure_vm');
    const rdsNodes = nodes.filter((n) => n.resourceType === 'aws_rds');
    const sqlNodes = nodes.filter((n) => n.resourceType === 'azure_sql');
    const albNodes = nodes.filter((n) => n.resourceType === 'aws_alb' || n.resourceType === 'azure_lb' || n.resourceType === 'azure_app_gateway');
    const asgNodes = nodes.filter((n) => n.resourceType === 'aws_auto_scaling' || n.resourceType === 'azure_vmss');

    // SPOF 1: Single application instance
    const totalAppCompute = ec2Nodes.length + vmNodes.length + asgNodes.length;
    if (totalAppCompute === 1 && asgNodes.length === 0) {
      const singleNode = ec2Nodes[0] || vmNodes[0];
      findings.push({
        id: 'spof-single-compute-instance',
        pillar: 'availability',
        severity: 'critical',
        title: `Single Point of Failure: Single Application Server (${singleNode.label})`,
        description: 'The application relies on a single compute instance without redundancy. A crash, hardware failure, or host maintenance will cause complete downtime.',
        affectedNodeIds: [singleNode.id],
        affectedNodeLabels: [singleNode.label],
        rationale: 'Production workloads must use multiple instances behind a load balancer or an Auto Scaling Group across multiple Availability Zones.',
        suggestedAction: 'Add an Auto Scaling Group or deploy at least two application server instances across distinct Availability Zones.',
      });
    }

    // SPOF 2: RDS without Multi-AZ
    for (const rds of rdsNodes) {
      if (rds.config?.multiAz !== true) {
        findings.push({
          id: `spof-rds-no-multiaz-${rds.id}`,
          pillar: 'availability',
          severity: 'high',
          title: `Single Point of Failure: RDS "${rds.label}" without Multi-AZ`,
          description: 'The RDS database instance is running as a single standalone node without synchronous Multi-AZ standby replication.',
          affectedNodeIds: [rds.id],
          affectedNodeLabels: [rds.label],
          rationale: 'In single-AZ RDS, storage failure or instance disruption requires manual restore with elevated RTO and RPO.',
          suggestedAction: 'Enable Multi-AZ in the RDS configuration for automatic failover with zero manual intervention.',
        });
      }
    }

    // SPOF 3: Azure SQL without High Availability / Zone Redundancy
    for (const sql of sqlNodes) {
      const tier = (sql.config?.tier as string) || 'Standard';
      if (tier === 'Basic' || tier === 'Standard') {
        findings.push({
          id: `spof-azure-sql-tier-${sql.id}`,
          pillar: 'availability',
          severity: 'medium',
          title: `Azure SQL "${sql.label}" on Non-HA Tier (${tier})`,
          description: `Azure SQL database is on the ${tier} tier, which lacks automatic zone-redundant replicas.`,
          affectedNodeIds: [sql.id],
          affectedNodeLabels: [sql.label],
          rationale: 'Zone-redundant high availability on Azure SQL requires General Purpose or Business Critical tier with zone redundancy enabled.',
          suggestedAction: 'Upgrade Azure SQL tier to General Purpose or Business Critical with Zone Redundancy enabled.',
        });
      }
    }

    // SPOF 4: Compute instances without a Load Balancer
    if (totalAppCompute > 0 && albNodes.length === 0) {
      findings.push({
        id: 'spof-missing-load-balancer',
        pillar: 'availability',
        severity: 'high',
        title: 'Compute Tier Lacks Load Balancer',
        description: `${totalAppCompute} compute instance(s) detected without an Application Load Balancer. Traffic cannot be distributed automatically.`,
        affectedNodeIds: [...ec2Nodes, ...vmNodes].map((n) => n.id),
        affectedNodeLabels: [...ec2Nodes, ...vmNodes].map((n) => n.label),
        rationale: 'A load balancer performs health checks, removes unhealthy instances, and handles TLS termination.',
        suggestedAction: 'Place an Application Load Balancer in front of the compute tier.',
      });
    }

    // ── 4. Security & Compliance ────────────────────────────────────────────
    for (const node of nodes) {
      const cfg = node.config || {};

      // Open SSH / RDP
      if (node.resourceType === 'aws_sg' && cfg.allowSsh === true) {
        findings.push({
          id: `sec-sg-open-ssh-${node.id}`,
          pillar: 'security',
          severity: 'critical',
          title: `Security Group Allows Unrestricted Inbound SSH (0.0.0.0/0)`,
          description: `"${node.label}" has inbound port 22 open to the entire internet.`,
          affectedNodeIds: [node.id],
          affectedNodeLabels: [node.label],
          rationale: 'Exposing port 22 to the public internet attracts automated brute-force attacks and vulnerability exploitation.',
          suggestedAction: 'Disable allowSsh on the security group and utilize AWS SSM Session Manager.',
        });
      }

      if (node.resourceType === 'azure_nsg' && (cfg.allowSsh === true || cfg.allowRdp === true)) {
        findings.push({
          id: `sec-nsg-open-mgmt-${node.id}`,
          pillar: 'security',
          severity: 'critical',
          title: `NSG Allows Public Remote Management Access`,
          description: `"${node.label}" has inbound SSH or RDP exposed publicly.`,
          affectedNodeIds: [node.id],
          affectedNodeLabels: [node.label],
          rationale: 'Administrative ports should never be exposed to public CIDRs.',
          suggestedAction: 'Disable public SSH/RDP rules and use Azure Bastion.',
        });
      }

      // S3 Public Access
      if (node.resourceType === 'aws_s3' && cfg.publicAccess === true) {
        findings.push({
          id: `sec-s3-public-${node.id}`,
          pillar: 'security',
          severity: 'high',
          title: `S3 Bucket "${node.label}" Has Public Access Enabled`,
          description: 'S3 public access block is disabled, exposing stored data to public reads.',
          affectedNodeIds: [node.id],
          affectedNodeLabels: [node.label],
          rationale: 'Unless hosting a public static website, S3 buckets must block all public ACLs and policies.',
          suggestedAction: 'Enable Block Public Access on the S3 bucket.',
        });
      }

      // Unencrypted Storage
      if (node.resourceType === 'aws_s3' && cfg.encryption === false) {
        findings.push({
          id: `sec-s3-unencrypted-${node.id}`,
          pillar: 'security',
          severity: 'high',
          title: `S3 Bucket "${node.label}" Not Encrypted at Rest`,
          description: 'Server-side encryption is disabled on this storage bucket.',
          affectedNodeIds: [node.id],
          affectedNodeLabels: [node.label],
          rationale: 'All production cloud storage must enforce AES-256 or KMS encryption for compliance.',
          suggestedAction: 'Enable default SSE-S3 or SSE-KMS encryption on the bucket.',
        });
      }

      if (node.resourceType === 'aws_rds' && cfg.encrypted === false) {
        findings.push({
          id: `sec-rds-unencrypted-${node.id}`,
          pillar: 'security',
          severity: 'high',
          title: `RDS Instance "${node.label}" Storage Unencrypted`,
          description: 'Database storage encryption is disabled.',
          affectedNodeIds: [node.id],
          affectedNodeLabels: [node.label],
          rationale: 'Databases contain sensitive application state and customer data that must be encrypted at rest.',
          suggestedAction: 'Enable storage encryption in RDS configuration.',
        });
      }
    }

    // Check for missing WAF on public web apps
    const hasPublicIngress = nodes.some((n) => n.resourceType === 'aws_cloudfront' || n.resourceType === 'azure_front_door' || n.resourceType === 'aws_alb');
    const hasWaf = nodes.some((n) => n.resourceType === 'aws_waf' || n.resourceType === 'azure_waf');
    if (hasPublicIngress && !hasWaf) {
      findings.push({
        id: 'sec-missing-waf',
        pillar: 'security',
        severity: 'medium',
        title: 'Missing Web Application Firewall (WAF)',
        description: 'Public-facing web ingress is exposed to internet traffic without a Web Application Firewall.',
        affectedNodeIds: [],
        affectedNodeLabels: [],
        rationale: 'A WAF protects against Layer 7 attacks, OWASP Top 10 exploits, DDoS floods, and bot traffic.',
        suggestedAction: 'Associate AWS WAF or Azure WAF with the load balancer / CDN distribution.',
      });
    }

    // ── 5. Scalability & 1,000-User Readiness ────────────────────────────────
    const hasAsg = nodes.some((n) => n.resourceType === 'aws_auto_scaling' || n.resourceType === 'azure_vmss');
    const hasCache = nodes.some((n) => n.resourceType === 'aws_elasticache' || n.resourceType === 'azure_redis');
    const hasCdn = nodes.some((n) => n.resourceType === 'aws_cloudfront' || n.resourceType === 'azure_front_door');

    if (!hasAsg && totalAppCompute > 0) {
      findings.push({
        id: 'scale-missing-asg',
        pillar: 'scalability',
        severity: 'medium',
        title: 'Fixed Compute Capacity (Auto Scaling Recommended)',
        description: 'The application uses statically provisioned instances rather than an Auto Scaling Group or Virtual Machine Scale Set.',
        affectedNodeIds: [...ec2Nodes, ...vmNodes].map((n) => n.id),
        affectedNodeLabels: [...ec2Nodes, ...vmNodes].map((n) => n.label),
        rationale: 'Targeting 1,000 concurrent users requires elastic auto-scaling to absorb traffic spikes without manual intervention.',
        suggestedAction: 'Transition static compute instances into an Auto Scaling Group (EC2) or VM Scale Set (Azure).',
      });
    }

    if (!hasCache && (rdsNodes.length > 0 || sqlNodes.length > 0)) {
      findings.push({
        id: 'scale-missing-cache',
        pillar: 'scalability',
        severity: 'low',
        title: 'No In-Memory Caching Layer Detected',
        description: 'Architecture routes all read traffic directly to relational database storage without an in-memory cache.',
        affectedNodeIds: [...rdsNodes, ...sqlNodes].map((n) => n.id),
        affectedNodeLabels: [...rdsNodes, ...sqlNodes].map((n) => n.label),
        rationale: 'An in-memory Redis cache offloads 70-80% of repetitive read queries, dramatically improving response times for 1,000+ user workloads.',
        suggestedAction: 'Add ElastiCache Redis or Azure Cache for Redis to cache frequent read queries and user sessions.',
      });
    }

    if (!hasCdn && hasPublicIngress) {
      findings.push({
        id: 'scale-missing-cdn',
        pillar: 'performance',
        severity: 'low',
        title: 'No Global CDN Distribution',
        description: 'Static and cacheable content is served directly from origin servers instead of an edge CDN.',
        affectedNodeIds: [],
        affectedNodeLabels: [],
        rationale: 'A CDN (CloudFront / Azure Front Door) terminates SSL close to users and offloads 85%+ of asset requests from web servers.',
        suggestedAction: 'Place CloudFront or Azure Front Door in front of the Application Load Balancer and object storage.',
      });
    }

    // ── 6. Deterministic Score Calculation ──────────────────────────────────
    let critCount = 0;
    let highCount = 0;
    let medCount = 0;
    let lowCount = 0;

    let reliabilityDeduction = 0;
    let securityDeduction = 0;
    let perfDeduction = 0;
    let scaleDeduction = 0;
    let netDeduction = 0;

    for (const f of findings) {
      let weight = 0;
      if (f.severity === 'critical') { weight = 25; critCount++; }
      else if (f.severity === 'high') { weight = 15; highCount++; }
      else if (f.severity === 'medium') { weight = 8; medCount++; }
      else { weight = 3; lowCount++; }

      if (f.pillar === 'availability') reliabilityDeduction += weight;
      else if (f.pillar === 'security') securityDeduction += weight;
      else if (f.pillar === 'performance') perfDeduction += weight;
      else if (f.pillar === 'scalability') scaleDeduction += weight;
      else if (f.pillar === 'networking' || f.pillar === 'cloud-correctness') netDeduction += weight;
      else reliabilityDeduction += Math.floor(weight / 2);
    }

    const reliability = Math.max(0, 100 - reliabilityDeduction);
    const security = Math.max(0, 100 - securityDeduction);
    const performance = Math.max(0, 100 - perfDeduction);
    const scalability = Math.max(0, 100 - scaleDeduction);
    const networkCorrectness = Math.max(0, 100 - netDeduction);
    const cost = Math.max(60, 100 - Math.min(30, (nodes.length > 15 ? 15 : 0)));

    const overall = Math.round(
      (reliability * 0.25) +
      (security * 0.25) +
      (networkCorrectness * 0.20) +
      (scalability * 0.15) +
      (performance * 0.10) +
      (cost * 0.05)
    );

    const summary = critCount > 0
      ? `Architecture has ${critCount} CRITICAL issue(s) that must be resolved before production deployment.`
      : highCount > 0
      ? `Architecture has ${highCount} HIGH severity finding(s) impacting resilience and security.`
      : 'Architecture satisfies production-grade baseline standards.';

    return {
      isValid: critCount === 0,
      score: {
        overall,
        reliability,
        security,
        performance,
        cost,
        scalability,
        networkCorrectness,
      },
      criticalCount: critCount,
      highCount,
      mediumCount: medCount,
      lowCount,
      findings,
      summary,
    };
  }
}

export const architectureValidator = ArchitectureValidator.getInstance();
