/**
 * "Deploy to Azure Kubernetes Service (AKS)" for a whole project (Frontend, Backend, API): Terraform for a resource group, one container
 * registry, a Log Analytics workspace, an AKS cluster and (when a service has secrets) a Key Vault, plus the project's Kubernetes manifests and
 * deploy.sh / destroy.sh that build every image inside Azure, connect kubectl and roll everything out.
 *
 * The AKS counterpart of stackKubernetesDeploy.ts, built the way a single service's AKS bundle (aksDeploy.ts) is:
 *  - the manifests are the project's Kustomize manifests (a folder per service, one namespace, the same service addresses as docker compose);
 *  - the cluster pulls images with its kubelet identity, which holds only AcrPull on the registry: no registry password, no pull secret;
 *  - secrets live in Key Vault and reach the pods through the Secrets Store CSI driver and workload identity: one managed identity that can only
 *    read the vault, and a federated credential for each service's own service account (so only those pods can act as it). They never pass
 *    through kubectl, a file or Terraform's state;
 *  - deploy.sh fills the registry and the vault into the manifests when it applies them.
 * A database is not run in the cluster: use Azure Database for PostgreSQL/MySQL and give the Backend and API its address as a secret DATABASE_URL.
 */
import { withDeployTarget } from './dockerTemplates';
import { defaultAks, estimateAksCost, validateAks, type AksConfig } from './aksDeploy';
import { defaultStackK8s, k8sLayerConfig, stackManifestFiles, type StackK8sConfig, type StackK8sLayer } from './stackKubernetesDeploy';
import { KV_TOKENS, validateK8s } from './kubernetesDeploy';
import { vaultSecretName } from './azureVmDeploy';
import { q, type DeployCost } from './ec2Deploy';
import { defaultConfig } from './dockerTemplates';

/** What is asked of the person for a project on AKS: the cluster, and how the services are exposed. */
export interface StackAksConfig {
  location: string;
  nodeSize: string;
  minNodes: number;
  maxNodes: number;
  imageTag: string;
  /** Empty means the project's name. */
  namespace: string;
  replicas: number;
  serviceType: 'ClusterIP' | 'LoadBalancer';
  ingressHost: string;
  tlsSecret: string;
}

export const defaultStackAks = (): StackAksConfig => ({
  location: 'westeurope', nodeSize: 'Standard_B2s', minNodes: 2, maxNodes: 4, imageTag: 'latest', namespace: '', replicas: 2, serviceType: 'ClusterIP', ingressHost: '', tlsSecret: '',
});

/** AKS's managed ingress controller (application routing) has its own class. */
export const AKS_INGRESS_CLASS = 'webapprouting.kubernetes.azure.com';

export interface StackAksSpec {
  project: string;
  namespace: string;
  aks: StackAksConfig;
  layers: StackK8sLayer[];
  entry: string;
  /** Every secret of every service, once each. */
  secrets: string[];
}

/** The part of the settings the Kubernetes generator reads, so the project's layers are built like any other project's. */
export const asStackK8s = (a: StackAksConfig): StackK8sConfig => ({
  ...defaultStackK8s(), namespace: a.namespace, replicas: a.replicas, serviceType: a.serviceType, ingressHost: a.ingressHost, tlsSecret: a.tlsSecret, imageTag: a.imageTag, ingressClass: AKS_INGRESS_CLASS,
});

/** The image name a built service has in the manifests: deploy.sh puts the registry in front of it when it applies them. */
export const aksImage = (project: string, layer: string, tag: string) => `${project}-${layer}:${tag}`;

/** A service as the Kubernetes generator sees it, with its secrets coming from Key Vault. */
export function aksLayerConfig(project: string, a: StackAksConfig, layer: string, base: Parameters<typeof k8sLayerConfig>[3], entry: boolean, extraEnv: Array<{ key: string; value: string }>) {
  const keyVault = base.env.some((v) => v.secret);
  return k8sLayerConfig(project, asStackK8s(a), layer, base, entry, extraEnv, { image: aksImage(project, layer, a.imageTag), keyVault });
}

export const aksNamespace = (project: string, a: StackAksConfig) => (a.namespace === '' ? project : a.namespace);

/** The settings checked as a single service's AKS bundle is (cluster name, location, node size, node counts, tag). */
function asSingle(s: StackAksSpec) {
  return { ...withDeployTarget(defaultConfig('node'), 'none'), appName: s.project, aks: { ...defaultAks(), enabled: true, location: s.aks.location, nodeSize: s.aks.nodeSize, minNodes: s.aks.minNodes, maxNodes: s.aks.maxNodes, imageTag: s.aks.imageTag } as AksConfig };
}

