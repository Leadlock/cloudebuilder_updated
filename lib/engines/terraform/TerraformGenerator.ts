/**
 * Terraform Generator — Phase 2D
 *
 * Generates valid Terraform HCL from persisted ArchitectureResource and
 * ArchitectureConnection rows. Resource references are derived from actual
 * connection relationships, not hardcoded IDs.
 *
 * SECURITY: No cloud credentials are included in generated output.
 * Generated Terraform uses variables for all sensitive values.
 */
import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TerraformFile {
  filename: string;
  content: string;
  provider: string;
}

export interface TerraformGenerationInput {
  architectureId: string;
  projectId: string;
  versionId?: string;
  resources: DbArchitectureResource[];
  connections: DbArchitectureConnection[];
  projectName?: string;
}

export interface TerraformGenerationResult {
  files: TerraformFile[];
  warnings: string[];
  resourceMap: Record<string, string>; // resourceId → tf resource address
  providers: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a label or name to a valid Terraform identifier */
function tfName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^[0-9]/, 'r$&')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    || 'resource';
}

function indent(text: string, spaces = 2): string {
  return text.split('\n').map((l) => (l.trim() ? ' '.repeat(spaces) + l : l)).join('\n');
}

// ─── Reference resolver ───────────────────────────────────────────────────────

/**
 * Resolves parent resource references from connections.
 * Given a connection source→target, returns the Terraform reference string
 * for the source resource appropriate for use inside the target resource block.
 */
class ReferenceResolver {
  private readonly nameMap: Map<string, string>; // resourceId → tfName

  constructor(resources: DbArchitectureResource[]) {
    this.nameMap = new Map(
      resources.map((r) => [r.id, tfName((JSON.parse(r.configJson || '{}') as Record<string, unknown>)['name'] as string || r.label)])
    );
  }

  tfNameOf(resourceId: string): string | undefined {
    return this.nameMap.get(resourceId);
  }

  /** Returns the parent of a given resourceType derived from groupId hierarchy or connected edges */
  resolveParent(
    targetId: string,
    parentType: string,
    connections: DbArchitectureConnection[],
    resources: DbArchitectureResource[],
  ): DbArchitectureResource | undefined {
    // 1. Direct container hierarchy (groupId)
    const targetResource = resources.find((r) => r.id === targetId);
    if (targetResource?.groupId) {
      const parentByGroup = resources.find((r) => r.id === targetResource.groupId);
      if (parentByGroup && parentByGroup.resourceType === parentType) {
        return parentByGroup;
      }
      // If target is EC2 inside Subnet and parentType is VPC, check Subnet's groupId
      if (parentByGroup?.groupId) {
        const grandParent = resources.find((r) => r.id === parentByGroup.groupId);
        if (grandParent && grandParent.resourceType === parentType) {
          return grandParent;
        }
      }
    }

    // 2. Bidirectional connections (works regardless of which direction user drew the wire)
    const connectedIds = connections
      .filter((c) => c.targetId === targetId || c.sourceId === targetId)
      .map((c) => (c.targetId === targetId ? c.sourceId : c.targetId));

    return resources.find((r) => connectedIds.includes(r.id) && r.resourceType === parentType);
  }

  /** Returns ALL resources of a given type connected/contained to a target (e.g. every subnet an ALB spans) */
  resolveParents(
    targetId: string,
    parentType: string,
    connections: DbArchitectureConnection[],
    resources: DbArchitectureResource[],
  ): DbArchitectureResource[] {
    const found = new Map<string, DbArchitectureResource>();

    const targetResource = resources.find((r) => r.id === targetId);
    if (targetResource?.groupId) {
      const parentByGroup = resources.find((r) => r.id === targetResource.groupId);
      if (parentByGroup && parentByGroup.resourceType === parentType) {
        found.set(parentByGroup.id, parentByGroup);
      }
    }

    const connectedIds = connections
      .filter((c) => c.targetId === targetId || c.sourceId === targetId)
      .map((c) => (c.targetId === targetId ? c.sourceId : c.targetId));

    for (const r of resources) {
      if (connectedIds.includes(r.id) && r.resourceType === parentType) {
        found.set(r.id, r);
      }
    }

    return Array.from(found.values());
  }
}

// ─── AWS Terraform Generator ─────────────────────────────────────────────────

class AwsTerraformGenerator {
  generate(
    resources: DbArchitectureResource[],
    connections: DbArchitectureConnection[],
    projectName: string,
    resolver: ReferenceResolver,
  ): { blocks: string[]; warnings: string[]; resourceMap: Record<string, string> } {
    const blocks: string[] = [];
    const warnings: string[] = [];
    const resourceMap: Record<string, string> = {};

    for (const r of resources) {
      const cfg = this._cfg(r);
      const name = resolver.tfNameOf(r.id) ?? tfName(r.label);
      const isImported = Boolean(cfg.imported || cfg.importState === 'imported');

      switch (r.resourceType) {
        case 'aws_vpc': {
          if (isImported) {
            blocks.push(this._dataVpc(name, cfg));
            resourceMap[r.id] = `data.aws_vpc.${name}`;
          } else {
            blocks.push(this._vpc(name, cfg));
            resourceMap[r.id] = `aws_vpc.${name}`;
          }
          break;
        }
        case 'aws_subnet': {
          const vpc = resolver.resolveParent(r.id, 'aws_vpc', connections, resources);
          const isVpcImported = vpc && Boolean(this._cfg(vpc).imported || this._cfg(vpc).importState === 'imported');
          const vpcRef = vpc
            ? `${isVpcImported ? 'data.' : ''}aws_vpc.${resolver.tfNameOf(vpc.id) ?? 'main'}.id`
            : 'aws_vpc.main.id # WARNING: VPC not connected';

          if (isImported) {
            blocks.push(this._dataSubnet(name, cfg));
            resourceMap[r.id] = `data.aws_subnet.${name}`;
          } else {
            blocks.push(this._subnet(name, cfg, vpcRef));
            resourceMap[r.id] = `aws_subnet.${name}`;
          }
          break;
        }
        case 'aws_ec2': {
          const subnet = resolver.resolveParent(r.id, 'aws_subnet', connections, resources);
          const isSubnetImported = subnet && Boolean(this._cfg(subnet).imported || this._cfg(subnet).importState === 'imported');
          const subnetRef = subnet
            ? `${isSubnetImported ? 'data.' : ''}aws_subnet.${resolver.tfNameOf(subnet.id) ?? 'main'}.id`
            : null;
          const sg = resolver.resolveParent(r.id, 'aws_sg', connections, resources);
          const isSgImported = sg && Boolean(this._cfg(sg).imported || this._cfg(sg).importState === 'imported');
          const sgRef = sg
            ? `[${isSgImported ? 'data.' : ''}aws_security_group.${resolver.tfNameOf(sg.id) ?? 'main'}.id]`
            : null;

          if (isImported) {
            blocks.push(this._dataEc2(name, cfg));
            resourceMap[r.id] = `data.aws_instance.${name}`;
          } else {
            blocks.push(this._ec2(name, cfg, subnetRef, sgRef));
            resourceMap[r.id] = `aws_instance.${name}`;
          }
          break;
        }
        case 'aws_rds': {
          const subnets = resolver.resolveParents(r.id, 'aws_subnet', connections, resources);
          const subnetRefs = subnets.map((s) => {
            const isImp = Boolean(this._cfg(s).imported || this._cfg(s).importState === 'imported');
            return `${isImp ? 'data.' : ''}aws_subnet.${resolver.tfNameOf(s.id) ?? 'main'}.id`;
          });
          const sg = resolver.resolveParent(r.id, 'aws_sg', connections, resources);
          const isSgImported = sg && Boolean(this._cfg(sg).imported || this._cfg(sg).importState === 'imported');
          const sgRef = sg
            ? `[${isSgImported ? 'data.' : ''}aws_security_group.${resolver.tfNameOf(sg.id) ?? 'main'}.id]`
            : null;

          if (subnetRefs.length === 0) {
            warnings.push(`RDS instance "${r.label}" has no connected subnet — generated aws_db_instance will have no db_subnet_group_name and may fail to apply in a VPC-only account.`);
          } else if (subnetRefs.length === 1) {
            warnings.push(`RDS instance "${r.label}" is connected to only one subnet — AWS requires a DB subnet group spanning at least 2 Availability Zones for most instance classes.`);
          }

          if (isImported) {
            blocks.push(this._dataRds(name, cfg));
            resourceMap[r.id] = `data.aws_db_instance.${name}`;
          } else {
            if (subnetRefs.length > 0) {
              blocks.push(this._dbSubnetGroup(name, subnetRefs));
            }
            blocks.push(this._rds(name, cfg, subnetRefs.length > 0 ? `aws_db_subnet_group.${name}_subnet_group.name` : null, sgRef));
            resourceMap[r.id] = `aws_db_instance.${name}`;
            const replicaBlock = this._rdsReplicas(name, cfg);
            if (replicaBlock) blocks.push(replicaBlock);
          }
          break;
        }
        case 'aws_s3': {
          if (isImported) {
            blocks.push(this._dataS3(name, cfg));
            resourceMap[r.id] = `data.aws_s3_bucket.${name}`;
          } else {
            blocks.push(this._s3(name, cfg));
            resourceMap[r.id] = `aws_s3_bucket.${name}`;
          }
          break;
        }
        case 'aws_lambda': {
          const subnets = resolver.resolveParents(r.id, 'aws_subnet', connections, resources);
          const subnetRefs = subnets.map((s) => {
            const isImp = Boolean(this._cfg(s).imported || this._cfg(s).importState === 'imported');
            return `${isImp ? 'data.' : ''}aws_subnet.${resolver.tfNameOf(s.id) ?? 'main'}.id`;
          });
          const sg = resolver.resolveParent(r.id, 'aws_sg', connections, resources);
          const isSgImported = sg && Boolean(this._cfg(sg).imported || this._cfg(sg).importState === 'imported');
          const sgRef = sg ? `${isSgImported ? 'data.' : ''}aws_security_group.${resolver.tfNameOf(sg.id) ?? 'main'}.id` : null;

          blocks.push(this._lambda(name, cfg, subnetRefs, sgRef));
          resourceMap[r.id] = `aws_lambda_function.${name}`;
          break;
        }
        case 'aws_alb': {
          const sg = resolver.resolveParent(r.id, 'aws_sg', connections, resources);
          const isSgImported = sg && Boolean(this._cfg(sg).imported || this._cfg(sg).importState === 'imported');
          const sgRef = sg
            ? `[${isSgImported ? 'data.' : ''}aws_security_group.${resolver.tfNameOf(sg.id) ?? 'main'}.id]`
            : null;
          const subnets = resolver.resolveParents(r.id, 'aws_subnet', connections, resources);
          const subnetRefs = subnets.map((s) => {
            const isImp = Boolean(this._cfg(s).imported || this._cfg(s).importState === 'imported');
            return `${isImp ? 'data.' : ''}aws_subnet.${resolver.tfNameOf(s.id) ?? 'main'}.id`;
          });
          if (subnetRefs.length < 2) {
            warnings.push(`ALB "${r.label}" is connected to ${subnetRefs.length} subnet(s) — an aws_lb requires subnets in at least 2 distinct Availability Zones and will fail to apply as generated.`);
          }

          let vpc = resolver.resolveParent(r.id, 'aws_vpc', connections, resources);
          if (!vpc && subnets.length > 0) {
            vpc = resolver.resolveParent(subnets[0]!.id, 'aws_vpc', connections, resources);
          }
          const isVpcImported = vpc && Boolean(this._cfg(vpc).imported || this._cfg(vpc).importState === 'imported');
          const vpcRef = vpc ? `${isVpcImported ? 'data.' : ''}aws_vpc.${resolver.tfNameOf(vpc.id) ?? 'main'}.id` : null;
          if (!vpcRef) {
            warnings.push(`ALB "${r.label}" has no resolvable VPC (directly or via a connected subnet) — its target group's vpc_id will fall back to a placeholder and Terraform will fail to apply.`);
          }

          if (isImported) {
            blocks.push(this._dataAlb(name, cfg));
            resourceMap[r.id] = `data.aws_lb.${name}`;
          } else {
            blocks.push(this._alb(name, cfg, vpcRef, sgRef, subnetRefs));
            resourceMap[r.id] = `aws_lb.${name}`;
          }
          break;
        }
        case 'aws_igw': {
          const vpc = resolver.resolveParent(r.id, 'aws_vpc', connections, resources);
          const isVpcImported = vpc && Boolean(this._cfg(vpc).imported || this._cfg(vpc).importState === 'imported');
          const vpcRef = vpc
            ? `${isVpcImported ? 'data.' : ''}aws_vpc.${resolver.tfNameOf(vpc.id) ?? 'main'}.id`
            : 'aws_vpc.main.id # WARNING: VPC not connected';
          blocks.push(this._igw(name, cfg, vpcRef));
          resourceMap[r.id] = `aws_internet_gateway.${name}`;
          break;
        }
        case 'aws_nat': {
          const subnet = resolver.resolveParent(r.id, 'aws_subnet', connections, resources);
          const isSubnetImported = subnet && Boolean(this._cfg(subnet).imported || this._cfg(subnet).importState === 'imported');
          const subnetRef = subnet
            ? `${isSubnetImported ? 'data.' : ''}aws_subnet.${resolver.tfNameOf(subnet.id) ?? 'main'}.id`
            : 'aws_subnet.main.id # WARNING: Subnet not connected';
          blocks.push(this._nat(name, cfg, subnetRef));
          resourceMap[r.id] = `aws_nat_gateway.${name}`;
          break;
        }
        case 'aws_sg': {
          const vpc = resolver.resolveParent(r.id, 'aws_vpc', connections, resources);
          const isVpcImported = vpc && Boolean(this._cfg(vpc).imported || this._cfg(vpc).importState === 'imported');
          const vpcRef = vpc
            ? `${isVpcImported ? 'data.' : ''}aws_vpc.${resolver.tfNameOf(vpc.id) ?? 'main'}.id`
            : 'aws_vpc.main.id # WARNING: VPC not connected';

          if (isImported) {
            blocks.push(this._dataSg(name, cfg));
            resourceMap[r.id] = `data.aws_security_group.${name}`;
          } else {
            blocks.push(this._sg(name, cfg, vpcRef));
            resourceMap[r.id] = `aws_security_group.${name}`;
          }
          break;
        }
        case 'aws_cloudfront': {
          const alb = resolver.resolveParent(r.id, 'aws_alb', connections, resources);
          const isAlbImported = alb && Boolean(this._cfg(alb).imported || this._cfg(alb).importState === 'imported');
          const originDns = alb
            ? `${isAlbImported ? 'data.' : ''}aws_lb.${resolver.tfNameOf(alb.id) ?? 'main'}.dns_name`
            : '"origin.example.com"';
          blocks.push(this._cloudfront(name, cfg, originDns));
          resourceMap[r.id] = `aws_cloudfront_distribution.${name}`;
          break;
        }
        case 'aws_internet': {
          // Public internet traffic entrypoint marker (no standalone terraform resource)
          break;
        }
        case 'aws_dynamodb': {
          blocks.push(this._dynamodb(name, cfg));
          resourceMap[r.id] = `aws_dynamodb_table.${name}`;
          break;
        }
        case 'aws_elasticache': {
          const subnets = resolver.resolveParents(r.id, 'aws_subnet', connections, resources);
          const subnetRefs = subnets.map((s) => {
            const isImp = Boolean(this._cfg(s).imported || this._cfg(s).importState === 'imported');
            return `${isImp ? 'data.' : ''}aws_subnet.${resolver.tfNameOf(s.id) ?? 'main'}.id`;
          });
          const sg = resolver.resolveParent(r.id, 'aws_sg', connections, resources);
          const isSgImported = sg && Boolean(this._cfg(sg).imported || this._cfg(sg).importState === 'imported');
          const sgRef = sg ? `[${isSgImported ? 'data.' : ''}aws_security_group.${resolver.tfNameOf(sg.id) ?? 'main'}.id]` : null;
          if (subnetRefs.length > 0) {
            blocks.push(this._elasticacheSubnetGroup(name, subnetRefs));
          }
          blocks.push(this._elasticache(name, cfg, subnetRefs.length > 0 ? `aws_elasticache_subnet_group.${name}_subnet_group.name` : null, sgRef));
          resourceMap[r.id] = `aws_elasticache_replication_group.${name}`;
          break;
        }
        case 'aws_sqs': {
          blocks.push(this._sqs(name, cfg));
          resourceMap[r.id] = `aws_sqs_queue.${name}`;
          break;
        }
        case 'aws_ecs': {
          const subnets = resolver.resolveParents(r.id, 'aws_subnet', connections, resources);
          const subnetRefs = subnets.map((s) => {
            const isImp = Boolean(this._cfg(s).imported || this._cfg(s).importState === 'imported');
            return `${isImp ? 'data.' : ''}aws_subnet.${resolver.tfNameOf(s.id) ?? 'main'}.id`;
          });
          const sg = resolver.resolveParent(r.id, 'aws_sg', connections, resources);
          const isSgImported = sg && Boolean(this._cfg(sg).imported || this._cfg(sg).importState === 'imported');
          const sgRef = sg ? `${isSgImported ? 'data.' : ''}aws_security_group.${resolver.tfNameOf(sg.id) ?? 'main'}.id` : null;
          if (subnetRefs.length === 0) {
            warnings.push(`ECS service "${r.label}" is not connected to any subnet — the generated aws_ecs_service will have no network configuration and will fail to apply.`);
          }
          blocks.push(this._ecs(name, cfg, subnetRefs, sgRef));
          resourceMap[r.id] = `aws_ecs_service.${name}`;
          break;
        }
        case 'aws_eks': {
          const subnets = resolver.resolveParents(r.id, 'aws_subnet', connections, resources);
          const subnetRefs = subnets.map((s) => {
            const isImp = Boolean(this._cfg(s).imported || this._cfg(s).importState === 'imported');
            return `${isImp ? 'data.' : ''}aws_subnet.${resolver.tfNameOf(s.id) ?? 'main'}.id`;
          });
          if (subnetRefs.length < 2) {
            warnings.push(`EKS cluster "${r.label}" is connected to ${subnetRefs.length} subnet(s) — EKS requires subnets in at least 2 distinct Availability Zones and will fail to apply as generated.`);
          }
          blocks.push(this._eks(name, cfg, subnetRefs));
          resourceMap[r.id] = `aws_eks_cluster.${name}`;
          break;
        }
        case 'aws_route53': {
          blocks.push(this._route53(name, cfg));
          resourceMap[r.id] = `aws_route53_record.${name}`;
          break;
        }
        case 'aws_waf': {
          blocks.push(this._waf(name, cfg));
          resourceMap[r.id] = `aws_wafv2_web_acl.${name}`;
          break;
        }
        case 'aws_route_table': {
          const vpc = resolver.resolveParent(r.id, 'aws_vpc', connections, resources);
          const isVpcImported = vpc && Boolean(this._cfg(vpc).imported || this._cfg(vpc).importState === 'imported');
          const vpcRef = vpc ? `${isVpcImported ? 'data.' : ''}aws_vpc.${resolver.tfNameOf(vpc.id) ?? 'main'}.id` : 'aws_vpc.main.id # WARNING: VPC not connected';
          const igw = resolver.resolveParent(r.id, 'aws_igw', connections, resources);
          const nat = resolver.resolveParent(r.id, 'aws_nat', connections, resources);
          const subnets = resolver.resolveParents(r.id, 'aws_subnet', connections, resources);
          const subnetRefs = subnets.map((s) => {
            const isImp = Boolean(this._cfg(s).imported || this._cfg(s).importState === 'imported');
            return `${isImp ? 'data.' : ''}aws_subnet.${resolver.tfNameOf(s.id) ?? 'main'}.id`;
          });
          const igwRef = igw ? `aws_internet_gateway.${resolver.tfNameOf(igw.id) ?? 'main'}.id` : null;
          const natRef = nat ? `aws_nat_gateway.${resolver.tfNameOf(nat.id) ?? 'main'}.id` : null;
          blocks.push(this._routeTable(name, cfg, vpcRef, igwRef, natRef, subnetRefs));
          resourceMap[r.id] = `aws_route_table.${name}`;
          break;
        }
        case 'aws_nacl': {
          const vpc = resolver.resolveParent(r.id, 'aws_vpc', connections, resources);
          const isVpcImported = vpc && Boolean(this._cfg(vpc).imported || this._cfg(vpc).importState === 'imported');
          const vpcRef = vpc ? `${isVpcImported ? 'data.' : ''}aws_vpc.${resolver.tfNameOf(vpc.id) ?? 'main'}.id` : 'aws_vpc.main.id # WARNING: VPC not connected';
          const subnets = resolver.resolveParents(r.id, 'aws_subnet', connections, resources);
          const subnetRefs = subnets.map((s) => {
            const isImp = Boolean(this._cfg(s).imported || this._cfg(s).importState === 'imported');
            return `${isImp ? 'data.' : ''}aws_subnet.${resolver.tfNameOf(s.id) ?? 'main'}.id`;
          });
          blocks.push(this._nacl(name, cfg, vpcRef, subnetRefs));
          resourceMap[r.id] = `aws_network_acl.${name}`;
          break;
        }
        case 'aws_iam': {
          blocks.push(this._iamRole(name, cfg));
          resourceMap[r.id] = `aws_iam_role.${name}`;
          break;
        }
        case 'aws_kms': {
          blocks.push(this._kms(name, cfg));
          resourceMap[r.id] = `aws_kms_key.${name}`;
          break;
        }
        case 'aws_cloudwatch': {
          blocks.push(this._cloudwatchAlarm(name, cfg));
          resourceMap[r.id] = `aws_cloudwatch_metric_alarm.${name}`;
          break;
        }
        case 'aws_ebs': {
          blocks.push(this._ebs(name, cfg));
          resourceMap[r.id] = `aws_ebs_volume.${name}`;
          break;
        }
        case 'aws_auto_scaling': {
          const subnets = resolver.resolveParents(r.id, 'aws_subnet', connections, resources);
          const subnetRefs = subnets.map((s) => {
            const isImp = Boolean(this._cfg(s).imported || this._cfg(s).importState === 'imported');
            return `${isImp ? 'data.' : ''}aws_subnet.${resolver.tfNameOf(s.id) ?? 'main'}.id`;
          });
          const sg = resolver.resolveParent(r.id, 'aws_sg', connections, resources);
          const isSgImported = sg && Boolean(this._cfg(sg).imported || this._cfg(sg).importState === 'imported');
          const sgRef = sg ? `${isSgImported ? 'data.' : ''}aws_security_group.${resolver.tfNameOf(sg.id) ?? 'main'}.id` : null;
          if (subnetRefs.length === 0) {
            warnings.push(`Auto Scaling group "${r.label}" is not connected to any subnet — the generated aws_autoscaling_group will have no vpc_zone_identifier and will fail to apply.`);
          }
          blocks.push(this._autoScaling(name, cfg, subnetRefs, sgRef));
          resourceMap[r.id] = `aws_autoscaling_group.${name}`;
          break;
        }
        default: {
          warnings.push(`Unsupported AWS resource type: ${r.resourceType} (resource: ${r.label})`);
        }
      }
    }

    return { blocks, warnings, resourceMap };
  }

