/**
 * Optional "deploy to an Azure VM" bundle for a container template: the Azure counterpart of the EC2 bundle. Terraform for a resource group,
 * network, one Linux VM that runs the container under systemd, a container registry and a Key Vault, plus deploy.sh / destroy.sh and a
 * GitHub Actions workflow.
 *
 * Safe by default, like the EC2 bundle:
 *  - no SSH and no password: the NSG opens only the app port, and the VM is managed with `az vm run-command`. deploy.sh makes a throw-away
 *    key pair only because Azure insists on one, and deletes the private half at once;
 *  - the VM has a managed identity that can only pull from this registry and read this vault; there is no registry admin user;
 *  - secrets live in Key Vault and are read by the VM when the container starts, never written to Terraform, its state or any file;
 *  - the start-up script is a static file: everything it needs (registry, vault, image tag) is read from the VM's own tags.
 */
import type { ContainerConfig } from './dockerTemplates';
import { usesExistingImage } from './existingImageUse';
import { azureVmHourlyUsd } from '@/lib/engines/cost/azurePricing';
import { GITHUB_REPO, TAG, q, secretNames, validCidr, type DeployCost } from './ec2Deploy';
import { companionServices } from './companions';
import { hostPorts, hostSoftwareSh, hostSoftwareWarnings, validateHostSoftware } from './hostSoftware';

export interface AzVmConfig {
  enabled: boolean;
  location: string;
  /** VM size, for example Standard_B2s. */
  size: string;
  diskGb: number;
  /** Who can reach the app port. */
  allowedCidr: string;
  imageTag: string;
  githubActions: boolean;
  githubRepo: string;
  scanImage: boolean;
  /** Software installed on the VM itself, by id (see lib/engines/servers/software.ts). */
  software: string[];
  /** One line for the home page of a web server installed this way. */
  pageText: string;
}

export const defaultAzVm = (): AzVmConfig => ({
  enabled: false, location: 'westeurope', size: 'Standard_B2s', diskGb: 30, allowedCidr: '0.0.0.0/0', imageTag: 'latest', githubActions: true, githubRepo: '', scanImage: true, software: [], pageText: '',
});

const LOCATION = /^[a-z]{3,}[a-z0-9]*$/;
const VM_SIZE = /^Standard_[A-Za-z0-9_]{2,30}$/;
const APP_NAME = /^[a-z](?:[a-z0-9]|-(?!-)){0,30}[a-z0-9]$/;

export function validateAzVm(c: ContainerConfig): string[] {
  const v = c.azvm;
  if (!v.enabled) return [];
  const out: string[] = [];
  if (!APP_NAME.test(c.appName)) out.push('Azure VM: the app name may use only lowercase letters, digits and single "-", must start with a letter and end with a letter or digit, up to 32 characters.');
  if (!LOCATION.test(v.location)) out.push('Azure VM: location looks like westeurope or eastus2.');
  if (!VM_SIZE.test(v.size)) out.push('Azure VM: size looks like Standard_B2s.');
  if (!validCidr(v.allowedCidr)) out.push('Azure VM: "who can connect" must be an IPv4 range such as 203.0.113.0/24 (or 0.0.0.0/0 for everyone).');
  if (!Number.isInteger(v.diskGb) || v.diskGb < 30 || v.diskGb > 1024) out.push('Azure VM: disk size must be 30 to 1024 GB.');
  if (!TAG.test(v.imageTag)) out.push('Azure VM: image tag may use letters, digits, "_", "." and "-" (up to 128 characters).');
  if (v.githubRepo !== '' && !GITHUB_REPO.test(v.githubRepo)) out.push('Azure VM: GitHub repository looks like owner/name.');
  out.push(...validateHostSoftware('Azure VM', v.software, c.port));
  return out;
}

