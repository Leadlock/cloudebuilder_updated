/**
 * "Deploy to Azure Container Apps" for a whole project (Frontend + Backend + API): one Container App per service in one environment, the public
 * service open to the internet over HTTPS and the others reachable only from inside the environment.
 *
 * How it differs from a single service (containerAppsDeploy.ts), which it shares its safety rules with:
 *  - One resource group, one registry (when something is built), one Key Vault (when there are secrets), one identity that can only pull images and read
 *    secrets, one environment and one Container App per service, named `<project>-<service>`.
 *  - The services reach each other by app name inside the environment: `http://<project>-api`, with no port (ingress listens on 80). The static
 *    frontend's nginx proxies to that name and sends it as the Host header; BACKEND_URL / API_URL hold the same address.
 *  - Secrets live in Key Vault; each app reads them through its identity (a Key Vault reference). Values never enter Terraform or its state.
 *  - A database is not run in Container Apps: use Azure Database for PostgreSQL / MySQL and a DATABASE_URL secret.
 *
 * For a release CloudCraft runs (`forRelease`), Terraform creates the apps with no replicas and a placeholder image, and a placeholder in each Key Vault
 * secret (marked as such); CloudCraft stores the real secrets, builds the images, points each app at them and scales it up, so Terraform never undoes it.
 */
import { LOCATION } from './shared';
import { TAG, q, validCidr, type DeployCost } from './ec2Deploy';
import { ACA_CPU } from './containerAppsDeploy';
import { vaultSecretName } from './azureVmDeploy';

export interface StackAcaConfig {
  location: string;
  /** vCPU of each replica; memory is twice that in GiB. */
  cpu: number;
  minReplicas: number;
  maxReplicas: number;
  concurrentRequests: number;
  /** Who may call the public service; 0.0.0.0/0 means anyone. */
  allowedCidr: string;
  imageTag: string;
}

export const defaultStackAca = (): StackAcaConfig => ({ location: 'westeurope', cpu: 0.5, minReplicas: 1, maxReplicas: 5, concurrentRequests: 50, allowedCidr: '0.0.0.0/0', imageTag: 'latest' });

export interface StackAcaLayer {
  name: string;
  port: number;
  built: boolean;
  /** The ready-made image, when it is not built. */
  image: string;
  /** Plain variables, including the addresses of the other services. */
  env: Array<{ key: string; value: string }>;
  secrets: string[];
  healthPath: string;
}

export interface StackAcaSpec {
  project: string;
  aca: StackAcaConfig;
  layers: StackAcaLayer[];
  /** The name of the public service. */
  entry: string;
  secrets: string[];
}

/** The name of a service's Container App, which is also the address the others call. */
export const acaAppName = (project: string, layer: string) => `${project}-${layer}`;
/** What a release's Terraform runs before its own image exists: nothing starts on it, because the app has no replicas. */
export const ACA_PLACEHOLDER_IMAGE = 'mcr.microsoft.com/k8se/quickstart:latest';
/** The tag Terraform puts on the Key Vault secrets of a release until CloudCraft stores the real value. */
export const PLACEHOLDER_TAG = 'placeholder';

/** Lowercase letters, digits and single hyphens, starting with a letter. The longest suffix is "-frontend" (9), and an app name is at most 32. */
const PROJECT = /^[a-z](?:[a-z0-9]|-(?!-)){0,21}[a-z0-9]$/;
const hcl = (s: string) => JSON.stringify(s).replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');
const secretName = (key: string) => key.toLowerCase().replace(/_/g, '-');
const builtOf = (s: StackAcaSpec) => s.layers.filter((l) => l.built).map((l) => l.name);