  private _cfg(r: DbArchitectureResource): Record<string, unknown> {
    try { return JSON.parse(r.configJson) as Record<string, unknown>; } catch { return {}; }
  }

  private _vpc(name: string, cfg: Record<string, unknown>): string {
    return `resource "aws_vpc" "${name}" {
  cidr_block           = "${cfg['cidrBlock'] ?? '10.0.0.0/16'}"
  enable_dns_support   = ${cfg['enableDnsSupport'] !== false}
  enable_dns_hostnames = ${cfg['enableDnsHostnames'] !== false}
  tags = {
    Name        = "${name}"
    ManagedBy   = "CloudCraft"
  }
}`;
  }

  private _subnet(name: string, cfg: Record<string, unknown>, vpcRef: string): string {
    return `resource "aws_subnet" "${name}" {
  vpc_id                  = ${vpcRef}
  cidr_block              = "${cfg['cidrBlock'] ?? '10.0.1.0/24'}"
  availability_zone       = "${cfg['availabilityZone'] ?? 'us-east-1a'}"
  map_public_ip_on_launch = ${cfg['mapPublicIpOnLaunch'] === true}
  tags = {
    Name      = "${name}"
    ManagedBy = "CloudCraft"
  }
}`;
  }

  private _ec2(name: string, cfg: Record<string, unknown>, subnetRef: string | null, sgRef: string | null): string {
    const storageType = (cfg['storageType'] as string) || 'gp3';
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};

