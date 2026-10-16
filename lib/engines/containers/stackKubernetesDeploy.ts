/**
 * "Deploy to Kubernetes" for a whole project (Frontend + Backend + API): manifests applied with Kustomize, plus deploy.sh / destroy.sh.
 * Works on any cluster (EKS, AKS, GKE, k3s, kind).
 *
 * It is built from the single-service bundle (kubernetesDeploy.ts), so every service gets the same hardening: a numeric non-root user, no privilege
 * escalation, all capabilities dropped, the runtime's seccomp profile, no service account token, health probes, a rolling update that never drops
 * below the running pods and a PodDisruptionBudget. What a project adds:
 *  - one namespace for everything (the project's name unless you choose another), written once;
 *  - one folder per service under k8s/ (each with its own kustomization), and a top-level kustomization that applies them all;
 *  - each Service is named after its layer (frontend, backend, api) and listens on the container's own port, so the services reach each other at
 *    exactly the addresses docker compose uses (http://api:8000, http://backend:3000): the same images and the same nginx.conf work in both;
 *  - only the public service (the Frontend, else the API, else the Backend) has an Ingress or a LoadBalancer; the others are ClusterIP;
 *  - secrets are one Kubernetes Secret per service (<service>-secrets), created by deploy.sh from values you type, never from a file.
 *
 * A database is not run in the cluster (it needs persistent storage and backups these templates do not set up): use the cloud's managed database
 * and give the Backend and API its address as a secret named DATABASE_URL.
 */
import { withDeployTarget, type ContainerConfig } from './dockerTemplates';
import { defaultK8s, generateK8sManifestFiles, namespaceYaml, validateK8s, type K8sConfig } from './kubernetesDeploy';
import { usesExistingImage } from './existingImageUse';
import { q } from './ec2Deploy';

/** What is asked of the person for a project on Kubernetes. */
export interface StackK8sConfig {
  /** Empty means the project's name. */
  namespace: string;
  /** Where the images are pushed and pulled, for example ghcr.io/acme or myregistry.azurecr.io (lowercase). Each image is <registry>/<project>-<service>:<tag>. */
  registry: string;
  imageTag: string;
  replicas: number;
  serviceType: 'ClusterIP' | 'LoadBalancer';
  ingressHost: string;
  ingressClass: string;
  tlsSecret: string;
}

export const defaultStackK8s = (): StackK8sConfig => ({
  namespace: '', registry: '', imageTag: 'latest', replicas: 2, serviceType: 'ClusterIP', ingressHost: '', ingressClass: 'nginx', tlsSecret: '',
});

/** One service of the project, ready for the single-service generator. */
export interface StackK8sLayer {
  /** Also the Deployment's and the Service's name, and the DNS name the other services use. */
  name: string;
  config: ContainerConfig;
  /** Built from source: its image is pushed by deploy.sh. A service that uses a ready-made image is pulled as it is. */
  built: boolean;
  /** The full image reference the cluster pulls. */
  image: string;
  /** Secret variable names this service reads. */
  secrets: string[];
}

export interface StackK8sSpec {
  project: string;
  namespace: string;
  k8s: StackK8sConfig;
  layers: StackK8sLayer[];
  entry: string;
  /** Every secret of every service, once each. */
  secrets: string[];
}

const REGISTRY = /^[a-z0-9][a-z0-9._-]*(?::[0-9]{1,5})?(?:\/[a-z0-9][a-z0-9._-]*)*$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const namespaceOf = (project: string, k: StackK8sConfig) => (k.namespace === '' ? project : k.namespace);

/** The image a built service is pushed to and pulled from. */
export const imageFor = (project: string, k: StackK8sConfig, layer: string) => `${k.registry}/${project}-${layer}:${k.imageTag}`;

/** A service as the single-service generator sees it: named after its layer, deployed to the project's namespace, public only when it is the entry. */
export function k8sLayerConfig(
  project: string, k: StackK8sConfig, layer: string, base: ContainerConfig, entry: boolean, extraEnv: Array<{ key: string; value: string }>,
  opts: { image?: string; keyVault?: boolean } = {},
): ContainerConfig {
  const built = !usesExistingImage(base);
  const cfg: K8sConfig = {
    ...defaultK8s(),
    enabled: true,
    namespace: namespaceOf(project, k),
    image: built ? (opts.image ?? imageFor(project, k, layer)) : base.image,
    replicas: k.replicas,
    serviceType: entry ? k.serviceType : 'ClusterIP',
    ingressHost: entry ? k.ingressHost : '',
    ingressClass: k.ingressClass,
    tlsSecret: entry ? k.tlsSecret : '',
    helm: false, keyVault: opts.keyVault ?? false, githubActions: false, autoscaling: false,
  };
  return { ...withDeployTarget(base, 'none'), appName: layer, proxy: false, postgres: false, redis: false, mysql: false, mongodb: false, rabbitmq: false, k8s: cfg, env: [...base.env.filter((v) => !extraEnv.some((e) => e.key === v.key)), ...extraEnv.map((e) => ({ ...e }))] };
}

