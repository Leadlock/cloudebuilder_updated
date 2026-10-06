import {
  azurermTypesIn, providerForResourceType, azureRequiredPermissionsFor, azureGrantCommands, azureAllows, evaluateAzureAccess, checkAzureAccess,
} from '@/lib/terraform/execution/azurePermissions';

const HCL = `
resource "azurerm_resource_group" "rg" {}
resource "azurerm_virtual_network" "vnet" {}
resource "azurerm_subnet" "web" {}
resource "azurerm_application_gateway" "agw" {}
resource "azurerm_linux_web_app" "app" {}
resource "azurerm_mssql_server" "sql" {}
resource "azurerm_key_vault" "kv" {}
data "azurerm_client_config" "current" {}
`;
const files = [{ filename: 'main.tf', content: HCL }, { filename: 'notes.md', content: 'resource "azurerm_redis_cache" "x" {}' }];

// What Azure returns for the built-in roles on a subscription.
const CONTRIBUTOR = [{ actions: ['*'], notActions: ['Microsoft.Authorization/*/Delete', 'Microsoft.Authorization/*/Write', 'Microsoft.Authorization/elevateAccess/Action'] }];
const READER = [{ actions: ['*/read'], notActions: [] }];
const OWNER = [{ actions: ['*'], notActions: [] }];

describe('azure types and providers', () => {
  it('lists azurerm resource and data types from .tf files only', () => {
    const t = azurermTypesIn(files);
    expect(t).toContain('azurerm_virtual_network');
    expect(t).toContain('data.azurerm_client_config');
    expect(t).not.toContain('azurerm_redis_cache');
  });
  it('maps types to the provider that owns them, longest prefix first', () => {
    expect(providerForResourceType('azurerm_mssql_server')).toBe('Microsoft.Sql');
    expect(providerForResourceType('azurerm_linux_web_app')).toBe('Microsoft.Web');
    expect(providerForResourceType('azurerm_linux_virtual_machine_scale_set')).toBe('Microsoft.Compute');
    expect(providerForResourceType('azurerm_role_assignment')).toBe('Microsoft.Authorization');
    expect(providerForResourceType('azurerm_made_up')).toBeNull();
  });
});

describe('azureRequiredPermissionsFor', () => {
  it('needs Contributor for a normal design, plus the state storage providers', () => {
    const p = azureRequiredPermissionsFor(files);
    expect(p.providers).toEqual(['Microsoft.KeyVault', 'Microsoft.Network', 'Microsoft.Resources', 'Microsoft.Sql', 'Microsoft.Storage', 'Microsoft.Web']);
    expect(p.roles.map((r) => r.name)).toEqual(['Contributor']);
    expect(p.needsRoleAssignment).toBe(false);
  });
  it('also needs User Access Administrator when the design creates role assignments', () => {
    const p = azureRequiredPermissionsFor([{ filename: 'main.tf', content: 'resource "azurerm_role_assignment" "r" {}' }]);
    expect(p.roles.map((r) => r.name)).toEqual(['Contributor', 'User Access Administrator']);
    expect(p.needsRoleAssignment).toBe(true);
  });
  it('reports a type it cannot map', () => {
    expect(azureRequiredPermissionsFor([{ filename: 'main.tf', content: 'resource "azurerm_made_up" "x" {}' }]).unknownTypes).toEqual(['azurerm_made_up']);
  });
  it('writes one CLI command per role for this principal and subscription', () => {
    const cmd = azureGrantCommands([{ name: 'Contributor', why: '' }, { name: 'User Access Administrator', why: '' }], 'client-1', 'sub-1');
    expect(cmd.split('\n')).toEqual([
      'az role assignment create --assignee client-1 --role "Contributor" --scope /subscriptions/sub-1',
      'az role assignment create --assignee client-1 --role "User Access Administrator" --scope /subscriptions/sub-1',
    ]);
  });
});

describe('effective permissions', () => {
  it('Contributor can create resources but not role assignments; Owner can do both; Reader can do neither', () => {
    expect(azureAllows(CONTRIBUTOR, 'Microsoft.Network/virtualNetworks/write')).toBe(true);
    expect(azureAllows(CONTRIBUTOR, 'Microsoft.Authorization/roleAssignments/write')).toBe(false);
    expect(azureAllows(OWNER, 'Microsoft.Authorization/roleAssignments/write')).toBe(true);
    expect(azureAllows(READER, 'Microsoft.Network/virtualNetworks/write')).toBe(false);
    expect(azureAllows(READER, 'Microsoft.Network/virtualNetworks/read')).toBe(true);
  });

  it('ok with Contributor for a normal design', () => {
    const p = azureRequiredPermissionsFor(files);
    expect(evaluateAzureAccess(CONTRIBUTOR, p.providers, p.needsRoleAssignment).state).toBe('ok');
  });
  it('partial with Reader, naming the providers; partial with Contributor when role assignments are needed', () => {
    const p = azureRequiredPermissionsFor(files);
    const reader = evaluateAzureAccess(READER, p.providers, false);
    expect(reader.state).toBe('partial');
    expect(reader.providers.every((r) => r.allowed === false)).toBe(true);
    expect(reader.message).toMatch(/Microsoft\.Network/);

    const ra = azureRequiredPermissionsFor([{ filename: 'main.tf', content: 'resource "azurerm_role_assignment" "r" {}\nresource "azurerm_virtual_network" "v" {}' }]);
    const c = evaluateAzureAccess(CONTRIBUTOR, ra.providers, ra.needsRoleAssignment);
    expect(c.state).toBe('partial');
    expect(c.message).toMatch(/role assignments/);
    expect(evaluateAzureAccess(OWNER, ra.providers, ra.needsRoleAssignment).state).toBe('ok');
  });
});

describe('checkAzureAccess', () => {
  const args = { token: 't', subscriptionId: 'sub-1', providers: ['Microsoft.Network'], needsRoleAssignment: false };
  const answer = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  it('asks Azure about the subscription with the bearer token and evaluates the answer', async () => {
    const calls: { url: string; auth: string }[] = [];
    const fetcher = async (url: string, init: { headers: Record<string, string> }) => { calls.push({ url, auth: init.headers['Authorization']! }); return { ok: true, status: 200, json: async () => ({ value: CONTRIBUTOR }) }; };
    const r = await checkAzureAccess({ ...args, fetcher });
    expect(r.state).toBe('ok');
    expect(calls[0]!.url).toContain('/subscriptions/sub-1/providers/Microsoft.Authorization/permissions');
    expect(calls[0]!.auth).toBe('Bearer t');
  });
  it('cannot check, with a reason, when Azure refuses, errors, or is unreachable', async () => {
    expect((await checkAzureAccess({ ...args, fetcher: answer(403, {}) })).state).toBe('cannot-check');
    expect((await checkAzureAccess({ ...args, fetcher: answer(500, {}) })).message).toMatch(/HTTP 500/);
    expect((await checkAzureAccess({ ...args, fetcher: async () => { throw new Error('ENOTFOUND'); } })).message).toMatch(/could not reach Azure/);
    expect((await checkAzureAccess({ ...args, fetcher: answer(200, {}) })).state).toBe('cannot-check');
  });
});