export function validateStackAks(s: StackAksSpec): string[] {
  const out: string[] = [];
  // The project's name, location, node size and counts and image tag are checked by the single-service rules; its own Kubernetes checks are redone per service below.
  out.push(...validateAks({ ...asSingle(s), k8s: { ...asSingle(s).k8s, namespace: s.namespace } }).filter((e) => !/^Kubernetes:/.test(e)));
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s.namespace)) out.push('Kubernetes: the namespace (the project name unless you set one) may use only lowercase letters, digits and "-" (no "_"), up to 63 characters.');
  for (const l of s.layers) for (const e of validateK8s(l.config)) {
    if (/ingress|TLS secret/i.test(e) && l.name !== s.entry) continue;     // those settings belong to the public service only
    out.push(`${l.name}: ${e}`);
  }
  return [...new Set(out)];
}

export function stackAksWarnings(s: StackAksSpec): string[] {
  const a = s.aks;
  const w: string[] = [];
  if (a.imageTag === 'latest' && s.layers.some((l) => l.built)) w.push('AKS: the "latest" tag is used. A version tag (for example the commit id) makes it clear what is running and allows a rollback.');
  if (a.ingressHost === '' && a.serviceType === 'ClusterIP') w.push(`AKS: the ${s.entry} is reachable only inside the cluster (ClusterIP and no ingress host). Use kubectl port-forward, or set an ingress host or a LoadBalancer service.`);
  if (a.ingressHost !== '') w.push('AKS: deploy.sh turns on the managed ingress controller (application routing). Point your DNS name at its public IP.');
  if (a.ingressHost !== '' && a.tlsSecret === '') w.push(`AKS: the ingress for the ${s.entry} serves plain HTTP. Add a TLS secret name to serve HTTPS.`);
  if (s.secrets.length > 0) w.push('AKS: deploy.sh stores each secret in Key Vault (asks once, hidden). The pods read them through the Key Vault CSI driver and workload identity. After you change a secret, restart the deployments (kubectl rollout restart) so the pods pick up the new value. One identity reads the whole vault, so every service that has a secret could read every secret in it.');
  w.push('AKS: no Helm chart is generated for a project, only Kustomize manifests.');
  return w;
}

export function estimateStackAksCost(s: StackAksSpec): DeployCost {
  const c = estimateAksCost(asSingle(s))!;
  const lines = s.layers.some((l) => l.built) ? c.lines : c.lines.filter((l) => !l.label.startsWith('Container Registry'));
  return { ...c, monthlyUsd: Math.round(lines.reduce((t, l) => t + l.monthlyUsd, 0) * 100) / 100, lines };
}

// ─── Terraform ───────────────────────────────────────────────────────────────

const hcl = (s: string) => JSON.stringify(s).replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');

function mainTf(s: StackAksSpec): string {
  const kv = s.secrets.length > 0;
  const repos = s.layers.some((l) => l.built);
  const withSecrets = s.layers.filter((l) => l.secrets.length > 0).map((l) => `"${l.name}"`);
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
    ManagedBy = "CloudBuilder"
    App       = var.app_name
  }
  slug     = replace(replace(var.app_name, "-", ""), "_", "")
  suffix   = substr(md5("$\{data.azurerm_client_config.current.subscription_id}$\{var.app_name}"), 0, 6)
${repos ? `  acr_name = substr("acr$\{local.slug}$\{local.suffix}", 0, 50)` : ''}${kv ? `
  vault_name = "kv$\{substr(local.slug, 0, 12)}$\{local.suffix}"
  # The services that read secrets: each one's own service account may act as the vault-reading identity.
  secret_services = [${withSecrets.join(', ')}]` : ''}
}

resource "azurerm_resource_group" "app" {
  name     = "rg-$\{var.app_name}"
  location = var.location
  tags     = local.tags
}