    const lines: string[] = [
      `resource "aws_instance" "${name}" {`,
      `  ami                         = "${cfg['ami'] ?? 'ami-0c55b159cbfafe1f0'}"`,
      `  instance_type               = "${cfg['instanceType'] ?? 't3.micro'}"`,
    ];
    if (cfg['keyName']) lines.push(`  key_name                    = "${cfg['keyName']}"`);
    if (subnetRef)      lines.push(`  subnet_id                   = ${subnetRef}`);
    if (sgRef)          lines.push(`  vpc_security_group_ids      = ${sgRef}`);
    lines.push(`  associate_public_ip_address = ${cfg['associatePublicIpAddress'] === true}`);
    lines.push(`  monitoring                  = ${cfg['detailedMonitoring'] === true}`);
    lines.push(`  ebs_optimized               = ${cfg['ebsOptimized'] !== false}`);
    lines.push(`  disable_api_termination     = ${cfg['terminationProtection'] === true}`);
    lines.push(`  instance_initiated_shutdown_behavior = "${cfg['instanceInitiatedShutdownBehavior'] ?? 'stop'}"`);
    if (cfg['tenancy'] && cfg['tenancy'] !== 'default') {
      lines.push(`  tenancy                     = "${cfg['tenancy']}"`);
    }
    if (cfg['iamInstanceProfile']) {
      lines.push(`  iam_instance_profile        = "${cfg['iamInstanceProfile']}"`);
    }
    if (cfg['userData']) {
      lines.push(`  user_data                   = base64encode(<<-EOF\n    ${cfg['userData']}\n  EOF\n  )`);
    }
    lines.push(`  root_block_device {`);
    lines.push(`    volume_size           = ${cfg['storageGb'] ?? 30}`);
    lines.push(`    volume_type           = "${storageType}"`);
    if (storageType === 'io1' || storageType === 'io2') {
      lines.push(`    iops                  = ${cfg['storageIops'] ?? 3000}`);
    }
    lines.push(`    encrypted             = ${cfg['encrypted'] !== false}`);
    lines.push(`    delete_on_termination = ${cfg['deleteOnTermination'] !== false}`);
    lines.push(`  }`);
    lines.push(`  tags = {`);
    lines.push(`    Name      = "${name}"`);
    lines.push(`    ManagedBy = "CloudCraft"`);
    for (const [k, v] of Object.entries(tags)) {
      if (!k) continue;
      lines.push(`    ${k} = "${v}"`);
    }
    lines.push(`  }`);
    lines.push(`}`);
    return lines.join('\n');
  }

  private _dbSubnetGroup(name: string, subnetRefs: string[]): string {
    return `resource "aws_db_subnet_group" "${name}_subnet_group" {
  name       = "${name}-subnet-group"
  subnet_ids = [${subnetRefs.join(', ')}]
  tags = {
    Name      = "${name}-subnet-group"
    ManagedBy = "CloudCraft"
  }
}`;
  }

  private _rds(name: string, cfg: Record<string, unknown>, dbSubnetGroupRef: string | null, sgRef: string | null): string {
    const storageType = (cfg['storageType'] as string) || 'gp3';
    const monitoringInterval = Number(cfg['monitoringInterval'] ?? 0);
    const cloudwatchLogExports = Array.isArray(cfg['enableCloudwatchLogsExports']) ? cfg['enableCloudwatchLogsExports'] as string[] : [];
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};

    const lines: string[] = [
      `resource "aws_db_instance" "${name}" {`,
      `  identifier                     = "${name}"`,
      `  engine                         = "${cfg['engine'] ?? 'mysql'}"`,
      `  engine_version                 = "${cfg['engineVersion'] ?? '8.0'}"`,
      `  instance_class                 = "${cfg['instanceClass'] ?? 'db.t3.micro'}"`,
      `  allocated_storage              = ${cfg['allocatedStorage'] ?? 20}`,
      `  storage_type                   = "${storageType}"`,
    ];
    if (storageType === 'io1' || storageType === 'io2') {
      lines.push(`  iops                           = ${cfg['iops'] ?? 3000}`);
    }
    if (storageType === 'gp3' && cfg['storageThroughput'] !== undefined) {
      lines.push(`  storage_throughput             = ${cfg['storageThroughput']}`);
    }
    const maxAllocated = Number(cfg['maxAllocatedStorage'] ?? 0);
    if (maxAllocated > 0) {
      lines.push(`  max_allocated_storage          = ${maxAllocated}`);
    }
    lines.push(`  storage_encrypted              = ${cfg['encrypted'] !== false}`);
    if (cfg['encrypted'] !== false && cfg['kmsKeyId']) {
      lines.push(`  kms_key_id                     = "${cfg['kmsKeyId']}"`);
    }
    lines.push(`  multi_az                       = ${cfg['multiAz'] === true}`);
    lines.push(`  publicly_accessible            = ${cfg['publiclyAccessible'] === true}`);
    lines.push(`  port                            = ${cfg['port'] ?? 5432}`);
    lines.push(`  iam_database_authentication_enabled = ${cfg['iamDatabaseAuthenticationEnabled'] === true}`);
    lines.push(`  skip_final_snapshot            = true`);
    lines.push(`  db_name                        = var.db_name`);
    lines.push(`  username                       = "${cfg['masterUsername'] ?? 'admin'}"`);
    lines.push(`  password                       = var.db_password`);
    lines.push(`  backup_retention_period        = ${cfg['backupRetentionPeriod'] ?? 7}`);
    if (cfg['preferredBackupWindow']) {
      lines.push(`  backup_window                  = "${cfg['preferredBackupWindow']}"`);
    }
    if (cfg['preferredMaintenanceWindow']) {
      lines.push(`  maintenance_window             = "${cfg['preferredMaintenanceWindow']}"`);
    }
    lines.push(`  copy_tags_to_snapshot          = ${cfg['copyTagsToSnapshot'] !== false}`);
    lines.push(`  deletion_protection            = ${cfg['deletionProtection'] === true}`);
    lines.push(`  auto_minor_version_upgrade     = ${cfg['autoMinorVersionUpgrade'] !== false}`);
    if (cfg['parameterGroupName']) {
      lines.push(`  parameter_group_name           = "${cfg['parameterGroupName']}"`);
    }
    if (cfg['enablePerformanceInsights'] === true) {
      lines.push(`  performance_insights_enabled   = true`);
      lines.push(`  performance_insights_retention_period = ${Number(cfg['performanceInsightsRetentionPeriod'] ?? 7)}`);
    }
    if (monitoringInterval > 0) {
      lines.push(`  monitoring_interval            = ${monitoringInterval}`);
      lines.push(`  monitoring_role_arn            = aws_iam_role.${name}_monitoring.arn`);
    }
    if (cloudwatchLogExports.length > 0) {
      lines.push(`  enabled_cloudwatch_logs_exports = [${cloudwatchLogExports.map((e) => `"${e}"`).join(', ')}]`);
    }
    if (dbSubnetGroupRef) lines.push(`  db_subnet_group_name           = ${dbSubnetGroupRef}`);
    if (sgRef) lines.push(`  vpc_security_group_ids         = ${sgRef}`);
    lines.push(`  tags = {`);
    lines.push(`    Name      = "${name}"`);
    lines.push(`    ManagedBy = "CloudCraft"`);
    for (const [k, v] of Object.entries(tags)) {
      if (!k) continue;
      lines.push(`    ${k} = "${v}"`);
    }
    lines.push(`  }`);
    lines.push(`}`);

    if (monitoringInterval > 0) {
      lines.push('');
      lines.push(`resource "aws_iam_role" "${name}_monitoring" {`);
      lines.push(`  name = "${name}-rds-monitoring"`);
      lines.push(`  assume_role_policy = jsonencode({`);
      lines.push(`    Version = "2012-10-17"`);
      lines.push(`    Statement = [{`);
      lines.push(`      Action    = "sts:AssumeRole"`);
      lines.push(`      Effect    = "Allow"`);
      lines.push(`      Principal = { Service = "monitoring.rds.amazonaws.com" }`);
      lines.push(`    }]`);
      lines.push(`  })`);
      lines.push(`}`);
      lines.push('');
      lines.push(`resource "aws_iam_role_policy_attachment" "${name}_monitoring_attach" {`);
      lines.push(`  role       = aws_iam_role.${name}_monitoring.name`);
      lines.push(`  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"`);
      lines.push(`}`);
    }

    return lines.join('\n');
  }

  /** Emits one aws_db_instance per configured read replica, each replicating from the primary via replicate_source_db. */
  private _rdsReplicas(name: string, cfg: Record<string, unknown>): string | null {
    const count = Math.max(0, Math.floor(Number(cfg['readReplicas'] ?? 0)));
    if (count === 0) return null;

    const blocks: string[] = [];
    for (let i = 1; i <= count; i++) {
      blocks.push(
        `resource "aws_db_instance" "${name}_replica_${i}" {\n` +
        `  identifier             = "${name}-replica-${i}"\n` +
        `  replicate_source_db    = aws_db_instance.${name}.identifier\n` +
        `  instance_class         = "${cfg['instanceClass'] ?? 'db.t3.micro'}"\n` +
        `  storage_encrypted      = ${cfg['encrypted'] !== false}\n` +
        `  publicly_accessible    = false\n` +
        `  skip_final_snapshot    = true\n` +
        `  tags = {\n` +
        `    Name      = "${name}-replica-${i}"\n` +
        `    ManagedBy = "CloudCraft"\n` +
        `  }\n` +
        `}`
      );
    }
    return blocks.join('\n\n');
  }

  /**
   * Generates aws_lambda_function plus the IAM execution role it requires to
   * apply cleanly. No deployment package exists on the canvas, so `filename`
   * points at a placeholder the user must replace — this is called out
   * explicitly rather than silently emitting a resource that can never
   * actually apply.
   */
  private _lambda(name: string, cfg: Record<string, unknown>, subnetRefs: string[], sgRef: string | null): string {
    const isVpcAttached = subnetRefs.length > 0;
    const architecture = (cfg['architecture'] as string) || 'x86_64';
    const reservedConcurrency = Number(cfg['reservedConcurrency'] ?? -1);
    const provisionedConcurrency = Number(cfg['provisionedConcurrency'] ?? 0);
    const envVars = (cfg['environmentVariables'] && typeof cfg['environmentVariables'] === 'object')
      ? cfg['environmentVariables'] as Record<string, string> : {};
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};

    const parts: string[] = [
      `resource "aws_iam_role" "${name}_exec_role" {
  name = "${name}-exec-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}`,
      `resource "aws_iam_role_policy_attachment" "${name}_basic_execution" {
  role       = aws_iam_role.${name}_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}`,
    ];

    if (isVpcAttached) {
      parts.push(`resource "aws_iam_role_policy_attachment" "${name}_vpc_access" {
  role       = aws_iam_role.${name}_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}`);
    }

    const fnLines: string[] = [
      `resource "aws_lambda_function" "${name}" {`,
      `  function_name = "${name}"`,
      `  role          = aws_iam_role.${name}_exec_role.arn`,
      `  handler       = "${cfg['handler'] ?? 'index.handler'}"`,
      `  runtime       = "${cfg['runtime'] ?? 'nodejs20.x'}"`,
      `  architectures = ["${architecture}"]`,
      `  memory_size   = ${cfg['memorySize'] ?? 512}`,
      `  timeout       = ${cfg['timeout'] ?? 15}`,
      `  # No deployment package exists on the canvas — replace with your build artifact`,
      `  filename         = "placeholder.zip"`,
      `  source_code_hash = filebase64sha256("placeholder.zip")`,
    ];
    if (reservedConcurrency >= 0) {
      fnLines.push(`  reserved_concurrent_executions = ${reservedConcurrency}`);
    }
    if (provisionedConcurrency > 0) {
      fnLines.push(`  publish = true`);
    }
    const ephemeralMb = Number(cfg['ephemeralStorageMb'] ?? 512);
    if (ephemeralMb !== 512) {
      fnLines.push(`  ephemeral_storage {`, `    size = ${ephemeralMb}`, `  }`);
    }
    if (cfg['tracingMode']) {
      fnLines.push(`  tracing_config {`, `    mode = "${cfg['tracingMode']}"`, `  }`);
    }
    if (Object.keys(envVars).length > 0) {
      fnLines.push(`  environment {`, `    variables = {`);
      for (const [k, v] of Object.entries(envVars)) {
        if (!k) continue;
        fnLines.push(`      ${k} = "${v}"`);
      }
      fnLines.push(`    }`, `  }`);
    }
    if (isVpcAttached) {
      fnLines.push(`  vpc_config {`, `    subnet_ids         = [${subnetRefs.join(', ')}]`);
      fnLines.push(`    security_group_ids = ${sgRef ? `[${sgRef}]` : '[]'}`);
      fnLines.push(`  }`);
    }
    fnLines.push(`  tags = {`, `    Name      = "${name}"`, `    ManagedBy = "CloudCraft"`);
    for (const [k, v] of Object.entries(tags)) {
      if (!k) continue;
      fnLines.push(`    ${k} = "${v}"`);
    }
    fnLines.push(`  }`, `  depends_on = [aws_iam_role_policy_attachment.${name}_basic_execution]`, `}`);
    parts.push(fnLines.join('\n'));

    if (provisionedConcurrency > 0) {
      parts.push(`resource "aws_lambda_provisioned_concurrency_config" "${name}_provisioned" {
  function_name                     = aws_lambda_function.${name}.function_name
  provisioned_concurrent_executions = ${provisionedConcurrency}
  qualifier                         = aws_lambda_function.${name}.version
}`);
    }

    return parts.join('\n\n');
  }

  private _dynamodb(name: string, cfg: Record<string, unknown>): string {
    const billingMode = (cfg['billingMode'] as string) || 'PAY_PER_REQUEST';
    const partitionKeyName = (cfg['partitionKeyName'] as string) || 'id';
    const partitionKeyType = (cfg['partitionKeyType'] as string) || 'S';
    const sortKeyName = cfg['sortKeyName'] as string | undefined;
    const sortKeyType = (cfg['sortKeyType'] as string) || 'S';
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    const lines: string[] = [
      `resource "aws_dynamodb_table" "${name}" {`,
      `  name         = "${cfg['tableName'] ?? name}"`,
      `  billing_mode = "${billingMode}"`,
      `  hash_key     = "${partitionKeyName}"`,
    ];
    if (sortKeyName) lines.push(`  range_key    = "${sortKeyName}"`);
    if (billingMode === 'PROVISIONED') {
      lines.push(`  read_capacity  = ${cfg['readCapacity'] ?? 5}`, `  write_capacity = ${cfg['writeCapacity'] ?? 5}`);
    }
    if ((cfg['tableClass'] as string) === 'STANDARD_INFREQUENT_ACCESS') {
      lines.push(`  table_class = "STANDARD_INFREQUENT_ACCESS"`);
    }
    lines.push(`  deletion_protection_enabled = ${cfg['deletionProtection'] === true}`);

    lines.push(`  attribute {`, `    name = "${partitionKeyName}"`, `    type = "${partitionKeyType}"`, `  }`);
    if (sortKeyName) {
      lines.push(`  attribute {`, `    name = "${sortKeyName}"`, `    type = "${sortKeyType}"`, `  }`);
    }

    lines.push(`  point_in_time_recovery {`, `    enabled = ${cfg['pointInTimeRecovery'] !== false}`, `  }`);
    if (cfg['serverSideEncryption'] !== false) {
      lines.push(`  server_side_encryption {`, `    enabled = true`, `  }`);
    }
    if (cfg['streamEnabled'] === true) {
      lines.push(`  stream_enabled   = true`, `  stream_view_type = "${cfg['streamViewType'] ?? 'NEW_AND_OLD_IMAGES'}"`);
    }
    if (cfg['ttlAttribute']) {
      lines.push(`  ttl {`, `    attribute_name = "${cfg['ttlAttribute']}"`, `    enabled        = true`, `  }`);
    }

    lines.push(`  tags = {`, `    Name      = "${name}"`, `    ManagedBy = "CloudCraft"`, ...tagLines, `  }`, `}`);
    return lines.join('\n');
  }

  private _elasticacheSubnetGroup(name: string, subnetRefs: string[]): string {
    return `resource "aws_elasticache_subnet_group" "${name}_subnet_group" {
  name       = "${name}-subnet-group"
  subnet_ids = [${subnetRefs.join(', ')}]
}`;
  }

  private _elasticache(name: string, cfg: Record<string, unknown>, subnetGroupRef: string | null, sgRef: string | null): string {
    const numNodes = Number(cfg['numNodes'] ?? 2);
    const multiAz = numNodes > 1 && cfg['multiAzEnabled'] !== false;
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    const lines: string[] = [
      `resource "aws_elasticache_replication_group" "${name}" {`,
      `  replication_group_id = "${name}"`,
      `  description           = "Managed by CloudCraft"`,
      `  engine                = "${cfg['engine'] ?? 'redis'}"`,
      `  engine_version        = "${cfg['engineVersion'] ?? '7.1'}"`,
      `  node_type             = "${cfg['nodeType'] ?? 'cache.t3.medium'}"`,
      `  num_cache_clusters    = ${numNodes}`,
      `  port                  = ${cfg['port'] ?? 6379}`,
      `  automatic_failover_enabled = ${numNodes > 1 && cfg['automaticFailoverEnabled'] !== false}`,
      `  multi_az_enabled           = ${multiAz}`,
      `  at_rest_encryption_enabled = ${cfg['atRestEncryption'] !== false}`,
      `  transit_encryption_enabled = ${cfg['transitEncryption'] !== false}`,
      `  snapshot_retention_limit   = ${cfg['snapshotRetentionLimit'] ?? 5}`,
    ];
    if (subnetGroupRef) lines.push(`  subnet_group_name     = ${subnetGroupRef}`);
    if (sgRef) lines.push(`  security_group_ids    = ${sgRef}`);
    lines.push(`  tags = {`, `    Name      = "${name}"`, `    ManagedBy = "CloudCraft"`, ...tagLines, `  }`, `}`);
    return lines.join('\n');
  }

  private _sqs(name: string, cfg: Record<string, unknown>): string {
    const isFifo = cfg['fifoQueue'] === true;
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    const lines: string[] = [
      `resource "aws_sqs_queue" "${name}" {`,
      `  name                       = "${cfg['queueName'] ?? name}${isFifo ? '.fifo' : ''}"`,
      `  fifo_queue                 = ${isFifo}`,
    ];
    if (isFifo) {
      lines.push(`  content_based_deduplication = ${cfg['contentBasedDeduplication'] === true}`);
    }
    lines.push(
      `  visibility_timeout_seconds = ${cfg['visibilityTimeoutSeconds'] ?? 30}`,
      `  message_retention_seconds  = ${cfg['messageRetentionSeconds'] ?? 345600}`,
      `  delay_seconds              = ${cfg['delaySeconds'] ?? 0}`,
      `  receive_wait_time_seconds  = ${cfg['receiveWaitTimeSeconds'] ?? 0}`,
    );
    if (cfg['encryption'] !== false) {
      if (cfg['kmsMasterKeyId']) {
        lines.push(`  kms_master_key_id          = "${cfg['kmsMasterKeyId']}"`);
      } else {
        lines.push(`  sqs_managed_sse_enabled    = true`);
      }
    }
    if (cfg['deadLetterTargetArn']) {
      lines.push(`  redrive_policy = jsonencode({`, `    deadLetterTargetArn = "${cfg['deadLetterTargetArn']}"`, `    maxReceiveCount     = ${cfg['maxReceiveCount'] ?? 5}`, `  })`);
    }
    lines.push(`  tags = {`, `    Name      = "${name}"`, `    ManagedBy = "CloudCraft"`, ...tagLines, `  }`, `}`);
    return lines.join('\n');
  }

  /**
   * Generates a Fargate/EC2 ECS service: cluster, CloudWatch log group,
   * IAM execution role, task definition (single container), and the
   * service itself. Networking is only attached when the service is
   * connected to a subnet on the canvas.
   */
  private _ecs(name: string, cfg: Record<string, unknown>, subnetRefs: string[], sgRef: string | null): string {
    const launchType = (cfg['launchType'] as string) || 'FARGATE';
    const isFargate = launchType === 'FARGATE';
    const envVars = (cfg['environmentVariables'] && typeof cfg['environmentVariables'] === 'object')
      ? cfg['environmentVariables'] as Record<string, string> : {};
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);
    const containerPort = cfg['containerPort'] ?? 80;

    const envJson = Object.entries(envVars).filter(([k]) => k)
      .map(([k, v]) => `        { "name": "${k}", "value": ${JSON.stringify(v)} }`).join(',\n');

    const parts: string[] = [
      `resource "aws_ecs_cluster" "${name}_cluster" {
  name = "${name}-cluster"
  tags = {
    Name      = "${name}-cluster"
    ManagedBy = "CloudCraft"
  }
}`,
      `resource "aws_cloudwatch_log_group" "${name}_logs" {
  name              = "/ecs/${name}"
  retention_in_days = ${cfg['logRetentionDays'] ?? 30}
}`,
      `resource "aws_iam_role" "${name}_exec_role" {
  name = "${name}-exec-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}`,
      `resource "aws_iam_role_policy_attachment" "${name}_exec_policy" {
  role       = aws_iam_role.${name}_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}`,
      `resource "aws_ecs_task_definition" "${name}" {
  family                   = "${name}"
  requires_compatibilities = ["${launchType}"]
  network_mode             = "${isFargate ? 'awsvpc' : 'bridge'}"
  cpu                      = "${cfg['cpu'] ?? 256}"
  memory                   = "${cfg['memory'] ?? 512}"
  execution_role_arn       = aws_iam_role.${name}_exec_role.arn

  container_definitions = jsonencode([
    {
      name      = "${name}"
      image     = "${cfg['containerImage'] ?? 'nginx:latest'}"
      essential = true
      portMappings = [
        { containerPort = ${containerPort}, hostPort = ${isFargate ? containerPort : 0}, protocol = "tcp" }
      ]${envJson ? `,\n      environment = [\n${envJson}\n      ]` : ''}
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.${name}_logs.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "${name}"
        }
      }
    }
  ])

  tags = {
    Name      = "${name}"
    ManagedBy = "CloudCraft"
${tagLines.join('\n')}
  }
}`,
    ];

    const serviceLines: string[] = [
      `resource "aws_ecs_service" "${name}" {`,
      `  name            = "${name}"`,
      `  cluster         = aws_ecs_cluster.${name}_cluster.id`,
      `  task_definition = aws_ecs_task_definition.${name}.arn`,
      `  desired_count   = ${cfg['desiredCount'] ?? 2}`,
      `  launch_type     = "${launchType}"`,
    ];
    if (Number(cfg['healthCheckGracePeriodSeconds'] ?? 0) > 0) {
      serviceLines.push(`  health_check_grace_period_seconds = ${cfg['healthCheckGracePeriodSeconds']}`);
    }
    if (isFargate) {
      serviceLines.push(`  network_configuration {`);
      serviceLines.push(`    subnets          = [${subnetRefs.join(', ')}]`);
      if (sgRef) serviceLines.push(`    security_groups  = [${sgRef}]`);
      serviceLines.push(`    assign_public_ip = ${cfg['assignPublicIp'] === true}`);
      serviceLines.push(`  }`);
    }
    serviceLines.push(`  tags = {`, `    Name      = "${name}"`, `    ManagedBy = "CloudCraft"`, ...tagLines, `  }`, `}`);
    parts.push(serviceLines.join('\n'));

    const minCap = Number(cfg['minCapacity'] ?? 1);
    const maxCap = Number(cfg['maxCapacity'] ?? 10);
    if (maxCap > minCap) {
      parts.push(
        `resource "aws_appautoscaling_target" "${name}_scaling" {
  max_capacity       = ${maxCap}
  min_capacity       = ${minCap}
  resource_id        = "service/\${aws_ecs_cluster.${name}_cluster.name}/\${aws_ecs_service.${name}.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}`,
      );
    }

    return parts.join('\n\n');
  }

  /**
   * Generates an EKS cluster with its own IAM role plus a single managed
   * node group with its own IAM role and the three policies AWS requires
   * for worker nodes to join the cluster.
   */
  private _eks(name: string, cfg: Record<string, unknown>, subnetRefs: string[]): string {
    const subnetsHcl = subnetRefs.length > 0 ? `[${subnetRefs.join(', ')}]` : `[] # WARNING: no subnets connected to this EKS cluster on the canvas`;
    const logTypes = Array.isArray(cfg['clusterLogTypes']) ? cfg['clusterLogTypes'] as string[] : ['api', 'audit'];
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    const parts: string[] = [
      `resource "aws_iam_role" "${name}_cluster_role" {
  name = "${name}-cluster-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
    }]
  })
}`,
      `resource "aws_iam_role_policy_attachment" "${name}_cluster_policy" {
  role       = aws_iam_role.${name}_cluster_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}`,
    ];

    const clusterLines: string[] = [
      `resource "aws_eks_cluster" "${name}" {`,
      `  name     = "${name}"`,
      `  role_arn = aws_iam_role.${name}_cluster_role.arn`,
      `  version  = "${cfg['version'] ?? '1.30'}"`,
      ``,
      `  vpc_config {`,
      `    subnet_ids              = ${subnetsHcl}`,
      `    endpoint_public_access  = ${cfg['endpointPublicAccess'] !== false}`,
      `    endpoint_private_access = ${cfg['endpointPrivateAccess'] === true}`,
    ];
    if (cfg['endpointPublicAccess'] !== false) {
      clusterLines.push(`    public_access_cidrs     = ["${cfg['publicAccessCidrs'] ?? '0.0.0.0/0'}"]`);
    }
    clusterLines.push(`  }`);
    if (logTypes.length > 0) {
      clusterLines.push(`  enabled_cluster_log_types = [${logTypes.map((t) => `"${t}"`).join(', ')}]`);
    }
    if (cfg['secretsEncryption'] !== false) {
      clusterLines.push(
        `  encryption_config {`,
        `    resources = ["secrets"]`,
        `    provider {`,
        `      key_arn = aws_kms_key.${name}_secrets.arn`,
        `    }`,
        `  }`,
      );
    }
    clusterLines.push(`  tags = {`, `    Name      = "${name}"`, `    ManagedBy = "CloudCraft"`, ...tagLines, `  }`);
    clusterLines.push(`  depends_on = [aws_iam_role_policy_attachment.${name}_cluster_policy]`, `}`);
    parts.push(clusterLines.join('\n'));

    if (cfg['secretsEncryption'] !== false) {
      parts.push(`resource "aws_kms_key" "${name}_secrets" {
  description         = "EKS Secrets encryption for ${name}"
  enable_key_rotation = true
}`);
    }

    parts.push(
      `resource "aws_iam_role" "${name}_node_role" {
  name = "${name}-node-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}`,
      `resource "aws_iam_role_policy_attachment" "${name}_node_worker_policy" {
  role       = aws_iam_role.${name}_node_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}`,
      `resource "aws_iam_role_policy_attachment" "${name}_node_cni_policy" {
  role       = aws_iam_role.${name}_node_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}`,
      `resource "aws_iam_role_policy_attachment" "${name}_node_ecr_policy" {
  role       = aws_iam_role.${name}_node_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}`,
      `resource "aws_eks_node_group" "${name}_nodes" {
  cluster_name    = aws_eks_cluster.${name}.name
  node_group_name = "${name}-nodes"
  node_role_arn   = aws_iam_role.${name}_node_role.arn
  subnet_ids      = ${subnetsHcl}
  instance_types  = ["${cfg['nodeInstanceType'] ?? 't3.medium'}"]
  capacity_type   = "${cfg['capacityType'] ?? 'ON_DEMAND'}"
  disk_size       = ${cfg['nodeDiskSizeGb'] ?? 20}

  scaling_config {
    desired_size = ${cfg['nodeCount'] ?? 3}
    min_size     = ${cfg['nodeCount'] ?? 3}
    max_size     = ${cfg['nodeCount'] ?? 3}
  }

  tags = {
    Name      = "${name}-nodes"
    ManagedBy = "CloudCraft"
${tagLines.join('\n')}
  }

  depends_on = [
    aws_iam_role_policy_attachment.${name}_node_worker_policy,
    aws_iam_role_policy_attachment.${name}_node_cni_policy,
    aws_iam_role_policy_attachment.${name}_node_ecr_policy,
  ]
}`,
    );

    return parts.join('\n\n');
  }

  private _route53(name: string, cfg: Record<string, unknown>): string {
    const isPrivate = cfg['hostedZoneType'] === 'Private';
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    const zoneLines: string[] = [
      `resource "aws_route53_zone" "${name}" {`,
      `  name = "${cfg['domainName'] ?? 'example.com'}"`,
    ];
    if (cfg['comment']) zoneLines.push(`  comment = "${cfg['comment']}"`);
    if (isPrivate) {
      zoneLines.push(`  vpc {`, `    vpc_id = aws_vpc.main.id # WARNING: connect this hosted zone to a VPC on the canvas for a real private zone`, `  }`);
    }
    zoneLines.push(`  tags = {`, `    Name      = "${name}"`, `    ManagedBy = "CloudCraft"`, ...tagLines, `  }`, `}`);

    const recordType = (cfg['recordType'] as string) || 'A';
    const routingPolicy = (cfg['routingPolicy'] as string) || 'Simple';
    const recordLines: string[] = [
      `resource "aws_route53_record" "${name}" {`,
      `  zone_id = aws_route53_zone.${name}.zone_id`,
      `  name    = "${cfg['domainName'] ?? 'example.com'}"`,
      `  type    = "${recordType}"`,
      `  ttl     = ${cfg['ttl'] ?? 300}`,
      `  records = ["${cfg['recordValue'] ?? ''}"]`,
    ];
    if (routingPolicy === 'Weighted') {
      recordLines.push(`  weighted_routing_policy {`, `    weight = ${cfg['weight'] ?? 100}`, `  }`, `  set_identifier = "${name}"`);
    }
    recordLines.push(`}`);

    return [zoneLines.join('\n'), recordLines.join('\n')].join('\n\n');
  }

  private _waf(name: string, cfg: Record<string, unknown>): string {
    const scope = (cfg['scope'] as string) || 'REGIONAL';
    const defaultAction = (cfg['defaultAction'] as string) || 'ALLOW';
    const managedRuleGroups = Array.isArray(cfg['managedRuleGroups']) ? cfg['managedRuleGroups'] as string[] : [];
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    const lines: string[] = [
      `resource "aws_wafv2_web_acl" "${name}" {`,
      `  name  = "${name}"`,
      `  scope = "${scope}"`,
      ``,
      `  default_action {`,
      `    ${defaultAction === 'BLOCK' ? 'block' : 'allow'} {}`,
      `  }`,
    ];

    let priority = 1;
    for (const ruleGroup of managedRuleGroups) {
      lines.push(
        ``,
        `  rule {`,
        `    name     = "${ruleGroup}"`,
        `    priority = ${priority}`,
        ``,
        `    override_action {`,
        `      none {}`,
        `    }`,
        ``,
        `    statement {`,
        `      managed_rule_group_statement {`,
        `        name        = "${ruleGroup}"`,
        `        vendor_name = "AWS"`,
        `      }`,
        `    }`,
        ``,
        `    visibility_config {`,
        `      cloudwatch_metrics_enabled = ${cfg['cloudWatchMetricsEnabled'] !== false}`,
        `      metric_name                = "${name}-${ruleGroup}"`,
        `      sampled_requests_enabled   = ${cfg['sampledRequestsEnabled'] !== false}`,
        `    }`,
        `  }`,
      );
      priority++;
    }

    if (cfg['rateLimitEnabled'] === true) {
      lines.push(
        ``,
        `  rule {`,
        `    name     = "${name}-rate-limit"`,
        `    priority = ${priority}`,
        ``,
        `    action {`,
        `      block {}`,
        `    }`,
        ``,
        `    statement {`,
        `      rate_based_statement {`,
        `        limit              = ${cfg['rateLimitThreshold'] ?? 2000}`,
        `        aggregate_key_type = "IP"`,
        `      }`,
        `    }`,
        ``,
        `    visibility_config {`,
        `      cloudwatch_metrics_enabled = ${cfg['cloudWatchMetricsEnabled'] !== false}`,
        `      metric_name                = "${name}-rate-limit"`,
        `      sampled_requests_enabled   = ${cfg['sampledRequestsEnabled'] !== false}`,
        `    }`,
        `  }`,
      );
    }

    lines.push(
      ``,
      `  visibility_config {`,
      `    cloudwatch_metrics_enabled = ${cfg['cloudWatchMetricsEnabled'] !== false}`,
      `    metric_name                = "${name}"`,
      `    sampled_requests_enabled   = ${cfg['sampledRequestsEnabled'] !== false}`,
      `  }`,
      ``,
      `  tags = {`,
      `    Name      = "${name}"`,
      `    ManagedBy = "CloudCraft"`,
      ...tagLines,
      `  }`,
      `}`,
    );

    return lines.join('\n');
  }

  private _routeTable(name: string, cfg: Record<string, unknown>, vpcRef: string, igwRef: string | null, natRef: string | null, subnetRefs: string[]): string {
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);
    const targetType = (cfg['targetType'] as string) || 'internet_gateway';

    const lines: string[] = [`resource "aws_route_table" "${name}" {`, `  vpc_id = ${vpcRef}`];

    if (targetType === 'internet_gateway') {
      lines.push(`  route {`, `    cidr_block = "${cfg['destinationCidr'] ?? '0.0.0.0/0'}"`);
      lines.push(igwRef ? `    gateway_id = ${igwRef}` : `    gateway_id = aws_internet_gateway.main.id # WARNING: no Internet Gateway connected`);
      lines.push(`  }`);
    } else if (targetType === 'nat_gateway') {
      lines.push(`  route {`, `    cidr_block = "${cfg['destinationCidr'] ?? '0.0.0.0/0'}"`);
      lines.push(natRef ? `    nat_gateway_id = ${natRef}` : `    nat_gateway_id = aws_nat_gateway.main.id # WARNING: no NAT Gateway connected`);
      lines.push(`  }`);
    }

    lines.push(`  tags = {`, `    Name      = "${name}"`, `    ManagedBy = "CloudCraft"`, ...tagLines, `  }`, `}`);

    const assocBlocks = subnetRefs.map((subnetRef, i) =>
      `resource "aws_route_table_association" "${name}_assoc_${i + 1}" {\n  subnet_id      = ${subnetRef}\n  route_table_id = aws_route_table.${name}.id\n}`
    );

    return [lines.join('\n'), ...assocBlocks].join('\n\n');
  }

  private _nacl(name: string, cfg: Record<string, unknown>, vpcRef: string, subnetRefs: string[]): string {
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    const lines: string[] = [`resource "aws_network_acl" "${name}" {`, `  vpc_id     = ${vpcRef}`];
    if (subnetRefs.length > 0) {
      lines.push(`  subnet_ids = [${subnetRefs.join(', ')}]`);
    }

    if (cfg['allowAllInbound'] === true) {
      lines.push(`  ingress {`, `    protocol   = "-1"`, `    rule_no    = 100`, `    action     = "allow"`, `    cidr_block = "0.0.0.0/0"`, `    from_port  = 0`, `    to_port    = 0`, `  }`);
    } else {
      const proto = (cfg['inboundProtocol'] as string) || 'tcp';
      const isPortless = proto === 'all' || proto === 'icmp';
      lines.push(
        `  ingress {`,
        `    protocol   = "${proto === 'all' ? '-1' : proto}"`,
        `    rule_no    = 100`,
        `    action     = "allow"`,
        `    cidr_block = "${cfg['inboundCidr'] ?? '10.0.0.0/16'}"`,
        `    from_port  = ${isPortless ? 0 : (cfg['inboundPortFrom'] ?? 443)}`,
        `    to_port    = ${isPortless ? 0 : (cfg['inboundPortTo'] ?? 443)}`,
        `  }`,
      );
    }

    if (cfg['allowAllOutbound'] !== false) {
      lines.push(`  egress {`, `    protocol   = "-1"`, `    rule_no    = 100`, `    action     = "allow"`, `    cidr_block = "0.0.0.0/0"`, `    from_port  = 0`, `    to_port    = 0`, `  }`);
    } else {
      const outProto = (cfg['outboundProtocol'] as string) || 'all';
      lines.push(
        `  egress {`,
        `    protocol   = "${outProto === 'all' ? '-1' : outProto}"`,
        `    rule_no    = 100`,
        `    action     = "allow"`,
        `    cidr_block = "${cfg['outboundCidr'] ?? '0.0.0.0/0'}"`,
        `    from_port  = 0`,
        `    to_port    = 0`,
        `  }`,
      );
    }

    lines.push(`  tags = {`, `    Name      = "${name}"`, `    ManagedBy = "CloudCraft"`, ...tagLines, `  }`, `}`);
    return lines.join('\n');
  }

  private _iamRole(name: string, cfg: Record<string, unknown>): string {
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);
    const managedPolicyArns = Array.isArray(cfg['managedPolicyArns']) ? cfg['managedPolicyArns'] as string[] : [];

    const parts: string[] = [
      `resource "aws_iam_role" "${name}" {
  name                 = "${name}"
  max_session_duration = ${cfg['maxSessionDurationSeconds'] ?? 3600}
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "${cfg['trustedService'] ?? 'ec2.amazonaws.com'}" }
    }]
  })
  tags = {
    Name      = "${name}"
    ManagedBy = "CloudCraft"
${tagLines.join('\n')}
  }
}`,
    ];

    managedPolicyArns.forEach((arn, i) => {
      parts.push(`resource "aws_iam_role_policy_attachment" "${name}_policy_${i + 1}" {
  role       = aws_iam_role.${name}.name
  policy_arn = "${arn}"
}`);
    });

    return parts.join('\n\n');
  }

  private _kms(name: string, cfg: Record<string, unknown>): string {
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    const lines: string[] = [
      `resource "aws_kms_key" "${name}" {`,
      `  description              = "Managed by CloudCraft"`,
      `  key_usage                = "${cfg['keyUsage'] ?? 'ENCRYPT_DECRYPT'}"`,
      `  customer_master_key_spec = "${cfg['keySpec'] ?? 'SYMMETRIC_DEFAULT'}"`,
      `  enable_key_rotation      = ${cfg['enableKeyRotation'] !== false}`,
      `  multi_region             = ${cfg['multiRegion'] === true}`,
      `  deletion_window_in_days  = ${cfg['deletionWindowDays'] ?? 30}`,
      `  tags = {`,
      `    Name      = "${name}"`,
      `    ManagedBy = "CloudCraft"`,
      ...tagLines,
      `  }`,
      `}`,
      ``,
      `resource "aws_kms_alias" "${name}_alias" {`,
      `  name          = "alias/${name}"`,
      `  target_key_id = aws_kms_key.${name}.key_id`,
      `}`,
    ];
    return lines.join('\n');
  }

  private _cloudwatchAlarm(name: string, cfg: Record<string, unknown>): string {
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    const missingDataMap: Record<string, string> = { missing: 'missing', notBreaching: 'notBreaching', breaching: 'breaching', ignore: 'ignore' };
    const treatMissingData = missingDataMap[(cfg['treatMissingData'] as string) ?? 'missing'] ?? 'missing';

    return [
      `resource "aws_cloudwatch_metric_alarm" "${name}" {
  alarm_name          = "${name}"
  comparison_operator = "${cfg['comparisonOperator'] ?? 'GreaterThanThreshold'}"
  evaluation_periods   = ${cfg['evaluationPeriods'] ?? 2}
  metric_name          = "${cfg['metricName'] ?? 'CPUUtilization'}"
  namespace            = "${cfg['namespace'] ?? 'AWS/EC2'}"
  period               = ${cfg['periodSeconds'] ?? 300}
  statistic            = "${cfg['statistic'] ?? 'Average'}"
  threshold            = ${cfg['threshold'] ?? 80}
  treat_missing_data   = "${treatMissingData}"
  tags = {
    Name      = "${name}"
    ManagedBy = "CloudCraft"
${tagLines.join('\n')}
  }
}`,
      `resource "aws_cloudwatch_log_group" "${name}_logs" {
  name              = "/cloudcraft/${name}"
  retention_in_days = ${cfg['logRetentionDays'] ?? 30}
}`,
    ].join('\n\n');
  }

  private _ebs(name: string, cfg: Record<string, unknown>): string {
    const volumeType = (cfg['volumeType'] as string) || 'gp3';
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    const lines: string[] = [
      `resource "aws_ebs_volume" "${name}" {`,
      `  availability_zone = "${cfg['availabilityZone'] ?? 'us-east-1a'}"`,
      `  size              = ${cfg['sizeGb'] ?? 100}`,
      `  type              = "${volumeType}"`,
    ];
    if (volumeType === 'io1' || volumeType === 'io2' || volumeType === 'gp3') {
      lines.push(`  iops              = ${cfg['iops'] ?? 3000}`);
    }
    if (volumeType === 'gp3') {
      lines.push(`  throughput        = ${cfg['throughputMbps'] ?? 125}`);
    }
    lines.push(`  encrypted         = ${cfg['encrypted'] !== false}`);
    if (cfg['encrypted'] !== false && cfg['kmsKeyId']) {
      lines.push(`  kms_key_id        = "${cfg['kmsKeyId']}"`);
    }
    if (cfg['multiAttachEnabled'] === true && (volumeType === 'io1' || volumeType === 'io2')) {
      lines.push(`  multi_attach_enabled = true`);
    }
    lines.push(`  tags = {`, `    Name      = "${name}"`, `    ManagedBy = "CloudCraft"`, ...tagLines, `  }`, `}`);
    return lines.join('\n');
  }

  private _autoScaling(name: string, cfg: Record<string, unknown>, subnetRefs: string[], sgRef: string | null): string {
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k)
      .map(([k, v]) => `  tag {\n    key                 = "${k}"\n    value               = "${v}"\n    propagate_at_launch = true\n  }`);

    const parts: string[] = [
      `resource "aws_launch_template" "${name}_lt" {
  name_prefix   = "${name}-"
  image_id      = "${cfg['amiId'] ?? 'ami-0c55b159cbfafe1f0'}"
  instance_type = "${cfg['instanceType'] ?? 't3.medium'}"${sgRef ? `\n  vpc_security_group_ids = [${sgRef}]` : ''}
}`,
    ];

    const asgLines: string[] = [
      `resource "aws_autoscaling_group" "${name}" {`,
      `  name                = "${name}"`,
      `  min_size            = ${cfg['minSize'] ?? 2}`,
      `  max_size            = ${cfg['maxSize'] ?? 10}`,
      `  desired_capacity    = ${cfg['desiredCapacity'] ?? 2}`,
      `  health_check_type          = "${cfg['healthCheckType'] ?? 'EC2'}"`,
      `  health_check_grace_period  = ${cfg['healthCheckGracePeriodSeconds'] ?? 300}`,
      `  default_cooldown           = ${cfg['defaultCooldownSeconds'] ?? 300}`,
      subnetRefs.length > 0
        ? `  vpc_zone_identifier = [${subnetRefs.join(', ')}]`
        : `  vpc_zone_identifier = [] # WARNING: no subnets connected to this Auto Scaling group on the canvas`,
      `  launch_template {`,
      `    id      = aws_launch_template.${name}_lt.id`,
      `    version = "$Latest"`,
      `  }`,
      ...tagLines,
      `}`,
    ];
    parts.push(asgLines.join('\n'));

    if (cfg['scalingPolicyEnabled'] !== false) {
      parts.push(`resource "aws_autoscaling_policy" "${name}_target_tracking" {
  name                   = "${name}-target-tracking-cpu"
  autoscaling_group_name = aws_autoscaling_group.${name}.name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
    target_value = ${cfg['targetCpuUtilization'] ?? 60}
  }
}`);
    }

    return parts.join('\n\n');
  }

  private _s3(name: string, cfg: Record<string, unknown>): string {
    const bucketName = (cfg['bucketName'] as string) ?? name;
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const blockAcls = cfg['publicAccess'] === true ? cfg['blockPublicAcls'] === true : true;
    const blockPolicy = cfg['publicAccess'] === true ? cfg['blockPublicPolicy'] === true : true;

    const parts: string[] = [
      `resource "aws_s3_bucket" "${name}" {`,
      `  bucket = "${bucketName}"`,
      `  tags = {`,
      `    Name      = "${name}"`,
      `    ManagedBy = "CloudCraft"`,
    ];
    for (const [k, v] of Object.entries(tags)) {
      if (!k) continue;
      parts.push(`    ${k} = "${v}"`);
    }
    parts.push(`  }`, `}`, ``);

    parts.push(
      `resource "aws_s3_bucket_versioning" "${name}_versioning" {`,
      `  bucket = aws_s3_bucket.${name}.id`,
      `  versioning_configuration {`,
      `    status = "${cfg['versioning'] === true ? 'Enabled' : 'Suspended'}"`,
      `  }`,
      `}`,
      ``,
    );

    if (cfg['encryption'] !== false) {
      const sseAlgorithm = (cfg['encryptionType'] as string) || 'AES256';
      parts.push(
        `resource "aws_s3_bucket_server_side_encryption_configuration" "${name}_sse" {`,
        `  bucket = aws_s3_bucket.${name}.id`,
        `  rule {`,
        `    apply_server_side_encryption_by_default {`,
        `      sse_algorithm     = "${sseAlgorithm}"`,
      );
      if (sseAlgorithm === 'aws:kms' && cfg['kmsKeyId']) {
        parts.push(`      kms_master_key_id = "${cfg['kmsKeyId']}"`);
      }
      parts.push(`    }`, `  }`, `}`, ``);
    }

    parts.push(
      `resource "aws_s3_bucket_public_access_block" "${name}_pab" {`,
      `  bucket                  = aws_s3_bucket.${name}.id`,
      `  block_public_acls       = ${blockAcls}`,
      `  block_public_policy     = ${blockPolicy}`,
      `  ignore_public_acls      = ${blockAcls}`,
      `  restrict_public_buckets = ${cfg['publicAccess'] !== true}`,
      `}`,
    );

    const transitionDays = Number(cfg['lifecycleTransitionDays'] ?? 0);
    const expirationDays = Number(cfg['lifecycleExpirationDays'] ?? 0);
    if (transitionDays > 0 || expirationDays > 0) {
      parts.push(``, `resource "aws_s3_bucket_lifecycle_configuration" "${name}_lifecycle" {`, `  bucket = aws_s3_bucket.${name}.id`, `  rule {`, `    id     = "${name}-lifecycle"`, `    status = "Enabled"`);
      if (transitionDays > 0) {
        parts.push(`    transition {`, `      days          = ${transitionDays}`, `      storage_class = "${cfg['lifecycleTransitionStorageClass'] ?? 'STANDARD_IA'}"`, `    }`);
      }
      if (expirationDays > 0) {
        parts.push(`    expiration {`, `      days = ${expirationDays}`, `    }`);
      }
      parts.push(`  }`, `}`);
    }

    if (cfg['transferAcceleration'] === true) {
      parts.push(``, `resource "aws_s3_bucket_accelerate_configuration" "${name}_accel" {`, `  bucket = aws_s3_bucket.${name}.id`, `  status = "Enabled"`, `}`);
    }

    if (cfg['requesterPays'] === true) {
      parts.push(``, `resource "aws_s3_bucket_request_payment_configuration" "${name}_rp" {`, `  bucket = aws_s3_bucket.${name}.id`, `  payer  = "Requester"`, `}`);
    }

    if (cfg['objectOwnership']) {
      parts.push(``, `resource "aws_s3_bucket_ownership_controls" "${name}_ownership" {`, `  bucket = aws_s3_bucket.${name}.id`, `  rule {`, `    object_ownership = "${cfg['objectOwnership']}"`, `  }`, `}`);
    }

    return parts.join('\n');
  }

  private _alb(name: string, cfg: Record<string, unknown>, vpcRef: string | null, sgRef: string | null, subnetRefs: string[] = []): string {
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    const lines: string[] = [
      `resource "aws_lb" "${name}" {`,
      `  name               = "${name}"`,
      `  internal           = ${cfg['scheme'] === 'internal'}`,
      `  load_balancer_type = "${cfg['lbType'] ?? 'application'}"`,
      `  idle_timeout               = ${cfg['idleTimeoutSeconds'] ?? 60}`,
      `  enable_deletion_protection = ${cfg['deletionProtection'] === true}`,
    ];
    if (sgRef) lines.push(`  security_groups    = ${sgRef}`);
    if (subnetRefs.length > 0) {
      lines.push(`  subnets            = [${subnetRefs.join(', ')}]`);
    } else {
      lines.push(`  subnets            = [] # WARNING: no subnets connected to this ALB on the canvas`);
    }
    lines.push(`  tags = {`, `    Name      = "${name}"`, `    ManagedBy = "CloudCraft"`, ...tagLines, `  }`, `}`);

    const targetProtocol = (cfg['targetProtocol'] as string) || 'HTTP';
    const targetPort = cfg['targetPort'] ?? 80;
    lines.push(
      ``,
      `resource "aws_lb_target_group" "${name}_tg" {`,
      `  name        = "${name}-tg"`,
      `  port        = ${targetPort}`,
      `  protocol    = "${targetProtocol}"`,
      `  vpc_id      = ${vpcRef ?? `aws_vpc.main.id # WARNING: VPC not connected`}`,
      `  target_type = "instance"`,
      ``,
      `  health_check {`,
      `    path                = "${cfg['healthCheckPath'] ?? '/'}"`,
      `    protocol            = "${targetProtocol}"`,
      `    interval            = ${cfg['healthCheckIntervalSeconds'] ?? 30}`,
      `    healthy_threshold   = 3`,
      `    unhealthy_threshold = 3`,
      `  }`,
      `}`,
    );

    const listenerProtocol = (cfg['listenerProtocol'] as string) || 'HTTPS';
    const isTls = listenerProtocol === 'HTTPS' || listenerProtocol === 'TLS';
    lines.push(
      ``,
      `resource "aws_lb_listener" "${name}_listener" {`,
      `  load_balancer_arn = aws_lb.${name}.arn`,
      `  port              = ${cfg['listenerPort'] ?? 443}`,
      `  protocol          = "${listenerProtocol}"`,
    );
    if (isTls) {
      lines.push(`  ssl_policy        = "${cfg['sslPolicy'] ?? 'ELBSecurityPolicy-TLS13-1-2-2021-06'}"`);
      if (cfg['certificateArn']) {
        lines.push(`  certificate_arn   = "${cfg['certificateArn']}"`);
      } else {
        lines.push(`  # WARNING: certificate_arn not set — this listener will fail to apply. Set an ACM certificate ARN.`);
      }
    }
    lines.push(
      `  default_action {`,
      `    type             = "forward"`,
      `    target_group_arn = aws_lb_target_group.${name}_tg.arn`,
      `  }`,
      `}`,
      ``,
      `# Target attachment is not auto-generated — attach EC2/ASG targets to`,
      `# aws_lb_target_group.${name}_tg via aws_lb_target_group_attachment or`,
      `# an Auto Scaling Group's target_group_arns.`,
    );

    return lines.join('\n');
  }

  private _igw(name: string, _cfg: Record<string, unknown>, vpcRef: string): string {
    return `resource "aws_internet_gateway" "${name}" {
  vpc_id = ${vpcRef}
  tags = {
    Name      = "${name}"
    ManagedBy = "CloudCraft"
  }
}`;
  }

  private _nat(name: string, cfg: Record<string, unknown>, subnetRef: string): string {
    return `resource "aws_eip" "${name}_eip" {
  domain = "vpc"
}

resource "aws_nat_gateway" "${name}" {
  allocation_id     = aws_eip.${name}_eip.id
  subnet_id         = ${subnetRef}
  connectivity_type = "${cfg['connectivityType'] ?? 'public'}"
  tags = {
    Name      = "${name}"
    ManagedBy = "CloudCraft"
  }
}`;
  }

  private _sg(name: string, cfg: Record<string, unknown>, vpcRef: string): string {
    const sourceCidr = (cfg['sourceCidr'] as string) || '0.0.0.0/0';
    const isPublicSource = sourceCidr === '0.0.0.0/0';
    const rules: string[] = [];
    if (cfg['allowHttp'] === true) {
      rules.push(`
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["${sourceCidr}"]
    description = "HTTP"
  }`);
    }
    if (cfg['allowHttps'] === true) {
      rules.push(`
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["${sourceCidr}"]
    description = "HTTPS"
  }`);
    }
    if (cfg['allowSsh'] === true) {
      rules.push(`
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["${sourceCidr}"]${isPublicSource ? ' # WARNING: Restrict to known IPs in production' : ''}
    description = "SSH${isPublicSource ? ' - RESTRICT THIS IN PRODUCTION' : ''}"
  }`);
    }
    if (cfg['allowRdp'] === true) {
      rules.push(`
  ingress {
    from_port   = 3389
    to_port     = 3389
    protocol    = "tcp"
    cidr_blocks = ["${sourceCidr}"]${isPublicSource ? ' # WARNING: Restrict to known IPs in production' : ''}
    description = "RDP${isPublicSource ? ' - RESTRICT THIS IN PRODUCTION' : ''}"
  }`);
    }

    const allowAllOutbound = cfg['allowAllOutbound'] !== false;
    const egressCidr = (cfg['egressCidr'] as string) || '0.0.0.0/0';
    const egressBlock = allowAllOutbound
      ? `
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "All outbound"
  }`
      : `
  egress {
    from_port   = 0
    to_port     = 65535
    protocol    = "-1"
    cidr_blocks = ["${egressCidr}"]
    description = "Restricted outbound"
  }`;

    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    return `resource "aws_security_group" "${name}" {
  name        = "${name}"
  description = "${(cfg['description'] as string) || 'Managed by CloudCraft'}"
  vpc_id      = ${vpcRef}
${rules.join('\n')}
${egressBlock}

  tags = {
    Name      = "${name}"
    ManagedBy = "CloudCraft"
${tagLines.join('\n')}
  }
}`;
  }

  private _cloudfront(name: string, cfg: Record<string, unknown>, originDns: string): string {
    const priceClass = (cfg['priceClass'] as string) || 'PriceClass_100';
    const defaultRoot = (cfg['defaultRootObject'] as string) || 'index.html';
    const enabled = cfg['enabled'] !== false;

    return `resource "aws_cloudfront_distribution" "${name}" {
  enabled             = ${enabled}
  price_class         = "${priceClass}"
  default_root_object = "${defaultRoot}"

  origin {
    domain_name = ${originDns}
    origin_id   = "${name}-alb-origin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "match-viewer"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "${name}-alb-origin"

    forwarded_values {
      query_string = true
      cookies {
        forward = "all"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Name      = "${name}"
    ManagedBy = "CloudCraft"
  }
}`;
  }

  private _dataVpc(name: string, cfg: Record<string, unknown>): string {
    const id = (cfg['resourceId'] as string) || (cfg['providerResourceId'] as string) || '';
    return `# Existing AWS VPC (Imported)
data "aws_vpc" "${name}" {
  ${id ? `id = "${id}"` : `default = true`}
}`;
  }

  private _dataSubnet(name: string, cfg: Record<string, unknown>): string {
    const id = (cfg['resourceId'] as string) || (cfg['providerResourceId'] as string) || '';
    return `# Existing AWS Subnet (Imported)
data "aws_subnet" "${name}" {
  ${id ? `id = "${id}"` : `cidr_block = "${cfg['cidrBlock'] ?? '10.0.1.0/24'}"`}
}`;
  }

  private _dataEc2(name: string, cfg: Record<string, unknown>): string {
    const id = (cfg['resourceId'] as string) || (cfg['providerResourceId'] as string) || '';
    return `# Existing AWS EC2 Instance (Imported)
data "aws_instance" "${name}" {
  ${id ? `instance_id = "${id}"` : `filter {\n    name   = "tag:Name"\n    values = ["${name}"]\n  }`}
}`;
  }

  private _dataRds(name: string, cfg: Record<string, unknown>): string {
    const id = (cfg['name'] as string) || (cfg['resourceId'] as string) || name;
    return `# Existing AWS RDS Instance (Imported)
data "aws_db_instance" "${name}" {
  db_instance_identifier = "${id}"
}`;
  }

  private _dataS3(name: string, cfg: Record<string, unknown>): string {
    const bucket = (cfg['bucketName'] as string) || (cfg['resourceId'] as string) || name;
    return `# Existing AWS S3 Bucket (Imported)
data "aws_s3_bucket" "${name}" {
  bucket = "${bucket}"
}`;
  }

  private _dataAlb(name: string, cfg: Record<string, unknown>): string {
    const arn = (cfg['arn'] as string) || (cfg['providerResourceId'] as string);
    return `# Existing AWS Load Balancer (Imported)
data "aws_lb" "${name}" {
  ${arn ? `arn = "${arn}"` : `name = "${name}"`}
}`;
  }

  private _dataSg(name: string, cfg: Record<string, unknown>): string {
    const id = (cfg['resourceId'] as string) || (cfg['providerResourceId'] as string) || '';
    return `# Existing AWS Security Group (Imported)
data "aws_security_group" "${name}" {
  ${id ? `id = "${id}"` : `name = "${name}"`}
}`;
  }
}

