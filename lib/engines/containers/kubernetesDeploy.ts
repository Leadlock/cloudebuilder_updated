/**
 * Optional "deploy to Kubernetes" bundle for a container template: plain manifests applied with Kustomize (k8s/), an optional Helm chart
 * (helm/<app>/), and deploy.sh / destroy.sh that build and push the image, store secrets in the cluster and wait for the rollout.
 *
 * Works on any cluster (EKS, AKS, GKE, k3s, kind). Hardened by default: pods run as a numeric non-root user with no privilege escalation,
 * all Linux capabilities dropped and the runtime's default seccomp profile, no service account token is mounted, secrets come from a
 * Kubernetes Secret created by deploy.sh (never from a file), and a PodDisruptionBudget keeps one replica up during node maintenance.
 */
import { yq } from './shared';
import { companionServices } from './companions';
import type { ContainerConfig, ContainerStack } from './dockerTemplates';
import { usesExistingImage } from './existingImageUse';
import { q, secretNames } from './ec2Deploy';

export interface K8sConfig {
  enabled: boolean;
  namespace: string;
  /** Full image reference the cluster pulls, for example ghcr.io/you/app:1.0. */
  image: string;
  replicas: number;
  serviceType: 'ClusterIP' | 'LoadBalancer';
  /** Host name for an Ingress. Empty means no Ingress. */
  ingressHost: string;
  ingressClass: string;
  /** Name of a TLS Secret (for example one cert-manager fills). Empty means the Ingress is plain HTTP. */
  tlsSecret: string;
  autoscaling: boolean;
  minReplicas: number;
  maxReplicas: number;
  /** Also generate a Helm chart. */
  helm: boolean;
  /**
   * Read secrets from Azure Key Vault through the Secrets Store CSI driver and workload identity (set by the AKS target when the app has secrets):
   * the values never pass through kubectl or a file, and the Kubernetes Secret the app reads is synced from the vault.
   */
  keyVault: boolean;
  /** Also generate a GitHub Actions workflow that builds, scans and pushes the image (GitHub Container Registry images only). */
  githubActions: boolean;
  scanImage: boolean;
}

