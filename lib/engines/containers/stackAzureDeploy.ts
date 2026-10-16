/**
 * "Deploy to an Azure VM" for a whole project (Frontend + Backend + API + Database): one Ubuntu VM that runs the project's Docker Compose file.
 * The Azure counterpart of stackEc2Deploy.ts, with the same rules, and built the way a single service's Azure VM bundle (azureVmDeploy.ts) is.
 *
 *  - Terraform creates a resource group, one container registry (a repository per built service), a Key Vault, a managed identity, a network
 *    whose security group opens only the public service's port, and one VM. No SSH and no registry password.
 *  - The VM installs Docker and the Compose plugin (a pinned release, refused unless it matches its checksum). A systemd service signs in to the
 *    registry with the VM's identity, reads the secrets from Key Vault, pulls the images and runs `docker compose up`.
 *  - The registry, the vault and the image tag are read from the VM's own tags. The compose file is written to the VM at first boot (cloud-init)
 *    and replaced by deploy.sh on every release, through `az vm run-command`, so a release never replaces the VM (and the database volume on its disk).
 *  - Secret values never enter Terraform, its state, the tags or any file: they are read from Key Vault when the service starts.
 */
import { defaultConfig, type ContainerConfig } from './dockerTemplates';
import { defaultAzVm, estimateAzVmCost, validateAzVm, vaultSecretName, type AzVmConfig } from './azureVmDeploy';
import { q, type DeployCost } from './ec2Deploy';
import { DB_SINGLE_MACHINE_NOTE } from './databases';
import { composePluginSh, type StackDeployBase } from './stackEc2Deploy';

export interface StackAzureSpec extends StackDeployBase { azvm: AzVmConfig }

export const stackAzureDefaults = (): AzVmConfig => ({ ...defaultAzVm(), enabled: true, size: 'Standard_B2ms', diskGb: 40, githubActions: false });

const hcl = (s: string) => JSON.stringify(s).replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');

/** The settings checked as a single service's are (name, location, size, CIDR, disk, tag), against the one port that is open. */
function asSingle(s: StackAzureSpec): ContainerConfig {
  return { ...defaultConfig('node'), appName: s.name, port: s.entry.port, azvm: { ...s.azvm, enabled: true, githubRepo: '', software: [] } };
}

export function validateStackAzure(s: StackAzureSpec): string[] {
  return validateAzVm(asSingle(s));
}

export function stackAzureWarnings(s: StackAzureSpec): string[] {
  const w: string[] = [];
  const v = s.azvm;
  if (v.allowedCidr === '0.0.0.0/0') w.push(`Azure VM: ${s.entry.service} (port ${s.entry.port}) will be open to the whole internet. Narrow "who can connect" if it is not public.`);
  if (v.imageTag === 'latest') w.push('Azure VM: the "latest" tag is used. A version tag (for example the commit id) makes it clear what is running.');
  if (s.secrets.length > 0) w.push(`Azure VM: deploy.sh asks for ${s.secrets.join(', ')} and stores each in Key Vault; the VM reads them when the services start.`);
  if (s.databaseLabel) w.push(`Azure VM: ${s.databaseLabel} runs on the same VM as the application, with its data on the VM's disk. ${DB_SINGLE_MACHINE_NOTE}`);
  w.push('Azure VM: the VM serves HTTP only, with no load balancer, and is not replaced automatically if it fails.');
  return w;
}

export function estimateStackAzureCost(s: StackAzureSpec): DeployCost {
  const c = estimateAzVmCost(asSingle(s))!;
  // The registry is created only when something is built.
  const lines = s.built.length > 0 ? c.lines : c.lines.filter((l) => !l.label.startsWith('Container Registry'));
  const total = Math.round(lines.reduce((t, l) => t + l.monthlyUsd, 0) * 100) / 100;
  return { ...c, monthlyUsd: total, lines };
}

// ─── Terraform ───────────────────────────────────────────────────────────────