// ─── Azure Terraform Generator ────────────────────────────────────────────────

class AzureTerraformGenerator {
  generate(
    resources: DbArchitectureResource[],
    connections: DbArchitectureConnection[],
    projectName: string,
    resolver: ReferenceResolver,
  ): { blocks: string[]; warnings: string[]; resourceMap: Record<string, string> } {
    const blocks: string[] = [];
    const warnings: string[] = [];
    const resourceMap: Record<string, string> = {};

    for (const r of resources) {
      const cfg = this._cfg(r);
      const name = resolver.tfNameOf(r.id) ?? tfName(r.label);
      const isImported = Boolean(cfg.imported || cfg.importState === 'imported');

      switch (r.resourceType) {
        case 'azure_resource_group': {
          if (isImported) {
            blocks.push(this._dataRg(name, cfg));
            resourceMap[r.id] = `data.azurerm_resource_group.${name}`;
          } else {
            blocks.push(this._rg(name, cfg));
            resourceMap[r.id] = `azurerm_resource_group.${name}`;
          }
          break;
        }
        case 'azure_vnet': {
          const rg = resolver.resolveParent(r.id, 'azure_resource_group', connections, resources);
          const isRgImported = rg && Boolean(this._cfg(rg).imported || this._cfg(rg).importState === 'imported');
          const rgPrefix = isRgImported ? 'data.' : '';
          const rgName = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.name` : 'azurerm_resource_group.main.name # WARNING: RG not connected';
          const rgLoc  = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.location` : '"eastus"';
          if (isImported) {
            blocks.push(this._dataVnet(name, cfg, rgName));
            resourceMap[r.id] = `data.azurerm_virtual_network.${name}`;
          } else {
            blocks.push(this._vnet(name, cfg, rgName, rgLoc));
            resourceMap[r.id] = `azurerm_virtual_network.${name}`;
          }
          break;
        }
        case 'azure_subnet': {
          const vnet = resolver.resolveParent(r.id, 'azure_vnet', connections, resources);
          const isVnetImported = vnet && Boolean(this._cfg(vnet).imported || this._cfg(vnet).importState === 'imported');
          const vnetPrefix = isVnetImported ? 'data.' : '';
          const rg   = vnet ? resolver.resolveParent(vnet.id, 'azure_resource_group', connections, resources) : undefined;
          const isRgImported = rg && Boolean(this._cfg(rg).imported || this._cfg(rg).importState === 'imported');
          const rgPrefix = isRgImported ? 'data.' : '';
          const vnetName = vnet ? `${vnetPrefix}azurerm_virtual_network.${resolver.tfNameOf(vnet.id) ?? 'main'}.name` : 'azurerm_virtual_network.main.name # WARNING: VNet not connected';
          const rgName   = rg   ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.name`  : 'azurerm_resource_group.main.name';
          if (isImported) {
            blocks.push(this._dataSubnet(name, cfg, rgName, vnetName));
            resourceMap[r.id] = `data.azurerm_subnet.${name}`;
          } else {
            blocks.push(this._subnet(name, cfg, rgName, vnetName));
            resourceMap[r.id] = `azurerm_subnet.${name}`;
          }
          break;
        }
        case 'azure_vm': {
          const rg = resolver.resolveParent(r.id, 'azure_resource_group', connections, resources);
          const isRgImported = rg && Boolean(this._cfg(rg).imported || this._cfg(rg).importState === 'imported');
          const rgPrefix = isRgImported ? 'data.' : '';
          const rgName = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.name` : 'azurerm_resource_group.main.name # WARNING: RG not connected';
          const rgLoc  = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.location` : '"eastus"';
          if (isImported) {
            blocks.push(this._dataVm(name, cfg, rgName));
            resourceMap[r.id] = `data.azurerm_virtual_machine.${name}`;
          } else {
            const subnet = resolver.resolveParent(r.id, 'azure_subnet', connections, resources);
            const isSubnetImported = subnet && Boolean(this._cfg(subnet).imported || this._cfg(subnet).importState === 'imported');
            const subnetPrefix = isSubnetImported ? 'data.' : '';
            const subnetRef = subnet ? `${subnetPrefix}azurerm_subnet.${resolver.tfNameOf(subnet.id) ?? 'main'}.id` : null;
            if (!subnetRef) {
              warnings.push(`Azure VM "${r.label}" is not connected to any subnet — a network interface cannot be generated and this resource's Terraform will fail to apply.`);
            }
            const isWindows = cfg['osType'] === 'Windows';
            if (cfg['publicIpEnabled'] === true) {
              blocks.push(this._publicIp(name, rgName, rgLoc));
            }
            blocks.push(this._nic(name, rgName, rgLoc, subnetRef, cfg['publicIpEnabled'] === true));
            blocks.push(this._vm(name, cfg, rgName, rgLoc));
            resourceMap[r.id] = `${isWindows ? 'azurerm_windows_virtual_machine' : 'azurerm_linux_virtual_machine'}.${name}`;
          }
          break;
        }
        case 'azure_blob':
        case 'azure_storage': {
          const rg = resolver.resolveParent(r.id, 'azure_resource_group', connections, resources);
          const isRgImported = rg && Boolean(this._cfg(rg).imported || this._cfg(rg).importState === 'imported');
          const rgPrefix = isRgImported ? 'data.' : '';
          const rgName = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.name` : 'azurerm_resource_group.main.name # WARNING: RG not connected';
          const rgLoc  = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.location` : '"eastus"';
          if (isImported) {
            blocks.push(this._dataStorage(name, cfg, rgName));
            resourceMap[r.id] = `data.azurerm_storage_account.${name}`;
          } else {
            blocks.push(this._storage(name, cfg, rgName, rgLoc));
            resourceMap[r.id] = `azurerm_storage_account.${name}`;
          }
          break;
        }
        case 'azure_sql': {
          const rg = resolver.resolveParent(r.id, 'azure_resource_group', connections, resources);
          const isRgImported = rg && Boolean(this._cfg(rg).imported || this._cfg(rg).importState === 'imported');
          const rgPrefix = isRgImported ? 'data.' : '';
          const rgName = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.name` : 'azurerm_resource_group.main.name # WARNING: RG not connected';
          const rgLoc  = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.location` : '"eastus"';
          blocks.push(this._sql(name, cfg, rgName, rgLoc));
          resourceMap[r.id] = `azurerm_mssql_server.${name}_server`;
          break;
        }
        case 'azure_cosmos_db': {
          const rg = resolver.resolveParent(r.id, 'azure_resource_group', connections, resources);
          const isRgImported = rg && Boolean(this._cfg(rg).imported || this._cfg(rg).importState === 'imported');
          const rgPrefix = isRgImported ? 'data.' : '';
          const rgName = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.name` : 'azurerm_resource_group.main.name # WARNING: RG not connected';
          const rgLoc  = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.location` : '"eastus"';
          blocks.push(this._cosmosDb(name, cfg, rgName, rgLoc));
          resourceMap[r.id] = `azurerm_cosmosdb_account.${name}`;
          break;
        }
        case 'azure_functions': {
          const rg = resolver.resolveParent(r.id, 'azure_resource_group', connections, resources);
          const isRgImported = rg && Boolean(this._cfg(rg).imported || this._cfg(rg).importState === 'imported');
          const rgPrefix = isRgImported ? 'data.' : '';
          const rgName = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.name` : 'azurerm_resource_group.main.name # WARNING: RG not connected';
          const rgLoc  = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.location` : '"eastus"';
          blocks.push(this._functionApp(name, cfg, rgName, rgLoc));
          resourceMap[r.id] = `${cfg['osType'] === 'Windows' ? 'azurerm_windows_function_app' : 'azurerm_linux_function_app'}.${name}`;
          break;
        }
        case 'azure_aks': {
          const rg = resolver.resolveParent(r.id, 'azure_resource_group', connections, resources);
          const isRgImported = rg && Boolean(this._cfg(rg).imported || this._cfg(rg).importState === 'imported');
          const rgPrefix = isRgImported ? 'data.' : '';
          const rgName = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.name` : 'azurerm_resource_group.main.name # WARNING: RG not connected';
          const rgLoc  = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.location` : '"eastus"';
          blocks.push(this._aks(name, cfg, rgName, rgLoc));
          resourceMap[r.id] = `azurerm_kubernetes_cluster.${name}`;
          break;
        }
        case 'azure_app_service': {
          const rg = resolver.resolveParent(r.id, 'azure_resource_group', connections, resources);
          const isRgImported = rg && Boolean(this._cfg(rg).imported || this._cfg(rg).importState === 'imported');
          const rgPrefix = isRgImported ? 'data.' : '';
          const rgName = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.name` : 'azurerm_resource_group.main.name # WARNING: RG not connected';
          const rgLoc  = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.location` : '"eastus"';
          blocks.push(this._appService(name, cfg, rgName, rgLoc));
          resourceMap[r.id] = `${cfg['osType'] === 'Windows' ? 'azurerm_windows_web_app' : 'azurerm_linux_web_app'}.${name}`;
          break;
        }
        case 'azure_nsg': {
          const rg = resolver.resolveParent(r.id, 'azure_resource_group', connections, resources);
          const isRgImported = rg && Boolean(this._cfg(rg).imported || this._cfg(rg).importState === 'imported');
          const rgPrefix = isRgImported ? 'data.' : '';
          const rgName = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.name` : 'azurerm_resource_group.main.name # WARNING: RG not connected';
          const rgLoc  = rg ? `${rgPrefix}azurerm_resource_group.${resolver.tfNameOf(rg.id) ?? 'main'}.location` : '"eastus"';
          if (isImported) {
            blocks.push(this._dataNsg(name, cfg, rgName));
            resourceMap[r.id] = `data.azurerm_network_security_group.${name}`;
          } else {
            blocks.push(this._nsg(name, cfg, rgName, rgLoc));
            resourceMap[r.id] = `azurerm_network_security_group.${name}`;
          }
          break;
        }
        default: {
          warnings.push(`Unsupported Azure resource type: ${r.resourceType} (resource: ${r.label})`);
        }
      }
    }

    return { blocks, warnings, resourceMap };
  }

  private _cfg(r: DbArchitectureResource): Record<string, unknown> {
    try { return JSON.parse(r.configJson) as Record<string, unknown>; } catch { return {}; }
  }

  private _dataRg(name: string, cfg: Record<string, unknown>): string {
    const rgName = (cfg['name'] as string) || (cfg['resourceGroup'] as string) || name;
    return `# Existing Azure Resource Group (Imported)
data "azurerm_resource_group" "${name}" {
  name = "${rgName}"
}`;
  }

  private _dataVnet(name: string, cfg: Record<string, unknown>, rgName: string): string {
    const vnetName = (cfg['name'] as string) || name;
    return `# Existing Azure Virtual Network (Imported)
data "azurerm_virtual_network" "${name}" {
  name                = "${vnetName}"
  resource_group_name = ${rgName}
}`;
  }

  private _dataSubnet(name: string, cfg: Record<string, unknown>, rgName: string, vnetName: string): string {
    const subName = (cfg['name'] as string) || name;
    return `# Existing Azure Subnet (Imported)
data "azurerm_subnet" "${name}" {
  name                 = "${subName}"
  virtual_network_name = ${vnetName}
  resource_group_name  = ${rgName}
}`;
  }

  private _dataVm(name: string, cfg: Record<string, unknown>, rgName: string): string {
    const vmName = (cfg['name'] as string) || name;
    return `# Existing Azure Virtual Machine (Imported)
data "azurerm_virtual_machine" "${name}" {
  name                = "${vmName}"
  resource_group_name = ${rgName}
}`;
  }

  private _dataStorage(name: string, cfg: Record<string, unknown>, rgName: string): string {
    const storageName = ((cfg['name'] as string) || name).replace(/_/g, '').toLowerCase().substring(0, 24);
    return `# Existing Azure Storage Account (Imported)
data "azurerm_storage_account" "${name}" {
  name                = "${storageName}"
  resource_group_name = ${rgName}
}`;
  }

  private _dataNsg(name: string, cfg: Record<string, unknown>, rgName: string): string {
    const nsgName = (cfg['name'] as string) || name;
    return `# Existing Azure Network Security Group (Imported)
data "azurerm_network_security_group" "${name}" {
  name                = "${nsgName}"
  resource_group_name = ${rgName}
}`;
  }

  private _rg(name: string, cfg: Record<string, unknown>): string {
    return `resource "azurerm_resource_group" "${name}" {
  name     = "${name}"
  location = "${cfg['location'] ?? 'eastus'}"
  tags = {
    ManagedBy = "CloudCraft"
  }
}`;
  }

  private _vnet(name: string, cfg: Record<string, unknown>, rgName: string, rgLoc: string): string {
    return `resource "azurerm_virtual_network" "${name}" {
  name                = "${name}"
  address_space       = ["${cfg['addressSpace'] ?? '10.0.0.0/16'}"]
  location            = ${rgLoc}
  resource_group_name = ${rgName}
  tags = {
    ManagedBy = "CloudCraft"
  }
}`;
  }

  private _subnet(name: string, cfg: Record<string, unknown>, rgName: string, vnetName: string): string {
    return `resource "azurerm_subnet" "${name}" {
  name                 = "${name}"
  resource_group_name  = ${rgName}
  virtual_network_name = ${vnetName}
  address_prefixes     = ["${cfg['addressPrefix'] ?? '10.0.1.0/24'}"]
}`;
  }

  private _publicIp(name: string, rgName: string, rgLoc: string): string {
    return `resource "azurerm_public_ip" "${name}_pip" {
  name                = "${name}-pip"
  resource_group_name = ${rgName}
  location            = ${rgLoc}
  allocation_method   = "Static"
  sku                 = "Standard"
}`;
  }

  private _nic(name: string, rgName: string, rgLoc: string, subnetRef: string | null, hasPublicIp = false): string {
    return `resource "azurerm_network_interface" "${name}_nic" {
  name                = "${name}-nic"
  resource_group_name = ${rgName}
  location            = ${rgLoc}

  ip_configuration {
    name                          = "internal"
    subnet_id                     = ${subnetRef ?? `azurerm_subnet.main.id # WARNING: subnet not connected`}
    private_ip_address_allocation = "Dynamic"${hasPublicIp ? `\n    public_ip_address_id          = azurerm_public_ip.${name}_pip.id` : ''}
  }
}`;
  }

  private _vm(name: string, cfg: Record<string, unknown>, rgName: string, rgLoc: string): string {
    const isWindows = cfg['osType'] === 'Windows';
    const resourceType = isWindows ? 'azurerm_windows_virtual_machine' : 'azurerm_linux_virtual_machine';
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    const lines: string[] = [
      `resource "${resourceType}" "${name}" {`,
      `  name                  = "${name}"`,
      `  resource_group_name   = ${rgName}`,
      `  location              = ${rgLoc}`,
      `  size                  = "${cfg['size'] ?? 'Standard_B2s'}"`,
      `  admin_username        = "${cfg['adminUsername'] ?? 'azureuser'}"`,
      `  network_interface_ids = [azurerm_network_interface.${name}_nic.id]`,
      `  availability_zone     = ${cfg['availabilityZone'] ? `"${cfg['availabilityZone']}"` : 'null'}`,
      `  encryption_at_host_enabled = ${cfg['encryptionAtHostEnabled'] === true}`,
    ];

    if (isWindows) {
      lines.push(`  admin_password        = var.windows_admin_password`);
    }

    lines.push(
      `  os_disk {`,
      `    caching              = "${cfg['osDiskCaching'] ?? 'ReadWrite'}"`,
      `    storage_account_type = "${cfg['osDiskType'] ?? 'Premium_LRS'}"`,
    );
    if (cfg['osDiskSizeGb']) lines.push(`    disk_size_gb         = ${cfg['osDiskSizeGb']}`);
    lines.push(`  }`);

    lines.push(
      `  source_image_reference {`,
      `    publisher = "${cfg['imagePublisher'] ?? (isWindows ? 'MicrosoftWindowsServer' : 'Canonical')}"`,
      `    offer     = "${cfg['imageOffer'] ?? (isWindows ? 'WindowsServer' : '0001-com-ubuntu-server-focal')}"`,
      `    sku       = "${cfg['imageSku'] ?? (isWindows ? '2022-datacenter-azure-edition' : '20_04-lts')}"`,
      `    version   = "latest"`,
      `  }`,
    );

    if (!isWindows) {
      lines.push(
        `  admin_ssh_key {`,
        `    username   = "${cfg['adminUsername'] ?? 'azureuser'}"`,
        `    public_key = var.admin_ssh_public_key`,
        `  }`,
      );
    }

    if (cfg['bootDiagnosticsEnabled'] !== false) {
      lines.push(`  boot_diagnostics {`, `    storage_account_uri = null # managed storage account`, `  }`);
    }

    if (cfg['customData']) {
      lines.push(`  custom_data = base64encode(${JSON.stringify(cfg['customData'])})`);
    }

    lines.push(`  tags = {`, `    ManagedBy = "CloudCraft"`, ...tagLines, `  }`, `}`);

    return lines.join('\n');
  }

  private _storage(name: string, cfg: Record<string, unknown>, rgName: string, rgLoc: string): string {
    const storageName = name.replace(/_/g, '').toLowerCase().substring(0, 24);
    const sku = (cfg['sku'] as string) ?? 'Standard_LRS';
    const tier = sku.startsWith('Premium') ? 'Premium' : 'Standard';
    const replication = sku.replace('Standard_', '').replace('Premium_', '') || 'LRS';
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    const lines: string[] = [
      `resource "azurerm_storage_account" "${name}" {`,
      `  name                     = "${storageName}"`,
      `  resource_group_name      = ${rgName}`,
      `  location                 = ${rgLoc}`,
      `  account_kind             = "${cfg['kind'] ?? 'StorageV2'}"`,
      `  account_tier             = "${tier}"`,
      `  account_replication_type = "${replication}"`,
      `  enable_https_traffic_only = ${cfg['httpsOnly'] !== false}`,
      `  min_tls_version          = "${cfg['minimumTlsVersion'] ?? 'TLS1_2'}"`,
      `  allow_nested_items_to_be_public = ${cfg['allowBlobPublicAccess'] === true}`,
    ];

    const blobVersioning = cfg['blobVersioningEnabled'] === true;
    const softDeleteDays = Number(cfg['blobSoftDeleteRetentionDays'] ?? 0);
    if (blobVersioning || softDeleteDays > 0) {
      lines.push(`  blob_properties {`);
      if (blobVersioning) lines.push(`    versioning_enabled = true`);
      if (softDeleteDays > 0) {
        lines.push(`    delete_retention_policy {`, `      days = ${softDeleteDays}`, `    }`);
      }
      lines.push(`  }`);
    }

    if (cfg['networkDefaultAction'] === 'Deny') {
      lines.push(`  network_rules {`, `    default_action = "Deny"`, `  }`);
    }

    lines.push(`  tags = {`, `    Name      = "${name}"`, `    ManagedBy = "CloudCraft"`, ...tagLines, `  }`, `}`);
    return lines.join('\n');
  }

  private _sql(name: string, cfg: Record<string, unknown>, rgName: string, rgLoc: string): string {
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);
    const tagsBlock = tagLines.length > 0 ? `\n  tags = {\n${tagLines.join('\n')}\n  }` : '';

    const parts: string[] = [
      `resource "azurerm_mssql_server" "${name}_server" {
  name                         = "${name}-server"
  resource_group_name          = ${rgName}
  location                     = ${rgLoc}
  version                      = "12.0"
  administrator_login          = var.sql_admin_login
  administrator_login_password = var.sql_admin_password
  minimum_tls_version          = "${cfg['minimumTlsVersion'] ?? '1.2'}"
  public_network_access_enabled = ${cfg['publicNetworkAccess'] === true}${tagsBlock}
}`,
      `resource "azurerm_mssql_database" "${name}" {
  name                        = "${name}"
  server_id                   = azurerm_mssql_server.${name}_server.id
  max_size_gb                 = ${cfg['maxSizeGb'] ?? 250}
  sku_name                    = "${cfg['tier'] ?? 'S0'}"
  zone_redundant               = ${cfg['zoneRedundant'] === true}
  read_scale                   = ${cfg['readScale'] === true}
  storage_account_type         = "${cfg['requestedBackupStorageRedundancy'] ?? 'Geo'}"
  transparent_data_encryption_enabled = ${cfg['transparentDataEncryptionEnabled'] !== false}${tagsBlock}
}`,
    ];

    if (cfg['publicNetworkAccess'] === true && cfg['allowAzureServices'] !== false) {
      parts.push(`resource "azurerm_mssql_firewall_rule" "${name}_allow_azure_services" {
  name             = "AllowAllWindowsAzureIps"
  server_id        = azurerm_mssql_server.${name}_server.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}`);
    }

    if (cfg['auditingEnabled'] === true) {
      parts.push(`# NOTE: extended auditing policy requires a storage account or Log Analytics
# workspace destination. Connect one on the canvas to generate
# azurerm_mssql_server_extended_auditing_policy automatically — not yet wired.`);
    }

    return parts.join('\n\n');
  }

  private _cosmosDb(name: string, cfg: Record<string, unknown>, rgName: string, rgLoc: string): string {
    return `resource "azurerm_cosmosdb_account" "${name}" {
  name                          = "${name}"
  resource_group_name           = ${rgName}
  location                      = ${rgLoc}
  offer_type                    = "Standard"
  kind                          = "GlobalDocumentDB"
  public_network_access_enabled = ${cfg['publicNetworkAccess'] === true}

  consistency_policy {
    consistency_level = "${cfg['defaultConsistency'] ?? 'Session'}"
  }

  geo_location {
    location          = ${rgLoc}
    failover_priority = 0
  }
}`;
  }

  /**
   * Generates a Function App plus the storage account and hosting plan it
   * requires. A dedicated storage account is created per function app
   * (the standard pattern) rather than assuming one exists on the canvas.
   */
  private _functionApp(name: string, cfg: Record<string, unknown>, rgName: string, rgLoc: string): string {
    const isWindows = cfg['osType'] === 'Windows';
    const resourceType = isWindows ? 'azurerm_windows_function_app' : 'azurerm_linux_function_app';
    const planType = (cfg['planType'] as string) || 'Y1';
    const skuName = planType === 'Y1' ? 'Y1' : planType;
    const storageName = `${name}fnsa`.replace(/[^a-z0-9]/gi, '').toLowerCase().substring(0, 24);
    const runtime = (cfg['runtime'] as string) || 'node';
    const runtimeVersion = (cfg['runtimeVersion'] as string) || '20';
    const appSettings = (cfg['appSettings'] && typeof cfg['appSettings'] === 'object') ? cfg['appSettings'] as Record<string, string> : {};
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    const runtimeKeyMap: Record<string, string> = { node: 'node_version', python: 'python_version', dotnet: 'dotnet_version', java: 'java_version', powershell: 'powershell_core_version' };
    const runtimeKey = runtimeKeyMap[runtime] ?? 'node_version';

    const parts: string[] = [
      `resource "azurerm_storage_account" "${name}_sa" {
  name                     = "${storageName}"
  resource_group_name      = ${rgName}
  location                 = ${rgLoc}
  account_tier             = "Standard"
  account_replication_type = "LRS"
  tags = {
    ManagedBy = "CloudCraft"
  }
}`,
      `resource "azurerm_service_plan" "${name}_plan" {
  name                = "${name}-plan"
  resource_group_name = ${rgName}
  location            = ${rgLoc}
  os_type             = "${isWindows ? 'Windows' : 'Linux'}"
  sku_name            = "${skuName}"
}`,
    ];

    const appLines: string[] = [
      `resource "${resourceType}" "${name}" {`,
      `  name                       = "${name}"`,
      `  resource_group_name        = ${rgName}`,
      `  location                   = ${rgLoc}`,
      `  service_plan_id            = azurerm_service_plan.${name}_plan.id`,
      `  storage_account_name       = azurerm_storage_account.${name}_sa.name`,
      `  storage_account_access_key = azurerm_storage_account.${name}_sa.primary_access_key`,
      `  https_only                 = ${cfg['httpsOnly'] !== false}`,
      `  public_network_access_enabled = ${cfg['publicNetworkAccess'] !== false}`,
      `  site_config {`,
      `    minimum_tls_version = "${cfg['minimumTlsVersion'] ?? '1.2'}"`,
    ];
    if (planType !== 'Y1') {
      appLines.push(`    always_on           = ${cfg['alwaysOn'] === true}`);
    }
    appLines.push(`    application_stack {`, `      ${runtimeKey} = "${runtimeVersion}"`, `    }`, `  }`);

    if (Object.keys(appSettings).length > 0) {
      appLines.push(`  app_settings = {`);
      for (const [k, v] of Object.entries(appSettings)) {
        if (!k) continue;
        appLines.push(`    "${k}" = "${v}"`);
      }
      appLines.push(`  }`);
    }

    appLines.push(`  tags = {`, `    Name      = "${name}"`, `    ManagedBy = "CloudCraft"`, ...tagLines, `  }`, `}`);
    parts.push(appLines.join('\n'));

    return parts.join('\n\n');
  }

  private _aks(name: string, cfg: Record<string, unknown>, rgName: string, rgLoc: string): string {
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);
    const autoscale = cfg['enableAutoScaling'] === true;

    const lines: string[] = [
      `resource "azurerm_kubernetes_cluster" "${name}" {`,
      `  name                = "${name}"`,
      `  resource_group_name = ${rgName}`,
      `  location            = ${rgLoc}`,
      `  dns_prefix          = "${cfg['dnsPrefix'] ?? name}"`,
      `  sku_tier            = "${cfg['skuTier'] ?? 'Free'}"`,
      `  private_cluster_enabled = ${cfg['privateClusterEnabled'] === true}`,
    ];
    if (cfg['kubernetesVersion']) {
      lines.push(`  kubernetes_version  = "${cfg['kubernetesVersion']}"`);
    }
    lines.push(
      ``,
      `  default_node_pool {`,
      `    name       = "default"`,
      `    vm_size    = "${cfg['nodeVmSize'] ?? 'Standard_D2s_v3'}"`,
      `    node_count = ${cfg['nodeCount'] ?? 3}`,
    );
    if (autoscale) {
      lines.push(`    enable_auto_scaling = true`, `    min_count           = ${cfg['minNodeCount'] ?? 1}`, `    max_count           = ${cfg['maxNodeCount'] ?? 5}`);
    }
    lines.push(`  }`, ``);
    lines.push(`  identity {`, `    type = "SystemAssigned"`, `  }`);
    lines.push(``, `  network_profile {`, `    network_plugin = "${cfg['networkPlugin'] ?? 'azure'}"`, `  }`);
    if (cfg['rbacEnabled'] !== false) {
      lines.push(``, `  azure_active_directory_role_based_access_control {`, `    azure_rbac_enabled = true`, `  }`);
    }
    lines.push(`  tags = {`, `    Name      = "${name}"`, `    ManagedBy = "CloudCraft"`, ...tagLines, `  }`, `}`);
    return lines.join('\n');
  }

