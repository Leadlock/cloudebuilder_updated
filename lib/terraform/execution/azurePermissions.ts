/**
 * What the Azure service principal needs in order to deploy THIS architecture, worked out before anything is planned.
 *
 * Azure grants access by ROLE at a scope (a subscription or a resource group), not by a per-service policy like AWS. Terraform can create
 * everything with the built-in "Contributor" role, which cannot grant access to anyone else. A design that also creates role assignments
 * (for example giving an app permission to read a Key Vault) needs one more role that may do that: "User Access Administrator", or "Owner"
 * instead of both. The resource providers the design uses (Microsoft.Network, Microsoft.Sql…) are listed so the person can see what the
 * role will be used for, and "Check my access" asks Azure for the principal's effective permissions on the subscription (an Azure call
 * that every principal may make about itself; nothing is created or changed).
 */

/** Terraform resource type prefix → the Azure resource provider that owns it. Longest prefix wins. */
const PROVIDER_BY_PREFIX: [string, string][] = [
  ['azurerm_resource_group', 'Microsoft.Resources'],
  ['azurerm_virtual_network', 'Microsoft.Network'], ['azurerm_subnet', 'Microsoft.Network'], ['azurerm_network_security', 'Microsoft.Network'],
  ['azurerm_public_ip', 'Microsoft.Network'], ['azurerm_lb', 'Microsoft.Network'], ['azurerm_application_gateway', 'Microsoft.Network'],
  ['azurerm_nat_gateway', 'Microsoft.Network'], ['azurerm_route', 'Microsoft.Network'], ['azurerm_bastion', 'Microsoft.Network'],
  ['azurerm_network_interface', 'Microsoft.Network'], ['azurerm_web_application_firewall', 'Microsoft.Network'], ['azurerm_private_', 'Microsoft.Network'],
  ['azurerm_subnet_network_security_group_association', 'Microsoft.Network'], ['azurerm_dns', 'Microsoft.Network'], ['azurerm_frontdoor_firewall', 'Microsoft.Network'],
  ['azurerm_linux_virtual_machine', 'Microsoft.Compute'], ['azurerm_windows_virtual_machine', 'Microsoft.Compute'], ['azurerm_virtual_machine', 'Microsoft.Compute'],
  ['azurerm_linux_virtual_machine_scale_set', 'Microsoft.Compute'], ['azurerm_windows_virtual_machine_scale_set', 'Microsoft.Compute'], ['azurerm_orchestrated_virtual_machine_scale_set', 'Microsoft.Compute'],
  ['azurerm_managed_disk', 'Microsoft.Compute'], ['azurerm_availability_set', 'Microsoft.Compute'],
  ['azurerm_mssql', 'Microsoft.Sql'], ['azurerm_sql', 'Microsoft.Sql'],
  ['azurerm_storage', 'Microsoft.Storage'],
  ['azurerm_key_vault', 'Microsoft.KeyVault'],
  ['azurerm_cosmosdb', 'Microsoft.DocumentDB'],
  ['azurerm_redis', 'Microsoft.Cache'],
  ['azurerm_kubernetes', 'Microsoft.ContainerService'],
  ['azurerm_service_plan', 'Microsoft.Web'], ['azurerm_linux_web_app', 'Microsoft.Web'], ['azurerm_windows_web_app', 'Microsoft.Web'],
  ['azurerm_linux_function_app', 'Microsoft.Web'], ['azurerm_windows_function_app', 'Microsoft.Web'], ['azurerm_app_service', 'Microsoft.Web'], ['azurerm_function_app', 'Microsoft.Web'],
  ['azurerm_cdn', 'Microsoft.Cdn'], ['azurerm_frontdoor', 'Microsoft.Network'],
  ['azurerm_user_assigned_identity', 'Microsoft.ManagedIdentity'],
  ['azurerm_monitor', 'Microsoft.Insights'], ['azurerm_application_insights', 'Microsoft.Insights'],
  ['azurerm_log_analytics', 'Microsoft.OperationalInsights'],
  ['azurerm_container_registry', 'Microsoft.ContainerRegistry'],
  ['azurerm_servicebus', 'Microsoft.ServiceBus'], ['azurerm_eventhub', 'Microsoft.EventHub'],
  ['azurerm_role_assignment', 'Microsoft.Authorization'],
];

