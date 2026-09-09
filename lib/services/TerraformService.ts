import { CanvasNode, CanvasEdge } from '@/types';
import { generateTerraform } from '@/lib/analysis';

// ─── Interface ────────────────────────────────────────────────────────────────
export interface ITerraformService {
  /** Generate a single main.tf string */
  generateMain(nodes: CanvasNode[], edges: CanvasEdge[], provider: string): string;
  /** Generate multi-file output keyed by filename */
  generateFiles(
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    provider: string,
  ): Record<string, string>;
}

// ─── Mock Implementation ──────────────────────────────────────────────────────
class MockTerraformService implements ITerraformService {
  generateMain(nodes: CanvasNode[], edges: CanvasEdge[], provider: string): string {
    if (provider === 'multi') {
      const awsNodes  = nodes.filter((n) => n.provider === 'aws');
      const azureNodes = nodes.filter((n) => n.provider === 'azure');
      return [
        generateTerraform(awsNodes, edges, 'aws'),
        generateTerraform(azureNodes, edges, 'azure'),
      ].join('\n\n# ─── Azure Resources ──────────────────────────────────────\n\n');
    }
    return generateTerraform(nodes, edges, provider);
  }

  generateFiles(
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    provider: string,
  ): Record<string, string> {
    return {
      'main.tf':          this.generateMain(nodes, edges, provider),
      'providers.tf':     this._providers(provider),
      'variables.tf':     this._variables(provider),
      'outputs.tf':       this._outputs(nodes),
      'terraform.tfvars': this._tfvars(provider),
    };
  }

  private _providers(provider: string): string {
    const aws = `terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}`;

    const azure = `terraform {
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
}`;

    if (provider === 'multi') return `${aws}\n\n${azure}`;
    if (provider === 'azure') return azure;
    return aws;
  }

  private _variables(provider: string): string {
    const common = `variable "environment" {
  type    = string
  default = "production"
}`;
    if (provider === 'aws' || provider === 'multi') {
      return `variable "aws_region" {
  type    = string
  default = "us-east-1"
}

${common}`;
    }
    return `variable "azure_location" {
  type    = string
  default = "eastus"
}

${common}`;
  }

  private _outputs(nodes: CanvasNode[]): string {
    const lines: string[] = [];
    for (const n of nodes) {
      const name = ((n.config.name as string) || n.label).replace(/\s+/g, '_').toLowerCase();
      if (n.resourceType === 'aws_alb') {
        lines.push(`output "${name}_dns" { value = aws_lb.${name}.dns_name }`);
      } else if (n.resourceType === 'aws_rds') {
        lines.push(`output "${name}_endpoint" { value = aws_db_instance.${name}.endpoint; sensitive = true }`);
      }
    }
    return lines.length ? lines.join('\n') : '# No outputs defined';
  }

  private _tfvars(provider: string): string {
    if (provider === 'azure') return `azure_location = "eastus"\nenvironment    = "production"`;
    return `aws_region  = "us-east-1"\nenvironment = "production"`;
  }
}

export const terraformService: ITerraformService = new MockTerraformService();