export const defaultK8s = (): K8sConfig => ({
  enabled: false, namespace: 'default', image: '', replicas: 2, serviceType: 'ClusterIP', ingressHost: '', ingressClass: 'nginx', tlsSecret: '',
  autoscaling: false, minReplicas: 2, maxReplicas: 6, helm: true, keyVault: false, githubActions: false, scanImage: true,
});

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IMAGE = /^[a-z0-9][a-z0-9._-]*(?::[0-9]{1,5})?(?:\/[a-z0-9][a-z0-9._-]*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

/** A ready-made image chosen in the form is the image the cluster pulls. */
const withImage = (c: ContainerConfig): ContainerConfig => (usesExistingImage(c) ? { ...c, k8s: { ...c.k8s, image: c.image } } : c);

export function validateK8s(c0: ContainerConfig): string[] {
  const c = withImage(c0);
  const k = c.k8s;
  if (!k.enabled) return [];
  const out: string[] = [];
  if (!DNS_LABEL.test(c.appName)) out.push('Kubernetes: the app name becomes the name of the Deployment, so it may use only lowercase letters, digits and "-" (no "_"), up to 63 characters.');
  if (!DNS_LABEL.test(k.namespace)) out.push('Kubernetes: namespace may use only lowercase letters, digits and "-".');
  if (k.image === '' || k.image.length > 255 || !IMAGE.test(k.image)) out.push('Kubernetes: enter the image the cluster should pull, for example ghcr.io/yourname/yourapp:1.0 (lowercase).');
  if (!Number.isInteger(k.replicas) || k.replicas < 1 || k.replicas > 50) out.push('Kubernetes: replicas must be 1 to 50.');
  if (!['ClusterIP', 'LoadBalancer'].includes(k.serviceType)) out.push('Kubernetes: choose a service type.');
  if (k.ingressHost !== '' && !DNS_NAME.test(k.ingressHost)) out.push('Kubernetes: the ingress host looks like app.example.com.');
  if (k.ingressClass !== '' && !DNS_SUBDOMAIN.test(k.ingressClass)) out.push('Kubernetes: ingress class may use only lowercase letters, digits, "." and "-".');
  if (k.tlsSecret !== '' && !DNS_LABEL.test(k.tlsSecret)) out.push('Kubernetes: the TLS secret name may use only lowercase letters, digits and "-".');
  if (k.tlsSecret !== '' && k.ingressHost === '') out.push('Kubernetes: a TLS secret needs an ingress host.');
  if (k.autoscaling && (!Number.isInteger(k.minReplicas) || !Number.isInteger(k.maxReplicas) || k.minReplicas < 1 || k.maxReplicas < k.minReplicas || k.maxReplicas > 200)) {
    out.push('Kubernetes: autoscaling needs a minimum of at least 1 and a maximum that is not below it (up to 200).');
  }
  return out;
}

export function k8sWarnings(c0: ContainerConfig): string[] {
  const c = withImage(c0);
  const k = c.k8s;
  if (!k.enabled) return [];
  const w: string[] = [];
  if (k.ingressHost === '' && k.serviceType === 'ClusterIP') w.push('Kubernetes: the app is reachable only inside the cluster (ClusterIP and no ingress host). Use `kubectl port-forward`, or set an ingress host or a LoadBalancer service.');
  if (k.ingressHost !== '' && k.tlsSecret === '') w.push('Kubernetes: the ingress serves plain HTTP. Add a TLS secret name (for example from cert-manager) to serve HTTPS.');
  if (/(:latest|^[^:@]+)$/.test(k.image.split('/').pop() ?? '')) w.push('Kubernetes: the image has no version tag or uses :latest. A version tag makes it clear what is running and allows a rollback.');
  if (companionServices(c).length > 0) w.push('Kubernetes: PostgreSQL and Redis are not deployed. Use your cloud\'s managed services (or a Helm chart for them) and put the connection settings in the environment variables.');
  if (usesExistingImage(c) && ROOT_IMAGE.test(c.image)) {
    w.push(c.runAsNonRoot
      ? `Kubernetes: ${c.image} starts as root and listens on port 80, so Kubernetes will refuse to start it while "Run as non-root" is on. Use the unprivileged build (for example nginxinc/nginx-unprivileged:1.27 on port 8080), or turn "Run as non-root" off: the pod then keeps all other restrictions and only gets the four permissions this image needs (${ROOT_IMAGE_CAPS.join(', ')}).`
      : `Kubernetes: ${c.image} runs as root with the four permissions it needs (${ROOT_IMAGE_CAPS.join(', ')}) and nothing else. For a fully non-root pod use the unprivileged build (for example nginxinc/nginx-unprivileged:1.27 on port 8080).`);
  }
  if (c.env.some((v) => v.secret)) w.push(`Kubernetes: deploy.sh asks for each secret and stores it in a Secret named ${c.appName}-secrets in the cluster.`);
  return w;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** True when secrets come from Key Vault (the AKS target) rather than from a Secret the deploy script creates. */
const usesKeyVault = (c: ContainerConfig) => c.k8s.keyVault && secretNames(c).length > 0;
/** Key Vault secret names allow letters, digits and "-" only. */
export const kvName = (key: string) => key.replace(/_/g, '-');
/** Tokens in the Key Vault manifests that deploy.sh (or helm --set) fills in once Terraform has created the vault and the identity. */
export const KV_TOKENS = { clientId: '__WORKLOAD_CLIENT_ID__', tenantId: '__TENANT_ID__', vaultName: '__VAULT_NAME__' } as const;

/** Docker "512m" / "2g" -> Kubernetes "512Mi" / "2Gi". */
export function k8sMemory(v: string): string { const m = /^(\d+)([mMgG])$/.exec(v); return m ? `${m[1]}${m[2]!.toLowerCase() === 'g' ? 'Gi' : 'Mi'}` : v; }
const halfMemory = (v: string) => { const m = /^(\d+)([mMgG])$/.exec(v); if (!m) return k8sMemory(v); const mb = Number(m[1]) * (m[2]!.toLowerCase() === 'g' ? 1024 : 1); return `${Math.max(64, Math.floor(mb / 2))}Mi`; };
const cpuQty = (v: string) => { const n = Number(v); return Number.isInteger(n) ? String(n) : `${Math.round(n * 1000)}m`; };
const halfCpu = (v: string) => `${Math.max(50, Math.round((Number(v) * 1000) / 2))}m`;
/** The numeric user the generated Dockerfile (or nginx-unprivileged) runs as. */
const runAsUser = (stack: ContainerStack) => (stack === 'static' ? 101 : 1001);
/**
 * A ready-made image decides its own user, so none is forced on it (a forced one breaks images that need to write to files owned by their
 * own user, such as the official nginx). "Run as non-root" then only makes Kubernetes refuse an image that would run as root.
 */
const userId = (c: ContainerConfig): number | null => (usesExistingImage(c) ? null : runAsUser(c.stack));
const nonRoot = (c: ContainerConfig): boolean => (usesExistingImage(c) ? c.runAsNonRoot : c.runAsNonRoot || c.stack === 'static');
/** Official images that start as root and listen on a privileged port: they cannot run under the hardened settings as they are. */
const ROOT_IMAGE = /^(?:docker\.io\/)?(?:library\/)?(nginx|httpd)(?::|@|$)/;
/** What a root-running image needs after "drop all": start the server, switch to its own user, own its cache files, listen on port 80. */
const ROOT_IMAGE_CAPS = ['CHOWN', 'SETGID', 'SETUID', 'NET_BIND_SERVICE'] as const;

/** "ghcr.io/a/b:1.2" -> repository and tag (a registry port is not a tag). */
export function splitImage(image: string): { repository: string; tag: string } {
  const at = image.indexOf('@');
  if (at !== -1) return { repository: image.slice(0, at), tag: image.slice(at + 1) };
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  return colon > slash ? { repository: image.slice(0, colon), tag: image.slice(colon + 1) } : { repository: image, tag: 'latest' };
}

const labels = (c: ContainerConfig, indent: number) => ['app.kubernetes.io/name: ' + c.appName, 'app.kubernetes.io/managed-by: cloudcraft'].map((l) => ' '.repeat(indent) + l).join('\n');
const selector = (c: ContainerConfig, indent: number) => ' '.repeat(indent) + 'app.kubernetes.io/name: ' + c.appName;

function containerBlock(c: ContainerConfig, image: string, indent: number, helm: boolean): string {
  const plain = c.env.filter((v) => !v.secret);
  const secrets = secretNames(c);
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  lines.push(`- name: ${c.appName}`);
  lines.push(`  image: ${image}`);
  lines.push('  imagePullPolicy: IfNotPresent');
  lines.push('  ports:');
  lines.push(`    - name: http`);
  lines.push(`      containerPort: ${helm ? '{{ .Values.port }}' : c.port}`);
  if (plain.length > 0 || secrets.length > 0) {
    lines.push('  env:');
    if (helm) {
      lines.push('    {{- range $name, $value := .Values.env }}');
      lines.push('    - name: {{ $name }}');
      lines.push('      value: {{ $value | quote }}');
      lines.push('    {{- end }}');
      lines.push('    {{- range .Values.secretNames }}');
      lines.push('    - name: {{ . }}');
      lines.push('      valueFrom:');
      lines.push('        secretKeyRef:');
      lines.push('          name: {{ $.Values.secretName }}');
      lines.push('          key: {{ . }}');
      lines.push('    {{- end }}');
    } else {
      for (const v of plain) { lines.push(`    - name: ${v.key}`); lines.push(`      value: ${yq(v.value)}`); }
      for (const k of secrets) {
        lines.push(`    - name: ${k}`); lines.push('      valueFrom:'); lines.push('        secretKeyRef:');
        lines.push(`          name: ${c.appName}-secrets`); lines.push(`          key: ${k}`);
      }
    }
  }
  const probe = (kind: string, extra: string[]) => [
    `  ${kind}:`, '    httpGet:', `      path: ${helm ? '{{ .Values.healthPath }}' : c.healthPath}`, '      port: http', ...extra.map((e) => '    ' + e),
  ];
  if (c.stack === 'java') lines.push(...probe('startupProbe', ['periodSeconds: 5', 'failureThreshold: 36']));
  lines.push(...probe('readinessProbe', ['periodSeconds: 10', 'failureThreshold: 3']));
  lines.push(...probe('livenessProbe', ['periodSeconds: 20', 'failureThreshold: 3', 'initialDelaySeconds: 10']));
  lines.push('  resources:');
  lines.push('    requests:');
  lines.push(`      cpu: ${helm ? '{{ .Values.resources.requests.cpu }}' : halfCpu(c.cpuLimit)}`);
  lines.push(`      memory: ${helm ? '{{ .Values.resources.requests.memory }}' : halfMemory(c.memoryLimit)}`);
  lines.push('    limits:');
  lines.push(`      cpu: ${helm ? '{{ .Values.resources.limits.cpu | quote }}' : yq(cpuQty(c.cpuLimit))}`);
  lines.push(`      memory: ${helm ? '{{ .Values.resources.limits.memory }}' : k8sMemory(c.memoryLimit)}`);
  lines.push('  securityContext:');
  lines.push('    allowPrivilegeEscalation: false');
  lines.push('    capabilities:');
  lines.push('      drop: ["ALL"]');
  if (usesExistingImage(c) && !c.runAsNonRoot) lines.push(`      add: [${ROOT_IMAGE_CAPS.map((x) => `"${x}"`).join(', ')}]`);
  lines.push('    seccompProfile:');
  lines.push('      type: RuntimeDefault');
  if (nonRoot(c)) {
    lines.push('    runAsNonRoot: true');
    const uid = userId(c);
    if (uid !== null) lines.push(`    runAsUser: ${uid}`);
  }
  if (helm) {
    lines.push('  {{- if .Values.keyVault.enabled }}', '  volumeMounts:', '    - name: secrets-store', '      mountPath: /mnt/secrets-store', '      readOnly: true', '  {{- end }}');
  } else if (usesKeyVault(c)) {
    lines.push('  volumeMounts:', '    - name: secrets-store', '      mountPath: /mnt/secrets-store', '      readOnly: true');
  }
  return lines.map((l) => pad + l).join('\n');
}

// ─── plain manifests ─────────────────────────────────────────────────────────

function deploymentYaml(c: ContainerConfig): string {
  const k = c.k8s;
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${c.appName}
  namespace: ${k.namespace}
  labels:
${labels(c, 4)}
spec:
${k.autoscaling ? '' : `  replicas: ${k.replicas}\n`}  revisionHistoryLimit: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
${selector(c, 6)}
  template:
    metadata:
      labels:
${labels(c, 8)}${usesKeyVault(c) ? '\n        azure.workload.identity/use: "true"' : ''}
    spec:
${usesKeyVault(c) ? `      serviceAccountName: ${c.appName}\n` : ''}      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 30
      containers:
${containerBlock(c, k.image, 8, false)}
${usesKeyVault(c) ? `      volumes:
        - name: secrets-store
          csi:
            driver: secrets-store.csi.k8s.io
            readOnly: true
            volumeAttributes:
              secretProviderClass: ${c.appName}
` : ''}`;
}

function serviceAccountYaml(c: ContainerConfig): string {
  return `# The identity the pods use to read Key Vault (workload identity): its client id is filled in by deploy.sh.
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${c.appName}
  namespace: ${c.k8s.namespace}
  labels:
${labels(c, 4)}
  annotations:
    azure.workload.identity/client-id: ${KV_TOKENS.clientId}
`;
}

function secretProviderClassYaml(c: ContainerConfig): string {
  const secrets = secretNames(c);
  return `# Reads the secrets from Azure Key Vault and syncs them into the Secret ${c.appName}-secrets while a pod runs.
# The vault name, tenant and client id are filled in by deploy.sh once Terraform has created them.
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: ${c.appName}
  namespace: ${c.k8s.namespace}
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    clientID: ${KV_TOKENS.clientId}
    keyvaultName: ${KV_TOKENS.vaultName}
    tenantId: ${KV_TOKENS.tenantId}
    objects: |
      array:
${secrets.map((k) => `        - |\n          objectName: ${kvName(k)}\n          objectType: secret`).join('\n')}
  secretObjects:
    - secretName: ${c.appName}-secrets
      type: Opaque
      data:
${secrets.map((k) => `        - objectName: ${kvName(k)}\n          key: ${k}`).join('\n')}
`;
}

function serviceYaml(c: ContainerConfig, servicePort = 80): string {
  const k = c.k8s;
  return `apiVersion: v1
kind: Service
metadata:
  name: ${c.appName}
  namespace: ${k.namespace}
  labels:
${labels(c, 4)}
spec:
  type: ${k.serviceType}
  selector:
${selector(c, 4)}
  ports:
    - name: http
      port: ${servicePort}
      targetPort: http
`;
}

function ingressYaml(c: ContainerConfig): string {
  const k = c.k8s;
  return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${c.appName}
  namespace: ${k.namespace}
  labels:
${labels(c, 4)}
spec:
${k.ingressClass ? `  ingressClassName: ${k.ingressClass}\n` : ''}${k.tlsSecret ? `  tls:\n    - hosts:\n        - ${k.ingressHost}\n      secretName: ${k.tlsSecret}\n` : ''}  rules:
    - host: ${k.ingressHost}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${c.appName}
                port:
                  name: http
`;
}

function hpaYaml(c: ContainerConfig): string {
  const k = c.k8s;
  return `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${c.appName}
  namespace: ${k.namespace}
  labels:
${labels(c, 4)}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${c.appName}
  minReplicas: ${k.minReplicas}
  maxReplicas: ${k.maxReplicas}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
`;
}

function pdbYaml(c: ContainerConfig): string {
  return `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ${c.appName}
  namespace: ${c.k8s.namespace}
  labels:
${labels(c, 4)}
spec:
  minAvailable: 1
  selector:
    matchLabels:
${selector(c, 6)}
`;
}

export const namespaceYaml = (c: ContainerConfig) => `apiVersion: v1
kind: Namespace
metadata:
  name: ${c.k8s.namespace}
  labels:
${labels(c, 4)}
`;

const wantsPdb = (c: ContainerConfig) => (c.k8s.autoscaling ? c.k8s.minReplicas : c.k8s.replicas) > 1;

function kustomizationYaml(c: ContainerConfig, withNamespace = true): string {
  const k = c.k8s;
  const res = [...(withNamespace && k.namespace !== 'default' ? ['namespace.yaml'] : []), ...(usesKeyVault(c) ? ['serviceaccount.yaml', 'secretproviderclass.yaml'] : []), 'deployment.yaml', 'service.yaml', ...(k.ingressHost ? ['ingress.yaml'] : []), ...(k.autoscaling ? ['hpa.yaml'] : []), ...(wantsPdb(c) ? ['pdb.yaml'] : [])];
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
${res.map((r) => `  - ${r}`).join('\n')}
`;
}

// ─── Helm chart ──────────────────────────────────────────────────────────────

function helmChart(c: ContainerConfig): Array<{ path: string; content: string }> {
  const k = c.k8s;
  const dir = `helm/${c.appName}`;
  const { repository, tag } = splitImage(k.image);
  const plain = c.env.filter((v) => !v.secret);
  const secrets = secretNames(c);
  const values = `# Values for the ${c.appName} chart. Override with --set or -f.
image:
  repository: ${repository}
  tag: ${yq(tag)}
replicaCount: ${k.replicas}
port: ${c.port}
healthPath: ${yq(c.healthPath)}
service:
  type: ${k.serviceType}
ingress:
  enabled: ${k.ingressHost !== ''}
  host: ${yq(k.ingressHost)}
  className: ${yq(k.ingressClass)}
  tlsSecret: ${yq(k.tlsSecret)}
autoscaling:
  enabled: ${k.autoscaling}
  minReplicas: ${k.minReplicas}
  maxReplicas: ${k.maxReplicas}
  targetCPUUtilizationPercentage: 70
resources:
  requests:
    cpu: ${halfCpu(c.cpuLimit)}
    memory: ${halfMemory(c.memoryLimit)}
  limits:
    cpu: ${yq(cpuQty(c.cpuLimit))}
    memory: ${k8sMemory(c.memoryLimit)}
# Plain environment variables.
env:${plain.length === 0 ? ' {}' : '\n' + plain.map((v) => `  ${v.key}: ${yq(v.value)}`).join('\n')}
# Secret values live in a Secret created by deploy.sh (or kubectl); these are the keys the pods read from it.
secretName: ${c.appName}-secrets
secretNames:${secrets.length === 0 ? ' []' : '\n' + secrets.map((s) => `  - ${s}`).join('\n')}
nonRoot: ${nonRoot(c)}
# The numeric user to force. Empty lets the image choose (always the case for a ready-made image).
runAsUser: ${userId(c) ?? '""'}
# Secrets from Azure Key Vault (Secrets Store CSI driver + workload identity). Fill these from the Terraform outputs (vault_name, tenant_id, workload_client_id).
keyVault:
  enabled: ${usesKeyVault(c)}
  vaultName: ""
  tenantId: ""
  clientId: ""
`;
  const helpers = `{{- define "app.name" -}}${c.appName}{{- end -}}
{{- define "app.labels" -}}
app.kubernetes.io/name: {{ include "app.name" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "app.selector" -}}
app.kubernetes.io/name: {{ include "app.name" . }}
{{- end -}}
`;
  const container = containerBlock(c, '{{ .Values.image.repository }}:{{ .Values.image.tag }}', 8, true)
    // The user ids and the non-root switch come from values so they can be changed per environment.
    .replace(/ {8} {4}runAsNonRoot: true(?:\n {8} {4}runAsUser: \d+)?/, '        {{- if .Values.nonRoot }}\n            runAsNonRoot: true\n            {{- if .Values.runAsUser }}\n            runAsUser: {{ .Values.runAsUser }}\n            {{- end }}\n        {{- end }}');
  const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "app.name" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  revisionHistoryLimit: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
      {{- include "app.selector" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "app.labels" . | nindent 8 }}
        {{- if .Values.keyVault.enabled }}
        azure.workload.identity/use: "true"
        {{- end }}
    spec:
      {{- if .Values.keyVault.enabled }}
      serviceAccountName: {{ include "app.name" . }}
      {{- end }}
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 30
      containers:
${container}
      {{- if .Values.keyVault.enabled }}
      volumes:
        - name: secrets-store
          csi:
            driver: secrets-store.csi.k8s.io
            readOnly: true
            volumeAttributes:
              secretProviderClass: {{ include "app.name" . }}
      {{- end }}
`;
  const kvServiceAccount = `{{- if .Values.keyVault.enabled }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "app.name" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
  annotations:
    azure.workload.identity/client-id: {{ .Values.keyVault.clientId | quote }}
{{- end }}
`;
  const kvProviderClass = `{{- if .Values.keyVault.enabled }}
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: {{ include "app.name" . }}
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    clientID: {{ .Values.keyVault.clientId | quote }}
    keyvaultName: {{ .Values.keyVault.vaultName | quote }}
    tenantId: {{ .Values.keyVault.tenantId | quote }}
    objects: |
      array:
        {{- range .Values.secretNames }}
        - |
          objectName: {{ . | replace "_" "-" }}
          objectType: secret
        {{- end }}
  secretObjects:
    - secretName: {{ .Values.secretName }}
      type: Opaque
      data:
        {{- range .Values.secretNames }}
        - objectName: {{ . | replace "_" "-" }}
          key: {{ . }}
        {{- end }}
{{- end }}
`;
  const service = `apiVersion: v1
kind: Service
metadata:
  name: {{ include "app.name" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
spec:
  type: {{ .Values.service.type }}
  selector:
    {{- include "app.selector" . | nindent 4 }}
  ports:
    - name: http
      port: 80
      targetPort: http
`;
  const ingress = `{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "app.name" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
spec:
  {{- if .Values.ingress.className }}
  ingressClassName: {{ .Values.ingress.className }}
  {{- end }}
  {{- if .Values.ingress.tlsSecret }}
  tls:
    - hosts:
        - {{ .Values.ingress.host | quote }}
      secretName: {{ .Values.ingress.tlsSecret }}
  {{- end }}
  rules:
    - host: {{ .Values.ingress.host | quote }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ include "app.name" . }}
                port:
                  name: http
{{- end }}
`;
  const hpa = `{{- if .Values.autoscaling.enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "app.name" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "app.name" . }}
  minReplicas: {{ .Values.autoscaling.minReplicas }}
  maxReplicas: {{ .Values.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .Values.autoscaling.targetCPUUtilizationPercentage }}
{{- end }}
`;
  const pdb = `{{- if or (gt (int .Values.replicaCount) 1) .Values.autoscaling.enabled }}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "app.name" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
spec:
  minAvailable: 1
  selector:
    matchLabels:
      {{- include "app.selector" . | nindent 6 }}
{{- end }}
`;
  return [
    { path: `${dir}/Chart.yaml`, content: `apiVersion: v2\nname: ${c.appName}\ndescription: ${c.appName}, generated by CloudCraft\ntype: application\nversion: 0.1.0\nappVersion: ${yq(tag)}\n` },
    { path: `${dir}/values.yaml`, content: values },
    { path: `${dir}/templates/_helpers.tpl`, content: helpers },
    { path: `${dir}/templates/deployment.yaml`, content: deployment },
    { path: `${dir}/templates/service.yaml`, content: service },
    { path: `${dir}/templates/ingress.yaml`, content: ingress },
    { path: `${dir}/templates/hpa.yaml`, content: hpa },
    { path: `${dir}/templates/pdb.yaml`, content: pdb },
    { path: `${dir}/templates/serviceaccount.yaml`, content: kvServiceAccount },
    { path: `${dir}/templates/secretproviderclass.yaml`, content: kvProviderClass },
    { path: `${dir}/.helmignore`, content: '.git/\n*.swp\n' },
  ];
}

// ─── scripts, workflow, README ───────────────────────────────────────────────

function deploySh(c: ContainerConfig): string {
  const k = c.k8s;
  const secrets = secretNames(c);
  const ex = usesExistingImage(c);
  return `#!/usr/bin/env bash
# One command to deploy ${c.appName} to the Kubernetes cluster kubectl is pointed at: bash deploy.sh
${ex ? `#   1. stores any secret values in the cluster (asks once, hidden), never in a file
#   2. applies the manifests in k8s/ (the cluster pulls ${k.image}) and waits for the rollout
# Run it again after changing the settings. Add --yes to skip the confirmation.` : `#   1. builds the image for amd64 and arm64 and pushes it to ${splitImage(k.image).repository.split('/')[0]} (skip with SKIP_BUILD=1 if the image is already there)
#   2. stores any secret values in the cluster (asks once, hidden), never in a file
#   3. applies the manifests in k8s/ and waits for the rollout
# Run it again to release a new version. Add --yes to skip the confirmation.`}
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(c.appName)}
NAMESPACE=${q(k.namespace)}
IMAGE=${q(k.image)}
SECRETS=(${secrets.map(q).join(' ')})

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing tool: $1. $2"; exit 1; }; }
need kubectl "Install it from https://kubernetes.io/docs/tasks/tools/"
CONTEXT=$(kubectl config current-context 2>/dev/null) || { echo "kubectl is not pointed at a cluster. Set one up first (for example: aws eks update-kubeconfig, az aks get-credentials)."; exit 1; }
kubectl version --request-timeout=10s >/dev/null 2>&1 || { echo "Cannot reach the cluster for context $CONTEXT."; exit 1; }

echo "Cluster: $CONTEXT   Namespace: $NAMESPACE   Image: $IMAGE"
if [ "\${1:-}" != "--yes" ]; then
  read -r -p "Deploy $APP here? [y/N] " OK
  [ "$OK" = "y" ] || [ "$OK" = "Y" ] || { echo "Cancelled."; exit 1; }
fi

${ex ? '' : `if [ -z "\${SKIP_BUILD:-}" ]; then
  echo "==> 1/3  Build and push the image"
  need docker "Install Docker Desktop from https://www.docker.com/products/docker-desktop"
  docker info >/dev/null 2>&1 || { echo "Docker is not running."; exit 1; }
  # You must already be logged in to the registry (docker login).
  docker buildx build --platform linux/amd64,linux/arm64 -t "$IMAGE" --push .
else
  echo "==> 1/3  Skipped the build (SKIP_BUILD is set)"
fi

`}echo "==> ${ex ? '1/2' : '2/3'}  Namespace and secrets"
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

echo "==> ${ex ? '2/2' : '3/3'}  Apply and wait"
kubectl apply -k k8s
kubectl -n "$NAMESPACE" rollout status deployment/"$APP" --timeout=300s
echo "Done. ${k.ingressHost ? `Open ${k.tlsSecret ? 'https' : 'http'}://${k.ingressHost}` : k.serviceType === 'LoadBalancer' ? 'Find the address with: kubectl -n "$NAMESPACE" get service "$APP"' : 'Try it with: kubectl -n "$NAMESPACE" port-forward service/"$APP" 8080:80'}"
`;
}

function destroySh(c: ContainerConfig): string {
  return `#!/usr/bin/env bash
# Removes ${c.appName} from the cluster kubectl is pointed at (the Deployment, Service, Ingress, Secret): bash destroy.sh
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(c.appName)}
NAMESPACE=${q(c.k8s.namespace)}

command -v kubectl >/dev/null 2>&1 || { echo "Missing tool: kubectl"; exit 1; }
echo "Cluster: $(kubectl config current-context)   Namespace: $NAMESPACE"
echo "This deletes $APP${c.k8s.namespace === 'default' ? '' : ` and the whole namespace ${c.k8s.namespace}`} from that cluster."
read -r -p "Type the app name ($APP) to continue: " ANSWER
[ "$ANSWER" = "$APP" ] || { echo "Cancelled."; exit 1; }

kubectl delete -k k8s --ignore-not-found
kubectl -n "$NAMESPACE" delete secret "$APP-secrets" --ignore-not-found
echo "Done."
`;
}

function workflowYml(c: ContainerConfig): string {
  const k = c.k8s;
  const { repository } = splitImage(k.image);
  return `# Builds the image, scans it and pushes it to GitHub Container Registry on every push to main.
# Applying it to your cluster stays a deliberate step: run bash deploy.sh (SKIP_BUILD=1), or give the cluster a GitOps tool that watches this image.
name: image-${c.appName}

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Build
        run: docker build -t "${repository}:\${{ github.sha }}" -t "${k.image}" .
${k.scanImage ? `
      # Stops the push if the image has a HIGH or CRITICAL vulnerability that already has a fix.
      - name: Scan the image (Trivy)
        uses: aquasecurity/trivy-action@915b19bbe73b92a6cf82a1bc12b087c9a19a5fe2 # v0.28.0
        with:
          image-ref: ${repository}:\${{ github.sha }}
          severity: HIGH,CRITICAL
          ignore-unfixed: true
          exit-code: '1'
          vuln-type: os,library
` : ''}
      - name: Push
        run: docker push "${repository}" --all-tags
`;
}

function readme(c: ContainerConfig): string {
  const k = c.k8s;
  const secrets = secretNames(c);
  return `# Deploy ${c.appName} to Kubernetes

## Quick start

You need \`kubectl\` pointed at your cluster (\`kubectl config current-context\` shows which)${usesExistingImage(c) ? '' : `, Docker, and to be logged in to the registry of \`${k.image}\` (\`docker login\`)`}. Then, from the folder that contains your app and these files:

\`\`\`bash
bash deploy.sh
\`\`\`

It ${usesExistingImage(c) ? '' : 'builds and pushes the image, '}${secrets.length ? 'asks for your secret values (hidden) and stores them in the cluster, ' : ''}applies \`k8s/\` (the cluster pulls \`${k.image}\`${usesExistingImage(c) ? ' as it is: nothing is built' : ''}) and waits for the rollout. ${usesExistingImage(c) ? 'Run it again after changing the settings.' : 'Run it again to release a new version.'} To remove everything: \`bash destroy.sh\`.

## What gets created (namespace \`${k.namespace}\`)

- A Deployment of ${k.autoscaling ? `${k.minReplicas} to ${k.maxReplicas}` : k.replicas} pod${k.replicas === 1 && !k.autoscaling ? '' : 's'} with health probes on \`${c.healthPath}\`, resource requests and limits, and zero-downtime rolling updates.
- A Service (${k.serviceType}) on port 80.${k.ingressHost ? `\n- An Ingress for \`${k.ingressHost}\`${k.tlsSecret ? ` with TLS from the secret \`${k.tlsSecret}\`` : ' (plain HTTP)'}.` : ''}${k.autoscaling ? '\n- A HorizontalPodAutoscaler that keeps average CPU near 70% (needs metrics-server in the cluster).' : ''}${wantsPdb(c) ? '\n- A PodDisruptionBudget so at least one pod stays up while nodes are drained.' : ''}
${secrets.length ? `- Secrets (${secrets.join(', ')}) are read from the Secret \`${c.appName}-secrets\`, which \`deploy.sh\` creates from what you type. They are never written to a file.\n` : ''}
Pods run as a non-root user with no privilege escalation, all Linux capabilities dropped, the default seccomp profile, and no service account token.

