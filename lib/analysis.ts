import { CanvasNode, CanvasEdge, SecurityIssue, CostItem } from '@/types';
import { getResourceDefinition } from './resources';
import { runAssessment } from './engines/assessment/AssessmentEngine';
import type { Finding } from './engines/assessment/types';

/**
 * Security findings for a canvas graph, produced by the unified assessment
 * engine (lib/engines/assessment). Returns SECURITY-domain FAIL/WARNING
 * findings only; reliability/operations/cost findings belong to the
 * Well-Architected review. Kept as a compatibility wrapper for callers that
 * only need a flat issue list — new code should call runAssessment() to also
 * get coverage, NOT_EVALUATED controls and evidence.
 */
export function runSecurityScan(nodes: CanvasNode[], edges: CanvasEdge[] = []): SecurityIssue[] {
  const assessment = runAssessment({ nodes, edges });
  return assessment.findings.filter((f) => f.domain === 'SECURITY').map(findingToIssue);
}

export function findingToIssue(f: Finding): SecurityIssue {
  const sev = f.severity === 'INFORMATIONAL' ? 'low' : (f.severity.toLowerCase() as SecurityIssue['severity']);
  return {
    id: f.findingId,
    findingId: f.findingId,
    nodeId: f.resourceIds[0] ?? '',
    nodeLabel: f.resourceLabels.join(', ') || 'Architecture',
    severity: sev,
    engineSeverity: f.severity,
    status: f.status as 'FAIL' | 'WARNING',
    message: f.title,
    recommendation: f.recommendation,
    fixable: f.autoFix.available,
    autoFixSafety: f.autoFix.safety,
    ruleId: f.ruleId,
  };
}

/**
 * @deprecated Issue-count scoring cannot account for coverage. Use
 * runAssessment(...).securityScore, which is coverage-aware and returns null
 * when nothing could be evaluated. Retained for legacy callers: it now
 * delegates to the same weighting used by the engine for failing checks.
 */
export function calculateSecurityScore(issues: SecurityIssue[]): number {
  if (issues.length === 0) return 100;
  const weights = { critical: 25, high: 15, medium: 8, low: 3 };
  const totalDeduction = issues.reduce((acc, i) => acc + weights[i.severity], 0);
  return Math.max(0, 100 - totalDeduction);
}

export function calculateCosts(nodes: CanvasNode[]): CostItem[] {
  const costs: CostItem[] = [];
  const instanceCostMap: Record<string, number> = {
    't3.micro': 8.76, 't3.small': 17.52, 't3.medium': 35.04, 't3.large': 70.08,
    'm5.large': 87.6, 'm5.xlarge': 175.2, 'c5.large': 76.65, 'r5.large': 109.5,
    'Standard_B1s': 8.76, 'Standard_B2s': 36.5, 'Standard_B4ms': 73.0,
    'Standard_D2s_v3': 87.6, 'Standard_D4s_v3': 175.2, 'Standard_E2s_v3': 91.98,
  };
  for (const node of nodes) {
    const def = getResourceDefinition(node.resourceType);
    if (!def) continue;
    let monthlyCost = def.monthlyBaseCost;
    const breakdown: { label: string; cost: number }[] = [];
    if (node.resourceType === 'aws_ec2') {
      const instanceType = node.config.instanceType as string;
      const cost = instanceCostMap[instanceType] ?? 33.84;
      monthlyCost = cost;
      breakdown.push({ label: `Instance (${instanceType})`, cost });
    } else if (node.resourceType === 'azure_vm') {
      const size = node.config.size as string;
      const cost = instanceCostMap[size] ?? 36.5;
      monthlyCost = cost;
      breakdown.push({ label: `VM Size (${size})`, cost });
    } else if (node.resourceType === 'aws_rds') {
      const multiAzMultiplier = node.config.multiAz ? 2 : 1;
      const instanceCost = 48.6 * multiAzMultiplier;
      const storageCost = 23;
      monthlyCost = instanceCost + storageCost;
      breakdown.push({ label: `Instance${node.config.multiAz ? ' (Multi-AZ)' : ''}`, cost: instanceCost });
      breakdown.push({ label: 'Storage (100GB)', cost: storageCost });
    } else if (node.resourceType === 'aws_s3') {
      const storageCost = 0.023 * 50;
      const transferCost = 9;
      monthlyCost = storageCost + transferCost;
      breakdown.push({ label: 'Storage (50GB)', cost: storageCost });
      breakdown.push({ label: 'Data Transfer', cost: transferCost });
    } else if (monthlyCost > 0) {
      breakdown.push({ label: def.label, cost: monthlyCost });
    }
    if (monthlyCost > 0) {
      costs.push({ nodeId: node.id, nodeLabel: node.label, resourceType: node.resourceType, provider: node.provider, monthlyCost, breakdown });
    }
  }
  return costs;
}