export function azVmWarnings(c: ContainerConfig): string[] {
  const v = c.azvm;
  if (!v.enabled) return [];
  const w: string[] = [];
  if (v.allowedCidr === '0.0.0.0/0') w.push(`Azure VM: port ${c.port} will be open to the whole internet. Narrow "who can connect" if the app is not public.`);
  if (companionServices(c).length > 0) w.push('Azure VM: PostgreSQL, MySQL, MongoDB, Redis and RabbitMQ are not started on the VM. Use the managed Azure services and put the connection settings in the environment variables.');
  if (!usesExistingImage(c) && v.imageTag === 'latest') w.push('Azure VM: the "latest" tag is used. A version tag (for example the commit id) makes it clear what is running.');
  if (c.env.some((x) => x.secret)) w.push('Azure VM: deploy.sh stores each secret in Key Vault (asks once, hidden); the VM reads it when the container starts.');
  w.push(...hostSoftwareWarnings('Azure VM', v.software));
  if (hostPorts(v.software).length > 0 && v.allowedCidr === '0.0.0.0/0') w.push('Azure VM: the web server on ports 80 and 443 will be open to the whole internet. Narrow "who can connect" if the site is not public.');
  return w;
}

// ─── cost ────────────────────────────────────────────────────────────────────

const HOURS = 730;
const DISK_PER_GB = 0.075; // Standard SSD, rounded up to the disk tier
const round2 = (n: number) => Math.round(n * 100) / 100;

/** List-price estimate (East US, Linux, pay as you go) of the VM, its disk, public IP and registry. Undefined when the target is off. */
export function estimateAzVmCost(c: ContainerConfig): DeployCost | undefined {
  const v = c.azvm;
  if (!v.enabled) return undefined;
  const hourly = azureVmHourlyUsd(v.size);
  const lines = [
    { label: `VM ${v.size}`, monthlyUsd: round2((hourly ?? 0) * HOURS) },
    { label: `Disk ${v.diskGb} GB (Standard SSD)`, monthlyUsd: round2(v.diskGb * DISK_PER_GB) },
    { label: 'Public IP address (Standard, static)', monthlyUsd: round2(0.005 * HOURS) },
    ...(usesExistingImage(c) ? [] : [{ label: 'Container Registry (Basic)', monthlyUsd: 5 }]),
  ];
  const notes = ['Excludes data transfer out and Key Vault operations (the first 10,000 a month cost about $0.03).'];
  if (hourly === undefined) notes.push(`${v.size} is not in the price table, so its price is left out of the total.`);
  if (v.location !== 'eastus') notes.push(`Priced for East US; ${v.location} is usually a little different.`);
  return { monthlyUsd: round2(lines.reduce((t, l) => t + l.monthlyUsd, 0)), lines, notes };
}

// ─── Terraform ───────────────────────────────────────────────────────────────

const hcl = (s: string) => JSON.stringify(s).replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');
/** Key Vault secret names allow letters, digits and "-" only. */
export const vaultSecretName = (key: string) => key.replace(/_/g, '-');

function mainTf(c: ContainerConfig): string {
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
${usesExistingImage(c) ? '' : `  acr_name   = substr("acr$\{local.slug}$\{local.suffix}", 0, 50)
`}  vault_name = "kv$\{substr(local.slug, 0, 12)}$\{local.suffix}"
}

resource "azurerm_resource_group" "app" {
  name     = "rg-$\{var.app_name}"
  location = var.location
  tags     = local.tags
}

# ── ${usesExistingImage(c) ? 'Secrets' : 'Registry and secrets'} ──────────────────────────────────────────────────────

${usesExistingImage(c) ? '' : `# No admin user: the VM pulls with its managed identity, which can only read images.
resource "azurerm_container_registry" "app" {
  name                = local.acr_name
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

`}resource "azurerm_key_vault" "app" {
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

${usesExistingImage(c) ? '' : `resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.app.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

`}resource "azurerm_role_assignment" "vault_read" {
  scope                = azurerm_key_vault.app.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# ── Network: only the app port, no SSH ───────────────────────────────────────

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

  security_rule {
    name                       = "app-port"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = tostring(var.app_port)
    source_address_prefix      = var.allowed_cidr
    destination_address_prefix = "*"
  }
${hostPorts(c.azvm.software).map((port, i) => `
  security_rule {
    name                       = "web-${port}"
    priority                   = ${110 + i}
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "${port}"
    source_address_prefix      = var.allowed_cidr
    destination_address_prefix = "*"
  }
`).join('')}}

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
${usesExistingImage(c) ? '' : `    acr       = azurerm_container_registry.app.login_server
`}    vault     = azurerm_key_vault.app.name${usesExistingImage(c) ? '' : `
    image_tag = var.image_tag`}
  })

  lifecycle {
    ignore_changes = [admin_ssh_key, tags]
  }

  depends_on = [${usesExistingImage(c) ? '' : 'azurerm_role_assignment.acr_pull, '}azurerm_role_assignment.vault_read]
}
`;
}

function variablesTf(c: ContainerConfig): string {
  const v = c.azvm;
  return `variable "location" {
  description = "Azure region to deploy to."
  type        = string
  default     = ${hcl(v.location)}
}

