/**
 * Optional "deploy to Azure Container Apps" bundle for a container template: Terraform for a resource group, a container registry, a
 * Log Analytics workspace, a Container Apps environment and the app (with HTTPS ingress, scale rules and health probes), plus
 * deploy.sh / destroy.sh and a GitHub Actions workflow.
 *
 * Safe by default: the registry has no admin user (the app pulls with a managed identity that holds only AcrPull), ingress is HTTPS only,
 * and images are built inside Azure (az acr build), so Docker is not needed on your machine. Secret values are passed to Terraform as
 * sensitive variables and are stored in its state: keep the state somewhere private (the README says how to move it to an encrypted backend).
 */
import type { ContainerConfig } from './dockerTemplates';
import { GITHUB_REPO, TAG, q, secretNames, validCidr, type DeployCost } from './ec2Deploy';

export interface AcaConfig {
  enabled: boolean;
  /** Azure region, for example westeurope. */
  location: string;
  /** vCPU for each replica; memory is twice that in GiB. */
  cpu: number;
  minReplicas: number;
  maxReplicas: number;
  /** Concurrent HTTP requests per replica that trigger scaling out. */
  concurrentRequests: number;
  /** Reachable from the internet. When false only other apps in the environment can call it. */
  externalIngress: boolean;
  /** Who may call it; 0.0.0.0/0 means anyone. */
  allowedCidr: string;
  imageTag: string;
  githubActions: boolean;
  githubRepo: string;
  scanImage: boolean;
}

export const defaultAca = (): AcaConfig => ({
  enabled: false, location: 'westeurope', cpu: 0.5, minReplicas: 1, maxReplicas: 5, concurrentRequests: 50, externalIngress: true,
  allowedCidr: '0.0.0.0/0', imageTag: 'latest', githubActions: true, githubRepo: '', scanImage: true,
});

export const ACA_CPU = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const LOCATION = /^[a-z]{3,}[a-z0-9]*$/;
const APP_NAME = /^[a-z](?:[a-z0-9]|-(?!-)){0,30}[a-z0-9]$/;

export function validateAca(c: ContainerConfig): string[] {
  const a = c.aca;
  if (!a.enabled) return [];
  const out: string[] = [];
  if (!APP_NAME.test(c.appName)) out.push('Container Apps: the app name may use only lowercase letters, digits and single "-", must start with a letter and end with a letter or digit, up to 32 characters.');
  if (!LOCATION.test(a.location)) out.push('Container Apps: location looks like westeurope or eastus2.');
  if (!(ACA_CPU as readonly number[]).includes(a.cpu)) out.push(`Container Apps: CPU must be one of ${ACA_CPU.join(', ')}.`);
  if (!Number.isInteger(a.minReplicas) || a.minReplicas < 0 || a.minReplicas > 30) out.push('Container Apps: the minimum number of replicas must be 0 to 30 (0 scales to zero when idle).');
  if (!Number.isInteger(a.maxReplicas) || a.maxReplicas < Math.max(1, a.minReplicas) || a.maxReplicas > 30) out.push('Container Apps: the maximum number of replicas must be at least 1 and not below the minimum (up to 30).');
  if (!Number.isInteger(a.concurrentRequests) || a.concurrentRequests < 1 || a.concurrentRequests > 10000) out.push('Container Apps: concurrent requests per replica must be 1 to 10000.');
  if (!validCidr(a.allowedCidr)) out.push('Container Apps: "who can connect" must be an IPv4 range such as 203.0.113.0/24 (or 0.0.0.0/0 for everyone).');
  if (!TAG.test(a.imageTag)) out.push('Container Apps: image tag may use letters, digits, "_", "." and "-" (up to 128 characters).');
  if (a.githubRepo !== '' && !GITHUB_REPO.test(a.githubRepo)) out.push('Container Apps: GitHub repository looks like owner/name.');
  return out;
}