function mainTf(s: StackAzureSpec): string {
  const repos = s.built.length > 0;
  return `terraform {
  required_version = ">= 1.5.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.100"
    }
  }
}

provider "azurerm" {
  features {
    key_vault {
      # So destroy.sh leaves nothing behind that would block creating the same vault again.
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
  }
}

data "azurerm_client_config" "current" {}

locals {
  tags = {
    ManagedBy = "CloudCraft"
    App       = var.app_name
  }
  slug       = replace(replace(var.app_name, "-", ""), "_", "")
  suffix     = substr(md5("$\{data.azurerm_client_config.current.subscription_id}$\{var.app_name}"), 0, 6)
${repos ? `  acr_name   = substr("acr$\{local.slug}$\{local.suffix}", 0, 50)
` : ''}  vault_name = "kv$\{substr(local.slug, 0, 12)}$\{local.suffix}"
}

resource "azurerm_resource_group" "app" {
  name     = "rg-$\{var.app_name}"
  location = var.location
  tags     = local.tags
}

# ── ${repos ? 'Registry and secrets' : 'Secrets'} ──────────────────────────────────────────────────────

${repos ? `# One registry for every service (a repository each). No admin user: the VM pulls with its managed identity, which can only read images.
resource "azurerm_container_registry" "app" {
  name                = local.acr_name
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

` : ''}resource "azurerm_key_vault" "app" {
  name                       = local.vault_name
  location                   = azurerm_resource_group.app.location
  resource_group_name        = azurerm_resource_group.app.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  enable_rbac_authorization  = true
  soft_delete_retention_days = 7
  purge_protection_enabled   = false
  tags                       = local.tags
}

# Whoever runs deploy.sh can store secrets; the VM can only read them.
resource "azurerm_role_assignment" "deployer_secrets" {
  scope                = azurerm_key_vault.app.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_user_assigned_identity" "app" {
  name                = "id-$\{var.app_name}"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  tags                = local.tags
}

${repos ? `resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.app.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

` : ''}resource "azurerm_role_assignment" "vault_read" {
  scope                = azurerm_key_vault.app.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# ── Network: only the public service's port, no SSH ──────────────────────────

resource "azurerm_virtual_network" "app" {
  name                = "vnet-$\{var.app_name}"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  address_space       = ["10.20.0.0/16"]
  tags                = local.tags
}

resource "azurerm_subnet" "app" {
  name                 = "snet-app"
  resource_group_name  = azurerm_resource_group.app.name
  virtual_network_name = azurerm_virtual_network.app.name
  address_prefixes     = ["10.20.1.0/24"]
}

resource "azurerm_network_security_group" "app" {
  name                = "nsg-$\{var.app_name}"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  tags                = local.tags

  # ${s.entry.service}: the only service open to the network.
  security_rule {
    name                       = "entry-port"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = tostring(var.entry_port)
    source_address_prefix      = var.allowed_cidr
    destination_address_prefix = "*"
  }
}

resource "azurerm_public_ip" "app" {
  name                = "pip-$\{var.app_name}"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_network_interface" "app" {
  name                = "nic-$\{var.app_name}"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  tags                = local.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.app.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.app.id
  }
}

resource "azurerm_network_interface_security_group_association" "app" {
  network_interface_id      = azurerm_network_interface.app.id
  network_security_group_id = azurerm_network_security_group.app.id
}

# ── The server ───────────────────────────────────────────────────────────────

resource "azurerm_linux_virtual_machine" "app" {
  name                            = "vm-$\{var.app_name}"
  computer_name                   = substr(replace(var.app_name, "_", "-"), 0, 63)
  location                        = azurerm_resource_group.app.location
  resource_group_name             = azurerm_resource_group.app.name
  size                            = var.vm_size
  admin_username                  = "azureuser"
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.app.id]
  custom_data                     = filebase64("$\{path.module}/cloud-init.sh")

  # Azure requires a key. deploy.sh passes a throw-away public key and deletes the private half, so nobody can sign in over SSH;
  # use "az vm run-command invoke" instead.
  admin_ssh_key {
    username   = "azureuser"
    public_key = var.admin_ssh_public_key
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = var.disk_gb
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  # The start-up script reads these from the VM itself (instance metadata), so the script never has to change.
  tags = merge(local.tags, {
${repos ? `    acr       = azurerm_container_registry.app.login_server
` : ''}    vault     = azurerm_key_vault.app.name
    image_tag = var.image_tag
  })

  # The VM keeps the database's data on its disk, so nothing may replace it: not a changed start-up script (the compose file is replaced
  # by deploy.sh through run-command instead) and not a new tag (deploy.sh sets it).
  lifecycle {
    ignore_changes = [admin_ssh_key, tags, custom_data]
  }

  depends_on = [${repos ? 'azurerm_role_assignment.acr_pull, ' : ''}azurerm_role_assignment.vault_read]
}
`;
}

function variablesTf(s: StackAzureSpec): string {
  const v = s.azvm;
  return `variable "location" {
  description = "Azure region to deploy to."
  type        = string
  default     = ${hcl(v.location)}
}

variable "app_name" {
  description = "Name used for the resource group, VM, registry and vault."
  type        = string
  default     = ${hcl(s.name)}
}

variable "entry_port" {
  description = "The port of the ${s.entry.service}, the only service open to the network."
  type        = number
  default     = ${s.entry.port}
}

variable "vm_size" {
  type    = string
  default = ${hcl(v.size)}
}

variable "disk_gb" {
  type    = number
  default = ${v.diskGb}
}

variable "allowed_cidr" {
  description = "Who can reach the ${s.entry.service} (IPv4 range)."
  type        = string
  default     = ${hcl(v.allowedCidr)}
}

variable "image_tag" {
  description = "Image tag to run. deploy.sh sets it."
  type        = string
  default     = ${hcl(v.imageTag)}
}

variable "admin_ssh_public_key" {
  description = "Public key Azure requires on a Linux VM. deploy.sh creates a throw-away pair and deletes the private key."
  type        = string
}
`;
}

function outputsTf(s: StackAzureSpec): string {
  return `${s.built.length > 0 ? `output "acr_name" {
  description = "The container registry that holds the images."
  value       = azurerm_container_registry.app.name
}

` : ''}output "vault_name" {
  description = "Key Vault that holds the secrets (deploy.sh stores them here)."
  value       = azurerm_key_vault.app.name
}

output "resource_group" {
  value = azurerm_resource_group.app.name
}

output "vm_name" {
  value = azurerm_linux_virtual_machine.app.name
}

output "public_ip" {
  value = azurerm_public_ip.app.ip_address
}

output "app_url" {
  value = "http://$\{azurerm_public_ip.app.ip_address}:$\{var.entry_port}${s.entry.path}"
}

output "logs" {
  description = "Read the logs of every service (no SSH needed)."
  value       = "az vm run-command invoke --resource-group $\{azurerm_resource_group.app.name} --name $\{azurerm_linux_virtual_machine.app.name} --command-id RunShellScript --scripts 'journalctl -u ${s.name}.service -n 100 --no-pager' --query 'value[0].message' -o tsv"
}
`;
}

// ─── start-up script ─────────────────────────────────────────────────────────

export function stackCloudInit(s: StackAzureSpec): string {
  const app = s.name;
  const repos = s.built.length > 0;
  return `#!/bin/bash
# Runs once when the VM first starts. Installs Docker and the Compose plugin, writes the compose file, and installs a systemd service that runs ${app}.
# Nothing here is specific to a deployment: the registry, the vault and the image tag come from the VM's tags (instance metadata).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y docker.io curl python3
systemctl enable --now docker

${composePluginSh()}
# The compose file the services run. deploy.sh replaces it on every release (az vm run-command), so a release never replaces this VM.
mkdir -p /opt/${app}
cat > /opt/${app}/compose.yml <<'COMPOSE'
${s.compose.trimEnd()}
COMPOSE

cat > /usr/local/bin/${app}-run <<'RUNNER'
#!/bin/bash
# Started by systemd. Safe to re-run: it reads the current tag and secrets every time, so a restart is a new release.
set -euo pipefail

APP=${q(app)}
DIR="/opt/$APP"
IMDS=http://169.254.169.254/metadata
vmtag() { curl -fsS -H Metadata:true "$IMDS/instance/compute/tagsList?api-version=2021-02-01" | python3 -c 'import sys, json; print({t["name"]: t["value"] for t in json.load(sys.stdin)}.get(sys.argv[1], ""))' "$1"; }
token() { curl -fsS -H Metadata:true "$IMDS/identity/oauth2/token?api-version=2018-02-01&resource=$1" | python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])'; }

VAULT=$(vmtag vault)
TAG=$(vmtag image_tag)
${repos ? `ACR=$(vmtag acr)
[ -n "$ACR" ] && [ -n "$TAG" ] || { echo "The VM tags acr and image_tag are missing."; exit 1; }

# Sign in to the registry with the VM's identity: exchange its Azure AD token for a registry token.
AAD=$(token https://management.azure.com/)
REFRESH=$(curl -fsS -X POST "https://$ACR/oauth2/exchange" -d "grant_type=access_token&service=$ACR&access_token=$AAD" | python3 -c 'import sys, json; print(json.load(sys.stdin)["refresh_token"])')
echo "$REFRESH" | docker login "$ACR" --username 00000000-0000-0000-0000-000000000000 --password-stdin
` : `ACR=""
[ -n "$TAG" ] || { echo "The VM tag image_tag is missing."; exit 1; }
`}
umask 077
cd "$DIR"
[ -f compose.yml ] || { echo "compose.yml is missing in $DIR"; exit 1; }

# The settings file for Compose: where the images are, which tag, and the secrets (single-quoted so nothing in a value is interpreted).
{
  printf 'REGISTRY=%s\\n' "$ACR"
  printf 'TAG=%s\\n' "$TAG"
} > .env
${s.secrets.length ? `KV_TOKEN=$(token https://vault.azure.net)
${s.secrets.map((k) => `# A failed read stops the script (set -e), so the services never start with an empty secret.
VALUE=$(curl -fsS -H "Authorization: Bearer $KV_TOKEN" "https://$VAULT.vault.azure.net/secrets/${vaultSecretName(k)}?api-version=7.4" | python3 -c 'import sys, json; print(json.load(sys.stdin)["value"])')
printf "%s='%s'\\n" '${k}' "$VALUE" >> .env`).join('\n')}
` : ''}
docker compose -p "$APP" -f compose.yml pull --quiet
exec docker compose -p "$APP" -f compose.yml up --remove-orphans
RUNNER
chmod 755 /usr/local/bin/${app}-run

cat > /etc/systemd/system/${app}.service <<'UNIT'
[Unit]
Description=${app} (docker compose)
After=docker.service network-online.target
Requires=docker.service

[Service]
ExecStart=/usr/local/bin/${app}-run
ExecStop=/usr/bin/docker compose -p ${app} -f /opt/${app}/compose.yml stop
# If an image is not pushed yet, or a secret is missing, try again in 30 seconds.
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now ${app}.service
`;
}

// ─── one-command scripts ─────────────────────────────────────────────────────

export function stackAzureDeploySh(s: StackAzureSpec): string {
  const repos = s.built.length > 0;
  const total = 4;
  return `#!/usr/bin/env bash
# One command to deploy ${s.name} (${repos ? s.built.join(', ') : 'ready-made images'}${s.databaseLabel ? `, ${s.databaseLabel}` : ''}) to one Azure VM: bash deploy.sh
#   1. creates the resource group${repos ? ', registry' : ''} and Key Vault with Terraform (first run), asking you to confirm
#   2. stores the secret values in Key Vault (asks once, hidden), never in a file
#   3. ${repos ? 'builds each service\'s image inside Azure (az acr build), so Docker is not needed on this machine' : 'nothing to build: every service uses a ready-made image'}
#   4. creates or updates the VM, puts the compose file on it, restarts the services and waits until the ${s.entry.service} answers
# Run it again to release a new version (IMAGE_TAG=v2 bash deploy.sh uses another tag). Add --yes to skip the Terraform confirmation.
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(s.name)}
TAG="\${IMAGE_TAG:-${s.azvm.imageTag}}"
SECRETS=(${s.secrets.map(q).join(' ')})
GENERATED=(${s.generated.map(q).join(' ')})
BUILT=(${s.built.map(q).join(' ')})
APPROVE=""
[ "\${1:-}" = "--yes" ] && APPROVE="-auto-approve"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing tool: $1. $2"; exit 1; }; }
need terraform "Install it from https://developer.hashicorp.com/terraform/install"
need az        "Install the Azure CLI from https://learn.microsoft.com/cli/azure/install-azure-cli"
need ssh-keygen "It ships with OpenSSH."
need openssl   "Needed to generate a random database password"
need base64    "It ships with your system."
az account show >/dev/null 2>&1 || { echo "You are not signed in to Azure. Run: az login"; exit 1; }
echo "Subscription: $(az account show --query name -o tsv)"

is_generated() { local n; for n in \${GENERATED[@]+"\${GENERATED[@]}"}; do [ "$n" = "$1" ] && return 0; done; return 1; }

# Azure insists on an SSH key for a Linux VM. A throw-away public key is enough: the private half is deleted right away,
# so nobody can sign in over SSH (use az vm run-command instead).
KEYDIR=$(mktemp -d)
trap 'rm -rf "$KEYDIR"' EXIT
ssh-keygen -q -t ed25519 -N '' -f "$KEYDIR/k" -C "${s.name}-throwaway"
export TF_VAR_admin_ssh_public_key="$(cat "$KEYDIR/k.pub")"
rm -f "$KEYDIR/k"

az provider register --namespace Microsoft.Compute --wait >/dev/null
az provider register --namespace Microsoft.ContainerRegistry --wait >/dev/null
az provider register --namespace Microsoft.KeyVault --wait >/dev/null

echo "==> 1/${total}  ${repos ? 'Registry and ' : ''}Key Vault (Terraform)"
terraform -chdir=azvm init -input=false >/dev/null
terraform -chdir=azvm apply -var "image_tag=$TAG" \\
  -target=azurerm_resource_group.app${repos ? ' -target=azurerm_container_registry.app' : ''} -target=azurerm_key_vault.app -target=azurerm_role_assignment.deployer_secrets \\
  \${APPROVE:+-auto-approve}

echo "==> 2/${total}  Secrets"
VAULT=$(terraform -chdir=azvm output -raw vault_name)
for NAME in \${SECRETS[@]+"\${SECRETS[@]}"}; do
  KVNAME=$(echo "$NAME" | tr '_' '-')
  if az keyvault secret show --vault-name "$VAULT" --name "$KVNAME" >/dev/null 2>&1; then
    echo "    $NAME: already stored"
  else
    if is_generated "$NAME"; then
      read -r -s -p "    Value for $NAME (hidden; press Enter to generate a random one): " VALUE; echo
      [ -n "$VALUE" ] || { VALUE=$(openssl rand -hex 24); echo "    $NAME: generated"; }
    else
      read -r -s -p "    Value for $NAME (hidden): " VALUE; echo
    fi
    [ -n "$VALUE" ] || { echo "    $NAME cannot be empty."; exit 1; }
    # The value ends up inside a connection URL and a settings file, so it must not contain anything that needs quoting.
    [[ "$VALUE" =~ ^[A-Za-z0-9._~-]+$ ]] || { echo "    $NAME may use only letters, digits and . _ ~ - (no spaces or other symbols)."; exit 1; }
    TMP=$(mktemp); chmod 600 "$TMP"
    printf '%s' "$VALUE" > "$TMP"
    # A new role assignment can take a minute to take effect.
    for TRY in 1 2 3 4 5 6 7 8; do
      if az keyvault secret set --vault-name "$VAULT" --name "$KVNAME" --file "$TMP" >/dev/null 2>&1; then break; fi
      [ "$TRY" = 8 ] && { rm -f "$TMP"; echo "    Could not store $NAME. Your account needs 'Key Vault Secrets Officer' on $VAULT."; exit 1; }
      sleep 15
    done
    rm -f "$TMP"; unset VALUE
    echo "    $NAME: stored"
  fi
done

${repos ? `echo "==> 3/${total}  Build the images in Azure"
ACR=$(terraform -chdir=azvm output -raw acr_name)
for LAYER in \${BUILT[@]+"\${BUILT[@]}"}; do
  echo "    $LAYER"
  az acr build --registry "$ACR" --image "$APP-$LAYER:$TAG" --platform linux/amd64 "./$LAYER"
done
` : `echo "==> 3/${total}  Images"
echo "    Every service uses a ready-made image: nothing to build."
`}
echo "==> ${total}/${total}  Virtual machine (Terraform), compose file, start"
terraform -chdir=azvm apply -var "image_tag=$TAG" \${APPROVE:+-auto-approve}
RG=$(terraform -chdir=azvm output -raw resource_group)
VM=$(terraform -chdir=azvm output -raw vm_name)
# Tags are ignored by Terraform after creation so that a release does not touch the VM: set the tag here.
az vm update --resource-group "$RG" --name "$VM" --set "tags.image_tag=$TAG" >/dev/null

# The compose file on the VM is replaced on every release. A new VM already has it from its first start; its agent may still be starting, so try for a while.
COMPOSE_B64=$(base64 < azvm/compose.deploy.yml | tr -d '\\n')
PUT="mkdir -p /opt/$APP && printf '%s' '$COMPOSE_B64' | base64 -d > /opt/$APP/compose.yml.new && mv /opt/$APP/compose.yml.new /opt/$APP/compose.yml"
SENT=""
for TRY in $(seq 1 30); do
  if az vm run-command invoke --resource-group "$RG" --name "$VM" --command-id RunShellScript --scripts "$PUT" >/dev/null 2>&1; then SENT=yes; break; fi
  [ "$TRY" = 1 ] && echo "    Waiting for the VM to accept commands ..."
  sleep 20
done
[ -n "$SENT" ] || { echo "    Could not reach the VM to update its compose file. Run bash deploy.sh again in a few minutes."; exit 1; }
if az vm run-command invoke --resource-group "$RG" --name "$VM" --command-id RunShellScript --scripts "systemctl restart $APP.service" >/dev/null 2>&1; then
  echo "    Restart sent."
else
  echo "    Could not restart the services now. They start by themselves within a few minutes."
fi

URL=$(terraform -chdir=azvm output -raw app_url)
WAIT="\${DEPLOY_WAIT_SECONDS:-600}"
END=$((SECONDS + WAIT))
echo "    Waiting for $URL ..."
UP=""
while [ "$SECONDS" -lt "$END" ]; do
  if curl -fsS -m 5 -o /dev/null "$URL" >/dev/null 2>&1; then UP=yes; break; fi
  sleep 10
done
if [ -n "$UP" ]; then
  echo "Done. ${s.name} is running at $URL"
else
  echo "Not answering yet. The first start installs Docker and pulls every image, which can take several minutes. Try $URL again, or read the logs:"
  echo "  $(terraform -chdir=azvm output -raw logs)"
fi
`;
}

export function stackAzureDestroySh(s: StackAzureSpec): string {
  return `#!/usr/bin/env bash
# Removes everything deploy.sh created (the whole resource group: VM, network, registry with its images, Key Vault): bash destroy.sh
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(s.name)}

command -v terraform >/dev/null 2>&1 || { echo "Missing tool: terraform"; exit 1; }
command -v az >/dev/null 2>&1 || { echo "Missing tool: az"; exit 1; }
az account show >/dev/null 2>&1 || { echo "You are not signed in to Azure. Run: az login"; exit 1; }

echo "This permanently deletes the resource group rg-$APP and everything in it${s.databaseLabel ? `, including the ${s.databaseLabel} data on the VM's disk` : ''} and the secrets in its Key Vault."
read -r -p "Type the project name ($APP) to continue: " ANSWER
[ "$ANSWER" = "$APP" ] || { echo "Cancelled."; exit 1; }

# Destroy needs a value for the key variable, not a real one.
export TF_VAR_admin_ssh_public_key="unused"
terraform -chdir=azvm init -input=false >/dev/null
terraform -chdir=azvm destroy -auto-approve
echo "Done."
`;
}

function stackAzureReadme(s: StackAzureSpec): string {
  const v = s.azvm;
  return `# Deploy ${s.name} to an Azure VM

One Azure VM runs all the services of this project with Docker Compose.

## Quick start

You need Terraform and the Azure CLI installed and to be signed in (\`az login\`). Docker is **not** needed: ${s.built.length > 0 ? 'the images are built inside Azure' : 'every service uses a ready-made image'}. From the project folder (the one with \`deploy.sh\`):

\`\`\`bash
bash deploy.sh
\`\`\`

It creates the resource group${s.built.length > 0 ? ', a container registry' : ''} and a Key Vault, asks for the secret values (${s.secrets.length ? s.secrets.join(', ') : 'none are needed'}${s.generated.length ? `; press Enter at ${s.generated.join(', ')} to generate a random one` : ''}), ${s.built.length > 0 ? 'builds each image in Azure, ' : ''}creates the VM, puts the compose file on it, starts the services and prints the address of the ${s.entry.service}.

To release a new version run \`bash deploy.sh\` again (\`IMAGE_TAG=v2 bash deploy.sh\` to use another tag). To remove everything: \`bash destroy.sh\`.

## What gets created

- A resource group \`rg-${s.name}\` in \`${v.location}\` with a virtual network, a network security group that opens **only port ${s.entry.port}** (the ${s.entry.service}) to \`${v.allowedCidr}\`, a static public IP and one Ubuntu 22.04 VM (\`${v.size}\`, ${v.diskGb} GB) that runs \`azvm/compose.deploy.yml\` under systemd. The other services${s.databaseLabel ? ' and the database' : ''} are reachable only from inside the VM. **No SSH**: manage it with \`az vm run-command\`.
${s.built.length > 0 ? '- A container registry (Basic, no admin user) with one repository per built service: ' + s.built.map((l) => `\`${s.name}-${l}\``).join(', ') + '. ' : '- '}A Key Vault. The VM has a managed identity that can only ${s.built.length > 0 ? 'pull images from this registry and ' : ''}read secrets from this vault.
${s.secrets.length ? `- Secrets (${s.secrets.join(', ')}) are stored in Key Vault (as ${s.secrets.map((k) => `\`${vaultSecretName(k)}\``).join(', ')}) and read by the VM when the services start. They are never written to Terraform, its state, the VM's tags or any file.\n` : ''}
## How a release works

1. \`deploy.sh\` builds each image in Azure with the tag (\`IMAGE_TAG\`, default \`${v.imageTag}\`).
2. It sets the tag on the VM and replaces \`/opt/${s.name}/compose.yml\` on it. **The VM is not replaced**, so the database volume on its disk survives.
3. It restarts the service. On every start the VM signs in to the registry with its identity, reads the secrets, pulls the images and runs \`docker compose up\`.

## Look inside the VM

\`\`\`bash
az vm run-command invoke --resource-group rg-${s.name} --name vm-${s.name} --command-id RunShellScript --scripts 'journalctl -u ${s.name}.service -n 100 --no-pager' --query 'value[0].message' -o tsv
az vm run-command invoke --resource-group rg-${s.name} --name vm-${s.name} --command-id RunShellScript --scripts 'docker compose -p ${s.name} -f /opt/${s.name}/compose.yml ps' --query 'value[0].message' -o tsv
\`\`\`

## Common problems

- **The address does not answer for a few minutes**: a new VM installs Docker and pulls every image first.
- **"Could not store a secret"**: your account needs the role *Key Vault Secrets Officer* on the vault; Terraform assigns it to whoever ran \`deploy.sh\`, and it can take a minute to apply.
- **"SkuNotAvailable"**: the VM size is not offered in that region for your subscription. Change \`vm_size\` in \`azvm/variables.tf\` or pick another region.
- **The address never answers**: the port is open only to \`${v.allowedCidr}\`.

## What to know

${s.databaseLabel ? `- ${s.databaseLabel} runs on the same VM, in the volume \`database-data\` on its disk. ${DB_SINGLE_MACHINE_NOTE}\n` : ''}- This is a single VM: HTTP only, no load balancer, no automatic replacement if it fails. For HTTPS or several instances use Azure Container Apps or AKS.
- Terraform keeps its record in \`azvm/terraform.tfstate\`. Keep that folder; \`bash destroy.sh\` needs it.
- Costs: the VM, its disk and the public IP bill every hour; the registry bills daily.
`;
}

export function generateStackAzureFiles(s: StackAzureSpec): Array<{ path: string; content: string; executable?: boolean }> {
  return [
    { path: 'deploy.sh', content: stackAzureDeploySh(s), executable: true },
    { path: 'destroy.sh', content: stackAzureDestroySh(s), executable: true },
    { path: 'azvm/main.tf', content: mainTf(s) },
    { path: 'azvm/variables.tf', content: variablesTf(s) },
    { path: 'azvm/outputs.tf', content: outputsTf(s) },
    { path: 'azvm/cloud-init.sh', content: stackCloudInit(s) },
    { path: 'azvm/compose.deploy.yml', content: s.compose },
    { path: 'azvm/.gitignore', content: '.terraform/\n*.tfstate\n*.tfstate.*\ncrash.log\n' },
    { path: 'azvm/README.md', content: stackAzureReadme(s) },
  ];
}