variable "app_name" {
  description = "Name used for the resource group, VM, registry and vault."
  type        = string
  default     = ${hcl(c.appName)}
}

variable "app_port" {
  description = "Port the container listens on."
  type        = number
  default     = ${c.port}
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
  description = "Who can reach the app port (IPv4 range)."
  type        = string
  default     = ${hcl(v.allowedCidr)}
}

${usesExistingImage(c) ? '' : `variable "image_tag" {
  description = "Image tag to run. deploy.sh sets it."
  type        = string
  default     = ${hcl(v.imageTag)}
}

`}variable "admin_ssh_public_key" {
  description = "Public key Azure requires on a Linux VM. deploy.sh creates a throw-away pair and deletes the private key."
  type        = string
}
`;
}

function outputsTf(c: ContainerConfig): string {
  return `${usesExistingImage(c) ? '' : `output "acr_name" {
  description = "The container registry that holds the image."
  value       = azurerm_container_registry.app.name
}

`}output "vault_name" {
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
  value = "http://$\{azurerm_public_ip.app.ip_address}:$\{var.app_port}${c.healthPath}"
}

output "logs" {
  description = "Read the application logs (no SSH needed)."
  value       = "az vm run-command invoke --resource-group $\{azurerm_resource_group.app.name} --name $\{azurerm_linux_virtual_machine.app.name} --command-id RunShellScript --scripts 'journalctl -u ${c.appName}.service -n 100 --no-pager' --query 'value[0].message' -o tsv"
}
`;
}

// ─── start-up script ─────────────────────────────────────────────────────────

export function azureCloudInit(c: ContainerConfig): string {
  const app = c.appName;
  const plain = c.env.filter((v) => !v.secret);
  const secrets = secretNames(c);
  return `#!/bin/bash
# Runs once when the VM first starts. Installs Docker and a systemd service that pulls and runs ${app}.
# Nothing here is specific to a deployment: the registry, the vault and the image tag come from the VM's tags (instance metadata).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y docker.io curl python3
systemctl enable --now docker
${hostSoftwareSh(c.azvm.software, { family: 'apt', loginUser: 'azureuser', pageText: c.azvm.pageText })}
cat > /usr/local/bin/${app}-run <<'RUNNER'
#!/bin/bash
# Started by systemd. Safe to re-run: it fetches the current image and secrets every time, so a restart picks up a new push.
set -euo pipefail

IMDS=http://169.254.169.254/metadata
vmtag() { curl -fsS -H Metadata:true "$IMDS/instance/compute/tagsList?api-version=2021-02-01" | python3 -c 'import sys, json; print({t["name"]: t["value"] for t in json.load(sys.stdin)}.get(sys.argv[1], ""))' "$1"; }
token() { curl -fsS -H Metadata:true "$IMDS/identity/oauth2/token?api-version=2018-02-01&resource=$1" | python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])'; }

${usesExistingImage(c) ? `VAULT=$(vmtag vault)
IMAGE=${q(c.image)}
` : `ACR=$(vmtag acr)
VAULT=$(vmtag vault)
TAG=$(vmtag image_tag)
[ -n "$ACR" ] && [ -n "$TAG" ] || { echo "The VM tags acr and image_tag are missing."; exit 1; }
IMAGE="$ACR/${app}:$TAG"

# Sign in to the registry with the VM's identity: exchange its Azure AD token for a registry token.
AAD=$(token https://management.azure.com/)
REFRESH=$(curl -fsS -X POST "https://$ACR/oauth2/exchange" -d "grant_type=access_token&service=$ACR&access_token=$AAD" | python3 -c 'import sys, json; print(json.load(sys.stdin)["refresh_token"])')
echo "$REFRESH" | docker login "$ACR" --username 00000000-0000-0000-0000-000000000000 --password-stdin
`}docker pull "$IMAGE"