  /**
   * Generates an App Service (Web App) plus the Service Plan it requires.
   * Windows vs Linux branches to the correct resource type and stack key —
   * the same distinction that was silently wrong for azurerm_virtual_machine
   * before that bug was fixed earlier in this pass.
   */
  private _appService(name: string, cfg: Record<string, unknown>, rgName: string, rgLoc: string): string {
    const isWindows = cfg['osType'] === 'Windows';
    const resourceType = isWindows ? 'azurerm_windows_web_app' : 'azurerm_linux_web_app';
    const skuName = (cfg['skuName'] as string) || 'B1';
    const runtime = (cfg['runtime'] as string) || 'node';
    const runtimeVersion = (cfg['runtimeVersion'] as string) || '20-lts';
    const appSettings = (cfg['appSettings'] && typeof cfg['appSettings'] === 'object') ? cfg['appSettings'] as Record<string, string> : {};
    const tags = (cfg['tags'] && typeof cfg['tags'] === 'object') ? cfg['tags'] as Record<string, string> : {};
    const tagLines = Object.entries(tags).filter(([k]) => k).map(([k, v]) => `    ${k} = "${v}"`);

    const runtimeKeyMap: Record<string, string> = {
      node: 'node_version', python: 'python_version', dotnet: 'dotnet_version',
      java: 'java_version', php: 'php_version', docker: 'docker_image_name',
    };
    const runtimeKey = runtimeKeyMap[runtime] ?? 'node_version';

    const parts: string[] = [
      `resource "azurerm_service_plan" "${name}_plan" {
  name                = "${name}-plan"
  resource_group_name = ${rgName}
  location            = ${rgLoc}
  os_type             = "${isWindows ? 'Windows' : 'Linux'}"
  sku_name            = "${skuName}"
}`,
    ];

    const appLines: string[] = [
      `resource "${resourceType}" "${name}" {`,
      `  name                       = "${name}"`,
      `  resource_group_name        = ${rgName}`,
      `  location                   = ${rgLoc}`,
      `  service_plan_id            = azurerm_service_plan.${name}_plan.id`,
      `  https_only                 = ${cfg['httpsOnly'] !== false}`,
      `  public_network_access_enabled = ${cfg['publicNetworkAccess'] !== false}`,
      `  client_affinity_enabled    = ${cfg['clientAffinityEnabled'] === true}`,
    ];
    if (cfg['healthCheckPath']) {
      appLines.push(`  health_check_path          = "${cfg['healthCheckPath']}"`);
    }
    appLines.push(
      `  site_config {`,
      `    minimum_tls_version = "${cfg['minimumTlsVersion'] ?? '1.2'}"`,
      `    ftps_state          = "${cfg['ftpsState'] ?? 'Disabled'}"`,
      `    http2_enabled       = ${cfg['http2Enabled'] !== false}`,
    );
    if (skuName !== 'F1') {
      appLines.push(`    always_on           = ${cfg['alwaysOn'] !== false}`);
    }
    appLines.push(`    application_stack {`, `      ${runtimeKey} = "${runtimeVersion}"`, `    }`, `  }`);

    if (Object.keys(appSettings).length > 0) {
      appLines.push(`  app_settings = {`);
      for (const [k, v] of Object.entries(appSettings)) {
        if (!k) continue;
        appLines.push(`    "${k}" = "${v}"`);
      }
      appLines.push(`  }`);
    }

    appLines.push(`  tags = {`, `    Name      = "${name}"`, `    ManagedBy = "CloudCraft"`, ...tagLines, `  }`, `}`);
    parts.push(appLines.join('\n'));

    return parts.join('\n\n');
  }