export function validateStackAca(s: StackAcaSpec): string[] {
  const a = s.aca;
  const out: string[] = [];
  if (!PROJECT.test(s.project)) out.push('Container Apps: the project name becomes the app names, so it may use only lowercase letters, digits and single "-", must start with a letter and end with a letter or digit, up to 23 characters.');
  if (!LOCATION.test(a.location)) out.push('Container Apps: location looks like westeurope or eastus2.');
  if (!(ACA_CPU as readonly number[]).includes(a.cpu)) out.push(`Container Apps: CPU must be one of ${ACA_CPU.join(', ')}.`);
  if (!Number.isInteger(a.minReplicas) || a.minReplicas < 0 || a.minReplicas > 30) out.push('Container Apps: the minimum number of replicas must be 0 to 30 (0 scales to zero when idle).');
  if (!Number.isInteger(a.maxReplicas) || a.maxReplicas < Math.max(1, a.minReplicas) || a.maxReplicas > 30) out.push('Container Apps: the maximum number of replicas must be at least 1 and not below the minimum (up to 30).');
  if (!Number.isInteger(a.concurrentRequests) || a.concurrentRequests < 1 || a.concurrentRequests > 10000) out.push('Container Apps: concurrent requests per replica must be 1 to 10000.');
  if (!validCidr(a.allowedCidr)) out.push('Container Apps: "who can connect" must be an IPv4 range such as 203.0.113.0/24 (or 0.0.0.0/0 for everyone).');
  if (!TAG.test(a.imageTag)) out.push('Container Apps: image tag may use letters, digits, "_", "." and "-" (up to 128 characters).');
  for (const l of s.layers) {
    if (!Number.isInteger(l.port) || l.port < 1 || l.port > 65535) out.push(`Container Apps: ${l.name}: port must be 1-65535.`);
    if (!l.built && !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(l.image)) out.push(`Container Apps: ${l.name}: the image name is not valid.`);
  }
  return out;
}

export function stackAcaWarnings(s: StackAcaSpec): string[] {
  const a = s.aca;
  const w: string[] = [];
  if (a.allowedCidr === '0.0.0.0/0') w.push(`Container Apps: the ${s.entry} is open to the whole internet (over HTTPS). Narrow "who can connect" if it is not public.`);
  if (a.minReplicas === 0) w.push('Container Apps: with 0 minimum replicas the first request after an idle period waits for a cold start.');
  if (a.imageTag === 'latest' && builtOf(s).length > 0) w.push('Container Apps: the "latest" tag is used. A version tag (for example the commit id) makes it clear what is running and allows a rollback.');
  if (s.secrets.length > 0) w.push(`Container Apps: deploy.sh asks for ${s.secrets.join(', ')} and stores each in Key Vault; the apps read them through their identity. After you change a secret, restart the apps so they pick up the new value.`);
  w.push('Container Apps: there is no database here. Use Azure Database for PostgreSQL / MySQL and keep its connection URL in a secret named DATABASE_URL.');
  return w;
}

const VCPU_SECOND = 0.000024;
const GIB_SECOND = 0.000003;
const FREE_VCPU_SECONDS = 180_000;
const FREE_GIB_SECONDS = 360_000;
const MONTH_SECONDS = 730 * 3600;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** List-price estimate (consumption plan, active rate) of the replicas of every service, after the monthly free grant (shared by the whole subscription), and the registry. */
export function estimateStackAcaCost(s: StackAcaSpec): DeployCost {
  const a = s.aca;
  const apps = s.layers.length;
  const replicaSeconds = (a.minReplicas > 0 ? a.minReplicas : 0.25) * MONTH_SECONDS * apps;
  const memGib = a.cpu * 2;
  const vcpu = Math.max(0, a.cpu * replicaSeconds - FREE_VCPU_SECONDS) * VCPU_SECOND;
  const mem = Math.max(0, memGib * replicaSeconds - FREE_GIB_SECONDS) * GIB_SECOND;
  const lines = [
    { label: `${apps} app${apps === 1 ? '' : 's'} x ${a.minReplicas > 0 ? a.minReplicas : '0 to 1'} replica${a.minReplicas === 1 ? '' : 's'} (${a.cpu} vCPU, ${memGib} GiB) after the monthly free grant`, monthlyUsd: round2(vcpu + mem) },
    ...(builtOf(s).length > 0 ? [{ label: 'Container Registry (Basic)', monthlyUsd: 5.0 }] : []),
    ...(s.secrets.length > 0 ? [{ label: 'Key Vault (secret operations)', monthlyUsd: 0.1 }] : []),
    { label: 'Log Analytics (about 1 GB)', monthlyUsd: 0 },
  ];
  const notes = ['Excludes data transfer out and requests beyond the free 2 million a month. Log Analytics gives 5 GB a month free.'];
  if (a.maxReplicas > Math.max(1, a.minReplicas)) notes.push(`Priced at the minimum; each extra replica adds up to ${round2((a.cpu * VCPU_SECOND + memGib * GIB_SECOND) * MONTH_SECONDS)} a month while it runs.`);
  return { monthlyUsd: round2(lines.reduce((t, l) => t + l.monthlyUsd, 0)), lines, notes };
}