ENV_FILE=/run/${app}.env
umask 077
cat > "$ENV_FILE" <<'ENVFILE'
${plain.map((v) => `${v.key}=${v.value}`).join('\n')}
ENVFILE
${secrets.length ? `KV_TOKEN=$(token https://vault.azure.net)
${secrets.map((k) => `# A failed read stops the script (set -e), so the app never starts with an empty secret.
VALUE=$(curl -fsS -H "Authorization: Bearer $KV_TOKEN" "https://$VAULT.vault.azure.net/secrets/${vaultSecretName(k)}?api-version=7.4" | python3 -c 'import sys, json; print(json.load(sys.stdin)["value"])')
printf '%s=%s\\n' '${k}' "$VALUE" >> "$ENV_FILE"`).join('\n')}
` : ''}
docker rm -f ${app} >/dev/null 2>&1 || true
exec docker run --name ${app} --init --env-file "$ENV_FILE" -p ${c.port}:${c.port} --memory ${c.memoryLimit} --cpus ${c.cpuLimit} "$IMAGE"
RUNNER
chmod 755 /usr/local/bin/${app}-run

cat > /etc/systemd/system/${app}.service <<'UNIT'
[Unit]
Description=${app} container
After=docker.service network-online.target
Requires=docker.service

[Service]
ExecStart=/usr/local/bin/${app}-run
ExecStop=/usr/bin/docker stop ${app}
# If the image ${usesExistingImage(c) ? 'cannot be pulled yet' : 'is not pushed yet'}, or a secret is missing, try again in 30 seconds.
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now ${app}.service
`;
}

// ─── GitHub Actions ──────────────────────────────────────────────────────────

function workflowYml(c: ContainerConfig): string {
  const v = c.azvm;
  return `# Builds the image, scans it, pushes it to the Azure container registry and restarts the app on the VM.
# One-time setup (see azvm/README.md): a Microsoft Entra app with a federated credential for this repository, then in GitHub
# (Settings, Secrets and variables, Actions) add the secrets AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID
# and the variables ACR_NAME, RESOURCE_GROUP and VM_NAME (all printed by: terraform -chdir=azvm output).
name: deploy-${c.appName}

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

