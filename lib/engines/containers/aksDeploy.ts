/**
 * Optional "deploy to Azure Kubernetes Service (AKS)" bundle: Terraform for a resource group, a container registry, a Log Analytics workspace
 * and an AKS cluster (managed identity, OIDC issuer and workload identity on, cluster autoscaler), plus the Kubernetes manifests and Helm
 * chart from the Kubernetes target, and deploy.sh / destroy.sh that build the image inside Azure, connect kubectl and roll the app out.
 *
 * Secrets live in Key Vault: deploy.sh stores them there, and the pods read them through the Secrets Store CSI driver with workload identity
 * (a federated credential ties the app's service account to a managed identity that can only read this vault). They never pass through kubectl or
 * a file. The cluster pulls images with its kubelet identity, which holds only AcrPull on this registry: no registry password, no pull secret. The manifests are the same hardened ones as the plain Kubernetes target; their image is the registry's, filled in by deploy.sh.
 */
import type { ContainerConfig } from './dockerTemplates';
import { usesExistingImage } from './existingImageUse';
import { azureVmHourlyUsd } from '@/lib/engines/cost/azurePricing';
import { TAG, q, secretNames, type DeployCost } from './ec2Deploy';
import { generateK8sManifestFiles, k8sWarnings, KV_TOKENS, splitImage, validateK8s } from './kubernetesDeploy';
import { vaultSecretName } from './azureVmDeploy';

export interface AksConfig {
  enabled: boolean;
  location: string;
  /** VM size of the node pool. */
  nodeSize: string;
  minNodes: number;
  maxNodes: number;
  /** Tag of the image deploy.sh builds and the manifests run. */
  imageTag: string;
}

export const defaultAks = (): AksConfig => ({ enabled: false, location: 'westeurope', nodeSize: 'Standard_B2s', minNodes: 1, maxNodes: 3, imageTag: 'latest' });

const LOCATION = /^[a-z]{3,}[a-z0-9]*$/;
const VM_SIZE = /^Standard_[A-Za-z0-9_]{2,30}$/;
const CLUSTER_NAME = /^[a-z][a-z0-9-]{0,52}[a-z0-9]$/;

/** The Kubernetes settings the manifests are generated from: the form's, with the image deploy.sh will push and AKS's ingress class. */
export function aksAsK8s(c: ContainerConfig): ContainerConfig {
  const k = c.k8s;
  return { ...c, k8s: { ...k, enabled: true, image: usesExistingImage(c) ? c.image : `${c.appName}:${c.aks.imageTag}`, ingressClass: k.ingressClass === 'nginx' || k.ingressClass === '' ? 'webapprouting.kubernetes.azure.com' : k.ingressClass, githubActions: false, keyVault: true } };
}

export function validateAks(c: ContainerConfig): string[] {
  const a = c.aks;
  if (!a.enabled) return [];
  const out: string[] = [];
  if (!CLUSTER_NAME.test(c.appName)) out.push('AKS: the app name becomes the cluster and DNS prefix, so it may use only lowercase letters, digits and "-", start with a letter, up to 54 characters.');
  if (!LOCATION.test(a.location)) out.push('AKS: location looks like westeurope or eastus2.');
  if (!VM_SIZE.test(a.nodeSize)) out.push('AKS: node size looks like Standard_B2s.');
  if (!Number.isInteger(a.minNodes) || !Number.isInteger(a.maxNodes) || a.minNodes < 1 || a.maxNodes < a.minNodes || a.maxNodes > 100) out.push('AKS: nodes need a minimum of at least 1 and a maximum that is not below it (up to 100).');
  if (!TAG.test(a.imageTag)) out.push('AKS: image tag may use letters, digits, "_", "." and "-" (up to 128 characters).');
  return [...out, ...validateK8s(aksAsK8s(c))];
}

