/**
 * Optional "deploy to Azure Kubernetes Service (AKS)" bundle: Terraform for a resource group, a container registry, a Log Analytics workspace
 * and an AKS cluster (managed identity, OIDC issuer and workload identity on, cluster autoscaler), plus the Kubernetes manifests and Helm
 * chart from the Kubernetes target, and deploy.sh / destroy.sh that build the image inside Azure, connect kubectl and roll the app out.
 *
 * The cluster pulls images with its kubelet identity, which holds only AcrPull on this registry: there is no registry password and no image
 * pull secret. The manifests are the same hardened ones as the plain Kubernetes target; their image is the registry's, filled in by deploy.sh.
 */
import type { ContainerConfig } from './dockerTemplates';
import { azureVmHourlyUsd } from '@/lib/engines/cost/azurePricing';
import { TAG, q, secretNames, type DeployCost } from './ec2Deploy';
import { generateK8sManifestFiles, k8sWarnings, validateK8s } from './kubernetesDeploy';

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
  return { ...c, k8s: { ...k, enabled: true, image: `${c.appName}:${c.aks.imageTag}`, ingressClass: k.ingressClass === 'nginx' || k.ingressClass === '' ? 'webapprouting.kubernetes.azure.com' : k.ingressClass, githubActions: false } };
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
  const w = k8sWarnings(aksAsK8s(c)).filter((x) => !/deploy\.sh asks for each secret/.test(x) && !/image has no version tag/.test(x));
  if (a.imageTag === 'latest') w.push('AKS: the "latest" tag is used. A version tag (for example the commit id) makes it clear what is running and allows a rollback.');
  if (c.env.some((v) => v.secret)) w.push(`AKS: deploy.sh asks for each secret and stores it in a Kubernetes Secret named ${c.appName}-secrets (Kubernetes Secrets are only base64-encoded: enable etcd encryption with a key you control, or use the Key Vault CSI driver, for sensitive data).`);
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
    { label: 'Container Registry (Basic)', monthlyUsd: 5 },
  ];
  const notes = ['Excludes data transfer, node OS disks (about $5 each), Log Analytics above 5 GB a month and any extra nodes the autoscaler adds.'];
  if (hourly === undefined) notes.push(`${a.nodeSize} is not in the price table, so its price is left out of the total.`);
  if (a.maxNodes > a.minNodes) notes.push(`Priced at the minimum; each extra node adds ${round2((hourly ?? 0) * HOURS)} a month while it runs.`);
  return { monthlyUsd: round2(lines.reduce((t, l) => t + l.monthlyUsd, 0)), lines, notes };
}

// ─── Terraform ───────────────────────────────────────────────────────────────

const hcl = (s: string) => JSON.stringify(s).replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');

function mainTf(c: ContainerConfig): string {
  void c;
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
  slug     = replace(replace(var.app_name, "-", ""), "_", "")
  suffix   = substr(md5("$\{data.azurerm_client_config.current.subscription_id}$\{var.app_name}"), 0, 6)
  acr_name = substr("acr$\{local.slug}$\{local.suffix}", 0, 50)
}

resource "azurerm_resource_group" "app" {
  name     = "rg-$\{var.app_name}"
  location = var.location
  tags     = local.tags
}

# No admin user: the cluster pulls with its kubelet identity, which can only read images.
resource "azurerm_container_registry" "app" {
  name                = local.acr_name
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

resource "azurerm_log_analytics_workspace" "app" {
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
}

resource "azurerm_role_assignment" "pull" {
  scope                            = azurerm_container_registry.app.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_kubernetes_cluster.app.kubelet_identity[0].object_id
  skip_service_principal_aad_check = true
}
`;
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

variable "node_size" {
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

function outputsTf(): string {
  return `output "acr_name" {
  description = "The container registry that holds the image."
  value       = azurerm_container_registry.app.name
}

output "resource_group" {
  value = azurerm_resource_group.app.name
}

output "cluster_name" {
  value = azurerm_kubernetes_cluster.app.name
}

output "get_credentials" {
  description = "Point kubectl at the cluster."
  value       = "az aks get-credentials --resource-group $\{azurerm_resource_group.app.name} --name $\{azurerm_kubernetes_cluster.app.name}"
}
`;
}

// ─── scripts and README ──────────────────────────────────────────────────────

function deploySh(c: ContainerConfig): string {
  const k = c.k8s;
  const secrets = secretNames(c);
  return `#!/usr/bin/env bash
# One command to deploy ${c.appName} to Azure Kubernetes Service: bash deploy.sh
#   1. creates the resource group, container registry and AKS cluster with Terraform (first run: about 10 minutes), asking you to confirm
#   2. builds the image inside Azure (az acr build), so Docker is not needed on this machine
#   3. connects kubectl, stores any secret values in the cluster (asks once, hidden), and applies the manifests
# Run it again to release a new version (IMAGE_TAG=v2 bash deploy.sh uses another tag). Add --yes to skip the Terraform confirmation.
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(c.appName)}
NAMESPACE=${q(k.namespace)}
TAG="\${IMAGE_TAG:-${c.aks.imageTag}}"
SECRETS=(${secrets.map(q).join(' ')})
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

echo "==> 1/3  Registry and AKS cluster (Terraform)"
terraform -chdir=aks init -input=false >/dev/null
terraform -chdir=aks apply \${APPROVE:+-auto-approve}
ACR=$(terraform -chdir=aks output -raw acr_name)
RG=$(terraform -chdir=aks output -raw resource_group)
CLUSTER=$(terraform -chdir=aks output -raw cluster_name)