export function validateStackK8s(s: StackK8sSpec): string[] {
  const out: string[] = [];
  const k = s.k8s;
  if (!DNS_LABEL.test(s.namespace)) out.push('Kubernetes: the namespace (the project name unless you set one) may use only lowercase letters, digits and "-" (no "_"), up to 63 characters.');
  if (s.layers.some((l) => l.built) && (k.registry === '' || k.registry.length > 200 || !REGISTRY.test(k.registry))) out.push('Kubernetes: enter the registry the images are pushed to, for example ghcr.io/yourname or myregistry.azurecr.io (lowercase, no tag).');
  for (const l of s.layers) for (const e of validateK8s(l.config)) {
    if (/ingress|TLS secret|namespace/i.test(e) && l.name !== s.entry) continue;     // those settings belong to the public service only
    out.push(`${l.name}: ${e}`);
  }
  return [...new Set(out)];
}

export function stackK8sWarnings(s: StackK8sSpec): string[] {
  const k = s.k8s;
  const w: string[] = [];
  if (k.ingressHost === '' && k.serviceType === 'ClusterIP') w.push(`Kubernetes: the ${s.entry} is reachable only inside the cluster (ClusterIP and no ingress host). Use kubectl port-forward, or set an ingress host or a LoadBalancer service.`);
  if (k.ingressHost !== '' && k.tlsSecret === '') w.push(`Kubernetes: the ingress for the ${s.entry} serves plain HTTP. Add a TLS secret name (for example from cert-manager) to serve HTTPS.`);
  if (k.imageTag === 'latest' && s.layers.some((l) => l.built)) w.push('Kubernetes: the "latest" tag is used. A version tag (for example the commit id) makes it clear what is running and allows a rollback.');
  if (s.layers.some((l) => l.built)) w.push(`Kubernetes: the cluster pulls ${k.registry || 'the registry'}/... : make the images public, or create an image pull secret and add it to each Deployment's service account.`);
  if (s.secrets.length > 0) w.push(`Kubernetes: deploy.sh asks for ${s.secrets.join(', ')} and stores them in one Secret per service (${s.layers.filter((l) => l.secrets.length > 0).map((l) => `${l.name}-secrets`).join(', ')}).`);
  w.push('Kubernetes: no Helm chart is generated for a project, only Kustomize manifests (kubectl apply -k k8s).');
  return w;
}

// ─── files ───────────────────────────────────────────────────────────────────