export function aksWarnings(c: ContainerConfig): string[] {
  const a = c.aks;
  if (!a.enabled) return [];
  const w = k8sWarnings(aksAsK8s(c)).filter((x) => !/deploy\.sh asks for each secret/.test(x) && usesExistingImage(c) ? true : !/image has no version tag/.test(x));
  if (!usesExistingImage(c) && a.imageTag === 'latest') w.push('AKS: the "latest" tag is used. A version tag (for example the commit id) makes it clear what is running and allows a rollback.');
  if (c.env.some((v) => v.secret)) w.push('AKS: deploy.sh stores each secret in Key Vault (asks once, hidden). The pods read them through the Key Vault CSI driver and workload identity; the Kubernetes Secret the app reads is synced from the vault while a pod runs. After you change a secret, restart the deployment (kubectl rollout restart) so the pods pick up the new value.');
  if (c.k8s.ingressHost !== '') w.push('AKS: deploy.sh turns on the managed ingress controller (application routing). Point your DNS name at its public IP.');
  return w;
}

// ─── cost ────────────────────────────────────────────────────────────────────

const HOURS = 730;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** List-price estimate (East US) of the nodes at the minimum count, the cluster's load balancer and outbound IP, and the registry. */
export function estimateAksCost(c: ContainerConfig): DeployCost | undefined {
  const a = c.aks;
  if (!a.enabled) return undefined;
  const hourly = azureVmHourlyUsd(a.nodeSize);
  const lines = [
    { label: `${a.minNodes} node${a.minNodes === 1 ? '' : 's'} (${a.nodeSize})`, monthlyUsd: round2((hourly ?? 0) * HOURS * a.minNodes) },
    { label: 'Cluster control plane (Free tier)', monthlyUsd: 0 },
    { label: 'Standard load balancer and outbound public IP', monthlyUsd: round2((0.025 + 0.005) * HOURS) },
    ...(usesExistingImage(c) ? [] : [{ label: 'Container Registry (Basic)', monthlyUsd: 5 }]),
  ];
  const notes = ['Excludes data transfer, node OS disks (about $5 each), Log Analytics above 5 GB a month and any extra nodes the autoscaler adds.'];
  if (hourly === undefined) notes.push(`${a.nodeSize} is not in the price table, so its price is left out of the total.`);
  if (a.maxNodes > a.minNodes) notes.push(`Priced at the minimum; each extra node adds ${round2((hourly ?? 0) * HOURS)} a month while it runs.`);
  return { monthlyUsd: round2(lines.reduce((t, l) => t + l.monthlyUsd, 0)), lines, notes };
}

// ─── Terraform ───────────────────────────────────────────────────────────────

const hcl = (s: string) => JSON.stringify(s).replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');