## Using Helm instead
${k.helm ? `
\`\`\`bash
helm upgrade --install ${c.appName} helm/${c.appName} --namespace ${k.namespace} --create-namespace \\
  --set image.tag=1.0
\`\`\`

Create the secret first if you have any: \`kubectl -n ${k.namespace} create secret generic ${c.appName}-secrets --from-literal=NAME=value\`. All settings are in \`helm/${c.appName}/values.yaml\`.
` : '\nTurn on "Also generate a Helm chart" in Container Templates and generate again.\n'}
## Look inside

\`\`\`bash
kubectl -n ${k.namespace} get pods -l app.kubernetes.io/name=${c.appName}
kubectl -n ${k.namespace} logs deployment/${c.appName} --tail=100 -f
kubectl -n ${k.namespace} describe deployment ${c.appName}
\`\`\`

## Common problems

- **ImagePullBackOff**: the cluster cannot pull \`${k.image}\`. Make the image public, or create an image pull secret and add it to the Deployment.
- **CreateContainerConfigError**: a secret is missing. Create \`${c.appName}-secrets\` with the keys above.
- **Pods restart in a loop**: read the logs. The health check path \`${c.healthPath}\` must answer on port ${c.port}.
- **"exec format error"**: the image was built for another CPU type. \`deploy.sh\` builds for amd64 and arm64.
`;
}

