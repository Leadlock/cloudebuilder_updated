import type { TerraformStateBackendConfig } from './types';

/**
 * Renders a `terraform { backend "..." { ... } }` block from an explicit,
 * caller-supplied state backend config. CloudCraft never provisions the S3
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
      `    bucket = "${backend.bucket}"`,
      `    key    = "${backend.key}"`,
      `    region = "${backend.region}"`,
    ];
    if (backend.dynamodbTable) {
      lines.push(`    dynamodb_table = "${backend.dynamodbTable}"`);
    }
    lines.push('    encrypt = true', '  }', '}');
    return lines.join('\n');
  }

  return [
    'terraform {',
    '  backend "azurerm" {',
    `    resource_group_name  = "${backend.resourceGroupName}"`,
    `    storage_account_name = "${backend.storageAccountName}"`,
    `    container_name        = "${backend.containerName}"`,
    `    key                   = "${backend.key}"`,
    '  }',
    '}',
  ].join('\n');
}