export function generateTerraform(nodes: CanvasNode[], edges: CanvasEdge[] = [], provider: string = 'aws'): string {
  if (nodes.length === 0) {
    return `# No resources defined yet.\n# Add resources to the canvas to generate Terraform code.\n`;
  }
  // Auto-detect if provider not explicitly specified
  if (provider === 'aws' && nodes.some(n => n.provider === 'azure')) {
    provider = nodes.some(n => n.provider === 'aws') ? 'multi' : 'azure';
  }
  const lines: string[] = [];

  // Multi-cloud: generate both AWS and Azure blocks
  if (provider === 'multi') {
    const awsNodes   = nodes.filter((n) => n.provider === 'aws');
    const azureNodes = nodes.filter((n) => n.provider === 'azure');
    const awsPart    = generateTerraform(awsNodes,   edges, 'aws');
    const azurePart  = generateTerraform(azureNodes, edges, 'azure');
    return [
      awsPart,
      '\n# ─── Azure Resources ─────────────────────────────────────────────────────────\n',
      azurePart,
    ].join('\n');
  }

  function tfName(n: CanvasNode): string {
    const raw = (n.config?.name as string) || n.label || n.id;
    return raw.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^([0-9])/, 'res_$1') || 'res';
  }

  if (provider === 'aws') {
    lines.push(`terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

`);

    const defaultVpc = nodes.find((n) => n.resourceType === 'aws_vpc');
    const defaultSubnet = nodes.find((n) => n.resourceType === 'aws_subnet');

    for (const node of nodes) {
      const cfg = node.config || {};
      const name = tfName(node);

      // Resolve parent VPC
      let vpcRef = defaultVpc ? `aws_vpc.${tfName(defaultVpc)}.id` : 'aws_vpc.main.id';
      if (node.groupId) {
        const parent = nodes.find((n) => n.id === node.groupId);
        if (parent && parent.resourceType === 'aws_vpc') {
          vpcRef = `aws_vpc.${tfName(parent)}.id`;
        } else if (parent && parent.groupId) {
          const grandParent = nodes.find((n) => n.id === parent.groupId);
          if (grandParent && grandParent.resourceType === 'aws_vpc') {
            vpcRef = `aws_vpc.${tfName(grandParent)}.id`;
          }
        }
      }

      if (node.resourceType === 'aws_vpc') {
        lines.push(`resource "aws_vpc" "${name}" {
  cidr_block           = "${cfg.cidrBlock || '10.0.0.0/16'}"
  enable_dns_support   = ${cfg.enableDnsSupport !== false}
  enable_dns_hostnames = ${cfg.enableDnsHostnames !== false}
  tags = { Name = "${name}" }
}
`);
      } else if (node.resourceType === 'aws_subnet') {
        lines.push(`resource "aws_subnet" "${name}" {
  vpc_id                  = ${vpcRef}
  cidr_block              = "${cfg.cidrBlock || '10.0.1.0/24'}"
  availability_zone       = "${cfg.availabilityZone || 'us-east-1a'}"
  map_public_ip_on_launch = ${cfg.mapPublicIpOnLaunch ? 'true' : 'false'}
  tags = { Name = "${name}" }
}
`);
      } else if (node.resourceType === 'aws_ec2') {
        lines.push(`resource "aws_instance" "${name}" {
  ami           = "${cfg.ami || 'ami-0c55b159cbfafe1f0'}"
  instance_type = "${cfg.instanceType || 't3.micro'}"
  ${cfg.keyName ? `key_name      = "${cfg.keyName}"` : '# key_name   = "your-key-pair"'}
  tags = { Name = "${name}" }
}
`);
      } else if (node.resourceType === 'aws_auto_scaling') {
        lines.push(`resource "aws_autoscaling_group" "${name}" {
  name                = "${name}"
  min_size            = ${cfg.minSize || 2}
  max_size            = ${cfg.maxSize || 10}
  desired_capacity    = ${cfg.desiredCapacity || 2}
  health_check_type   = "EC2"
  tags = [
    { key = "Name", value = "${name}", propagate_at_launch = true }
  ]
}
`);
      } else if (node.resourceType === 'aws_s3') {
        lines.push(`resource "aws_s3_bucket" "${name}" {
  bucket = "${cfg.bucketName || name}"
  tags   = { Name = "${name}" }
}

resource "aws_s3_bucket_versioning" "${name}_versioning" {
  bucket = aws_s3_bucket.${name}.id
  versioning_configuration {
    status = "${cfg.versioning !== false ? 'Enabled' : 'Suspended'}"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "${name}_sse" {
  bucket = aws_s3_bucket.${name}.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "${name}_block" {
  bucket                  = aws_s3_bucket.${name}.id
  block_public_acls       = ${!cfg.publicAccess ? 'true' : 'false'}
  block_public_policy     = ${!cfg.publicAccess ? 'true' : 'false'}
  ignore_public_acls      = ${!cfg.publicAccess ? 'true' : 'false'}
  restrict_public_buckets = ${!cfg.publicAccess ? 'true' : 'false'}
}
`);
      } else if (node.resourceType === 'aws_rds') {
        lines.push(`resource "aws_db_instance" "${name}" {
  identifier          = "${name}"
  engine              = "${cfg.engine || 'postgres'}"
  instance_class      = "${cfg.instanceClass || 'db.t3.medium'}"
  allocated_storage   = 50
  multi_az            = ${cfg.multiAz ? 'true' : 'false'}
  storage_encrypted   = ${cfg.encrypted !== false}
  skip_final_snapshot = true
  tags = { Name = "${name}" }
}
`);
      } else if (node.resourceType === 'aws_elasticache') {
        lines.push(`resource "aws_elasticache_cluster" "${name}" {
  cluster_id           = "${name}"
  engine               = "redis"
  node_type            = "${cfg.nodeType || 'cache.t3.medium'}"
  num_cache_nodes      = ${cfg.numNodes || 2}
  parameter_group_name = "default.redis7"
  port                 = 6379
  tags = { Name = "${name}" }
}
`);
      } else if (node.resourceType === 'aws_alb') {
        lines.push(`resource "aws_lb" "${name}" {
  name               = "${name}"
  internal           = ${cfg.scheme === 'internal' ? 'true' : 'false'}
  load_balancer_type = "${cfg.lbType || 'application'}"
  tags = { Name = "${name}" }
}
`);
      } else if (node.resourceType === 'aws_igw') {
        lines.push(`resource "aws_internet_gateway" "${name}" {
  vpc_id = ${vpcRef}
  tags   = { Name = "${name}" }
}
`);
      } else if (node.resourceType === 'aws_nat') {
        const subRef = defaultSubnet ? `aws_subnet.${tfName(defaultSubnet)}.id` : 'aws_subnet.main.id';
        lines.push(`resource "aws_eip" "${name}_eip" {
  domain = "vpc"
}

resource "aws_nat_gateway" "${name}" {
  allocation_id     = aws_eip.${name}_eip.id
  subnet_id         = ${subRef}
  connectivity_type = "${cfg.connectivityType || 'public'}"
  tags = { Name = "${name}" }
}
`);
      } else if (node.resourceType === 'aws_cloudfront') {
        lines.push(`resource "aws_cloudfront_distribution" "${name}" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Managed by CloudCraft"
  price_class         = "${cfg.priceClass || 'PriceClass_100'}"

  origin {
    domain_name = "origin.example.com"
    origin_id   = "primaryOrigin"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "primaryOrigin"

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

  tags = { Name = "${name}" }
}
`);
      } else if (node.resourceType === 'aws_route53') {
        lines.push(`resource "aws_route53_zone" "${name}" {
  name = "${cfg.domainName || 'example.com'}"
  tags = { Name = "${name}" }
}
`);
      } else if (node.resourceType === 'aws_waf') {
        lines.push(`resource "aws_wafv2_web_acl" "${name}" {
  name        = "${name}"
  description = "CloudCraft Production WAF WebACL"
  scope       = "${cfg.scope || 'REGIONAL'}"

  default_action {
    allow {}
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${name}Metric"
    sampled_requests_enabled   = true
  }
}
`);
      } else if (node.resourceType === 'aws_sg') {
        lines.push(`resource "aws_security_group" "${name}" {
  name        = "${name}"
  description = "Managed by CloudCraft"
  vpc_id      = ${vpcRef}

  ${cfg.allowHttp ? `ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }` : ''}

  ${cfg.allowHttps ? `ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }` : ''}

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${name}" }
}
`);
      }
    }
  } else if (provider === 'azure') {
    lines.push(`terraform {
  required_version = ">= 1.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}

`);
    const defaultRg = nodes.find((n) => n.resourceType === 'azure_resource_group');
    const defaultVnet = nodes.find((n) => n.resourceType === 'azure_vnet');

    for (const node of nodes) {
      const cfg = node.config || {};
      const name = tfName(node);

      const rgNameRef = defaultRg ? `azurerm_resource_group.${tfName(defaultRg)}.name` : 'azurerm_resource_group.main.name';
      const rgLocRef = defaultRg ? `azurerm_resource_group.${tfName(defaultRg)}.location` : 'azurerm_resource_group.main.location';
      const vnetNameRef = defaultVnet ? `azurerm_virtual_network.${tfName(defaultVnet)}.name` : 'azurerm_virtual_network.main.name';

      if (node.resourceType === 'azure_resource_group') {
        lines.push(`resource "azurerm_resource_group" "${name}" {
  name     = "${name}"
  location = "${cfg.location || 'eastus'}"
}
`);
      } else if (node.resourceType === 'azure_vnet') {
        lines.push(`resource "azurerm_virtual_network" "${name}" {
  name                = "${name}"
  address_space       = ["${cfg.addressSpace || '10.0.0.0/16'}"]
  location            = ${rgLocRef}
  resource_group_name = ${rgNameRef}
}
`);
      } else if (node.resourceType === 'azure_subnet') {
        lines.push(`resource "azurerm_subnet" "${name}" {
  name                 = "${name}"
  resource_group_name  = ${rgNameRef}
  virtual_network_name = ${vnetNameRef}
  address_prefixes     = ["${cfg.addressPrefix || '10.0.1.0/24'}"]
}
`);
      } else if (node.resourceType === 'azure_vm') {
        lines.push(`resource "azurerm_linux_virtual_machine" "${name}" {
  name                = "${name}"
  resource_group_name = ${rgNameRef}
  location            = ${rgLocRef}
  size                = "${cfg.size || 'Standard_B2s'}"
  admin_username      = "${cfg.adminUsername || 'azureuser'}"

  network_interface_ids = []

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-focal"
    sku       = "20_04-lts"
    version   = "latest"
  }

  admin_ssh_key {
    username   = "${cfg.adminUsername || 'azureuser'}"
    public_key = file("~/.ssh/id_rsa.pub")
  }
}
`);
      } else if (node.resourceType === 'azure_vmss') {
        lines.push(`resource "azurerm_linux_virtual_machine_scale_set" "${name}" {
  name                = "${name}"
  resource_group_name = ${rgNameRef}
  location            = ${rgLocRef}
  sku                 = "${cfg.sku || 'Standard_B2s'}"
  instances           = ${cfg.capacity || 2}
  admin_username      = "azureuser"

  admin_ssh_key {
    username   = "azureuser"
    public_key = file("~/.ssh/id_rsa.pub")
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-focal"
    sku       = "20_04-lts"
    version   = "latest"
  }

  os_disk {
    storage_account_type = "Premium_LRS"
    caching              = "ReadWrite"
  }

  network_interface {
    name    = "${name}-nic"
    primary = true

    ip_configuration {
      name      = "internal"
      primary   = true
      subnet_id = azurerm_subnet.main.id
    }
  }
}
`);
      } else if (node.resourceType === 'azure_storage') {
        lines.push(`resource "azurerm_storage_account" "${name}" {
  name                     = "${(name as string).replace(/[^a-z0-9]/g, '').toLowerCase().substring(0, 24)}"
  resource_group_name      = ${rgNameRef}
  location                 = ${rgLocRef}
  account_tier             = "Standard"
  account_replication_type = "${(cfg.sku as string)?.replace('Standard_', '') || 'LRS'}"
  enable_https_traffic_only = ${cfg.httpsOnly !== false}
}
`);
      } else if (node.resourceType === 'azure_sql') {
        lines.push(`resource "azurerm_mssql_server" "${name}_server" {
  name                         = "${name}-server"
  resource_group_name          = ${rgNameRef}
  location                     = ${rgLocRef}
  version                      = "12.0"
  administrator_login          = "sqladmin"
  administrator_login_password = var.sql_admin_password
}

resource "azurerm_mssql_database" "${name}" {
  name         = "${name}"
  server_id    = azurerm_mssql_server.${name}_server.id
  max_size_gb  = ${cfg.maxSizeGb || 250}
  sku_name     = "${cfg.tier || 'GeneralPurpose'}"
}
`);
      } else if (node.resourceType === 'azure_redis') {
        lines.push(`resource "azurerm_redis_cache" "${name}" {
  name                = "${name}"
  location            = ${rgLocRef}
  resource_group_name = ${rgNameRef}
  capacity            = 1
  family              = "C"
  sku_name            = "Standard"
  enable_non_ssl_port = false
  minimum_tls_version = "1.2"
}
`);
      } else if (node.resourceType === 'azure_nsg') {
        lines.push(`resource "azurerm_network_security_group" "${name}" {
  name                = "${name}"
  location            = ${rgLocRef}
  resource_group_name = ${rgNameRef}
}
`);
      }
    }
  }

  return lines.join('\n');
}