  private _nsg(name: string, cfg: Record<string, unknown>, rgName: string, rgLoc: string): string {
    const rules: string[] = [];
    if (cfg['allowSsh'] === true) {
      rules.push(`
  security_rule {
    name                       = "allow-ssh"
    priority                   = 1001
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "*" # WARNING: Restrict to known IPs in production
    destination_address_prefix = "*"
    description                = "SSH - RESTRICT THIS IN PRODUCTION"
  }`);
    }
    if (cfg['allowRdp'] === true) {
      rules.push(`
  security_rule {
    name                       = "allow-rdp"
    priority                   = 1002
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "3389"
    source_address_prefix      = "*" # WARNING: Restrict to known IPs in production
    destination_address_prefix = "*"
    description                = "RDP - RESTRICT THIS IN PRODUCTION"
  }`);
    }
    if (cfg['allowHttp'] === true) {
      rules.push(`
  security_rule {
    name                       = "allow-http"
    priority                   = 1003
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }`);
    }
    return `resource "azurerm_network_security_group" "${name}" {
  name                = "${name}"
  location            = ${rgLoc}
  resource_group_name = ${rgName}
${rules.join('\n')}
  tags = {
    ManagedBy = "CloudCraft"
  }
}`;
  }
}

// ─── TerraformGenerator ───────────────────────────────────────────────────────