${repos ? `# One registry for every service (a repository each). No admin user: the cluster pulls with its kubelet identity, which can only read images.
resource "azurerm_container_registry" "app" {
  name                = local.acr_name
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

` : ''}resource "azurerm_log_analytics_workspace" "app" {
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
  # Azure turns this on by default; saying so keeps it on, and visible.
  role_based_access_control_enabled = true
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
    # Enforces Kubernetes NetworkPolicy objects between pods (without an engine they are ignored). Azure network policy works with Azure CNI Overlay.
    network_policy      = "azure"
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

${repos ? `resource "azurerm_role_assignment" "pull" {
  scope                            = azurerm_container_registry.app.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_kubernetes_cluster.app.kubelet_identity[0].object_id
  skip_service_principal_aad_check = true
}
` : ''}${kv ? `
# ── Secrets: Key Vault, read by the services' own identity (workload identity) ──

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

# Only the pods that run as one of these service accounts in this namespace can act as the identity.
resource "azurerm_federated_identity_credential" "workload" {
  for_each            = toset(local.secret_services)
  name                = "$\{var.app_name}-$\{each.key}"
  resource_group_name = azurerm_resource_group.app.name
  parent_id           = azurerm_user_assigned_identity.workload.id
  issuer              = azurerm_kubernetes_cluster.app.oidc_issuer_url
  subject             = "system:serviceaccount:$\{var.k8s_namespace}:$\{each.key}"
  audience            = ["api://AzureADTokenExchange"]
}
` : ''}`;
}

function variablesTf(s: StackAksSpec): string {
  const a = s.aks;
  return `variable "location" {
  description = "Azure region to deploy to."
  type        = string
  default     = ${hcl(a.location)}
}

variable "app_name" {
  description = "Name used for the resource group, cluster and registry."
  type        = string
  default     = ${hcl(s.project)}
}

${s.secrets.length ? `variable "k8s_namespace" {
  description = "Namespace the services run in (the identity is bound to their service accounts there)."
  type        = string
  default     = ${hcl(s.namespace)}
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

function outputsTf(s: StackAksSpec): string {
  return `${s.layers.some((l) => l.built) ? `output "acr_name" {
  description = "The container registry that holds the images."
  value       = azurerm_container_registry.app.name
}

` : ''}output "resource_group" {
  value = azurerm_resource_group.app.name
}

output "cluster_name" {
  value = azurerm_kubernetes_cluster.app.name
}

${s.secrets.length ? `output "vault_name" {
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

export function stackAksDeploySh(s: StackAksSpec): string {
  const a = s.aks;
  const built = s.layers.filter((l) => l.built);
  const kv = s.secrets.length > 0;
  const total = 2 + (kv ? 1 : 0) + (built.length > 0 ? 1 : 0);
  const secretsStep = 2;
  const buildStep = kv ? 3 : 2;
  const sed = [
    ...built.map((l) => `-e "s#image: $APP-${l.name}:${a.imageTag}#image: $ACR.azurecr.io/$APP-${l.name}:$TAG#"`),
    ...(kv ? [`-e "s#${KV_TOKENS.vaultName}#$VAULT#g"`, `-e "s#${KV_TOKENS.tenantId}#$TENANT#g"`, `-e "s#${KV_TOKENS.clientId}#$CLIENT_ID#g"`] : []),
  ];
  const entry = s.layers.find((l) => l.name === s.entry)!;
  const addr = a.ingressHost ? `Point ${a.ingressHost} at the ingress address: kubectl -n app-routing-system get service nginx`
    : a.serviceType === 'LoadBalancer' ? `Find the address with: kubectl -n "$NAMESPACE" get service ${s.entry}`
      : `Try it with: kubectl -n "$NAMESPACE" port-forward service/${s.entry} 8080:${entry.config.port}`;
  return `#!/usr/bin/env bash
# One command to deploy ${s.project} (${s.layers.map((l) => l.name).join(', ')}) to Azure Kubernetes Service: bash deploy.sh
#   1. creates the resource group, ${built.length > 0 ? 'container registry, ' : ''}AKS cluster${kv ? ' and Key Vault' : ''} with Terraform (first run: about 10 minutes), asking you to confirm
${kv ? '#   2. stores the secret values in Key Vault (asks once, hidden), never in a file, in Terraform\'s state or in the cluster\'s command line\n' : ''}${built.length > 0 ? `#   ${buildStep}. builds each service's image inside Azure (az acr build), so Docker is not needed on this machine\n` : ''}#   ${total}. connects kubectl, applies the manifests and waits for every rollout
# Run it again to release a new version (IMAGE_TAG=v2 bash deploy.sh uses another tag). Add --yes to skip the Terraform confirmation.
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(s.project)}
NAMESPACE=${q(s.namespace)}
TAG="\${IMAGE_TAG:-${a.imageTag}}"
SECRETS=(${s.secrets.map(q).join(' ')})
BUILT=(${built.map((l) => q(l.name)).join(' ')})
LAYERS=(${s.layers.map((l) => q(l.name)).join(' ')})
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
${kv ? 'az provider register --namespace Microsoft.KeyVault --wait >/dev/null\n' : ''}
echo "==> 1/${total}  ${built.length > 0 ? 'Registry and ' : ''}AKS cluster${kv ? ' and Key Vault' : ''} (Terraform)"
terraform -chdir=aks init -input=false >/dev/null
terraform -chdir=aks apply \${APPROVE:+-auto-approve}
${built.length > 0 ? `ACR=$(terraform -chdir=aks output -raw acr_name)
` : ''}RG=$(terraform -chdir=aks output -raw resource_group)
CLUSTER=$(terraform -chdir=aks output -raw cluster_name)
${kv ? `VAULT=$(terraform -chdir=aks output -raw vault_name)
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
${built.length > 0 ? `echo "==> ${buildStep}/${total}  Build the images in Azure"
for LAYER in "\${BUILT[@]}"; do
  echo "    $LAYER"
  az acr build --registry "$ACR" --image "$APP-$LAYER:$TAG" --platform linux/amd64 "./$LAYER"
done

` : ''}echo "==> ${total}/${total}  Deploy to the cluster"
# A private kubeconfig for this run: your own kubectl contexts are left alone.
export KUBECONFIG="$(mktemp)"
trap 'rm -f "$KUBECONFIG"' EXIT
az aks get-credentials --resource-group "$RG" --name "$CLUSTER" --file "$KUBECONFIG" --overwrite-existing >/dev/null

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
${a.ingressHost ? `
# The managed ingress controller (application routing), once.
az aks approuting enable --resource-group "$RG" --name "$CLUSTER" >/dev/null 2>&1 || true
` : ''}
# The manifests name each image "${s.project}-<service>:<tag>"${kv ? ' and carry placeholders for the vault, tenant and identity' : ''}; fill them in and apply.
${sed.length > 0 ? `kubectl kustomize k8s | sed ${sed.join(' \\\n  ')} | kubectl apply -f -` : 'kubectl apply -k k8s'}
for LAYER in "\${LAYERS[@]}"; do
  kubectl -n "$NAMESPACE" rollout status deployment/"$LAYER" --timeout=300s
done
echo "Done. ${addr}"
`;
}

export function stackAksDestroySh(s: StackAksSpec): string {
  return `#!/usr/bin/env bash
# Removes everything deploy.sh created (the whole resource group: cluster, registry with its images, logs${s.secrets.length > 0 ? ', Key Vault' : ''}): bash destroy.sh
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(s.project)}

command -v terraform >/dev/null 2>&1 || { echo "Missing tool: terraform"; exit 1; }
command -v az >/dev/null 2>&1 || { echo "Missing tool: az"; exit 1; }
az account show >/dev/null 2>&1 || { echo "You are not signed in to Azure. Run: az login"; exit 1; }

echo "This permanently deletes the resource group rg-$APP, the cluster and everything running in it${s.secrets.length > 0 ? ', and the secrets in its Key Vault' : ''}."
read -r -p "Type the project name ($APP) to continue: " ANSWER
[ "$ANSWER" = "$APP" ] || { echo "Cancelled."; exit 1; }

terraform -chdir=aks init -input=false >/dev/null
terraform -chdir=aks destroy -auto-approve
echo "Done."
`;
}

function stackAksReadme(s: StackAksSpec): string {
  const a = s.aks;
  const entry = s.layers.find((l) => l.name === s.entry)!;
  return `# Deploy ${s.project} to Azure Kubernetes Service (AKS)

Every service of this project runs as its own Deployment in the namespace \`${s.namespace}\` of one AKS cluster.

## Quick start

You need Terraform, the Azure CLI and kubectl installed and to be signed in (\`az login\`). Docker is **not** needed${s.layers.some((l) => l.built) ? ': the images are built inside Azure' : ''}. From the project folder (the one with \`deploy.sh\`):

\`\`\`bash
bash deploy.sh
\`\`\`

It creates the resource group, ${s.layers.some((l) => l.built) ? 'a container registry, ' : ''}the cluster${s.secrets.length ? ' and a Key Vault' : ''} (the first run takes about 10 minutes), ${s.secrets.length ? 'asks for the secret values (hidden), ' : ''}${s.layers.some((l) => l.built) ? 'builds each image in Azure, ' : ''}applies the manifests and waits for every rollout. To release a new version run it again (\`IMAGE_TAG=v2 bash deploy.sh\`). To remove everything: \`bash destroy.sh\`.

## What gets created

- A resource group \`rg-${s.project}\` in \`${a.location}\` with an AKS cluster (Free tier control plane, ${a.minNodes} to ${a.maxNodes} \`${a.nodeSize}\` nodes with the cluster autoscaler, Azure CNI overlay networking, workload identity and the OIDC issuer on, container insights).
${s.layers.some((l) => l.built) ? '- A container registry (Basic, no admin user). The cluster pulls from it with its kubelet identity, which holds only AcrPull.\n' : ''}- In \`${s.namespace}\`: a Deployment (${a.replicas} pods, health probes, resource limits, zero-downtime rolling updates), a Service and a PodDisruptionBudget for each of ${s.layers.map((l) => `\`${l.name}\``).join(', ')}. Pods run as a non-root user with no privilege escalation, all capabilities dropped and no service account token.
- The services reach each other by name, exactly as in docker compose: ${s.layers.map((l) => `\`http://${l.name}:${l.config.port}\``).join(', ')}.
- Only the ${s.entry} is reachable from outside${a.ingressHost ? `, through the Ingress \`${a.ingressHost}\` and AKS's managed ingress controller` : a.serviceType === 'LoadBalancer' ? ', through a LoadBalancer' : ' (use port-forward; set an ingress host or a LoadBalancer to open it)'}.
${s.secrets.length ? `- Secrets (${s.secrets.join(', ')}) are stored in Key Vault (as ${s.secrets.map((k) => `\`${vaultSecretName(k)}\``).join(', ')}) by deploy.sh. The pods read them through the Key Vault CSI driver and workload identity: one managed identity that can only read this vault, tied by a federated credential to the service account of each service that has a secret (${s.layers.filter((l) => l.secrets.length > 0).map((l) => `\`${l.name}\``).join(', ')}). The Secret \`<service>-secrets\` each service reads is synced from the vault while its pods run. Values never pass through kubectl, a file or Terraform's state. After you change a secret in the vault, run \`kubectl -n ${s.namespace} rollout restart deployment/<service>\`.\n` : ''}
## Look inside