// ─── Terraform ───────────────────────────────────────────────────────────────

function appTf(s: StackAcaSpec, l: StackAcaLayer, release: boolean): string {
  const entry = l.name === s.entry;
  const image = release && l.built ? hcl(ACA_PLACEHOLDER_IMAGE) : l.built ? `"\${azurerm_container_registry.app.login_server}/\${var.app_name}-${l.name}:\${var.image_tag}"` : hcl(l.image);
  const needsAcr = l.built;
  const deps = [
    ...(needsAcr ? ['azurerm_role_assignment.acr_pull'] : []),
    ...(l.secrets.length ? ['azurerm_role_assignment.vault_read', ...(release ? l.secrets.map((k) => `azurerm_key_vault_secret.${secretName(k)}`) : [])] : []),
  ];
  return `resource "azurerm_container_app" "${l.name}" {
  name                         = "\${var.app_name}-${l.name}"
  container_app_environment_id = azurerm_container_app_environment.app.id
  resource_group_name          = azurerm_resource_group.app.name
  revision_mode                = "Single"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }
${needsAcr ? `
  registry {
    server   = azurerm_container_registry.app.login_server
    identity = azurerm_user_assigned_identity.app.id
  }
` : ''}${l.secrets.map((k) => `
  secret {
    name                = ${hcl(secretName(k))}
    key_vault_secret_id = "\${azurerm_key_vault.app.vault_uri}secrets/${vaultSecretName(k)}"
    identity            = azurerm_user_assigned_identity.app.id
  }`).join('\n')}

  template {
    min_replicas = ${release ? '0 # CloudCraft scales the app up once its image is built and its secrets are stored' : 'var.min_replicas'}
    max_replicas = var.max_replicas

    container {
      name   = "${l.name}"
      image  = ${image}
      cpu    = var.cpu
      memory = "\${var.cpu * 2}Gi"
${l.env.map((v) => `
      env {
        name  = ${hcl(v.key)}
        value = ${hcl(v.value)}
      }`).join('')}${l.secrets.map((k) => `
      env {
        name        = ${hcl(k)}
        secret_name = ${hcl(secretName(k))}
      }`).join('')}

      startup_probe {
        transport               = "HTTP"
        port                    = ${l.port}
        path                    = ${hcl(l.healthPath || '/')}
        interval_seconds        = 5
        failure_count_threshold = 30
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = ${l.port}
        path                    = ${hcl(l.healthPath || '/')}
        interval_seconds        = 20
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = ${l.port}
        path                    = ${hcl(l.healthPath || '/')}
        interval_seconds        = 10
        failure_count_threshold = 3
      }
    }

    http_scale_rule {
      name                = "http"
      concurrent_requests = var.concurrent_requests
    }
  }

  ingress {
    external_enabled           = ${entry ? 'true' : 'false'}
    target_port                = ${l.port}
    transport                  = "auto"
    allow_insecure_connections = ${entry ? 'false' : 'true # the other services call this one over plain HTTP, inside the environment'}
${entry && s.aca.allowedCidr !== '0.0.0.0/0' ? `
    ip_security_restriction {
      name             = "allowed"
      action           = "Allow"
      ip_address_range = var.allowed_cidr
    }
` : ''}
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
${deps.length ? `
  depends_on = [${deps.join(', ')}]
` : ''}${release && l.built ? `
  # A release points the app at its new image and scales it itself; Terraform must not undo that.
  lifecycle {
    ignore_changes = [template[0].container[0].image, template[0].min_replicas]
  }
` : release ? `
  lifecycle {
    ignore_changes = [template[0].min_replicas]
  }
` : ''}}
`;
}

function mainTf(s: StackAcaSpec, release: boolean): string {
  const built = builtOf(s).length > 0;
  const secrets = s.secrets;
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
  features {${secrets.length ? `
    key_vault {
      # So destroy.sh leaves nothing behind that would block creating the same vault again.
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
  ` : ''}}
}

data "azurerm_client_config" "current" {}

locals {
  tags = {
    ManagedBy = "CloudCraft"
    App       = var.app_name
  }
  # Registry and vault names are global: a short stable suffix keeps these unique.
${built ? `  acr_name   = substr("acr$\{replace(var.app_name, "-", "")}$\{substr(md5("$\{data.azurerm_client_config.current.subscription_id}$\{var.app_name}"), 0, 6)}", 0, 50)\n` : ''}${secrets.length ? `  vault_name = "kv$\{substr(replace(var.app_name, "-", ""), 0, 12)}$\{substr(md5("$\{data.azurerm_client_config.current.subscription_id}$\{var.app_name}"), 0, 6)}"\n` : ''}}