function topKustomization(namespace: string, layers: StackK8sLayer[]): string {
  const res = [...(namespace !== 'default' ? ['namespace.yaml'] : []), ...layers.map((l) => l.name)];
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
${res.map((r) => `  - ${r}`).join('\n')}
`;
}

/** The manifests of every service: a folder each, the namespace written once, and a top-level kustomization that applies them all. */
export function stackManifestFiles(namespace: string, layers: StackK8sLayer[]): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  if (namespace !== 'default') files.push({ path: 'k8s/namespace.yaml', content: namespaceYaml(layers[0]!.config) });
  files.push({ path: 'k8s/kustomization.yaml', content: topKustomization(namespace, layers) });
  for (const l of layers) {
    for (const f of generateK8sManifestFiles(l.config, { withNamespace: false, servicePort: 'container' })) {
      files.push({ path: f.path.replace(/^k8s\//, `k8s/${l.name}/`), content: f.content });
    }
  }
  return files;
}

export function stackK8sDeploySh(s: StackK8sSpec): string {
  const k = s.k8s;
  const built = s.layers.filter((l) => l.built);
  const addr = k.ingressHost ? `Open ${k.tlsSecret ? 'https' : 'http'}://${k.ingressHost}` : k.serviceType === 'LoadBalancer'
    ? `Find the address with: kubectl -n "$NAMESPACE" get service ${s.entry}`
    : `Try it with: kubectl -n "$NAMESPACE" port-forward service/${s.entry} 8080:${s.layers.find((l) => l.name === s.entry)!.config.port}`;
  return `#!/usr/bin/env bash
# One command to deploy ${s.project} (${s.layers.map((l) => l.name).join(', ')}) to the Kubernetes cluster kubectl is pointed at: bash deploy.sh
#   1. builds each service's image for amd64 and arm64 and pushes it to ${k.registry || 'your registry'} (skip with SKIP_BUILD=1 if the images are already there)
#   2. stores the secret values in the cluster (asks once, hidden), one Secret per service, never in a file
#   3. applies the manifests in k8s/ and waits for every rollout
# Run it again to release a new version (IMAGE_TAG=v2 bash deploy.sh uses another tag). Add --yes to skip the confirmation.
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=${q(s.project)}
NAMESPACE=${q(s.namespace)}
REGISTRY=${q(k.registry)}
TAG="\${IMAGE_TAG:-${k.imageTag}}"
BUILT=(${built.map((l) => q(l.name)).join(' ')})
SECRETS=(${s.secrets.map(q).join(' ')})
LAYERS=(${s.layers.map((l) => q(l.name)).join(' ')})

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing tool: $1. $2"; exit 1; }; }
need kubectl "Install it from https://kubernetes.io/docs/tasks/tools/"
CONTEXT=$(kubectl config current-context 2>/dev/null) || { echo "kubectl is not pointed at a cluster. Set one up first (for example: aws eks update-kubeconfig, az aks get-credentials)."; exit 1; }
kubectl version --request-timeout=10s >/dev/null 2>&1 || { echo "Cannot reach the cluster for context $CONTEXT."; exit 1; }

echo "Cluster: $CONTEXT   Namespace: $NAMESPACE   Images: $REGISTRY/$PROJECT-<service>:$TAG"
if [ "\${1:-}" != "--yes" ]; then
  read -r -p "Deploy $PROJECT here? [y/N] " OK
  [ "$OK" = "y" ] || [ "$OK" = "Y" ] || { echo "Cancelled."; exit 1; }
fi

${built.length > 0 ? `if [ -z "\${SKIP_BUILD:-}" ]; then
  echo "==> 1/3  Build and push the images"
  need docker "Install Docker Desktop from https://www.docker.com/products/docker-desktop"
  docker info >/dev/null 2>&1 || { echo "Docker is not running."; exit 1; }
  # You must already be logged in to the registry (docker login).
  for LAYER in "\${BUILT[@]}"; do
    echo "    $LAYER"
    docker buildx build --platform linux/amd64,linux/arm64 -t "$REGISTRY/$PROJECT-$LAYER:$TAG" --push "./$LAYER"
  done
else
  echo "==> 1/3  Skipped the build (SKIP_BUILD is set)"
fi
` : `echo "==> 1/3  Images"
echo "    Every service uses a ready-made image: nothing to build."
`}
echo "==> 2/3  Namespace and secrets"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
${s.secrets.length > 0 ? `for NAME in "\${SECRETS[@]}"; do
  # A Secret that already exists is kept as it is. Delete it first to change a value: kubectl -n "$NAMESPACE" delete secret <service>-secrets
  NEEDED=""
${s.layers.filter((l) => l.secrets.length > 0).map((l) => `  if [[ " ${l.secrets.join(' ')} " == *" $NAME "* ]] && ! kubectl -n "$NAMESPACE" get secret ${l.name}-secrets >/dev/null 2>&1; then NEEDED=yes; fi`).join('\n')}
  [ -n "$NEEDED" ] || { echo "    $NAME: already stored"; continue; }
  read -r -s -p "    Value for $NAME (hidden): " VALUE; echo
  [ -n "$VALUE" ] || { echo "    $NAME cannot be empty."; exit 1; }
  printf -v "V_$NAME" '%s' "$VALUE"
done
${s.layers.filter((l) => l.secrets.length > 0).map((l) => `if ! kubectl -n "$NAMESPACE" get secret ${l.name}-secrets >/dev/null 2>&1; then
  kubectl -n "$NAMESPACE" create secret generic ${l.name}-secrets ${l.secrets.map((n) => `--from-literal=${n}="$V_${n}"`).join(' ')} >/dev/null
  echo "    ${l.name}-secrets: stored"
fi`).join('\n')}
unset VALUE
` : 'echo "    No secrets are needed."\n'}
echo "==> 3/3  Apply and wait"
kubectl apply -k k8s
${built.length > 0 ? `# Make sure what runs is the tag that was just pushed (the manifests carry ${k.imageTag}).
for LAYER in "\${BUILT[@]}"; do
  kubectl -n "$NAMESPACE" set image deployment/"$LAYER" "$LAYER=$REGISTRY/$PROJECT-$LAYER:$TAG" >/dev/null
done
` : ''}for LAYER in "\${LAYERS[@]}"; do
  kubectl -n "$NAMESPACE" rollout status deployment/"$LAYER" --timeout=300s
done
echo "Done. ${addr}"
`;
}