/**
 * The manifests, the Helm chart and the README, without the deploy scripts or workflow (other targets that run Kubernetes bring their own).
 * `withNamespace: false` leaves the Namespace object out: a project of several services writes it once for all of them.
 * `servicePort: 'container'` gives the Service the container's own port instead of 80, so services reach each other at the same address
 * (api:8000) as in docker compose.
 */
export function generateK8sManifestFiles(c0: ContainerConfig, opts: { withNamespace?: boolean; servicePort?: 'http' | 'container' } = {}): Array<{ path: string; content: string }> {
  const c = withImage(c0);
  const k = c.k8s;
  const withNamespace = opts.withNamespace ?? true;
  return [
    ...(withNamespace && k.namespace !== 'default' ? [{ path: 'k8s/namespace.yaml', content: namespaceYaml(c) }] : []),
    { path: 'k8s/deployment.yaml', content: deploymentYaml(c) },
    { path: 'k8s/service.yaml', content: serviceYaml(c, opts.servicePort === 'container' ? c.port : 80) },
    ...(usesKeyVault(c) ? [{ path: 'k8s/serviceaccount.yaml', content: serviceAccountYaml(c) }, { path: 'k8s/secretproviderclass.yaml', content: secretProviderClassYaml(c) }] : []),
    ...(k.ingressHost ? [{ path: 'k8s/ingress.yaml', content: ingressYaml(c) }] : []),
    ...(k.autoscaling ? [{ path: 'k8s/hpa.yaml', content: hpaYaml(c) }] : []),
    ...(wantsPdb(c) ? [{ path: 'k8s/pdb.yaml', content: pdbYaml(c) }] : []),
    { path: 'k8s/kustomization.yaml', content: kustomizationYaml(c, withNamespace) },
    ...(k.helm ? helmChart(c) : []),
  ];
}

export function generateK8sFiles(c0: ContainerConfig): Array<{ path: string; content: string; executable?: boolean }> {
  if (!c0.k8s.enabled) return [];
  const c = withImage(c0);
  const k = c.k8s;
  return [
    { path: 'deploy.sh', content: deploySh(c), executable: true },
    { path: 'destroy.sh', content: destroySh(c), executable: true },
    ...generateK8sManifestFiles(c),
    { path: 'k8s/README.md', content: readme(c) },
    ...(k.githubActions && !usesExistingImage(c) && /^ghcr\.io\//.test(k.image) ? [{ path: '.github/workflows/image.yml', content: workflowYml(c) }] : []),
  ];
}