function mainTf(c: ContainerConfig): string {
  const kv = secretNames(c).length > 0;
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
  features {${kv ? `
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
  slug     = replace(replace(var.app_name, "-", ""), "_", "")
  suffix   = substr(md5("$\{data.azurerm_client_config.current.subscription_id}$\{var.app_name}"), 0, 6)
${usesExistingImage(c) ? '' : `  acr_name = substr("acr$\{local.slug}$\{local.suffix}", 0, 50)`}${kv ? `
  vault_name = "kv$\{substr(local.slug, 0, 12)}$\{local.suffix}"` : ''}
}

resource "azurerm_resource_group" "app" {
  name     = "rg-$\{var.app_name}"
  location = var.location
  tags     = local.tags
}

${usesExistingImage(c) ? '' : `# No admin user: the cluster pulls with its kubelet identity, which can only read images.
resource "azurerm_container_registry" "app" {
  name                = local.acr_name
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

`}resource "azurerm_log_analytics_workspace" "app" {
  name                = "log-$\{var.app_name}"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

resource "azurerm_kubernetes_cluster" "app" {
  name                      = "aks-$\{var.app_name}"
  location                  = azurerm_resource_group.app.location
  resource_group_name       = azurerm_resource_group.app.name
  dns_prefix                = var.app_name
  sku_tier                  = "Free"
  automatic_channel_upgrade = "patch"
  oidc_issuer_enabled       = true
  workload_identity_enabled = true
  tags                      = local.tags

  default_node_pool {
    name                = "system"
    vm_size             = var.node_size
    enable_auto_scaling = true
    min_count           = var.min_nodes
    max_count           = var.max_nodes
    os_disk_size_gb     = 64

    upgrade_settings {
      max_surge = "10%"
    }
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
  }

  oms_agent {
    log_analytics_workspace_id = azurerm_log_analytics_workspace.app.id
  }
${kv ? `
  # The add-on that mounts Key Vault secrets into pods (Secrets Store CSI driver, Azure provider).
  key_vault_secrets_provider {
    secret_rotation_enabled = true
  }
` : ''}}

${usesExistingImage(c) ? '' : `resource "azurerm_role_assignment" "pull" {
  scope                            = azurerm_container_registry.app.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_kubernetes_cluster.app.kubelet_identity[0].object_id
  skip_service_principal_aad_check = true
}
`}${kv ? `
# ── Secrets: Key Vault, read by the app's own identity (workload identity) ───

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

# Whoever runs deploy.sh can store secrets.
resource "azurerm_role_assignment" "deployer_secrets" {
  scope                = azurerm_key_vault.app.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_user_assigned_identity" "workload" {
  name                = "id-$\{var.app_name}"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "vault_read" {
  scope                = azurerm_key_vault.app.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.workload.principal_id
}

# Only the pods that run as this service account in this namespace can act as the identity.
resource "azurerm_federated_identity_credential" "workload" {
  name                = "$\{var.app_name}-pods"
  resource_group_name = azurerm_resource_group.app.name
  parent_id           = azurerm_user_assigned_identity.workload.id
  issuer              = azurerm_kubernetes_cluster.app.oidc_issuer_url
  subject             = "system:serviceaccount:$\{var.k8s_namespace}:$\{var.app_name}"
  audience            = ["api://AzureADTokenExchange"]
}
` : ''}`;
}

function variablesTf(c: ContainerConfig): string {
  const a = c.aks;
  return `variable "location" {
  description = "Azure region to deploy to."
  type        = string
  default     = ${hcl(a.location)}
}

variable "app_name" {
  description = "Name used for the resource group, cluster and registry."
  type        = string
  default     = ${hcl(c.appName)}
}

${secretNames(c).length ? `variable "k8s_namespace" {
  description = "Namespace the app runs in (the identity is bound to the service account there)."
  type        = string
  default     = ${hcl(c.k8s.namespace)}
}

` : ''}variable "node_size" {
  description = "VM size of the node pool."
  type        = string
  default     = ${hcl(a.nodeSize)}
}

variable "min_nodes" {
  type    = number
  default = ${a.minNodes}
}

variable "max_nodes" {
  type    = number
  default = ${a.maxNodes}
}
`;
}

function outputsTf(c: ContainerConfig): string {
  return `${usesExistingImage(c) ? '' : `output "acr_name" {
  description = "The container registry that holds the image."
  value       = azurerm_container_registry.app.name
}

`}output "resource_group" {
  value = azurerm_resource_group.app.name
}

output "cluster_name" {
  value = azurerm_kubernetes_cluster.app.name
}

${secretNames(c).length ? `output "vault_name" {
  description = "Key Vault that holds the secrets (deploy.sh stores them here)."
  value       = azurerm_key_vault.app.name
}

output "tenant_id" {
  value = data.azurerm_client_config.current.tenant_id
}

output "workload_client_id" {
  description = "Client id of the identity the pods use to read the vault."
  value       = azurerm_user_assigned_identity.workload.client_id
}

` : ''}output "get_credentials" {
  description = "Point kubectl at the cluster."
  value       = "az aks get-credentials --resource-group $\{azurerm_resource_group.app.name} --name $\{azurerm_kubernetes_cluster.app.name}"
}
`;
}

// ─── scripts and README ──────────────────────────────────────────────────────

function deploySh(c: ContainerConfig): string {
  const k = c.k8s;
  const secrets = secretNames(c);
  const ex = usesExistingImage(c);
  const total = 2 + (secrets.length ? 1 : 0) + (ex ? 0 : 1);
  const secretsStep = 2;
  const buildStep = secrets.length ? 3 : 2;
  const steps = [
    `creates the resource group, ${ex ? '' : 'container registry, '}AKS cluster${secrets.length ? ' and Key Vault' : ''} with Terraform (first run: about 10 minutes), asking you to confirm`,
    ...(secrets.length ? ['stores any secret values in Key Vault (asks once, hidden), never in a file, in Terraform\'s state or in the cluster\'s command line'] : []),
    ...(ex ? [] : ['builds the image inside Azure (az acr build), so Docker is not needed on this machine']),
    `connects kubectl and applies the manifests${ex ? ` (the cluster pulls ${c.image})` : ''}`,
  ];
  return `#!/usr/bin/env bash
# One command to deploy ${c.appName} to Azure Kubernetes Service: bash deploy.sh
${steps.map((t, i) => `#   ${i + 1}. ${t}`).join('\n')}
# Run it again ${ex ? 'after changing the settings' : 'to release a new version (IMAGE_TAG=v2 bash deploy.sh uses another tag)'}. Add --yes to skip the Terraform confirmation.
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(c.appName)}
NAMESPACE=${q(k.namespace)}
${ex ? '' : `TAG="\${IMAGE_TAG:-${c.aks.imageTag}}"\n`}SECRETS=(${secrets.map(q).join(' ')})
APPROVE=""
[ "\${1:-}" = "--yes" ] && APPROVE="-auto-approve"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing tool: $1. $2"; exit 1; }; }
need terraform "Install it from https://developer.hashicorp.com/terraform/install"
need az        "Install the Azure CLI from https://learn.microsoft.com/cli/azure/install-azure-cli"
need kubectl   "Install it from https://kubernetes.io/docs/tasks/tools/ (or: az aks install-cli)"
az account show >/dev/null 2>&1 || { echo "You are not signed in to Azure. Run: az login"; exit 1; }
echo "Subscription: $(az account show --query name -o tsv)"

az provider register --namespace Microsoft.ContainerService --wait >/dev/null
az provider register --namespace Microsoft.ContainerRegistry --wait >/dev/null
az provider register --namespace Microsoft.OperationalInsights --wait >/dev/null
${secrets.length ? 'az provider register --namespace Microsoft.KeyVault --wait >/dev/null\n' : ''}
echo "==> 1/${total}  ${ex ? '' : 'Registry and '}AKS cluster${secrets.length ? ' and Key Vault' : ''} (Terraform)"
terraform -chdir=aks init -input=false >/dev/null
terraform -chdir=aks apply \${APPROVE:+-auto-approve}
${ex ? '' : `ACR=$(terraform -chdir=aks output -raw acr_name)
`}RG=$(terraform -chdir=aks output -raw resource_group)
CLUSTER=$(terraform -chdir=aks output -raw cluster_name)
${secrets.length ? `VAULT=$(terraform -chdir=aks output -raw vault_name)
TENANT=$(terraform -chdir=aks output -raw tenant_id)
CLIENT_ID=$(terraform -chdir=aks output -raw workload_client_id)

echo "==> ${secretsStep}/${total}  Secrets"
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
` : ''}
${ex ? '' : `echo "==> ${buildStep}/${total}  Build the image in Azure"
az acr build --registry "$ACR" --image "$APP:$TAG" --platform linux/amd64 .

`}echo "==> ${total}/${total}  Deploy to the cluster"
# A private kubeconfig for this run: your own kubectl contexts are left alone.
export KUBECONFIG="$(mktemp)"
trap 'rm -f "$KUBECONFIG"' EXIT
az aks get-credentials --resource-group "$RG" --name "$CLUSTER" --file "$KUBECONFIG" --overwrite-existing >/dev/null

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
${k.ingressHost ? `
# The managed ingress controller (application routing), once.
az aks approuting enable --resource-group "$RG" --name "$CLUSTER" >/dev/null 2>&1 || true
` : ''}
${ex ? (secrets.length ? '# The manifests carry placeholders for the vault, tenant and identity; fill them in and apply.' : '') : `# The manifests name the image "${c.appName}:<tag>"${secrets.length ? ' and carry placeholders for the vault, tenant and identity' : ''}; fill them in and apply.`}
${ex && !secrets.length ? 'kubectl apply -k k8s' : `kubectl kustomize k8s | sed ${[...(ex ? [] : ['-e "s#image: $APP:$TAG#image: $ACR.azurecr.io/$APP:$TAG#"']), ...(secrets.length ? [`-e "s#${KV_TOKENS.vaultName}#$VAULT#g"`, `-e "s#${KV_TOKENS.tenantId}#$TENANT#g"`, `-e "s#${KV_TOKENS.clientId}#$CLIENT_ID#g"`] : [])].join(' \\\n  ')} | kubectl apply -f -`}
kubectl -n "$NAMESPACE" rollout status deployment/"$APP" --timeout=300s
echo "Done. ${k.ingressHost ? `Point ${k.ingressHost} at the ingress address: kubectl -n app-routing-system get service nginx` : k.serviceType === 'LoadBalancer' ? 'Find the address with: kubectl -n "$NAMESPACE" get service "$APP"' : 'Try it with: kubectl -n "$NAMESPACE" port-forward service/"$APP" 8080:80'}"
`;
}

function destroySh(c: ContainerConfig): string {
  return `#!/usr/bin/env bash
# Removes everything deploy.sh created (the whole resource group: cluster, registry with its images, logs): bash destroy.sh
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(c.appName)}

command -v terraform >/dev/null 2>&1 || { echo "Missing tool: terraform"; exit 1; }
command -v az >/dev/null 2>&1 || { echo "Missing tool: az"; exit 1; }
az account show >/dev/null 2>&1 || { echo "You are not signed in to Azure. Run: az login"; exit 1; }

echo "This permanently deletes the resource group rg-$APP, the cluster and everything running in it."
read -r -p "Type the app name ($APP) to continue: " ANSWER
[ "$ANSWER" = "$APP" ] || { echo "Cancelled."; exit 1; }

terraform -chdir=aks init -input=false >/dev/null
terraform -chdir=aks destroy -auto-approve
echo "Done."
`;
}

function readme(c: ContainerConfig): string {
  const a = c.aks;
  const k = c.k8s;
  const secrets = secretNames(c);
  return `# Deploy ${c.appName} to Azure Kubernetes Service (AKS)

## Quick start

You need Terraform, the Azure CLI and kubectl installed and to be signed in (\`az login\`). Docker is **not** needed${usesExistingImage(c) ? '' : ': the image is built inside Azure'}. From the folder that contains your app and these files:

\`\`\`bash
bash deploy.sh
\`\`\`

It creates the resource group, ${usesExistingImage(c) ? '' : 'container registry and '}cluster (the first run takes about 10 minutes), ${usesExistingImage(c) ? '' : 'builds the image in Azure, '}${secrets.length ? 'asks for your secret values (hidden), ' : ''}applies the manifests${usesExistingImage(c) ? ` (the cluster pulls \`${c.image}\` as it is)` : ''} and waits for the rollout. ${usesExistingImage(c) ? 'To change anything edit the settings and run it again.' : 'To release a new version run it again (\`IMAGE_TAG=v2 bash deploy.sh\`).'} To remove everything: \`bash destroy.sh\`.

## What gets created

- A resource group \`rg-${c.appName}\` in \`${a.location}\` with an AKS cluster (Free tier control plane, ${a.minNodes} to ${a.maxNodes} \`${a.nodeSize}\` node${a.maxNodes === 1 ? '' : 's'} with the cluster autoscaler, Azure CNI overlay networking, workload identity and the OIDC issuer on, container insights).
${usesExistingImage(c) ? `- The cluster runs \`${c.image}\`, pulled from its public registry.` : '- A container registry (Basic, no admin user). The cluster pulls from it with its kubelet identity, which holds only AcrPull.'}
- In namespace \`${k.namespace}\`: a Deployment of ${k.autoscaling ? `${k.minReplicas} to ${k.maxReplicas}` : k.replicas} pod${k.replicas === 1 && !k.autoscaling ? '' : 's'} with health probes on \`${c.healthPath}\`, resource limits and zero-downtime rolling updates, a Service (${k.serviceType})${k.ingressHost ? `, an Ingress for \`${k.ingressHost}\` through the managed ingress controller` : ''}${k.autoscaling ? ', a HorizontalPodAutoscaler' : ''}. Pods run as a non-root user with no privilege escalation, all capabilities dropped and no service account token.
${secrets.length ? `- Secrets (${secrets.join(', ')}) are stored in a Key Vault (as ${secrets.map((x) => `\`${vaultSecretName(x)}\``).join(', ')}) by deploy.sh. The pods read them through the Key Vault CSI driver and workload identity: a managed identity that can only read this vault is tied, by a federated credential, to the service account \`${c.appName}\` in \`${k.namespace}\`. The Secret \`${c.appName}-secrets\` the app reads is synced from the vault while a pod runs. Values never pass through kubectl, a file or Terraform's state. After you change a secret in the vault, run \`kubectl -n ${k.namespace} rollout restart deployment/${c.appName}\`.\n` : ''}
## Look inside