export function stackK8sDestroySh(s: StackK8sSpec): string {
  return `#!/usr/bin/env bash
# Removes everything deploy.sh applied (every service, its secrets and the namespace): bash destroy.sh
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=${q(s.project)}
NAMESPACE=${q(s.namespace)}

command -v kubectl >/dev/null 2>&1 || { echo "Missing tool: kubectl"; exit 1; }
CONTEXT=$(kubectl config current-context 2>/dev/null) || { echo "kubectl is not pointed at a cluster."; exit 1; }

echo "This deletes $PROJECT from cluster $CONTEXT: every service${s.secrets.length > 0 ? ', its secrets' : ''}${s.namespace !== 'default' ? ` and the namespace $NAMESPACE with everything in it` : ''}."
read -r -p "Type the project name ($PROJECT) to continue: " ANSWER
[ "$ANSWER" = "$PROJECT" ] || { echo "Cancelled."; exit 1; }

kubectl delete -k k8s --ignore-not-found
${s.layers.filter((l) => l.secrets.length > 0).map((l) => `kubectl -n "$NAMESPACE" delete secret ${l.name}-secrets --ignore-not-found`).join('\n')}
echo "Done."
`;
}

function stackK8sReadme(s: StackK8sSpec): string {
  const k = s.k8s;
  const entry = s.layers.find((l) => l.name === s.entry)!;
  return `# Deploy ${s.project} to Kubernetes

Every service of this project runs as its own Deployment in the namespace \`${s.namespace}\`, applied with Kustomize. It works on any cluster (EKS, AKS, GKE, k3s, kind).

## Quick start

You need \`kubectl\` pointed at your cluster${s.layers.some((l) => l.built) ? `, Docker, and to be logged in to the registry (\`docker login ${k.registry.split('/')[0] || 'your-registry'}\`)` : ''}. From the project folder (the one with \`deploy.sh\`):

\`\`\`bash
bash deploy.sh
\`\`\`

${s.layers.some((l) => l.built) ? `It builds and pushes each image, ` : ''}${s.secrets.length ? 'asks for the secret values (hidden) and stores them in the cluster, ' : ''}applies \`k8s/\` and waits for every rollout. To release a new version run it again (\`IMAGE_TAG=v2 bash deploy.sh\`). To remove everything: \`bash destroy.sh\`.

## What gets created

| Service | Image | Reachable |
|---|---|---|
${s.layers.map((l) => `| \`${l.name}\` | \`${l.image}\` | ${l.name === s.entry ? (k.ingressHost ? `from outside through the Ingress \`${k.ingressHost}\`` : k.serviceType === 'LoadBalancer' ? 'from outside through a LoadBalancer' : 'inside the cluster only (use port-forward)') : 'inside the cluster only'} |`).join('\n')}

- Each service is a Deployment (${k.replicas} replicas, rolling update that never drops below the running pods), a Service named \`${'<service>'}\` on the container's own port, and a PodDisruptionBudget.
- The services reach each other by name, exactly as in docker compose: ${s.layers.filter((l) => l.name !== s.entry || s.layers.length > 1).map((l) => `\`http://${l.name}:${l.config.port}\``).join(', ')}.
- Pods are hardened: non-root, no privilege escalation, all capabilities dropped, seccomp, no service account token.
${s.secrets.length ? `- Secrets (${s.secrets.join(', ')}) are Kubernetes Secrets, one per service (${s.layers.filter((l) => l.secrets.length > 0).map((l) => `\`${l.name}-secrets\``).join(', ')}), created by \`deploy.sh\` from values you type. They are never in a file.\n` : ''}
## Look inside

\`\`\`bash
kubectl -n ${s.namespace} get pods
kubectl -n ${s.namespace} logs deployment/${entry.name}
kubectl -n ${s.namespace} port-forward service/${entry.name} 8080:${entry.config.port}
\`\`\`

## Common problems

- **ImagePullBackOff**: the cluster cannot pull the images. Make them public, or create an image pull secret and add it to each service's account.
- **CreateContainerConfigError**: a secret is missing. Create \`<service>-secrets\` with the keys \`deploy.sh\` lists.
- **Pods restart in a loop**: read the logs. Each service's health check path must answer on its port.
- **"exec format error"**: an image was built for another CPU type. \`deploy.sh\` builds for amd64 and arm64.

## What to know

- A database is not run in the cluster. Use your cloud's managed database and give the Backend and API its address as a secret named \`DATABASE_URL\`.
- There is no Helm chart for a project, only the Kustomize manifests.
`;
}

export function generateStackK8sFiles(s: StackK8sSpec): Array<{ path: string; content: string; executable?: boolean }> {
  return [
    { path: 'deploy.sh', content: stackK8sDeploySh(s), executable: true },
    { path: 'destroy.sh', content: stackK8sDestroySh(s), executable: true },
    ...stackManifestFiles(s.namespace, s.layers),
    { path: 'k8s/README.md', content: stackK8sReadme(s) },
  ];
}