env:
  APP_NAME: ${c.appName}

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: azure/login@v2
        with:
          client-id: \${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: \${{ secrets.AZURE_TENANT_ID }}
          subscription-id: \${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - name: Build
        run: docker build --platform linux/amd64 -t "\${{ vars.ACR_NAME }}.azurecr.io/$APP_NAME:\${{ github.sha }}" -t "\${{ vars.ACR_NAME }}.azurecr.io/$APP_NAME:${v.imageTag}" .
${v.scanImage ? `
      # Stops the deploy before anything is pushed if the image has a HIGH or CRITICAL vulnerability that already has a fix.
      - name: Scan the image (Trivy)
        uses: aquasecurity/trivy-action@915b19bbe73b92a6cf82a1bc12b087c9a19a5fe2 # v0.28.0
        with:
          image-ref: \${{ vars.ACR_NAME }}.azurecr.io/\${{ env.APP_NAME }}:\${{ github.sha }}
          severity: HIGH,CRITICAL
          ignore-unfixed: true
          exit-code: '1'
          vuln-type: os,library
` : ''}
      - name: Push
        run: |
          az acr login --name "\${{ vars.ACR_NAME }}"
          docker push "\${{ vars.ACR_NAME }}.azurecr.io/$APP_NAME" --all-tags

      - name: Restart the app on the VM
        run: |
          az vm run-command invoke --resource-group "\${{ vars.RESOURCE_GROUP }}" --name "\${{ vars.VM_NAME }}" \\
            --command-id RunShellScript --scripts "systemctl restart $APP_NAME.service" >/dev/null
`;
}

// ─── one-command scripts ─────────────────────────────────────────────────────

function deploySh(c: ContainerConfig): string {
  const secrets = secretNames(c);
  const ex = usesExistingImage(c);
  return `#!/usr/bin/env bash
# One command to deploy ${c.appName} to an Azure VM: bash deploy.sh
${ex ? `#   1. creates the resource group and Key Vault with Terraform (first run), asking you to confirm
#   2. stores any secret values in Key Vault (asks once, hidden), never in a file
#   3. creates or updates the VM (it pulls ${c.image}), restarts the app and waits until it answers
# Run it again after changing the settings. Add --yes to skip the Terraform confirmation.` : `#   1. creates the resource group, registry and Key Vault with Terraform (first run), asking you to confirm
#   2. stores any secret values in Key Vault (asks once, hidden), never in a file
#   3. builds the image inside Azure (az acr build), so Docker is not needed on this machine
#   4. creates or updates the VM, restarts the app and waits until it answers
# Run it again to release a new version (IMAGE_TAG=v2 bash deploy.sh uses another tag). Add --yes to skip the Terraform confirmation.`}
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(c.appName)}
${ex ? '' : `TAG="\${IMAGE_TAG:-${c.azvm.imageTag}}"\n`}SECRETS=(${secrets.map(q).join(' ')})
APPROVE=""
[ "\${1:-}" = "--yes" ] && APPROVE="-auto-approve"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing tool: $1. $2"; exit 1; }; }
need terraform "Install it from https://developer.hashicorp.com/terraform/install"
need az        "Install the Azure CLI from https://learn.microsoft.com/cli/azure/install-azure-cli"
need ssh-keygen "It ships with OpenSSH."
az account show >/dev/null 2>&1 || { echo "You are not signed in to Azure. Run: az login"; exit 1; }
echo "Subscription: $(az account show --query name -o tsv)"

# Azure insists on an SSH key for a Linux VM. A throw-away public key is enough: the private half is deleted right away,
# so nobody can sign in over SSH (use az vm run-command instead).
KEYDIR=$(mktemp -d)
trap 'rm -rf "$KEYDIR"' EXIT
ssh-keygen -q -t ed25519 -N '' -f "$KEYDIR/k" -C "${c.appName}-throwaway"
export TF_VAR_admin_ssh_public_key="$(cat "$KEYDIR/k.pub")"
rm -f "$KEYDIR/k"

az provider register --namespace Microsoft.Compute --wait >/dev/null
az provider register --namespace Microsoft.ContainerRegistry --wait >/dev/null
az provider register --namespace Microsoft.KeyVault --wait >/dev/null

echo "==> 1/${ex ? 3 : 4}  ${ex ? '' : 'Registry and '}Key Vault (Terraform)"
terraform -chdir=azvm init -input=false >/dev/null
terraform -chdir=azvm apply${ex ? '' : ' -var "image_tag=$TAG"'} \\
  -target=azurerm_resource_group.app${ex ? '' : ' -target=azurerm_container_registry.app'} -target=azurerm_key_vault.app -target=azurerm_role_assignment.deployer_secrets \\
  \${APPROVE:+-auto-approve}

echo "==> 2/${ex ? 3 : 4}  Secrets"
VAULT=$(terraform -chdir=azvm output -raw vault_name)
for NAME in \${SECRETS[@]+"\${SECRETS[@]}"}; do
  KVNAME=$(echo "$NAME" | tr '_' '-')
  if az keyvault secret show --vault-name "$VAULT" --name "$KVNAME" >/dev/null 2>&1; then
    echo "    $NAME: already stored"
  else
    read -r -s -p "    Value for $NAME (hidden): " VALUE; echo
    [ -n "$VALUE" ] || { echo "    $NAME cannot be empty."; exit 1; }
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

${ex ? '' : `echo "==> 3/4  Build the image in Azure"
ACR=$(terraform -chdir=azvm output -raw acr_name)
az acr build --registry "$ACR" --image "$APP:$TAG" --platform linux/amd64 .

`}echo "==> ${ex ? '3/3' : '4/4'}  Virtual machine (Terraform)"
terraform -chdir=azvm apply${ex ? '' : ' -var "image_tag=$TAG"'} \${APPROVE:+-auto-approve}
RG=$(terraform -chdir=azvm output -raw resource_group)
VM=$(terraform -chdir=azvm output -raw vm_name)
${ex ? '' : `# Tags are ignored by Terraform after creation so that a release does not touch the VM: set the tag here, then restart the app.
az vm update --resource-group "$RG" --name "$VM" --set "tags.image_tag=$TAG" >/dev/null
`}
if az vm run-command invoke --resource-group "$RG" --name "$VM" --command-id RunShellScript --scripts "systemctl restart $APP.service" >/dev/null 2>&1; then
  echo "    Restart sent."
else
  echo "    The VM is not ready for commands yet (normal on a new VM). It starts the app by itself within a few minutes."
fi

URL=$(terraform -chdir=azvm output -raw app_url)
WAIT="\${DEPLOY_WAIT_SECONDS:-480}"
END=$((SECONDS + WAIT))
echo "    Waiting for $URL ..."
UP=""
while [ "$SECONDS" -lt "$END" ]; do
  if curl -fsS -m 5 -o /dev/null "$URL" >/dev/null 2>&1; then UP=yes; break; fi
  sleep 10
done
if [ -n "$UP" ]; then
  echo "Done. ${c.appName} is running at $URL"
else
  echo "Not answering yet. The first start installs Docker and can take several minutes. Check again, or read the logs:"
  echo "  $(terraform -chdir=azvm output -raw logs)"
fi
`;
}

function destroySh(c: ContainerConfig): string {
  return `#!/usr/bin/env bash
# Removes everything deploy.sh created (the whole resource group: VM, network, registry with its images, Key Vault): bash destroy.sh
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(c.appName)}