\`\`\`bash
az aks get-credentials --resource-group rg-${s.project} --name aks-${s.project}
kubectl -n ${s.namespace} get pods
kubectl -n ${s.namespace} logs deployment/${entry.name} --tail=100 -f
\`\`\`

## Common problems

- **ImagePullBackOff**: the image is not in the registry yet, or the AcrPull assignment has not taken effect (it can take a minute). Run \`bash deploy.sh\` again.
- **"SkuNotAvailable" or a quota error**: the node size is not offered, or your subscription has no quota for it in that region. Change \`node_size\` in \`aks/variables.tf\`, or pick another region.
- **CreateContainerConfigError** or pods stuck in ContainerCreating: a secret is missing from the vault, or the identity cannot read it yet (a new role assignment can take a few minutes). Run \`kubectl -n ${s.namespace} describe pod\` and read the events.
- **Pods restart in a loop**: read the logs. Each service's health check path must answer on its port.

## What to know

- A database is not run in the cluster. Use Azure Database for PostgreSQL or MySQL and give the Backend and API its address as a secret named \`DATABASE_URL\`.
- There is no Helm chart for a project, only the Kustomize manifests.
- Terraform keeps its record in \`aks/terraform.tfstate\`. Keep that folder; \`bash destroy.sh\` needs it.
- Costs: the nodes, the cluster's load balancer and outbound IP, and the registry bill all the time; the control plane is free.
`;
}

export function generateStackAksFiles(s: StackAksSpec): Array<{ path: string; content: string; executable?: boolean }> {
  return [
    { path: 'deploy.sh', content: stackAksDeploySh(s), executable: true },
    { path: 'destroy.sh', content: stackAksDestroySh(s), executable: true },
    { path: 'aks/main.tf', content: mainTf(s) },
    { path: 'aks/variables.tf', content: variablesTf(s) },
    { path: 'aks/outputs.tf', content: outputsTf(s) },
    { path: 'aks/.gitignore', content: '.terraform/\n*.tfstate\n*.tfstate.*\ncrash.log\n' },
    { path: 'aks/README.md', content: stackAksReadme(s) },
    ...stackManifestFiles(s.namespace, s.layers),
  ];
}
