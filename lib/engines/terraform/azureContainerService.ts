/**
 * Terraform for the "Container service" canvas node on Azure: one Linux VM that runs a Docker image from its own container registry.
 *
 * The VM, its identity and its start-up script are the ones the Container Templates "Azure VM" bundle uses
 * (lib/engines/containers/azureVmDeploy.ts), so a design drawn on the canvas and a bundle downloaded from the panel behave the same:
 * no SSH password, no registry admin user, secrets read from Key Vault by the VM's managed identity, the registry / vault / image tag read
 * from the VM's own tags. The image is built and pushed by the workflow / deploy.sh from Container Templates; until it exists the service
 * retries every 30 seconds.
 *
 * Azure insists on an SSH key for a Linux VM; it comes from the variable admin_ssh_public_key, like every other Linux VM in a design.
 */
import { containerConfigFromAzureNode, nodeProblemsFor } from '../containers/nodeConfig';
import { azureCloudInit } from '../containers/azureVmDeploy';

/** Text that goes inside a Terraform heredoc: nothing in it may start an interpolation or a directive. */
const heredoc = (s: string) => s.replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');
const q = (v: string) => JSON.stringify(v);

export function azureContainerServiceBlocks(name: string, cfg: Record<string, unknown>, rgName: string, rgLoc: string, subnetRef: string | null): string[] {
  const problems = nodeProblemsFor('azure_container_service', cfg);
  if (problems.length > 0) {
    return [`# CloudBuilder: the container service "${name}" was not generated. Fix: ${problems.join(' ').replace(/[\r\n]+/g, ' ')}`];
  }
  const c = containerConfigFromAzureNode(cfg);
  const app = c.appName;
  const v = c.azvm;
  const existing = c.image !== '';
  const out: string[] = [];

  out.push(`data "azurerm_client_config" "${name}" {}

locals {
  ${name}_slug   = replace(replace(${q(app)}, "-", ""), "_", "")
  ${name}_suffix = substr(md5("$\{data.azurerm_client_config.${name}.subscription_id}${app}"), 0, 6)
}

${existing ? '' : `# No admin user: the VM pulls with its managed identity, which can only read images.
resource "azurerm_container_registry" "${name}" {
  name                = substr("acr$\{local.${name}_slug}$\{local.${name}_suffix}", 0, 50)
  resource_group_name = ${rgName}
  location            = ${rgLoc}
  sku                 = "Basic"
  admin_enabled       = false
  tags = {
    ManagedBy = "CloudCraft"
  }
}

`}resource "azurerm_key_vault" "${name}" {
  name                       = "kv$\{substr(local.${name}_slug, 0, 12)}$\{local.${name}_suffix}"
  resource_group_name        = ${rgName}
  location                   = ${rgLoc}
  tenant_id                  = data.azurerm_client_config.${name}.tenant_id
  sku_name                   = "standard"
  enable_rbac_authorization  = true
  soft_delete_retention_days = 7
  purge_protection_enabled   = false
  tags = {
    ManagedBy = "CloudCraft"
  }
}

resource "azurerm_user_assigned_identity" "${name}" {
  name                = ${q(`id-${app}`)}
  resource_group_name = ${rgName}
  location            = ${rgLoc}
  tags = {
    ManagedBy = "CloudCraft"
  }
}

${existing ? '' : `resource "azurerm_role_assignment" "${name}_acr_pull" {
  scope                = azurerm_container_registry.${name}.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.${name}.principal_id
}
`}
resource "azurerm_role_assignment" "${name}_vault_read" {
  scope                = azurerm_key_vault.${name}.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.${name}.principal_id
}

# Whoever runs Terraform can store the secrets; the VM can only read them.
resource "azurerm_role_assignment" "${name}_deployer_secrets" {
  scope                = azurerm_key_vault.${name}.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.${name}.object_id
}`);

  out.push(`resource "azurerm_network_security_group" "${name}" {
  name                = ${q(`nsg-${app}`)}
  resource_group_name = ${rgName}
  location            = ${rgLoc}

  security_rule {
    name                       = "app-port"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = ${q(String(c.port))}
    source_address_prefix      = ${q(v.allowedCidr)}
    destination_address_prefix = "*"
  }

  tags = {
    ManagedBy = "CloudCraft"
  }
}

resource "azurerm_network_interface" "${name}" {
  name                = ${q(`nic-${app}`)}
  resource_group_name = ${rgName}
  location            = ${rgLoc}

  ip_configuration {
    name                          = "primary"
    subnet_id                     = ${subnetRef ?? 'azurerm_subnet.main.id # WARNING: not placed in a subnet'}
    private_ip_address_allocation = "Dynamic"
  }

  tags = {
    ManagedBy = "CloudCraft"
  }
}

resource "azurerm_network_interface_security_group_association" "${name}" {
  network_interface_id      = azurerm_network_interface.${name}.id
  network_security_group_id = azurerm_network_security_group.${name}.id
}`);

  out.push(`resource "azurerm_linux_virtual_machine" "${name}" {
  name                            = ${q(`vm-${app}`)}
  computer_name                   = ${q(app.replace(/_/g, '-').slice(0, 63))}
  resource_group_name             = ${rgName}
  location                        = ${rgLoc}
  size                            = ${q(v.size)}
  admin_username                  = "azureuser"
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.${name}.id]
  custom_data                     = base64encode(<<-EOT
${heredoc(azureCloudInit(c))}EOT
  )

  admin_ssh_key {
    username   = "azureuser"
    public_key = var.admin_ssh_public_key
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.${name}.id]
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = ${v.diskGb}
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  # The start-up script reads these from the VM itself (instance metadata), so the script never has to change.
  tags = {
    ManagedBy = "CloudCraft"
${existing ? '' : `    acr       = azurerm_container_registry.${name}.login_server
`}    vault     = azurerm_key_vault.${name}.name${existing ? '' : `
    image_tag = ${q(v.imageTag)}`}
  }

  depends_on = [${existing ? '' : `azurerm_role_assignment.${name}_acr_pull, `}azurerm_role_assignment.${name}_vault_read]
}`);
  return out;
}
