import type { TerraformStateBackendConfig } from './types';
import { escapeHclString } from '@/lib/engines/terraform/hclSafety';

// Defence in depth: the routes already restrict these names (backendSchema.ts); anything that still reaches
// here is escaped so it cannot leave its string.
const q = (v: string) => `"${escapeHclString(v)}"`;

/**
 * Renders a `terraform { backend "..." { ... } }` block from an explicit,
 * caller-supplied state backend config. CloudBuilder never provisions the S3
 * bucket / DynamoDB table / Azure Storage container itself — the caller must
 * already have one, matching the "remote state backend required" policy
 * (a local backend would mean state living only on this server's disk,
 * unsafe for anything beyond a single throwaway run).
 */
export function renderBackendConfig(backend: TerraformStateBackendConfig): string {
  if (backend.provider === 'aws') {
    const lines = [
      'terraform {',
      '  backend "s3" {',
      `    bucket = ${q(backend.bucket)}`,
      `    key    = ${q(backend.key)}`,
      `    region = ${q(backend.region)}`,
    ];
    if (backend.dynamodbTable) {
      lines.push(`    dynamodb_table = ${q(backend.dynamodbTable)}`);
    }
    lines.push('    encrypt = true', '  }', '}');
    return lines.join('\n');
  }

  return [
    'terraform {',
    '  backend "azurerm" {',
    `    resource_group_name  = ${q(backend.resourceGroupName)}`,
    `    storage_account_name = ${q(backend.storageAccountName)}`,
    `    container_name        = ${q(backend.containerName)}`,
    `    key                   = ${q(backend.key)}`,
    '  }',
    '}',
  ].join('\n');
}