command -v terraform >/dev/null 2>&1 || { echo "Missing tool: terraform"; exit 1; }
command -v az >/dev/null 2>&1 || { echo "Missing tool: az"; exit 1; }
az account show >/dev/null 2>&1 || { echo "You are not signed in to Azure. Run: az login"; exit 1; }

echo "This permanently deletes the resource group rg-$APP and everything in it, including the secrets in its Key Vault."
read -r -p "Type the app name ($APP) to continue: " ANSWER
[ "$ANSWER" = "$APP" ] || { echo "Cancelled."; exit 1; }

# Destroy needs a value for the key variable, not a real one.
export TF_VAR_admin_ssh_public_key="unused"
terraform -chdir=azvm init -input=false >/dev/null
terraform -chdir=azvm destroy -auto-approve
echo "Done."
`;
}

function readme(c: ContainerConfig): string {
  const v = c.azvm;
  const secrets = secretNames(c);
  return `# Deploy ${c.appName} to an Azure VM

## Quick start

You need Terraform and the Azure CLI installed and to be signed in (\`az login\`). Docker is **not** needed${usesExistingImage(c) ? '' : ': the image is built inside Azure'}. From the folder that contains your app and these files:

\`\`\`bash
bash deploy.sh
\`\`\`

It creates the resource group${usesExistingImage(c) ? '' : ', container registry'} and Key Vault, ${secrets.length ? 'asks for your secret values (hidden) and stores them in Key Vault, ' : ''}${usesExistingImage(c) ? `creates the VM, which pulls \`${c.image}\` as it is (nothing is built), ` : 'builds the image in Azure, creates the VM, '}starts the app and prints its address. ${usesExistingImage(c) ? 'To change anything edit the settings and run it again.' : 'To release a new version run it again (\`IMAGE_TAG=v2 bash deploy.sh\` to use another tag).'} To remove everything: \`bash destroy.sh\`.

## What gets created

- A resource group \`rg-${c.appName}\` in \`${v.location}\` with a virtual network, a network security group that opens only port ${c.port} to \`${v.allowedCidr}\`, a static public IP and one Ubuntu 22.04 VM (\`${v.size}\`, ${v.diskGb} GB) running your image under systemd. **No SSH**: manage it with \`az vm run-command\`.
- ${usesExistingImage(c) ? 'A Key Vault. The VM has a managed identity that can only read secrets from this vault.' : 'A container registry (Basic, no admin user) and a Key Vault. The VM has a managed identity that can only pull images from this registry and read secrets from this vault.'}
${secrets.length ? `- Secrets (${secrets.join(', ')}) are stored in Key Vault (as ${secrets.map((k) => `\`${vaultSecretName(k)}\``).join(', ')}) and read by the VM when the container starts. They are never written to Terraform, its state or any file.\n` : ''}
## Look inside the VM

\`\`\`bash
az vm run-command invoke --resource-group rg-${c.appName} --name vm-${c.appName} --command-id RunShellScript --scripts 'journalctl -u ${c.appName}.service -n 100 --no-pager' --query 'value[0].message' -o tsv
az vm run-command invoke --resource-group rg-${c.appName} --name vm-${c.appName} --command-id RunShellScript --scripts 'docker ps' --query 'value[0].message' -o tsv
\`\`\`

## Common problems

- **The address does not answer for a few minutes**: a new VM installs Docker first. The app starts by itself once the image and secrets exist.
- **"Could not store a secret"**: your account needs the role *Key Vault Secrets Officer* on the vault; Terraform assigns it to whoever ran \`deploy.sh\`, and it can take a minute to apply.
- **"SkuNotAvailable"**: the VM size is not offered in that region for your subscription. Change \`vm_size\` in \`azvm/variables.tf\` or pick another region.
- **The address never answers**: the port is open only to \`${v.allowedCidr}\`.
${v.githubActions && !usesExistingImage(c) ? `
## Optional: deploy automatically when you push to GitHub