export class TerraformGenerator {
  private readonly awsGen = new AwsTerraformGenerator();
  private readonly azureGen = new AzureTerraformGenerator();

  generate(input: TerraformGenerationInput): TerraformGenerationResult {
    if (input.resources.length === 0) {
      return {
        files: [{
          filename: 'main.tf',
          content: '# No resources defined yet.\n# Add resources to the canvas and save to generate Terraform code.\n',
          provider: 'all',
        }],
        warnings: [],
        resourceMap: {},
        providers: [],
      };
    }

    const resolver = new ReferenceResolver(input.resources);
    const projectName = input.projectName ?? 'cloudcraft';
    const awsResources   = input.resources.filter((r) => r.provider === 'aws');
    const azureResources = input.resources.filter((r) => r.provider === 'azure');

    const warnings: string[] = [];
    const resourceMap: Record<string, string> = {};
    const providers: string[] = [];

    let awsBlocks:   string[] = [];
    let azureBlocks: string[] = [];

    if (awsResources.length > 0) {
      const result = this.awsGen.generate(awsResources, input.connections, projectName, resolver);
      awsBlocks = result.blocks;
      warnings.push(...result.warnings);
      Object.assign(resourceMap, result.resourceMap);
      providers.push('aws');
    }

    if (azureResources.length > 0) {
      const result = this.azureGen.generate(azureResources, input.connections, projectName, resolver);
      azureBlocks = result.blocks;
      warnings.push(...result.warnings);
      Object.assign(resourceMap, result.resourceMap);
      providers.push('azure');
    }

    const unsupportedProviders = new Set(
      input.resources
        .map((r) => r.provider)
        .filter((p) => p !== 'aws' && p !== 'azure')
    );
    for (const p of unsupportedProviders) {
      warnings.push(`Provider "${p}" is no longer supported by CloudCraft — its resources were skipped. Remove them from the architecture or re-platform to AWS/Azure.`);
    }

    const files = this._buildFiles(awsBlocks, azureBlocks, providers, projectName, input);

    return { files, warnings, resourceMap, providers };
  }

