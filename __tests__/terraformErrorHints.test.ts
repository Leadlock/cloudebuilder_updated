import { explainTerraformError } from '@/lib/terraform/execution/errorHints';

const RG = `terraform destroy failed (exit 1): Error: deleting Resource Group "production_resource_group": the Resource Group still contains Resources. Terraform is configured to check for Resources within the Resource Group when deleting the Resource Group - and raise an error if nested Resources still exist. Terraform has detected that the following Resources still exist within the Resource Group: * \`/subscriptions/40ba1da4-7522-41de-b5e5-cfa1098bb7b1/resourceGroups/production_resource_group/providers/Microsoft.Cache/Redis/azure-cache-for-redis-kvagqt\` This feature is intended to avoid the unintentional destruction`;
const DNS = 'terraform destroy failed (exit 1): Error: populating Resource Provider cache: listing Resource Providers: loading results: Get "https://management.azure.com/subscriptions/x/providers": dial tcp: lookup management.azure.com: getaddrinfow: This is usually a temporary error during hostname resolution';
const LOCK = 'The remote state is locked by LAPTOP-G4Q1LCQB\\Lenovo@LAPTOP-G4Q1LCQB (running: OperationTypeApply), since 2026-10-01 11:30 UTC (4 min ago). Terraform said: Error acquiring the state lock Lock Info: ID: b62dca92-6904-8aff-9c92-38241bd68610 Path: tfstate/x Operation: OperationTypeApply Who: LAPTOP-G4Q1LCQB\\Lenovo@LAPTOP-G4Q1LCQB Version: 1.16.4 Created: 2026-10-01 11:30:50.6885795 +0000 UTC Info:';
const UNDECLARED = 'Error: Reference to undeclared resource on outputs.tf line 3, in output "cloudcraft_storage_account_name": value = azurerm_storage_account.cloudcraft.name A managed resource "azurerm_storage_account" "cloudcraft" has not been declared';

describe('explainTerraformError', () => {
  it('explains the leftover-resources error from a real Azure teardown and names the resource', () => {
    const e = explainTerraformError(RG)!;
    expect(e.kind).toBe('resource-group-not-empty');
    expect(e.title).toContain('production_resource_group');
    expect(e.summary).toContain('azure-cache-for-redis-kvagqt');
    expect(e.steps.join(' ')).toMatch(/Azure portal/);
    expect(e.steps.join(' ')).toMatch(/Do not turn off/);
  });

  it('explains a dropped connection without blaming the design', () => {
    const e = explainTerraformError(DNS)!;
    expect(e.kind).toBe('network');
    expect(e.summary).toMatch(/Nothing is wrong with the design/);
    expect(e.steps.join(' ')).toMatch(/Check lock/);
  });

  it('explains a state lock, who holds it, and gives the lock id for the "Check lock" action', () => {
    const e = explainTerraformError(LOCK)!;
    expect(e.kind).toBe('state-lock');
    expect(e.lockId).toBe('b62dca92-6904-8aff-9c92-38241bd68610');
    expect(e.summary).toContain('LAPTOP-G4Q1LCQB');
    expect(e.steps.join(' ')).toMatch(/Never release a lock while its run might still be going/);
  });

  it('a lock from another machine is explained, not offered for release', () => {
    const e = explainTerraformError(LOCK.replace(/LAPTOP-G4Q1LCQB\\Lenovo@LAPTOP-G4Q1LCQB/g, 'TANMAY\\22tan@Tanmay'))!;
    expect(e.summary).toContain('TANMAY');
  });

  it('recognises a generator/configuration error and says nothing was changed', () => {
    const e = explainTerraformError(UNDECLARED)!;
    expect(e.kind).toBe('invalid-configuration');
    expect(e.summary).toMatch(/nothing was changed/i);
  });

  it.each([
    ['The `terraform` CLI is not installed or not on PATH.', 'not-installed'],
    ['Error: AuthorizationFailed: client does not have authorization to perform action', 'credentials'],
    ['Error: ExpiredToken: The security token included in the request is expired', 'credentials'],
    ['Error: a resource with the ID already exists - to be managed via Terraform this resource needs to be imported into the State', 'already-exists'],
    ['Error: SubscriptionIsOverQuotaForSku', 'quota'],
    ['terraform apply timed out after 45 minutes.', 'timeout'],
  ])('%s → %s', (text, kind) => {
    expect(explainTerraformError(text)!.kind).toBe(kind);
  });

  it('returns null for empty input and for an error it does not recognise (the raw text is then shown as-is)', () => {
    expect(explainTerraformError('')).toBeNull();
    expect(explainTerraformError(undefined)).toBeNull();
    expect(explainTerraformError('Error: something completely different happened')).toBeNull();
  });
});

describe('the AWS plugin not starting is a busy computer, not a bad design', () => {
  const { explainTerraformError } = jest.requireActual('@/lib/terraform/execution/errorHints') as typeof import('@/lib/terraform/execution/errorHints');
  const raw = 'Terraform could not start the cloud plugin in time (nothing was changed): Error: Failed to load plugin schemas\n\nError while loading schemas for plugin components: Failed to obtain provider schema: Could not load the schema for provider registry.terraform.io/hashicorp/aws: failed to instantiate provider "registry.terraform.io/hashicorp/aws" to obtain schema: timeout while waiting for plugin to start..';

  it('explains it as a machine problem with steps, and keeps the cost warning for teardowns', () => {
    const e = explainTerraformError(raw)!;
    expect(e.kind).toBe('plugin-start');
    expect(e.title).toMatch(/too busy/);
    expect(e.summary).toMatch(/design is fine/);
    expect(e.steps.join(' ')).toMatch(/cloudcraft-tf-plugin-cache/);
    expect(e.steps.join(' ')).toContain('$env:TEMP\\cloudcraft-tf-plugin-cache');       // the backslash survives
    expect(e.steps.join(' ')).toMatch(/may still cost money/);
  });

  it('also catches the older wording that called it a rejected configuration', () => {
    const old = 'Terraform rejected the generated configuration (nothing was changed): Error: Failed to load plugin schemas ... timeout while waiting for plugin to start..';
    expect(explainTerraformError(old)!.kind).toBe('plugin-start');
  });

  it('still reports a real invalid configuration as one', () => {
    expect(explainTerraformError('Terraform rejected the generated configuration (nothing was changed): Error: Reference to undeclared resource')!.kind).toBe('invalid-configuration');
  });
});
