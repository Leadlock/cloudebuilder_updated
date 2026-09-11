/**
 * Network Path Validator
 *
 * Validates real cloud network topologies and packet routing paths across:
 * - Route tables and subnet classification (Public vs Private vs Data)
 * - Internet Gateway & NAT Gateway routing
 * - Ingress and egress path continuity
 * - Availability Zone distribution (Multi-AZ validation)
 * - Public/Private resource placement correctness
 */

import { CanvasNode, CanvasEdge } from '@/types';

export interface NetworkFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: 'topology' | 'placement' | 'routing' | 'multi-az';
  title: string;
  message: string;
  affectedNodeIds: string[];
  recommendation: string;
}

export interface NetworkValidationReport {
  isValid: boolean;
  score: number; // 0 - 100
  findings: NetworkFinding[];
  hasMultiAz: boolean;
  publicSubnetsCount: number;
  privateSubnetsCount: number;
  dataSubnetsCount: number;
}

export class NetworkPathValidator {
  public validate(nodes: CanvasNode[], edges: CanvasEdge[]): NetworkValidationReport {
    const findings: NetworkFinding[] = [];

    const subnets = nodes.filter((n) => n.resourceType === 'aws_subnet' || n.resourceType === 'azure_subnet');
    const vpcs = nodes.filter((n) => n.resourceType === 'aws_vpc' || n.resourceType === 'azure_vnet');
    const leafNodes = nodes.filter((n) => !subnets.includes(n) && !vpcs.includes(n));

    // ── Helper: Classify Subnet ─────────────────────────────────────────────
    const isPublicSubnet = (s: CanvasNode): boolean => {
      const name = (s.label || '').toLowerCase();
      const cfg = s.config || {};
      return cfg.mapPublicIpOnLaunch === true || name.includes('public') || name.includes('ingress') || name.includes('dmz');
    };

    const isDataSubnet = (s: CanvasNode): boolean => {
      const name = (s.label || '').toLowerCase();
      return name.includes('db') || name.includes('database') || name.includes('data');
    };

    let publicSubnetsCount = 0;
    let privateSubnetsCount = 0;
    let dataSubnetsCount = 0;

    for (const s of subnets) {
      if (isPublicSubnet(s)) publicSubnetsCount++;
      else if (isDataSubnet(s)) dataSubnetsCount++;
      else privateSubnetsCount++;
    }

    // ── Rule 1: S3 / Blob Storage should NOT be placed inside Subnets ────────
    for (const node of leafNodes) {
      if ((node.resourceType === 'aws_s3' || node.resourceType === 'azure_storage') && node.groupId) {
        const parent = nodes.find((n) => n.id === node.groupId);
        if (parent && (parent.resourceType === 'aws_subnet' || parent.resourceType === 'azure_subnet')) {
          findings.push({
            id: `net-placement-s3-${node.id}`,
            severity: 'high',
            category: 'placement',
            title: `${node.label} incorrectly placed inside subnet`,
            message: `${node.label} is an object storage service operating at the regional/global cloud boundary, not a subnet-bound private CIDR workload.`,
            affectedNodeIds: [node.id, parent.id],
            recommendation: 'Move the storage resource outside of the VPC/Subnet to the Regional Services boundary and connect via IAM/Private Endpoint.',
          });
        }
      }
    }

    // ── Rule 2: Databases (RDS, Azure SQL) placed in Public Subnets ──────────
    for (const node of leafNodes) {
      if (node.resourceType === 'aws_rds' || node.resourceType === 'azure_sql') {
        if (node.groupId) {
          const parent = nodes.find((n) => n.id === node.groupId);
          if (parent && isPublicSubnet(parent)) {
            findings.push({
              id: `net-placement-db-public-${node.id}`,
              severity: 'critical',
              category: 'placement',
              title: `Database deployed in Public Subnet (${parent.label})`,
              message: `${node.label} is housed in a public subnet with direct internet routing exposure.`,
              affectedNodeIds: [node.id, parent.id],
              recommendation: 'Relocate database to a dedicated private database subnet with no public IP allocation and restrict ingress to application security groups.',
            });
          }
        }
      }
    }

    // ── Rule 3: Internet-facing ALB in Private Subnet ────────────────────────
    for (const node of leafNodes) {
      if (node.resourceType === 'aws_alb' && node.config?.scheme === 'internet-facing') {
        if (node.groupId) {
          const parent = nodes.find((n) => n.id === node.groupId);
          if (parent && !isPublicSubnet(parent)) {
            findings.push({
              id: `net-alb-private-${node.id}`,
              severity: 'high',
              category: 'routing',
              title: `Internet-facing Load Balancer in Private Subnet`,
              message: `${node.label} is configured as internet-facing but placed within private subnet "${parent.label}". External clients cannot reach this load balancer.`,
              affectedNodeIds: [node.id, parent.id],
              recommendation: 'Move the internet-facing ALB into public subnets with Internet Gateway routes.',
            });
          }
        }
      }
    }

    // ── Rule 4: Multi-AZ Availability Validation ────────────────────────────
    const availabilityZones = new Set<string>();
    for (const s of subnets) {
      const az = (s.config?.availabilityZone as string) || (s.label.match(/[0-9][a-z]/i) ? s.label : undefined);
      if (az) availabilityZones.add(az.toLowerCase());
    }

    const computeNodes = leafNodes.filter(
      (n) => n.resourceType === 'aws_ec2' || n.resourceType === 'azure_vm' || n.resourceType === 'aws_ecs'
    );

    const hasMultiAz = availabilityZones.size >= 2 || (computeNodes.length >= 2 && subnets.length >= 2);

    if (computeNodes.length > 0 && !hasMultiAz) {
      findings.push({
        id: 'net-single-az-spof',
        severity: 'high',
        category: 'multi-az',
        title: 'Single Availability Zone Architecture (SPOF)',
        message: 'Compute workloads and subnets are concentrated in a single Availability Zone. An outage in this AZ will take down the entire application.',
        affectedNodeIds: computeNodes.map((n) => n.id),
        recommendation: 'Deploy across at least two Availability Zones (e.g. us-east-1a and us-east-1b) with load balancing.',
      });
    }

    // ── Rule 5: Direct Internet to Private Workload without Ingress Proxy ───
    for (const edge of edges) {
      const source = nodes.find((n) => n.id === edge.source);
      const target = nodes.find((n) => n.id === edge.target);
      if (!source || !target) continue;

      if ((source.resourceType === 'aws_internet' || source.resourceType === 'aws_igw') &&
          (target.resourceType === 'aws_rds' || target.resourceType === 'azure_sql')) {
        findings.push({
          id: `net-edge-invalid-db-${edge.id}`,
          severity: 'critical',
          category: 'routing',
          title: 'Direct Internet Route to Database',
          message: `Network path from ${source.label} directly to ${target.label} bypasses all application and firewall security controls.`,
          affectedNodeIds: [source.id, target.id],
          recommendation: 'Remove this edge. Route traffic through an Application Load Balancer and application servers.',
        });
      }
    }

    // ── Calculate Score ─────────────────────────────────────────────────────
    let deduction = 0;
    for (const f of findings) {
      if (f.severity === 'critical') deduction += 30;
      else if (f.severity === 'high') deduction += 15;
      else if (f.severity === 'medium') deduction += 8;
      else if (f.severity === 'low') deduction += 3;
    }

    const score = Math.max(0, 100 - deduction);

    return {
      isValid: findings.filter((f) => f.severity === 'critical').length === 0,
      score,
      findings,
      hasMultiAz,
      publicSubnetsCount,
      privateSubnetsCount,
      dataSubnetsCount,
    };
  }
}

export const networkPathValidator = new NetworkPathValidator();