export function acaWarnings(c: ContainerConfig): string[] {
  const a = c.aca;
  if (!a.enabled) return [];
  const w: string[] = [];
  if (a.externalIngress && a.allowedCidr === '0.0.0.0/0') w.push('Container Apps: the app is open to the whole internet (over HTTPS). Narrow "who can connect" if it is not public.');
  if (a.minReplicas === 0) w.push('Container Apps: with 0 minimum replicas the first request after an idle period waits for a cold start.');
  if (c.postgres || c.redis) w.push('Container Apps: PostgreSQL and Redis are not started. Use Azure Database for PostgreSQL / Azure Cache for Redis and put the connection settings in the environment variables.');
  if (a.imageTag === 'latest') w.push('Container Apps: the "latest" tag is used. A version tag (for example the commit id) makes it clear what is running and allows a rollback.');
  if (c.env.some((v) => v.secret)) w.push('Container Apps: secret values are kept in Terraform state. Keep the aca/ folder private, or move the state to an encrypted remote backend.');
  return w;
}

// ─── cost ────────────────────────────────────────────────────────────────────

const VCPU_SECOND = 0.000024;
const GIB_SECOND = 0.000003;
const FREE_VCPU_SECONDS = 180_000;
const FREE_GIB_SECONDS = 360_000;
const MONTH_SECONDS = 730 * 3600;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** List-price estimate (West Europe/US, consumption plan, active-rate) of the replicas and the container registry. Undefined when off. */
export function estimateAcaCost(c: ContainerConfig): DeployCost | undefined {
  const a = c.aca;
  if (!a.enabled) return undefined;
  // Always-on replicas for the minimum; with a minimum of 0 the app is assumed to run one replica a quarter of the time.
  const replicaSeconds = a.minReplicas > 0 ? a.minReplicas * MONTH_SECONDS : 0.25 * MONTH_SECONDS;
  const memGib = a.cpu * 2;
  const vcpu = Math.max(0, a.cpu * replicaSeconds - FREE_VCPU_SECONDS) * VCPU_SECOND;
  const mem = Math.max(0, memGib * replicaSeconds - FREE_GIB_SECONDS) * GIB_SECOND;
  const lines = [
    { label: `${a.minReplicas > 0 ? a.minReplicas : '0 to 1'} replica${a.minReplicas === 1 ? '' : 's'} (${a.cpu} vCPU, ${memGib} GiB) after the monthly free grant`, monthlyUsd: round2(vcpu + mem) },
    { label: 'Container Registry (Basic)', monthlyUsd: 5.0 },
    { label: 'Log Analytics (about 1 GB)', monthlyUsd: 0 },
  ];
  const notes = ['Excludes data transfer out and requests beyond the free 2 million a month. Log Analytics gives 5 GB a month free.'];
  if (a.maxReplicas > Math.max(1, a.minReplicas)) notes.push(`Priced at the minimum; each extra replica adds up to ${round2((a.cpu * VCPU_SECOND + memGib * GIB_SECOND) * MONTH_SECONDS)} a month while it runs.`);
  return { monthlyUsd: round2(lines.reduce((t, l) => t + l.monthlyUsd, 0)), lines, notes };
}

// ─── Terraform ───────────────────────────────────────────────────────────────

const hcl = (s: string) => JSON.stringify(s).replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');
const secretName = (key: string) => key.toLowerCase().replace(/_/g, '-');
const varName = (key: string) => `secret_${key.toLowerCase()}`;

function mainTf(c: ContainerConfig): string {
  const a = c.aca;
  const plain = c.env.filter((v) => !v.secret);
  const secrets = secretNames(c);
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
  features {}
}

data "azurerm_client_config" "current" {}