\`\`\`bash
az aks get-credentials --resource-group rg-${c.appName} --name aks-${c.appName}
kubectl -n ${k.namespace} get pods
kubectl -n ${k.namespace} logs deployment/${c.appName} --tail=100 -f
\`\`\`

${k.helm ? `## Using Helm instead

\`\`\`bash
helm upgrade --install ${c.appName} helm/${c.appName} --namespace ${k.namespace} --create-namespace \\
  --set image.repository=${usesExistingImage(c) ? splitImage(c.image).repository : `<acr_name>.azurecr.io/${c.appName}`} --set image.tag=${usesExistingImage(c) ? splitImage(c.image).tag : a.imageTag}${secrets.length ? ` \\
  --set keyVault.enabled=true --set keyVault.vaultName=<vault_name> --set keyVault.tenantId=<tenant_id> --set keyVault.clientId=<workload_client_id>` : ''}
\`\`\`

(\`terraform -chdir=aks output\` gives ${usesExistingImage(c) ? '' : 'the registry name'}${secrets.length ? `${usesExistingImage(c) ? '' : ', '}the vault name, the tenant id and the identity's client id` : ''}${usesExistingImage(c) && !secrets.length ? 'the cluster name' : ''}.)

` : ''}## Common problems

- **ImagePullBackOff**: ${usesExistingImage(c) ? `the cluster cannot pull \`${c.image}\`: check the name and tag, and that the image is public.` : 'the image is not in the registry yet, or the AcrPull assignment has not taken effect (it can take a minute). Run \`bash deploy.sh\` again.'}
- **"SkuNotAvailable" or a quota error**: the node size is not offered, or your subscription has no quota for it in that region. Change \`node_size\` in \`aks/variables.tf\`, or pick another region.
- **CreateContainerConfigError** or pods stuck in ContainerCreating: ${secrets.length ? `a secret is missing from the vault, or the identity cannot read it yet (a new role assignment can take a few minutes). Run \`kubectl -n ${k.namespace} describe pod\` and read the events; run \`bash deploy.sh\` again to be asked for missing secrets.` : 'a secret the app needs is missing.'}
- **Pods restart in a loop**: read the logs. The health check path \`${c.healthPath}\` must answer on port ${c.port}.

## What to know

- Terraform keeps its record in \`aks/terraform.tfstate\`. Keep that folder; \`bash destroy.sh\` needs it.
- Costs: the nodes, the cluster's load balancer and outbound IP, and the registry bill all the time; the control plane is free.
`;
}

export function generateAksFiles(c: ContainerConfig): Array<{ path: string; content: string; executable?: boolean }> {
  if (!c.aks.enabled) return [];
  return [
    { path: 'deploy.sh', content: deploySh(c), executable: true },
    { path: 'destroy.sh', content: destroySh(c), executable: true },
    { path: 'aks/main.tf', content: mainTf(c) },
    { path: 'aks/variables.tf', content: variablesTf(c) },
    { path: 'aks/outputs.tf', content: outputsTf(c) },
    { path: 'aks/.gitignore', content: '.terraform/\n*.tfstate\n*.tfstate.*\ncrash.log\n' },
    { path: 'aks/README.md', content: readme(c) },
    ...generateK8sManifestFiles(aksAsK8s(c)),
  ];
}
