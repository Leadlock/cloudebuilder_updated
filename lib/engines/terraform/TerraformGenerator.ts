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
          const subnet = resolver.resolveParent(r.id, 'aws_subnet', connections, resources);
          const isSubnetImported = subnet && Boolean(this._cfg(subnet).imported || this._cfg(subnet).importState === 'imported');
          const sg = resolver.resolveParent(r.id, 'aws_sg', connections, resources);
          const isSgImported = sg && Boolean(this._cfg(sg).imported || this._cfg(sg).importState === 'imported');
          const subnetRef = subnet
            ? `${isSubnetImported ? 'data.' : ''}aws_subnet.${resolver.tfNameOf(subnet.id) ?? 'main'}.id`
            : null;
          const sgRef = sg
            ? `[${isSgImported ? 'data.' : ''}aws_security_group.${resolver.tfNameOf(sg.id) ?? 'main'}.id]`
            : null;

          if (isImported) {
            blocks.push(this._dataRds(name, cfg));
            resourceMap[r.id] = `data.aws_db_instance.${name}`;
          } else {
            blocks.push(this._rds(name, cfg, subnetRef, sgRef));
            resourceMap[r.id] = `aws_db_instance.${name}`;
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
        case 'aws_alb': {
          const sg = resolver.resolveParent(r.id, 'aws_sg', connections, resources);
          const isSgImported = sg && Boolean(this._cfg(sg).imported || this._cfg(sg).importState === 'imported');
          const sgRef = sg
            ? `[${isSgImported ? 'data.' : ''}aws_security_group.${resolver.tfNameOf(sg.id) ?? 'main'}.id]`
            : null;

          if (isImported) {
            blocks.push(this._dataAlb(name, cfg));
            resourceMap[r.id] = `data.aws_lb.${name}`;
          } else {
            blocks.push(this._alb(name, cfg, sgRef));
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
    const lines: string[] = [
      `resource "aws_instance" "${name}" {`,
      `  ami           = "${cfg['ami'] ?? 'ami-0c55b159cbfafe1f0'}"`,
      `  instance_type = "${cfg['instanceType'] ?? 't3.micro'}"`,
    ];
    if (cfg['keyName']) lines.push(`  key_name      = "${cfg['keyName']}"`);
    if (subnetRef)      lines.push(`  subnet_id     = ${subnetRef}`);
    if (sgRef)          lines.push(`  vpc_security_group_ids = ${sgRef}`);
    lines.push(`  tags = {`);
    lines.push(`    Name      = "${name}"`);
    lines.push(`    ManagedBy = "CloudCraft"`);
    lines.push(`  }`);
    lines.push(`}`);
    return lines.join('\n');
  }

  private _rds(name: string, cfg: Record<string, unknown>, subnetRef: string | null, sgRef: string | null): string {
    const lines: string[] = [
      `resource "aws_db_instance" "${name}" {`,
      `  identifier              = "${name}"`,
      `  engine                  = "${cfg['engine'] ?? 'mysql'}"`,
      `  engine_version          = "${cfg['engineVersion'] ?? '8.0'}"`,
      `  instance_class          = "${cfg['instanceClass'] ?? 'db.t3.micro'}"`,
      `  allocated_storage       = ${cfg['allocatedStorage'] ?? 20}`,
      `  storage_type            = "gp3"`,
      `  storage_encrypted       = ${cfg['encrypted'] !== false}`,
      `  multi_az                = ${cfg['multiAz'] === true}`,
      `  publicly_accessible     = ${cfg['publiclyAccessible'] === true}`,
      `  skip_final_snapshot     = true`,
      `  db_name                 = var.db_name`,
      `  username                = var.db_username`,
      `  password                = var.db_password`,
    ];
    if (sgRef) lines.push(`  vpc_security_group_ids  = ${sgRef}`);
    lines.push(`  tags = {`);
    lines.push(`    Name      = "${name}"`);
    lines.push(`    ManagedBy = "CloudCraft"`);
    lines.push(`  }`);
    lines.push(`}`);
    return lines.join('\n');
  }

  private _s3(name: string, cfg: Record<string, unknown>): string {
    const bucketName = (cfg['bucketName'] as string) ?? name;
    const parts: string[] = [
      `resource "aws_s3_bucket" "${name}" {`,
      `  bucket = "${bucketName}"`,
      `  tags = {`,
      `    Name      = "${name}"`,
      `    ManagedBy = "CloudCraft"`,
      `  }`,
      `}`,
      ``,
      `resource "aws_s3_bucket_versioning" "${name}_versioning" {`,
      `  bucket = aws_s3_bucket.${name}.id`,
      `  versioning_configuration {`,
      `    status = "${cfg['versioning'] === true ? 'Enabled' : 'Suspended'}"`,
      `  }`,
      `}`,
      ``,
      `resource "aws_s3_bucket_server_side_encryption_configuration" "${name}_sse" {`,
      `  bucket = aws_s3_bucket.${name}.id`,
      `  rule {`,
      `    apply_server_side_encryption_by_default {`,
      `      sse_algorithm = "AES256"`,
      `    }`,
      `  }`,
      `}`,
      ``,
      `resource "aws_s3_bucket_public_access_block" "${name}_pab" {`,
      `  bucket                  = aws_s3_bucket.${name}.id`,
      `  block_public_acls       = ${cfg['publicAccess'] !== true}`,
      `  block_public_policy     = ${cfg['publicAccess'] !== true}`,
      `  ignore_public_acls      = ${cfg['publicAccess'] !== true}`,
      `  restrict_public_buckets = ${cfg['publicAccess'] !== true}`,
      `}`,
    ];
    return parts.join('\n');
  }

  private _alb(name: string, cfg: Record<string, unknown>, sgRef: string | null): string {
    const lines: string[] = [
      `resource "aws_lb" "${name}" {`,
      `  name               = "${name}"`,
      `  internal           = ${cfg['scheme'] === 'internal'}`,
      `  load_balancer_type = "${cfg['lbType'] ?? 'application'}"`,
      `  enable_deletion_protection = false`,
    ];
    if (sgRef) lines.push(`  security_groups    = ${sgRef}`);
    lines.push(`  tags = {`);
    lines.push(`    Name      = "${name}"`);
    lines.push(`    ManagedBy = "CloudCraft"`);
    lines.push(`  }`);
    lines.push(`}`);
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
    const rules: string[] = [];
    if (cfg['allowHttp'] === true) {
      rules.push(`
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTP"
  }`);
    }
    if (cfg['allowHttps'] === true) {
      rules.push(`
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS"
  }`);
    }
    if (cfg['allowSsh'] === true) {
      rules.push(`
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"] # WARNING: Restrict to known IPs in production
    description = "SSH - RESTRICT THIS IN PRODUCTION"
  }`);
    }
    return `resource "aws_security_group" "${name}" {
  name        = "${name}"
  description = "Managed by CloudCraft"
  vpc_id      = ${vpcRef}
${rules.join('\n')}
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "All outbound"
  }

  tags = {
    Name      = "${name}"
    ManagedBy = "CloudCraft"
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
            blocks.push(this._vm(name, cfg, rgName, rgLoc));
            resourceMap[r.id] = `azurerm_linux_virtual_machine.${name}`;
          }
          break;
        }
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

  private _vm(name: string, cfg: Record<string, unknown>, rgName: string, rgLoc: string): string {
    return `resource "azurerm_linux_virtual_machine" "${name}" {
  name                = "${name}"
  resource_group_name = ${rgName}
  location            = ${rgLoc}
  size                = "${cfg['size'] ?? 'Standard_B2s'}"
  admin_username      = "${cfg['adminUsername'] ?? 'azureuser'}"

  network_interface_ids = []  # TODO: attach azurerm_network_interface

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "${cfg['osDiskType'] ?? 'Premium_LRS'}"
  }

  source_image_reference {
    publisher = "${cfg['imagePublisher'] ?? 'Canonical'}"
    offer     = "${cfg['imageOffer'] ?? '0001-com-ubuntu-server-focal'}"
    sku       = "${cfg['imageSku'] ?? '20_04-lts'}"
    version   = "latest"
  }

  admin_ssh_key {
    username   = "${cfg['adminUsername'] ?? 'azureuser'}"
    public_key = var.admin_ssh_public_key
  }

  tags = {
    ManagedBy = "CloudCraft"
  }
}`;
  }

  private _storage(name: string, cfg: Record<string, unknown>, rgName: string, rgLoc: string): string {
    const storageName = name.replace(/_/g, '').toLowerCase().substring(0, 24);
    const sku = (cfg['sku'] as string) ?? 'Standard_LRS';
    const tier = sku.startsWith('Premium') ? 'Premium' : 'Standard';
    const replication = sku.replace('Standard_', '').replace('Premium_', '') || 'LRS';

    return `resource "azurerm_storage_account" "${name}" {
  name                     = "${storageName}"
  resource_group_name      = ${rgName}
  location                 = ${rgLoc}
  account_tier             = "${tier}"
  account_replication_type = "${replication}"
  enable_https_traffic_only = ${cfg['httpsOnly'] !== false}
  min_tls_version          = "TLS1_2"
  tags = {
    ManagedBy = "CloudCraft"
  }
}`;
  }

  private _sql(name: string, cfg: Record<string, unknown>, rgName: string, rgLoc: string): string {
    return `resource "azurerm_mssql_server" "${name}_server" {
  name                         = "${name}-server"
  resource_group_name          = ${rgName}
  location                     = ${rgLoc}
  version                      = "12.0"
  administrator_login          = var.sql_admin_login
  administrator_login_password = var.sql_admin_password
  minimum_tls_version          = "1.2"
  public_network_access_enabled = ${cfg['publicNetworkAccess'] === true}
}

resource "azurerm_mssql_database" "${name}" {
  name         = "${name}"
  server_id    = azurerm_mssql_server.${name}_server.id
  max_size_gb  = ${cfg['maxSizeGb'] ?? 250}
  sku_name     = "${cfg['tier'] ?? 'S0'}"

  transparent_data_encryption_enabled = true
}`;
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
      if (awsBlocks.length > 0) mainParts.push('');
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

    if (hasVm) {
      vars.push(`variable "admin_ssh_public_key" {
  description = "SSH public key for Azure VM admin access"
  type        = string
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
      } else if (r.resourceType === 'azure_storage') {
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
    return lines.join('\n') + '\n';
  }
}

export const terraformGenerator = new TerraformGenerator();