export function providerForResourceType(type: string): string | null {
  let best: [string, string] | null = null;
  for (const entry of PROVIDER_BY_PREFIX) if (type.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  return best ? best[1] : null;
}

/** The azurerm resource and data types a set of generated files uses. */
export function azurermTypesIn(files: { filename: string; content: string }[]): string[] {
  const found = new Set<string>();
  for (const f of files) {
    if (!f.filename.endsWith('.tf')) continue;
    for (const m of f.content.matchAll(/^\s*resource\s+"(azurerm_[a-z0-9_]+)"/gm)) found.add(m[1]!);
    for (const m of f.content.matchAll(/^\s*data\s+"(azurerm_[a-z0-9_]+)"/gm)) found.add(`data.${m[1]}`);
  }
  return [...found].sort();
}

export interface AzureRole { name: string; why: string }

export interface AzureRequiredPermissions {
  /** Resource providers the design uses, e.g. ["Microsoft.Network", "Microsoft.Sql"]; always includes the state storage's. */
  providers: string[];
  /** Terraform types that could not be mapped to a provider. */
  unknownTypes: string[];
  roles: AzureRole[];
  /** True when the design creates role assignments, which Contributor cannot do. */
  needsRoleAssignment: boolean;
  terraformTypes: string[];
}

export function azureRequiredPermissionsFor(files: { filename: string; content: string }[]): AzureRequiredPermissions {
  const terraformTypes = azurermTypesIn(files);
  const providers = new Set<string>(['Microsoft.Resources', 'Microsoft.Storage']);        // the resource group and the state storage
  const unknown = new Set<string>();
  for (const t of terraformTypes) {
    const isData = t.startsWith('data.');
    const p = providerForResourceType(t.replace(/^data\./, ''));
    if (p) providers.add(p);
    else if (!isData) unknown.add(t);        // a data lookup (for example the current client's identity) is a read, not something to grant
  }
  const needsRoleAssignment = providers.has('Microsoft.Authorization');
  const roles: AzureRole[] = [{ name: 'Contributor', why: 'creates, changes and deletes everything the design contains, and the state storage' }];
  if (needsRoleAssignment) roles.push({ name: 'User Access Administrator', why: 'this design gives one resource access to another (role assignments), which Contributor is not allowed to do' });
  return { providers: [...providers].sort(), unknownTypes: [...unknown].sort(), roles, needsRoleAssignment, terraformTypes };
}

/** The Azure CLI commands that grant the roles, for the given service principal and subscription. */
export function azureGrantCommands(roles: AzureRole[], clientId: string, subscriptionId: string): string {
  const scope = `/subscriptions/${subscriptionId}`;
  return roles.map((r) => `az role assignment create --assignee ${clientId} --role "${r.name}" --scope ${scope}`).join('\n');
}

// ── "Check my access": the principal's effective permissions ─────────────────────────────────────────────────────────────────────

export interface AzurePermissionBlock { actions?: string[]; notActions?: string[] }

const wildcard = (pattern: string, value: string): boolean =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(value);

/** Whether the principal's permission blocks allow `action` (an action matches when some block allows it and no notAction of that block excludes it). */
export function azureAllows(blocks: AzurePermissionBlock[], action: string): boolean {
  return blocks.some((b) => (b.actions ?? []).some((a) => wildcard(a, action)) && !(b.notActions ?? []).some((n) => wildcard(n, action)));
}

export interface AzureAccessCheck {
  state: 'ok' | 'partial' | 'cannot-check';
  providers: { provider: string; allowed: boolean | null }[];
  /** Whether role assignments may be created (only asked when the design needs them). */
  roleAssignments?: boolean | null;
  message?: string;
}

export function evaluateAzureAccess(blocks: AzurePermissionBlock[], providers: string[], needsRoleAssignment: boolean): AzureAccessCheck {
  const rows = providers.map((provider) => ({
    provider,
    // A write on a representative resource type of that provider: the question "may it create things in this provider?"
    allowed: provider === 'Microsoft.Authorization' ? azureAllows(blocks, 'Microsoft.Authorization/roleAssignments/write') : azureAllows(blocks, `${provider}/register/action`) || azureAllows(blocks, `${provider}/*/write`) || azureAllows(blocks, `${provider}/*`),
  }));
  const roleAssignments = needsRoleAssignment ? azureAllows(blocks, 'Microsoft.Authorization/roleAssignments/write') : undefined;
  const missing = rows.filter((r) => !r.allowed).map((r) => r.provider);
  const lacksRoleAssignments = needsRoleAssignment && !roleAssignments;
  if (missing.length === 0 && !lacksRoleAssignments) return { state: 'ok', providers: rows, ...(roleAssignments !== undefined ? { roleAssignments } : {}) };
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`the principal cannot yet create in: ${missing.join(', ')}`);
  if (lacksRoleAssignments) parts.push('it cannot create role assignments, which this design needs');
  return { state: 'partial', providers: rows, ...(roleAssignments !== undefined ? { roleAssignments } : {}), message: `${parts.join('; ')}. Grant the role${missing.length > 0 && lacksRoleAssignments ? 's' : ''} above, then check again.`.replace(/^./, (c) => c.toUpperCase()) };
}

/** The part of the HTTP layer this needs, so it can be tested without Azure. */
export type AzureFetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Asks Azure for the calling principal's effective permissions on the subscription. Never throws: a refusal or failure is "cannot check"
 * with a reason, never a guess.
 */
export async function checkAzureAccess(args: { token: string; subscriptionId: string; providers: string[]; needsRoleAssignment: boolean; fetcher?: AzureFetch }): Promise<AzureAccessCheck> {
  const fetcher = args.fetcher ?? ((url, init) => fetch(url, init) as never);
  const unavailable = (message: string): AzureAccessCheck => ({ state: 'cannot-check', providers: args.providers.map((provider) => ({ provider, allowed: null })), message });
  try {
    const res = await fetcher(`https://management.azure.com/subscriptions/${encodeURIComponent(args.subscriptionId)}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`, { headers: { Authorization: `Bearer ${args.token}` } });
    if (!res.ok) {
      return unavailable(res.status === 403 || res.status === 401
        ? 'Azure would not tell this principal what it is allowed to do. Grant the role above and deploy, or check in the Azure portal under Access control (IAM).'
        : `Azure did not answer the access check (HTTP ${res.status}). Try again, or grant the role above and deploy.`);
    }
    const body = await res.json() as { value?: AzurePermissionBlock[] };
    if (!Array.isArray(body.value)) return unavailable('Azure returned no permissions for this principal. It may have no role on the subscription yet.');
    return evaluateAzureAccess(body.value, args.providers, args.needsRoleAssignment);
  } catch (err) {
    return unavailable(`The access check could not reach Azure (${err instanceof Error ? err.message.slice(0, 120) : 'network error'}). Try again.`);
  }
}