echo "==> 2/3  Build the image in Azure"
az acr build --registry "$ACR" --image "$APP:$TAG" --platform linux/amd64 .

echo "==> 3/3  Deploy to the cluster"
# A private kubeconfig for this run: your own kubectl contexts are left alone.
export KUBECONFIG="$(mktemp)"
trap 'rm -f "$KUBECONFIG"' EXIT
az aks get-credentials --resource-group "$RG" --name "$CLUSTER" --file "$KUBECONFIG" --overwrite-existing >/dev/null

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
if [ \${#SECRETS[@]} -gt 0 ]; then
  if kubectl -n "$NAMESPACE" get secret "$APP-secrets" >/dev/null 2>&1; then
    echo "    $APP-secrets already exists (delete it with: kubectl -n $NAMESPACE delete secret $APP-secrets)"
  else
    ARGS=()
    for NAME in "\${SECRETS[@]}"; do
      read -r -s -p "    Value for $NAME (hidden): " VALUE; echo
      [ -n "$VALUE" ] || { echo "    $NAME cannot be empty."; exit 1; }
      ARGS+=("--from-literal=$NAME=$VALUE")
    done
    kubectl -n "$NAMESPACE" create secret generic "$APP-secrets" "\${ARGS[@]}" >/dev/null
    unset ARGS VALUE
    echo "    stored"
  fi
fi
${k.ingressHost ? `
# The managed ingress controller (application routing), once.
az aks approuting enable --resource-group "$RG" --name "$CLUSTER" >/dev/null 2>&1 || true
` : ''}
# The manifests name the image "${c.appName}:<tag>"; run it from this registry.
kubectl kustomize k8s | sed "s#image: $APP:$TAG#image: $ACR.azurecr.io/$APP:$TAG#" | kubectl apply -f -
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

You need Terraform, the Azure CLI and kubectl installed and to be signed in (\`az login\`). Docker is **not** needed: the image is built inside Azure. From the folder that contains your app and these files:

\`\`\`bash
bash deploy.sh
\`\`\`

It creates the resource group, container registry and cluster (the first run takes about 10 minutes), builds the image in Azure, ${secrets.length ? 'asks for your secret values (hidden), ' : ''}applies the manifests and waits for the rollout. To release a new version run it again (\`IMAGE_TAG=v2 bash deploy.sh\`). To remove everything: \`bash destroy.sh\`.

## What gets created

- A resource group \`rg-${c.appName}\` in \`${a.location}\` with an AKS cluster (Free tier control plane, ${a.minNodes} to ${a.maxNodes} \`${a.nodeSize}\` node${a.maxNodes === 1 ? '' : 's'} with the cluster autoscaler, Azure CNI overlay networking, workload identity and the OIDC issuer on, container insights).
- A container registry (Basic, no admin user). The cluster pulls from it with its kubelet identity, which holds only AcrPull.
- In namespace \`${k.namespace}\`: a Deployment of ${k.autoscaling ? `${k.minReplicas} to ${k.maxReplicas}` : k.replicas} pod${k.replicas === 1 && !k.autoscaling ? '' : 's'} with health probes on \`${c.healthPath}\`, resource limits and zero-downtime rolling updates, a Service (${k.serviceType})${k.ingressHost ? `, an Ingress for \`${k.ingressHost}\` through the managed ingress controller` : ''}${k.autoscaling ? ', a HorizontalPodAutoscaler' : ''}. Pods run as a non-root user with no privilege escalation, all capabilities dropped and no service account token.
${secrets.length ? `- Secrets (${secrets.join(', ')}) are stored in the Kubernetes Secret \`${c.appName}-secrets\`, created by deploy.sh from what you type. Kubernetes Secrets are only base64-encoded unless you turn on encryption with a key you control; for sensitive data consider the Azure Key Vault CSI driver.\n` : ''}
## Look inside

\`\`\`bash
az aks get-credentials --resource-group rg-${c.appName} --name aks-${c.appName}
kubectl -n ${k.namespace} get pods
kubectl -n ${k.namespace} logs deployment/${c.appName} --tail=100 -f
\`\`\`

${k.helm ? `## Using Helm instead

\`\`\`bash
helm upgrade --install ${c.appName} helm/${c.appName} --namespace ${k.namespace} --create-namespace \\
  --set image.repository=<acr_name>.azurecr.io/${c.appName} --set image.tag=${a.imageTag}
\`\`\`

(\`terraform -chdir=aks output acr_name\` gives the registry name.)

` : ''}## Common problems

- **ImagePullBackOff**: the image is not in the registry yet, or the AcrPull assignment has not taken effect (it can take a minute). Run \`bash deploy.sh\` again.
- **"SkuNotAvailable" or a quota error**: the node size is not offered, or your subscription has no quota for it in that region. Change \`node_size\` in \`aks/variables.tf\`, or pick another region.
- **CreateContainerConfigError**: a secret is missing. Create \`${c.appName}-secrets\` with the keys above.
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
    { path: 'aks/outputs.tf', content: outputsTf() },
    { path: 'aks/.gitignore', content: '.terraform/\n*.tfstate\n*.tfstate.*\ncrash.log\n' },
    { path: 'aks/README.md', content: readme(c) },
    ...generateK8sManifestFiles(aksAsK8s(c)),
  ];
}