locals {
  tags = {
    ManagedBy = "CloudCraft"
    App       = var.app_name
  }
  # Registry names are global, letters and digits only: a short stable suffix keeps this one unique.
  acr_name = substr("acr$\{replace(replace(var.app_name, "-", ""), "_", "")}$\{substr(md5("$\{data.azurerm_client_config.current.subscription_id}$\{var.app_name}"), 0, 6)}", 0, 50)
}

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

# No admin user: the app pulls with its managed identity, which can only read images.
resource "azurerm_container_registry" "app" {
  name                = local.acr_name
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "app" {
  name                = "id-$\{var.app_name}"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.app.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_container_app_environment" "app" {
  name                       = "cae-$\{var.app_name}"
  location                   = azurerm_resource_group.app.location
  resource_group_name        = azurerm_resource_group.app.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.app.id
  tags                       = local.tags
}

resource "azurerm_container_app" "app" {
  name                         = var.app_name
  container_app_environment_id = azurerm_container_app_environment.app.id
  resource_group_name          = azurerm_resource_group.app.name
  revision_mode                = "Single"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.app.login_server
    identity = azurerm_user_assigned_identity.app.id
  }
${secrets.map((k) => `
  secret {
    name  = ${hcl(secretName(k))}
    value = var.${varName(k)}
  }`).join('\n')}

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    container {
      name   = var.app_name
      image  = "$\{azurerm_container_registry.app.login_server}/$\{var.app_name}:$\{var.image_tag}"
      cpu    = var.cpu
      memory = "$\{var.cpu * 2}Gi"
${plain.map((v) => `
      env {
        name  = ${hcl(v.key)}
        value = ${hcl(v.value)}
      }`).join('')}${secrets.map((k) => `
      env {
        name        = ${hcl(k)}
        secret_name = ${hcl(secretName(k))}
      }`).join('\n')}

      startup_probe {
        transport               = "HTTP"
        port                    = var.app_port
        path                    = var.health_path
        interval_seconds        = 5
        failure_count_threshold = 30
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = var.app_port
        path                    = var.health_path
        interval_seconds        = 20
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = var.app_port
        path                    = var.health_path
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
    external_enabled = var.external_ingress
    target_port      = var.app_port
    transport        = "auto"
${a.allowedCidr !== '0.0.0.0/0' ? `
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

  depends_on = [azurerm_role_assignment.acr_pull]
}
`;
}

function variablesTf(c: ContainerConfig): string {
  const a = c.aca;
  const secrets = secretNames(c);
  return `variable "location" {
  description = "Azure region to deploy to."
  type        = string
  default     = ${hcl(a.location)}
}

variable "app_name" {
  description = "Name used for the app, resource group, registry and identity."
  type        = string
  default     = ${hcl(c.appName)}
}

variable "app_port" {
  description = "Port the container listens on."
  type        = number
  default     = ${c.port}
}

variable "health_path" {
  description = "Path used by the startup, liveness and readiness probes."
  type        = string
  default     = ${hcl(c.healthPath)}
}

variable "image_tag" {
  description = "Image tag to run. deploy.sh sets it."
  type        = string
  default     = ${hcl(a.imageTag)}
}

variable "cpu" {
  description = "vCPU per replica (memory is twice this in GiB)."
  type        = number
  default     = ${a.cpu}
}

variable "min_replicas" {
  description = "Minimum replicas. 0 scales to zero when idle."
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

variable "external_ingress" {
  description = "true: reachable from the internet over HTTPS. false: only from inside the environment."
  type        = bool
  default     = ${a.externalIngress}
}
${a.allowedCidr !== '0.0.0.0/0' ? `
variable "allowed_cidr" {
  description = "Who can call the app (IPv4 range)."
  type        = string
  default     = ${hcl(a.allowedCidr)}
}
` : ''}${secrets.map((k) => `
variable "${varName(k)}" {
  description = "Value of ${k}. deploy.sh asks for it; or export TF_VAR_${varName(k)}."
  type        = string
  sensitive   = true
}
`).join('')}`;
}

function outputsTf(c: ContainerConfig): string {
  return `output "acr_name" {
  description = "The container registry that holds the image."
  value       = azurerm_container_registry.app.name
}

output "resource_group" {
  value = azurerm_resource_group.app.name
}

output "app_name" {
  value = azurerm_container_app.app.name
}

output "app_url" {
  value = "https://$\{azurerm_container_app.app.ingress[0].fqdn}${c.healthPath}"
}

output "logs" {
  description = "Follow the application logs."
  value       = "az containerapp logs show --name $\{azurerm_container_app.app.name} --resource-group $\{azurerm_resource_group.app.name} --follow"
}
`;
}

// ─── GitHub Actions ──────────────────────────────────────────────────────────

function workflowYml(c: ContainerConfig): string {
  const a = c.aca;
  return `# Builds the image, scans it, pushes it to the Azure container registry and updates the Container App.
# One-time setup (see aca/README.md): a Microsoft Entra app with a federated credential for this repository, then in GitHub
# (Settings, Secrets and variables, Actions) add the secrets AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID
# and the variables ACR_NAME and RESOURCE_GROUP (both printed by: terraform -chdir=aca output).
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
        run: docker build --platform linux/amd64 -t "\${{ vars.ACR_NAME }}.azurecr.io/$APP_NAME:\${{ github.sha }}" .
${a.scanImage ? `
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
          docker push "\${{ vars.ACR_NAME }}.azurecr.io/$APP_NAME:\${{ github.sha }}"

      - name: Roll the app to the new image
        run: |
          az containerapp update --name "$APP_NAME" --resource-group "\${{ vars.RESOURCE_GROUP }}" \\
            --image "\${{ vars.ACR_NAME }}.azurecr.io/$APP_NAME:\${{ github.sha }}" >/dev/null
`;
}

// ─── one-command scripts ─────────────────────────────────────────────────────

function deploySh(c: ContainerConfig): string {
  const secrets = secretNames(c);
  return `#!/usr/bin/env bash
# One command to deploy ${c.appName} to Azure Container Apps: bash deploy.sh
#   1. creates the resource group and container registry with Terraform (first run)
#   2. builds the image inside Azure (az acr build), so Docker is not needed on this machine
#   3. creates or updates the Container Apps environment and the app, then waits until it answers
# Run it again to release a new version (IMAGE_TAG=v2 bash deploy.sh uses another tag). Add --yes to skip the Terraform confirmation.
set -euo pipefail
cd "$(dirname "$0")"

TAG="\${IMAGE_TAG:-${c.aca.imageTag}}"
SECRETS=(${secrets.map((k) => q(k)).join(' ')})
APPROVE=""
[ "\${1:-}" = "--yes" ] && APPROVE="-auto-approve"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing tool: $1. $2"; exit 1; }; }
need terraform "Install it from https://developer.hashicorp.com/terraform/install"
need az        "Install the Azure CLI from https://learn.microsoft.com/cli/azure/install-azure-cli"
az account show >/dev/null 2>&1 || { echo "You are not signed in to Azure. Run: az login"; exit 1; }
echo "Subscription: $(az account show --query name -o tsv)"

# Secret values go to Terraform as environment variables for this run only. Set TF_VAR_secret_<name> yourself to skip the questions.
for NAME in \${SECRETS[@]+"\${SECRETS[@]}"}; do
  VAR="TF_VAR_secret_$(echo "$NAME" | tr 'A-Z' 'a-z')"
  if [ -z "\${!VAR:-}" ]; then
    read -r -s -p "Value for $NAME (hidden): " VALUE; echo
    [ -n "$VALUE" ] || { echo "$NAME cannot be empty."; exit 1; }
    export "$VAR=$VALUE"; unset VALUE
  fi
done

echo "==> 1/3  Resource group and container registry (Terraform)"
az provider register --namespace Microsoft.App --wait >/dev/null
az provider register --namespace Microsoft.OperationalInsights --wait >/dev/null
terraform -chdir=aca init -input=false >/dev/null
terraform -chdir=aca apply -var "image_tag=$TAG" \\
  -target=azurerm_resource_group.app -target=azurerm_container_registry.app -target=azurerm_user_assigned_identity.app -target=azurerm_role_assignment.acr_pull \\
  \${APPROVE:+-auto-approve}

echo "==> 2/3  Build the image in Azure"
ACR=$(terraform -chdir=aca output -raw acr_name)
APP=${q(c.appName)}
az acr build --registry "$ACR" --image "$APP:$TAG" --platform linux/amd64 .

echo "==> 3/3  Environment and app (Terraform)"
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
  echo "Done. ${c.appName} is running at $URL"
else
  echo "Not answering yet. A new app can take a few minutes. Check again, or read the logs:"
  echo "  $(terraform -chdir=aca output -raw logs)"
fi
`;
}

function destroySh(c: ContainerConfig): string {
  const secrets = secretNames(c);
  return `#!/usr/bin/env bash
# Removes everything deploy.sh created (the whole resource group: app, environment, registry with its images, logs): bash destroy.sh
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(c.appName)}
SECRETS=(${secrets.map((k) => q(k)).join(' ')})

command -v terraform >/dev/null 2>&1 || { echo "Missing tool: terraform"; exit 1; }
command -v az >/dev/null 2>&1 || { echo "Missing tool: az"; exit 1; }
az account show >/dev/null 2>&1 || { echo "You are not signed in to Azure. Run: az login"; exit 1; }

echo "This permanently deletes the resource group rg-$APP and everything in it."
read -r -p "Type the app name ($APP) to continue: " ANSWER
[ "$ANSWER" = "$APP" ] || { echo "Cancelled."; exit 1; }

# Destroy needs a value for each secret variable, but not the real one.
for NAME in \${SECRETS[@]+"\${SECRETS[@]}"}; do
  export "TF_VAR_secret_$(echo "$NAME" | tr 'A-Z' 'a-z')=unused"
done

terraform -chdir=aca init -input=false >/dev/null
terraform -chdir=aca destroy -auto-approve
echo "Done."
`;
}

function readme(c: ContainerConfig): string {
  const a = c.aca;
  const secrets = secretNames(c);
  return `# Deploy ${c.appName} to Azure Container Apps

## Quick start

You need Terraform and the Azure CLI installed and to be signed in (\`az login\`). Docker is **not** needed: the image is built inside Azure. From the folder that contains your app and these files:

\`\`\`bash
bash deploy.sh
\`\`\`

It creates the resource group and container registry, ${secrets.length ? 'asks for your secret values (hidden), ' : ''}builds the image in Azure, creates the environment and the app, and prints the address. To release a new version run it again (\`IMAGE_TAG=v2 bash deploy.sh\` to use another tag). To remove everything: \`bash destroy.sh\`.

## What gets created

- A resource group \`rg-${c.appName}\` in \`${a.location}\` with a container registry (Basic, no admin user), a Log Analytics workspace and a Container Apps environment.
- The app: ${a.minReplicas}${a.maxReplicas !== a.minReplicas ? ` to ${a.maxReplicas}` : ''} replica${a.maxReplicas === 1 ? '' : 's'} of ${a.cpu} vCPU and ${a.cpu * 2} GiB, scaling out at ${a.concurrentRequests} concurrent requests per replica${a.minReplicas === 0 ? ' and to zero when idle' : ''}.
- ${a.externalIngress ? `HTTPS ingress${a.allowedCidr === '0.0.0.0/0' ? ' open to everyone' : ` restricted to \`${a.allowedCidr}\``}` : 'Internal ingress only (reachable from inside the environment)'}, with startup, liveness and readiness probes on \`${c.healthPath}\`.
- A managed identity that can only pull images (AcrPull) from the registry.
${secrets.length ? `- Secrets (${secrets.join(', ')}) are given to Terraform as sensitive variables and stored as Container Apps secrets. **They are also in Terraform's state file** (\`aca/terraform.tfstate\`): keep that folder private, or use an encrypted remote backend (an \`azurerm\` backend on a storage account).\n` : ''}
## Logs and status

\`\`\`bash
az containerapp logs show --name ${c.appName} --resource-group rg-${c.appName} --follow
az containerapp revision list --name ${c.appName} --resource-group rg-${c.appName} -o table
\`\`\`

## Common problems

- **"MissingSubscriptionRegistration"**: \`deploy.sh\` registers Microsoft.App and Microsoft.OperationalInsights; if you lack the permission ask an administrator to register them.
- **The first start is slow**: a new environment takes a few minutes. After that, a revision starts in about a minute.
- **The app restarts**: read the logs. The health check path \`${c.healthPath}\` must answer on port ${c.port}.
- **"exec format error"**: the image was built for the wrong CPU type. \`az acr build --platform linux/amd64\` is used by \`deploy.sh\`.
${a.githubActions ? `
## Optional: deploy automatically when you push to GitHub

\`.github/workflows/deploy.yml\` builds, scans and pushes the image on every push to \`main\` and updates the app. It signs in to Azure without a stored password (OIDC). One-time setup${a.githubRepo ? ` for \`${a.githubRepo}\`` : ''}:

\`\`\`bash
REPO=${a.githubRepo || 'owner/name'}
APP_ID=$(az ad app create --display-name "${c.appName}-github" --query appId -o tsv)
az ad sp create --id "$APP_ID" >/dev/null
az ad app federated-credential create --id "$APP_ID" --parameters '{"name":"main","issuer":"https://token.actions.githubusercontent.com","subject":"repo:'"$REPO"':ref:refs/heads/main","audiences":["api://AzureADTokenExchange"]}'
SUB=$(az account show --query id -o tsv)
az role assignment create --assignee "$APP_ID" --role Contributor --scope "/subscriptions/$SUB/resourceGroups/rg-${c.appName}"
\`\`\`

Then in GitHub (Settings, Secrets and variables, Actions) add the secrets \`AZURE_CLIENT_ID\` (= \`$APP_ID\`), \`AZURE_TENANT_ID\` (\`az account show --query tenantId -o tsv\`), \`AZURE_SUBSCRIPTION_ID\`, and the variables \`ACR_NAME\` and \`RESOURCE_GROUP\` (from \`terraform -chdir=aca output\`).
Contributor on the resource group is broad; narrow it to the roles you need (AcrPush on the registry and Container Apps Contributor on the app) if your policy requires.
` : ''}
## What to know

- Costs: replicas bill by the second while running (a monthly free grant applies), the registry bills daily, and Log Analytics bills above 5 GB a month.
- Terraform keeps its record in \`aca/terraform.tfstate\`. Keep that folder; \`bash destroy.sh\` needs it.
`;
}

export function generateAcaFiles(c: ContainerConfig): Array<{ path: string; content: string; executable?: boolean }> {
  if (!c.aca.enabled) return [];
  return [
    { path: 'deploy.sh', content: deploySh(c), executable: true },
    { path: 'destroy.sh', content: destroySh(c), executable: true },
    { path: 'aca/main.tf', content: mainTf(c) },
    { path: 'aca/variables.tf', content: variablesTf(c) },
    { path: 'aca/outputs.tf', content: outputsTf(c) },
    { path: 'aca/.gitignore', content: '.terraform/\n*.tfstate\n*.tfstate.*\ncrash.log\n' },
    { path: 'aca/README.md', content: readme(c) },
    ...(c.aca.githubActions ? [{ path: '.github/workflows/deploy.yml', content: workflowYml(c) }] : []),
  ];
}