resource "azurerm_resource_group" "app" {
  name     = "rg-$\{var.app_name}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_log_analytics_workspace" "app" {
  name                = "log-$\{var.app_name}"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

${built ? `# No admin user: the apps pull with their managed identity, which can only read images.
resource "azurerm_container_registry" "app" {
  name                = local.acr_name
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

` : ''}resource "azurerm_user_assigned_identity" "app" {
  name                = "id-$\{var.app_name}"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  tags                = local.tags
}

${built ? `resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.app.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

` : ''}${secrets.length ? `# Secrets live here. ${release ? 'CloudCraft' : 'deploy.sh'} stores them; the apps' identity can only read them.
resource "azurerm_key_vault" "app" {
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

# Whoever runs this can store secrets.
resource "azurerm_role_assignment" "deployer_secrets" {
  scope                = azurerm_key_vault.app.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_role_assignment" "vault_read" {
  scope                = azurerm_key_vault.app.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

${release ? secrets.map((k) => `# Not a secret: a marker that says no value has been stored yet. CloudCraft replaces it; Terraform never looks at the value again.
resource "azurerm_key_vault_secret" "${secretName(k)}" {
  name         = "${vaultSecretName(k)}"
  value        = "not-set-yet"
  key_vault_id = azurerm_key_vault.app.id
  tags         = { cloudcraft = "${PLACEHOLDER_TAG}" }

  depends_on = [azurerm_role_assignment.deployer_secrets]

  lifecycle {
    ignore_changes = [value, tags]
  }
}
`).join('\n') + '\n' : ''}` : ''}resource "azurerm_container_app_environment" "app" {
  name                       = "cae-$\{var.app_name}"
  location                   = azurerm_resource_group.app.location
  resource_group_name        = azurerm_resource_group.app.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.app.id
  tags                       = local.tags
}

${s.layers.map((l) => appTf(s, l, release)).join('\n')}`;
}

function variablesTf(s: StackAcaSpec): string {
  const a = s.aca;
  return `variable "location" {
  description = "Azure region to deploy to."
  type        = string
  default     = ${hcl(a.location)}
}

variable "app_name" {
  description = "Name used for the apps, resource group, registry and identity."
  type        = string
  default     = ${hcl(s.project)}
}

variable "image_tag" {
  description = "The tag of the images the apps run."
  type        = string
  default     = ${hcl(a.imageTag)}
}

variable "cpu" {
  description = "vCPU per replica (memory is twice this in GiB)."
  type        = number
  default     = ${a.cpu}
}

variable "min_replicas" {
  description = "Minimum replicas of each app. 0 scales to zero when idle."
  type        = number
  default     = ${a.minReplicas}
}

variable "max_replicas" {
  type    = number
  default = ${a.maxReplicas}
}

variable "concurrent_requests" {
  description = "Concurrent HTTP requests per replica that add another replica."
  type        = number
  default     = ${a.concurrentRequests}
}
${a.allowedCidr !== '0.0.0.0/0' ? `
variable "allowed_cidr" {
  description = "Who can call the public service (IPv4 range)."
  type        = string
  default     = ${hcl(a.allowedCidr)}
}
` : ''}`;
}

function outputsTf(s: StackAcaSpec, release: boolean): string {
  const built = builtOf(s).length > 0;
  const entry = s.layers.find((l) => l.name === s.entry)!;
  return `output "resource_group" {
  value = azurerm_resource_group.app.name
}
${built ? `
output "acr_name" {
  description = "The container registry that holds the images."
  value       = azurerm_container_registry.app.name
}
` : ''}${s.secrets.length ? `
output "vault_name" {
  description = "Key Vault that holds the secrets."
  value       = azurerm_key_vault.app.name
}
` : ''}
output "image_tag" {
  value = var.image_tag
}
${release ? `
output "apps" {
  description = "The Container Apps, one per service of the project."
  value       = [${s.layers.map((l) => `azurerm_container_app.${l.name}.name`).join(', ')}]
}

output "min_replicas" {
  value = var.min_replicas
}
` : ''}
output "app_url" {
  value = "https://\${azurerm_container_app.${entry.name}.ingress[0].fqdn}${entry.healthPath || '/'}"
}
`;
}

// ─── scripts ─────────────────────────────────────────────────────────────────

export function stackAcaDeploySh(s: StackAcaSpec): string {
  const built = builtOf(s);
  const total = 4;
  return `#!/usr/bin/env bash
# One command to deploy ${s.project} (${s.layers.map((l) => l.name).join(', ')}) to Azure Container Apps: bash deploy.sh
#   1. creates the resource group${built.length > 0 ? ', container registry' : ''}${s.secrets.length ? ' and Key Vault' : ''} with Terraform (first run)
#   2. stores the secret values in Key Vault (asks once, hidden), never in a file or in Terraform's state
#   3. ${built.length > 0 ? 'builds each service\'s image inside Azure (az acr build), so Docker is not needed on this machine' : 'nothing to build: every service uses a ready-made image'}
#   4. creates or updates the environment and the apps, then waits until the ${s.entry} answers
# Run it again to release a new version (IMAGE_TAG=v2 bash deploy.sh uses another tag). Add --yes to skip the Terraform confirmation.
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(s.project)}
TAG="\${IMAGE_TAG:-${s.aca.imageTag}}"
SECRETS=(${s.secrets.map(q).join(' ')})
BUILT=(${built.map(q).join(' ')})
APPROVE=""
[ "\${1:-}" = "--yes" ] && APPROVE="-auto-approve"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing tool: $1. $2"; exit 1; }; }
need terraform "Install it from https://developer.hashicorp.com/terraform/install"
need az        "Install the Azure CLI from https://learn.microsoft.com/cli/azure/install-azure-cli"
az account show >/dev/null 2>&1 || { echo "You are not signed in to Azure. Run: az login"; exit 1; }
echo "Subscription: $(az account show --query name -o tsv)"

echo "==> 1/${total}  Resource group${built.length > 0 ? ', container registry' : ''}${s.secrets.length ? ' and Key Vault' : ''} (Terraform)"
az provider register --namespace Microsoft.App --wait >/dev/null
az provider register --namespace Microsoft.OperationalInsights --wait >/dev/null
az provider register --namespace Microsoft.KeyVault --wait >/dev/null
terraform -chdir=aca init -input=false >/dev/null
terraform -chdir=aca apply -var "image_tag=$TAG" \\
  -target=azurerm_resource_group.app${built.length > 0 ? ' -target=azurerm_container_registry.app -target=azurerm_role_assignment.acr_pull' : ''} -target=azurerm_user_assigned_identity.app${s.secrets.length ? ' -target=azurerm_key_vault.app -target=azurerm_role_assignment.deployer_secrets -target=azurerm_role_assignment.vault_read' : ''} \\
  \${APPROVE:+-auto-approve}

echo "==> 2/${total}  Secrets"
if [ \${#SECRETS[@]} -gt 0 ]; then
  VAULT=$(terraform -chdir=aca output -raw vault_name)
  for NAME in "\${SECRETS[@]}"; do
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
else
  echo "    none"
fi

${built.length > 0 ? `echo "==> 3/${total}  Build the images in Azure"
ACR=$(terraform -chdir=aca output -raw acr_name)
for LAYER in "\${BUILT[@]}"; do
  echo "    $LAYER"
  az acr build --registry "$ACR" --image "$APP-$LAYER:$TAG" --platform linux/amd64 "./$LAYER"
done
` : `echo "==> 3/${total}  Images"
echo "    Every service uses a ready-made image: nothing to build."
`}
echo "==> ${total}/${total}  Environment and apps (Terraform)"
terraform -chdir=aca apply -var "image_tag=$TAG" \${APPROVE:+-auto-approve}

URL=$(terraform -chdir=aca output -raw app_url)
WAIT="\${DEPLOY_WAIT_SECONDS:-600}"
END=$((SECONDS + WAIT))
echo "    Waiting for $URL ..."
UP=""
while [ "$SECONDS" -lt "$END" ]; do
  if curl -fsS -m 10 -o /dev/null "$URL" >/dev/null 2>&1; then UP=yes; break; fi
  sleep 10
done
if [ -n "$UP" ]; then
  echo "Done. ${s.project} is running at $URL"
else
  echo "Not answering yet. New apps can take a few minutes. Check again, or read the logs:"
  echo "  az containerapp logs show --name ${acaAppName(s.project, s.entry)} --resource-group rg-$APP --follow"
fi
`;
}

export function stackAcaDestroySh(s: StackAcaSpec): string {
  return `#!/usr/bin/env bash
# Removes everything deploy.sh created (apps, environment, registry with its images, Key Vault with its secrets): bash destroy.sh
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(s.project)}

command -v terraform >/dev/null 2>&1 || { echo "Missing tool: terraform"; exit 1; }
command -v az >/dev/null 2>&1 || { echo "Missing tool: az"; exit 1; }
az account show >/dev/null 2>&1 || { echo "You are not signed in to Azure. Run: az login"; exit 1; }

echo "This permanently deletes the apps, the registry${s.secrets.length ? ' and the Key Vault with the secrets' : ''} of $APP (resource group rg-$APP)."
read -r -p "Type the project name ($APP) to continue: " ANSWER
[ "$ANSWER" = "$APP" ] || { echo "Cancelled."; exit 1; }

terraform -chdir=aca init -input=false >/dev/null
terraform -chdir=aca destroy -auto-approve
echo "Done."
`;
}

function readme(s: StackAcaSpec): string {
  const built = builtOf(s);
  const entry = s.layers.find((l) => l.name === s.entry)!;
  return `# Deploy ${s.project} to Azure Container Apps

Every service of this project runs as its own Container App in one environment. The ${s.entry} is open to the internet over HTTPS; the others can be called only from inside the environment, by app name.

## Quick start

You need Terraform and the Azure CLI installed and to be signed in (\`az login\`). From the project folder (the one with \`deploy.sh\`):

\`\`\`bash
bash deploy.sh
\`\`\`

It creates the resource group${built.length > 0 ? ', the registry' : ''}${s.secrets.length ? ' and the Key Vault' : ''}, asks for the secret values (${s.secrets.length ? s.secrets.join(', ') : 'none are needed'}), ${built.length > 0 ? 'builds each image inside Azure, ' : ''}creates the environment and the apps, and prints the address of the ${s.entry}.

To release a new version run \`IMAGE_TAG=v2 bash deploy.sh\`. To remove everything: \`bash destroy.sh\`.

## What gets created

- Resource group \`rg-${s.project}\`, a Log Analytics workspace and a Container Apps environment.
${built.length > 0 ? `- A container registry (no admin user) that holds ${built.map((l) => `\`${s.project}-${l}\``).join(', ')}.\n` : ''}- One identity that can only pull images and read this project's secrets.
- One Container App per service: ${s.layers.map((l) => `\`${acaAppName(s.project, l.name)}\``).join(', ')}, each with health probes and HTTP scaling (${s.aca.minReplicas} to ${s.aca.maxReplicas} replicas).
- The ${s.entry} (port ${entry.port}) has external HTTPS ingress${s.aca.allowedCidr !== '0.0.0.0/0' ? ` for \`${s.aca.allowedCidr}\` only` : ''}. The others have internal ingress.

## How the services find each other

Inside the environment an app is called by its name and no port: \`http://${acaAppName(s.project, 'api')}\`. The environment variables (\`BACKEND_URL\`, \`API_URL\`) and the frontend's nginx configuration already use these names.

## What to know

- There is no database here. Use Azure Database for PostgreSQL / MySQL and put its connection URL in a secret named \`DATABASE_URL\`.
- Secrets are stored in Key Vault and read by the apps through their identity. They are never written to Terraform, its state or any file generated here. After you change a secret, restart the apps.
- Terraform keeps its record in \`aca/terraform.tfstate\`. Keep that folder; \`bash destroy.sh\` needs it.
`;
}

export function generateStackAcaFiles(s: StackAcaSpec, opts: { forRelease?: boolean } = {}): Array<{ path: string; content: string; executable?: boolean }> {
  const release = opts.forRelease === true;
  return [
    { path: 'deploy.sh', content: stackAcaDeploySh(s), executable: true },
    { path: 'destroy.sh', content: stackAcaDestroySh(s), executable: true },
    { path: 'aca/main.tf', content: mainTf(s, release) },
    { path: 'aca/variables.tf', content: variablesTf(s) },
    { path: 'aca/outputs.tf', content: outputsTf(s, release) },
    { path: 'aca/.gitignore', content: '.terraform/\n*.tfstate\n*.tfstate.*\ncrash.log\n' },
    { path: 'aca/README.md', content: readme(s) },
  ];
}
