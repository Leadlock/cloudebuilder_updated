import { CanvasNode, CanvasEdge, SecurityIssue, CostItem } from '@/types';
import { getResourceDefinition } from './resources';

export function runSecurityScan(nodes: CanvasNode[]): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  for (const node of nodes) {
    const def = getResourceDefinition(node.resourceType);
    if (!def?.securityRules) continue;
    for (const rule of def.securityRules) {
      const result = rule.check(node.config, nodes);
      if (result) {
        issues.push({
          id: `${node.id}-${rule.id}`,
          nodeId: node.id,
          nodeLabel: node.label,
          severity: rule.severity,
          message: rule.message,
          recommendation: rule.recommendation,
          fixable: !!rule.fixAction,
          ruleId: rule.id,
        });
      }
    }
  }
  return issues;
}

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

export function generateTerraform(nodes: CanvasNode[], edges: CanvasEdge[], provider: string): string {
  if (nodes.length === 0) {
    return `# No resources defined yet.\n# Add resources to the canvas to generate Terraform code.\n`;
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

    for (const node of nodes) {
      const cfg = node.config;
      const name = (cfg.name as string) || node.id.replace(/-/g, '_');
      if (node.resourceType === 'aws_vpc') {
        lines.push(`resource "aws_vpc" "${name}" {
  cidr_block           = "${cfg.cidrBlock || '10.0.0.0/16'}"
  enable_dns_support   = ${cfg.enableDnsSupport ? 'true' : 'false'}
  enable_dns_hostnames = ${cfg.enableDnsHostnames ? 'true' : 'false'}
  tags = { Name = "${name}" }
}
`);
      } else if (node.resourceType === 'aws_subnet') {
        lines.push(`resource "aws_subnet" "${name}" {
  vpc_id                  = aws_vpc.main.id
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
      } else if (node.resourceType === 'aws_s3') {
        lines.push(`resource "aws_s3_bucket" "${name}" {
  bucket = "${cfg.bucketName || name}"
  tags   = { Name = "${name}" }
}

resource "aws_s3_bucket_versioning" "${name}_versioning" {
  bucket = aws_s3_bucket.${name}.id
  versioning_configuration {
    status = "${cfg.versioning ? 'Enabled' : 'Suspended'}"
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
  identifier        = "${name}"
  engine            = "${cfg.engine || 'mysql'}"
  instance_class    = "${cfg.instanceClass || 'db.t3.micro'}"
  allocated_storage = 20
  multi_az          = ${cfg.multiAz ? 'true' : 'false'}
  storage_encrypted = ${cfg.encrypted ? 'true' : 'false'}
  skip_final_snapshot = true
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
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${name}" }
}
`);
      } else if (node.resourceType === 'aws_nat') {
        lines.push(`resource "aws_eip" "${name}_eip" {
  domain = "vpc"
}

resource "aws_nat_gateway" "${name}" {
  allocation_id     = aws_eip.${name}_eip.id
  subnet_id         = aws_subnet.main.id
  connectivity_type = "${cfg.connectivityType || 'public'}"
  tags = { Name = "${name}" }
}
`);
      } else if (node.resourceType === 'aws_sg') {
        lines.push(`resource "aws_security_group" "${name}" {
  name        = "${name}"
  description = "Managed by CloudCraft"
  vpc_id      = aws_vpc.main.id

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

  ${cfg.allowSsh ? `ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]  # WARNING: Restrict this in production
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
    for (const node of nodes) {
      const cfg = node.config;
      const name = (cfg.name as string) || node.id.replace(/-/g, '_');
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
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}
`);
      } else if (node.resourceType === 'azure_subnet') {
        lines.push(`resource "azurerm_subnet" "${name}" {
  name                 = "${name}"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["${cfg.addressPrefix || '10.0.1.0/24'}"]
}
`);
      } else if (node.resourceType === 'azure_vm') {
        lines.push(`resource "azurerm_linux_virtual_machine" "${name}" {
  name                = "${name}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
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
      } else if (node.resourceType === 'azure_storage') {
        lines.push(`resource "azurerm_storage_account" "${name}" {
  name                     = "${(name as string).replace(/-/g, '').toLowerCase().substring(0, 24)}"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "${(cfg.sku as string)?.replace('Standard_', '') || 'LRS'}"
  enable_https_traffic_only = ${cfg.httpsOnly ? 'true' : 'false'}
}
`);
      } else if (node.resourceType === 'azure_sql') {
        lines.push(`resource "azurerm_mssql_server" "${name}_server" {
  name                         = "${name}-server"
  resource_group_name          = azurerm_resource_group.main.name
  location                     = azurerm_resource_group.main.location
  version                      = "12.0"
  administrator_login          = "sqladmin"
  administrator_login_password = var.sql_admin_password
}

resource "azurerm_mssql_database" "${name}" {
  name         = "${name}"
  server_id    = azurerm_mssql_server.${name}_server.id
  max_size_gb  = ${cfg.maxSizeGb || 250}
  sku_name     = "${cfg.tier || 'S0'}"
}
`);
      } else if (node.resourceType === 'azure_nsg') {
        lines.push(`resource "azurerm_network_security_group" "${name}" {
  name                = "${name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  ${cfg.allowSsh ? `security_rule {
    name                       = "allow-ssh"
    priority                   = 1001
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "*"  # WARNING: Restrict in production
    destination_address_prefix = "*"
  }` : ''}

  ${cfg.allowRdp ? `security_rule {
    name                       = "allow-rdp"
    priority                   = 1002
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "3389"
    source_address_prefix      = "*"  # WARNING: Restrict in production
    destination_address_prefix = "*"
  }` : ''}
}
`);
      }
    }
  }

  return lines.join('\n');
}