\`.github/workflows/deploy.yml\` builds, scans and pushes the image on every push to \`main\` and restarts the app. It signs in to Azure without a stored password (OIDC). One-time setup${v.githubRepo ? ` for \`${v.githubRepo}\`` : ''}:

\`\`\`bash
REPO=${v.githubRepo || 'owner/name'}
APP_ID=$(az ad app create --display-name "${c.appName}-github" --query appId -o tsv)
az ad sp create --id "$APP_ID" >/dev/null
az ad app federated-credential create --id "$APP_ID" --parameters '{"name":"main","issuer":"https://token.actions.githubusercontent.com","subject":"repo:'"$REPO"':ref:refs/heads/main","audiences":["api://AzureADTokenExchange"]}'
SUB=$(az account show --query id -o tsv)
az role assignment create --assignee "$APP_ID" --role Contributor --scope "/subscriptions/$SUB/resourceGroups/rg-${c.appName}"
\`\`\`

Then in GitHub (Settings, Secrets and variables, Actions) add the secrets \`AZURE_CLIENT_ID\` (= \`$APP_ID\`), \`AZURE_TENANT_ID\` (\`az account show --query tenantId -o tsv\`), \`AZURE_SUBSCRIPTION_ID\`, and the variables \`ACR_NAME\`, \`RESOURCE_GROUP\` and \`VM_NAME\` (from \`terraform -chdir=azvm output\`).
Contributor on the resource group is broad; narrow it (AcrPush on the registry and Virtual Machine Contributor on the VM) if your policy requires.
` : ''}
## What to know

- This is a single VM: HTTP only, no load balancer, and no automatic replacement if it fails. For HTTPS or several instances use Azure Container Apps or AKS.
- Terraform keeps its record in \`azvm/terraform.tfstate\`. Keep that folder; \`bash destroy.sh\` needs it.
- Costs: the VM, its disk and the public IP bill every hour; the registry bills daily.
`;
}

export function generateAzVmFiles(c: ContainerConfig): Array<{ path: string; content: string; executable?: boolean }> {
  if (!c.azvm.enabled) return [];
  return [
    { path: 'deploy.sh', content: deploySh(c), executable: true },
    { path: 'destroy.sh', content: destroySh(c), executable: true },
    { path: 'azvm/main.tf', content: mainTf(c) },
    { path: 'azvm/variables.tf', content: variablesTf(c) },
    { path: 'azvm/outputs.tf', content: outputsTf(c) },
    { path: 'azvm/cloud-init.sh', content: azureCloudInit(c) },
    { path: 'azvm/.gitignore', content: '.terraform/\n*.tfstate\n*.tfstate.*\ncrash.log\n' },
    { path: 'azvm/README.md', content: readme(c) },
    ...(c.azvm.githubActions && !usesExistingImage(c) ? [{ path: '.github/workflows/deploy.yml', content: workflowYml(c) }] : []),
  ];
}
