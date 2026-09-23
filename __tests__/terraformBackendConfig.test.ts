import { renderBackendConfig } from '@/lib/terraform/execution/backendConfig';

describe('renderBackendConfig', () => {
  test('renders an S3 backend block with the required fields', () => {
    const hcl = renderBackendConfig({ provider: 'aws', bucket: 'my-tfstate', key: 'proj/prod.tfstate', region: 'us-east-1' });
    expect(hcl).toContain('backend "s3"');
    expect(hcl).toContain('bucket = "my-tfstate"');
    expect(hcl).toContain('key    = "proj/prod.tfstate"');
    expect(hcl).toContain('region = "us-east-1"');
    expect(hcl).toContain('encrypt = true');
    expect(hcl).not.toContain('dynamodb_table');
  });

  test('includes dynamodb_table only when provided', () => {
    const hcl = renderBackendConfig({ provider: 'aws', bucket: 'b', key: 'k', region: 'us-east-1', dynamodbTable: 'tf-locks' });
    expect(hcl).toContain('dynamodb_table = "tf-locks"');
  });

  test('renders an azurerm backend block with the required fields', () => {
    const hcl = renderBackendConfig({
      provider: 'azure', resourceGroupName: 'my-rg', storageAccountName: 'mystorage', containerName: 'tfstate', key: 'prod.tfstate',
    });
    expect(hcl).toContain('backend "azurerm"');
    expect(hcl).toContain('resource_group_name  = "my-rg"');
    expect(hcl).toContain('storage_account_name = "mystorage"');
    expect(hcl).toContain('key                   = "prod.tfstate"');
  });
});