  private _buildFiles(
    awsBlocks: string[],
    azureBlocks: string[],
    providers: string[],
    projectName: string,
    input: TerraformGenerationInput,
  ): TerraformFile[] {
    const files: TerraformFile[] = [];

    // main.tf
    const mainParts: string[] = [];
    if (awsBlocks.length > 0) {
      mainParts.push('# ─── AWS Resources ───────────────────────────────────────────────────────────');
      mainParts.push('');
      mainParts.push(...awsBlocks.map((b) => b + '\n'));
    }
    if (azureBlocks.length > 0) {
      if (mainParts.length > 0) mainParts.push('');
      mainParts.push('# ─── Azure Resources ─────────────────────────────────────────────────────────');
      mainParts.push('');
      mainParts.push(...azureBlocks.map((b) => b + '\n'));
    }
    files.push({ filename: 'main.tf', content: mainParts.join('\n'), provider: 'all' });

    // providers.tf
    files.push({ filename: 'providers.tf', content: this._providersFile(providers), provider: 'all' });

    // variables.tf
    files.push({ filename: 'variables.tf', content: this._variablesFile(providers, input), provider: 'all' });

    // outputs.tf
    files.push({ filename: 'outputs.tf', content: this._outputsFile(input.resources, input.connections), provider: 'all' });

    // terraform.tfvars
    files.push({ filename: 'terraform.tfvars', content: this._tfvarsFile(providers, projectName), provider: 'all' });

    return files;
  }

  private _providersFile(providers: string[]): string {
    const hasAws   = providers.includes('aws');
    const hasAzure = providers.includes('azure');

    const required: string[] = [];
    if (hasAws)   required.push('    aws = {\n      source  = "hashicorp/aws"\n      version = "~> 5.0"\n    }');
    if (hasAzure) required.push('    azurerm = {\n      source  = "hashicorp/azurerm"\n      version = "~> 3.0"\n    }');

    const parts: string[] = [
      `terraform {
  required_version = ">= 1.5"
  required_providers {
${required.join('\n')}
  }
}
`,
    ];

    if (hasAws) {
      parts.push(`provider "aws" {
  region = var.aws_region
  # No credentials in Terraform — use AWS_ACCESS_KEY_ID env var or an instance profile
}
`);
    }

    if (hasAzure) {
      parts.push(`provider "azurerm" {
  features {}
  # No credentials in Terraform — use ARM_CLIENT_ID / ARM_CLIENT_SECRET env vars or managed identity
}
`);
    }

    return parts.join('\n');
  }

  private _variablesFile(providers: string[], input: TerraformGenerationInput): string {
    const hasAws   = providers.includes('aws');
    const hasAzure = providers.includes('azure');
    const hasRds   = input.resources.some((r) => r.resourceType === 'aws_rds');
    const hasSql   = input.resources.some((r) => r.resourceType === 'azure_sql');
    const hasVm    = input.resources.some((r) => r.resourceType === 'azure_vm');
    const parseCfg = (r: DbArchitectureResource): Record<string, unknown> => {
      try { return JSON.parse(r.configJson) as Record<string, unknown>; } catch { return {}; }
    };
    const hasWindowsVm = input.resources.some((r) => r.resourceType === 'azure_vm' && parseCfg(r)['osType'] === 'Windows');
    const hasLinuxVm   = input.resources.some((r) => r.resourceType === 'azure_vm' && parseCfg(r)['osType'] !== 'Windows');

    const vars: string[] = [
      `variable "environment" {
  description = "Environment name (development, staging, production)"
  type        = string
  default     = "production"
}`,
      `variable "project_name" {
  description = "Project name used as a prefix for resources"
  type        = string
  default     = "cloudcraft"
}`,
    ];

    if (hasAws) {
      vars.push(`variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}`);
    }

    if (hasAzure) {
      vars.push(`variable "azure_location" {
  description = "Azure region for all resources"
  type        = string
  default     = "eastus"
}`);
    }

    if (hasRds) {
      vars.push(`variable "db_name" {
  description = "Database name"
  type        = string
  default     = "appdb"
}

variable "db_username" {
  description = "Database admin username"
  type        = string
  default     = "dbadmin"
}

variable "db_password" {
  description = "Database admin password — set via TF_VAR_db_password environment variable"
  type        = string
  sensitive   = true
}`);
    }

    if (hasSql) {
      vars.push(`variable "sql_admin_login" {
  description = "Azure SQL Server admin login"
  type        = string
  default     = "sqladmin"
}

variable "sql_admin_password" {
  description = "Azure SQL Server admin password — set via TF_VAR_sql_admin_password environment variable"
  type        = string
  sensitive   = true
}`);
    }

    if (hasVm && hasLinuxVm) {
      vars.push(`variable "admin_ssh_public_key" {
  description = "SSH public key for Azure VM admin access"
  type        = string
}`);
    }

    if (hasWindowsVm) {
      vars.push(`variable "windows_admin_password" {
  description = "Windows VM admin password — set via TF_VAR_windows_admin_password environment variable"
  type        = string
  sensitive   = true
}`);
    }

    return vars.join('\n\n') + '\n';
  }

  private _outputsFile(resources: DbArchitectureResource[], _connections: DbArchitectureConnection[]): string {
    const outputs: string[] = [];

    for (const r of resources) {
      const cfg = (() => { try { return JSON.parse(r.configJson) as Record<string, unknown>; } catch { return {}; } })();
      const name = tfName((cfg['name'] as string) || r.label);

      if (r.resourceType === 'aws_alb') {
        outputs.push(`output "${name}_dns_name" {
  description = "DNS name of the Application Load Balancer ${r.label}"
  value       = aws_lb.${name}.dns_name
}`);
      } else if (r.resourceType === 'aws_rds') {
        outputs.push(`output "${name}_endpoint" {
  description = "RDS instance endpoint for ${r.label}"
  value       = aws_db_instance.${name}.endpoint
  sensitive   = true
}`);
      } else if (r.resourceType === 'aws_s3') {
        outputs.push(`output "${name}_bucket_arn" {
  description = "ARN of the S3 bucket ${r.label}"
  value       = aws_s3_bucket.${name}.arn
}
output "${name}_bucket_name" {
  description = "Name of the S3 bucket ${r.label}"
  value       = aws_s3_bucket.${name}.bucket
}`);
      } else if (r.resourceType === 'aws_vpc') {
        outputs.push(`output "${name}_vpc_id" {
  description = "ID of the VPC ${r.label}"
  value       = aws_vpc.${name}.id
}`);
      } else if (r.resourceType === 'azure_sql') {
        outputs.push(`output "${name}_server_fqdn" {
  description = "FQDN of the Azure SQL Server for ${r.label}"
  value       = azurerm_mssql_server.${name}_server.fully_qualified_domain_name
  sensitive   = true
}`);
      } else if (r.resourceType === 'azure_storage' || r.resourceType === 'azure_blob') {
        const storageName = name.replace(/_/g, '').toLowerCase().substring(0, 24);
        outputs.push(`output "${name}_storage_account_name" {
  description = "Name of the Azure Storage Account for ${r.label}"
  value       = azurerm_storage_account.${name}.name
}`);
      }
    }

    return outputs.length > 0 ? outputs.join('\n\n') + '\n' : '# No outputs defined — add resources to generate outputs\n';
  }

  private _tfvarsFile(providers: string[], projectName: string): string {
    const lines: string[] = [
      `environment  = "production"`,
      `project_name = "${projectName}"`,
    ];
    if (providers.includes('aws'))   lines.push(`aws_region   = "us-east-1"`);
    if (providers.includes('azure')) lines.push(`azure_location = "eastus"`);
    lines.push('');
    lines.push('# Sensitive values — set via environment variables:');
    lines.push('# TF_VAR_db_password          = "..."');
    lines.push('# TF_VAR_sql_admin_password   = "..."');
    lines.push('# TF_VAR_admin_ssh_public_key = "..."');
    lines.push('# TF_VAR_windows_admin_password = "..."');
    return lines.join('\n') + '\n';
  }
}

export const terraformGenerator = new TerraformGenerator();
