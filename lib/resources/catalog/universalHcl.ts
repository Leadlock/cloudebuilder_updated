/**
 * Universal Terraform HCL Generator
 *
 * Dynamically converts ANY AWS or Azure resource configuration into clean,
 * valid, production-ready Terraform HCL without requiring hardcoded templates.
 *
 * Automatically resolves:
 * - Parent VPC / Subnet references (aws_vpc.id, aws_subnet.id)
 * - Azure Resource Group and Location references (azurerm_resource_group.name, azurerm_resource_group.location)
 * - Security group references
 * - Proper HCL type formatting (strings, booleans, numbers, lists, maps, tags)
 */

import type { DbArchitectureResource, DbArchitectureConnection } from '@/lib/repositories/architectureRepository';
import { escapeHclString } from '@/lib/engines/terraform/hclSafety';

export interface UniversalHclResult {
  block: string;
  address: string;
}

/** Keys used strictly for UI/canvas metadata that should not be emitted directly to Terraform attributes */
const IGNORED_CONFIG_KEYS = new Set([
  'name',
  'label',
  'imported',
  'importState',
  'importId',
  'importArn',
  '_metadata',
  'serverSoftware',
  'serverPageText',
  'webAccessCidr',
]);

/** Format a single JavaScript value into Terraform HCL syntax */
export function formatHclValue(val: unknown, indentLevel = 1): string {
  const indent = '  '.repeat(indentLevel);
  const nextIndent = '  '.repeat(indentLevel + 1);

  if (val === null || val === undefined) {
    return 'null';
  }

  if (typeof val === 'boolean') {
    return val ? 'true' : 'false';
  }

  if (typeof val === 'number') {
    return Number.isFinite(val) ? val.toString() : '0';
  }

  if (typeof val === 'string') {
    // If it's a Terraform reference expression (starts with aws_*, azurerm_*, var.*, local.*, data.*)
    if (
      /^(aws_[a-zA-Z0-9_]+|azurerm_[a-zA-Z0-9_]+|var\.[a-zA-Z0-9_]+|local\.[a-zA-Z0-9_]+|data\.[a-zA-Z0-9_.]+)\.[a-zA-Z0-9_]+$/.test(val.trim())
    ) {
      return val.trim();
    }
    return `"${escapeHclString(val)}"`;
  }

  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    // Short scalar arrays on one line
    if (val.length <= 3 && val.every((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')) {
      return `[${val.map((item) => formatHclValue(item, indentLevel)).join(', ')}]`;
    }
    const items = val.map((item) => `${nextIndent}${formatHclValue(item, indentLevel + 1)},`).join('\n');
    return `[\n${items}\n${indent}]`;
  }

  if (typeof val === 'object') {
    const entries = Object.entries(val as Record<string, unknown>).filter(
      ([k, v]) => k && v !== undefined && v !== null && v !== ''
    );
    if (entries.length === 0) return '{}';
    const lines = entries.map(([k, v]) => `${nextIndent}${k} = ${formatHclValue(v, indentLevel + 1)}`).join('\n');
    return `{\n${lines}\n${indent}}`;
  }

  return '""';
}

/** Generates HCL for any generic AWS resource from the catalog */
export function generateUniversalAwsHcl(
  resource: DbArchitectureResource,
  name: string,
  cfg: Record<string, unknown>,
  connections: DbArchitectureConnection[],
  resources: DbArchitectureResource[],
  resolver: any,
): UniversalHclResult {
  const tfType = resource.resourceType.startsWith('aws_') ? resource.resourceType : `aws_${resource.resourceType}`;
  const lines: string[] = [`resource "${tfType}" "${name}" {`];

  // Auto-resolve VPC parent if not explicitly set
  if (!cfg['vpc_id'] && !cfg['vpcId']) {
    const parentVpc = resolver?.resolveParent?.(resource.id, 'aws_vpc', connections, resources);
    if (parentVpc) {
      const vpcName = resolver.tfNameOf(parentVpc.id) ?? parentVpc.label.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      lines.push(`  vpc_id = aws_vpc.${vpcName}.id`);
    }
  }

  // Auto-resolve Subnet parent if not explicitly set
  if (!cfg['subnet_id'] && !cfg['subnetId']) {
    const parentSubnet = resolver?.resolveParent?.(resource.id, 'aws_subnet', connections, resources);
    if (parentSubnet) {
      const subnetName = resolver.tfNameOf(parentSubnet.id) ?? parentSubnet.label.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      lines.push(`  subnet_id = aws_subnet.${subnetName}.id`);
    }
  }

  // Add attributes from config
  const customTags: Record<string, string> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (IGNORED_CONFIG_KEYS.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;

    // Convert camelCase keys to snake_case for Terraform standards if needed
    const hclKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();

    if (hclKey === 'tags' && typeof value === 'object') {
      Object.assign(customTags, value as Record<string, string>);
      continue;
    }

    lines.push(`  ${hclKey} = ${formatHclValue(value, 1)}`);
  }

  // Add standard tags block
  lines.push('  tags = {');
  lines.push(`    Name      = "${name}"`);
  lines.push(`    ManagedBy = "CloudCraft"`);
  for (const [k, v] of Object.entries(customTags)) {
    if (k && v) lines.push(`    ${k} = "${escapeHclString(v)}"`);
  }
  lines.push('  }');
  lines.push('}');

  return {
    block: lines.join('\n'),
    address: `${tfType}.${name}`,
  };
}

/** Generates HCL for any generic Azure resource from the catalog */
export function generateUniversalAzureHcl(
  resource: DbArchitectureResource,
  name: string,
  cfg: Record<string, unknown>,
  rgName: string,
  rgLoc: string,
  connections: DbArchitectureConnection[],
  resources: DbArchitectureResource[],
  resolver: any,
): UniversalHclResult {
  const tfType = resource.resourceType.startsWith('azurerm_')
    ? resource.resourceType
    : resource.resourceType.startsWith('azure_')
      ? resource.resourceType.replace(/^azure_/, 'azurerm_')
      : `azurerm_${resource.resourceType}`;

  const lines: string[] = [`resource "${tfType}" "${name}" {`];
  lines.push(`  name                = "${name}"`);
  lines.push(`  resource_group_name = ${rgName}`);
  lines.push(`  location            = ${rgLoc}`);

  // Auto-resolve Subnet parent if needed
  if (!cfg['subnet_id'] && !cfg['subnetId']) {
    const parentSubnet = resolver?.resolveParent?.(resource.id, 'azure_subnet', connections, resources);
    if (parentSubnet) {
      const subnetName = resolver.tfNameOf(parentSubnet.id) ?? parentSubnet.label.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      lines.push(`  subnet_id           = azurerm_subnet.${subnetName}.id`);
    }
  }

  // Add attributes from config
  const customTags: Record<string, string> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (IGNORED_CONFIG_KEYS.has(key)) continue;
    if (key === 'resource_group_name' || key === 'location') continue;
    if (value === undefined || value === null || value === '') continue;

    const hclKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();

    if (hclKey === 'tags' && typeof value === 'object') {
      Object.assign(customTags, value as Record<string, string>);
      continue;
    }

    lines.push(`  ${hclKey} = ${formatHclValue(value, 1)}`);
  }

  // Tags
  lines.push('  tags = {');
  lines.push(`    ManagedBy = "CloudCraft"`);
  for (const [k, v] of Object.entries(customTags)) {
    if (k && v) lines.push(`    ${k} = "${escapeHclString(v)}"`);
  }
  lines.push('  }');
  lines.push('}');

  return {
    block: lines.join('\n'),
    address: `${tfType}.${name}`,
  };
}
