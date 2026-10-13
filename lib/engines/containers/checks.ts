/**
 * Security and quality checks for a container template. They read the files CloudCraft is about to hand over (Dockerfile, compose file,
 * .dockerignore, the EC2 Terraform and the workflow) together with the form's settings, so a finding is about what you would actually run,
 * and a regression in a generator shows up here as well as in the form. Pure functions: nothing is sent anywhere.
 */
import type { ContainerConfig, GeneratedFile } from './dockerTemplates';

export type FindingSeverity = 'high' | 'medium' | 'low';

export interface ContainerFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  fix: string;
  /** The generated file the finding is about, when there is one. */
  file?: string;
}

const SECRET_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE_?KEY|API_?KEY|ACCESS_?KEY|CREDENTIAL)/i;
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

/** The instructions of the last stage of a Dockerfile (the one that is shipped). */
function finalStage(dockerfile: string): string {
  const parts = dockerfile.split(/^FROM\s/m);
  return parts.length > 1 ? 'FROM ' + parts[parts.length - 1] : dockerfile;
}

/** The text of each top-level service in a compose file. */
function composeServices(compose: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = compose.split(/^services:\s*$/m)[1] ?? '';
  const section = body.split(/^\S/m)[0] ?? '';
  const parts = section.split(/^ {2}([A-Za-z0-9_.-]+):\s*$/m);
  for (let i = 1; i < parts.length; i += 2) out.set(parts[i]!, parts[i + 1] ?? '');
  return out;
}

export function checkContainer(config: ContainerConfig, files: GeneratedFile[]): ContainerFinding[] {
  const c = config;
  const get = (p: string) => files.find((f) => f.path === p)?.content;
  const dockerfile = get('Dockerfile') ?? '';
  const compose = get('docker-compose.yml') ?? '';
  const dockerignore = get('.dockerignore') ?? '';
  const out: ContainerFinding[] = [];
  const add = (f: ContainerFinding) => out.push(f);

  // ── image ──
  const stages = new Set([...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1]!.toLowerCase()));
  for (const m of dockerfile.matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/gm)) {
    const ref = m[1]!;
    if (stages.has(ref.toLowerCase()) || ref === 'scratch') continue;
    const tag = ref.includes('@') ? '@' : ref.split('/').pop()!.split(':')[1];
    if (tag === undefined || tag === 'latest') {
      add({ id: 'CT-001', severity: 'medium', file: 'Dockerfile', title: `Base image ${ref} is not pinned to a version`,
        detail: 'An image without a version tag (or with :latest) changes underneath you, so the same Dockerfile builds different images on different days.',
        fix: 'Use a version tag such as node:22-alpine, or a digest.' });
    }
  }
  const last = finalStage(dockerfile);
  if (c.stack !== 'static' && !/^USER\s+(?!root\b|0\b)\S+/m.test(last)) {
    add({ id: 'CT-002', severity: 'high', file: 'Dockerfile', title: 'The container runs as root',
      detail: 'If someone takes over the app, they have root inside the container, which makes escaping it far easier.',
      fix: 'Turn on "Run as non-root".' });
  }
  if (!/^HEALTHCHECK\s/m.test(last)) {
    add({ id: 'CT-003', severity: 'medium', file: 'Dockerfile', title: 'No health check',
      detail: 'Without one, Docker keeps sending traffic to an app that has hung.', fix: 'Set a health check path.' });
  }
  if (/\b(curl|wget)\b[^\n|]*\|\s*(ba)?sh\b/.test(dockerfile) || /^ADD\s+https?:\/\//m.test(dockerfile)) {
    add({ id: 'CT-004', severity: 'high', file: 'Dockerfile', title: 'Downloads and runs code during the build',
      detail: '"curl | sh" and ADD from a URL run whatever the server returns that day, with no check on it.', fix: 'Install from a package manager with a lock file, or verify a checksum.' });
  }
  if (!/^\.env\s*$/m.test(dockerignore)) {
    add({ id: 'CT-005', severity: 'medium', file: '.dockerignore', title: '.env files can be copied into the image',
      detail: 'COPY . . would put a local .env (with real secrets) inside the image, and anyone who can pull the image can read it.', fix: 'List .env in .dockerignore.' });
  }

  // ── configuration ──
  for (const v of c.env) {
    if (!v.secret && v.value !== '' && (SECRET_NAME.test(v.key) || URL_WITH_PASSWORD.test(v.value))) {
      add({ id: 'CT-006', severity: 'high', title: `${v.key} looks like a secret but is stored as plain text`,
        detail: 'Plain values are written to .env.example, docker-compose.yml and the README, which usually end up in git.', fix: 'Tick "secret" for this variable and supply the value at run time.' });
    }
  }

  // ── compose ──
  if (compose) {
    if (/^\s*privileged:\s*true/m.test(compose) || /network_mode:\s*["']?host/m.test(compose) || /\/var\/run\/docker\.sock/.test(compose)) {
      add({ id: 'CT-007', severity: 'high', file: 'docker-compose.yml', title: 'The container is given control of the host',
        detail: 'privileged mode, host networking and the Docker socket each let a compromised container take over the machine.', fix: 'Remove them; publish only the port the app needs.' });
    }
    for (const [name, text] of composeServices(compose)) {
      if (name !== c.appName && /^\s+ports:/m.test(text)) {
        add({ id: 'CT-008', severity: 'high', file: 'docker-compose.yml', title: `${name} is published on the host's network`,
          detail: 'A database or cache has no business being reachable from outside; the app talks to it over the compose network.', fix: `Remove "ports" from ${name}.` });
      }
      if (/^\s+image:\s*\S+:latest\s*$/m.test(text) && name !== c.appName) {
        add({ id: 'CT-001', severity: 'medium', file: 'docker-compose.yml', title: `${name} uses the :latest image`, detail: 'The version changes without you choosing it.', fix: 'Pin a version tag.' });
      }
    }
    if (!/mem_limit:|memory:/.test(compose) || !/cpus:/.test(compose)) {
      add({ id: 'CT-009', severity: 'low', file: 'docker-compose.yml', title: 'No memory or CPU limit',
        detail: 'One runaway process can take the whole machine down.', fix: 'Set Memory and CPUs under Server settings.' });
    }
    if (c.restart === 'no') {
      add({ id: 'CT-010', severity: 'low', file: 'docker-compose.yml', title: 'The service does not restart after a crash or a reboot', detail: 'The app stays down until someone starts it.', fix: 'Use "unless-stopped".' });
    }
  }

  // ── every deployment target ──
  const t = c.ec2.enabled ? { name: 'EC2', dir: 'ec2', cidr: c.ec2.allowedCidr, tag: c.ec2.imageTag, scan: c.ec2.scanImage, actions: c.ec2.githubActions, what: `Port ${c.port}`, tagFile: 'ec2/variables.tf' }
    : c.ecs.enabled ? { name: 'ECS', dir: 'ecs', cidr: c.ecs.allowedCidr, tag: c.ecs.imageTag, scan: c.ecs.scanImage, actions: c.ecs.githubActions, what: 'The load balancer', tagFile: 'ecs/variables.tf' }
    : c.aca.enabled ? { name: 'Container Apps', dir: 'aca', cidr: c.aca.externalIngress ? c.aca.allowedCidr : '10.0.0.0/8', tag: c.aca.imageTag, scan: c.aca.scanImage, actions: c.aca.githubActions, what: 'The app', tagFile: 'aca/variables.tf' }
    : undefined;
  if (t) {
    if (t.cidr === '0.0.0.0/0') {
      add({ id: 'CT-011', severity: 'medium', file: `${t.dir}/variables.tf`, title: `${t.what} is open to the whole internet`,
        detail: 'Fine for a public website, risky for an internal tool or an API with no login.', fix: 'Set "Who can connect" to your office or VPN range.' });
    }
    if (t.actions && !t.scan) {
      add({ id: 'CT-015', severity: 'low', file: '.github/workflows/deploy.yml', title: 'Images are pushed without a vulnerability scan',
        detail: 'A known vulnerability in a base image or a library goes live unnoticed.', fix: 'Turn on "Scan the image for vulnerabilities".' });
    }
    if (t.tag === 'latest') {
      add({ id: 'CT-016', severity: 'low', file: t.tagFile, title: 'The deployed image tag is "latest"', detail: 'It is unclear which build is running, and you cannot roll back to a named one.', fix: 'Deploy a version tag such as the commit id.' });
    }
  }

  // ── EC2 ──
  if (c.ec2.enabled) {
    const tf = get('ec2/main.tf') ?? '';
    if (tf && !/http_tokens\s*=\s*"required"/.test(tf)) {
      add({ id: 'CT-012', severity: 'high', file: 'ec2/main.tf', title: 'The instance still allows IMDSv1', detail: 'IMDSv1 lets a server-side request forgery steal the instance role credentials.', fix: 'Set http_tokens = "required".' });
    }
    if (tf && !/encrypted\s*=\s*true/.test(tf)) {
      add({ id: 'CT-013', severity: 'medium', file: 'ec2/main.tf', title: 'The disk is not encrypted', detail: 'Snapshots and detached volumes would be readable.', fix: 'Set encrypted = true on the root volume.' });
    }
    if (/from_port\s*=\s*22\b/.test(tf)) {
      add({ id: 'CT-014', severity: 'high', file: 'ec2/main.tf', title: 'SSH is open', detail: 'Port 22 is a constant target for password guessing.', fix: 'Use Session Manager instead.' });
    }
  }

  // ── ECS Fargate ──
  if (c.ecs.enabled) {
    const tf = get('ecs/main.tf') ?? '';
    if (!c.ecs.certificateArn) {
      add({ id: 'CT-017', severity: 'medium', file: 'ecs/variables.tf', title: 'The load balancer serves plain HTTP',
        detail: 'Traffic, cookies and tokens cross the internet unencrypted.', fix: 'Add an ACM certificate ARN so it serves HTTPS and redirects HTTP.' });
    }
    const taskSg = /resource "aws_security_group" "task" \{[\s\S]*?\n\}/.exec(tf)?.[0] ?? '';
    if (taskSg && !/security_groups\s*=\s*\[aws_security_group\.alb\.id\]/.test(taskSg) || /ingress \{[^}]*cidr_blocks\s*=\s*\["0\.0\.0\.0\/0"\]/.test(taskSg)) {
      add({ id: 'CT-018', severity: 'high', file: 'ecs/main.tf', title: 'The tasks accept traffic from anywhere', detail: 'They should be reachable only through the load balancer.', fix: 'Allow the app port only from the load balancer\'s security group.' });
    }
    if (tf && !/deployment_circuit_breaker/.test(tf)) {
      add({ id: 'CT-019', severity: 'low', file: 'ecs/main.tf', title: 'A failing deployment does not roll back', detail: 'A bad release keeps replacing healthy tasks.', fix: 'Enable the deployment circuit breaker with rollback.' });
    }
  }

  // ── Azure Container Apps ──
  if (c.aca.enabled) {
    const tf = get('aca/main.tf') ?? '';
    if (/admin_enabled\s*=\s*true/.test(tf)) {
      add({ id: 'CT-020', severity: 'high', file: 'aca/main.tf', title: 'The container registry has its admin user on', detail: 'A shared password gives full push and pull access.', fix: 'Turn the admin user off and pull with a managed identity.' });
    }
    if (/allow_insecure_connections\s*=\s*true/.test(tf)) {
      add({ id: 'CT-021', severity: 'medium', file: 'aca/main.tf', title: 'The app accepts plain HTTP', detail: 'Traffic crosses the network unencrypted.', fix: 'Remove allow_insecure_connections.' });
    }
    if (c.env.some((v) => v.secret)) {
      add({ id: 'CT-022', severity: 'low', file: 'aca/README.md', title: 'Secret values are kept in Terraform state', detail: 'Anyone who can read the state file can read the secrets.', fix: 'Keep the aca/ folder private or use an encrypted remote backend.' });
    }
  }

  // ── Kubernetes ──
  if (c.k8s.enabled) {
    const dep = get('k8s/deployment.yaml') ?? '';
    if (dep && !/runAsNonRoot:\s*true/.test(dep)) {
      add({ id: 'CT-002', severity: 'high', file: 'k8s/deployment.yaml', title: 'The container runs as root', detail: 'If someone takes over the app, they have root inside the container, which makes escaping it far easier.', fix: 'Turn on "Run as non-root".' });
    }
    if (dep && !/allowPrivilegeEscalation:\s*false/.test(dep)) {
      add({ id: 'CT-023', severity: 'medium', file: 'k8s/deployment.yaml', title: 'The container may gain more privileges than its parent', detail: 'A setuid program inside the container could become root.', fix: 'Set allowPrivilegeEscalation: false.' });
    }
    if (dep && /privileged:\s*true|hostNetwork:\s*true|hostPID:\s*true/.test(dep)) {
      add({ id: 'CT-007', severity: 'high', file: 'k8s/deployment.yaml', title: 'The pod is given control of the host', detail: 'privileged mode and host namespaces let a compromised container take over the node.', fix: 'Remove them.' });
    }
    if (dep && !/resources:[\s\S]*limits:/.test(dep)) {
      add({ id: 'CT-009', severity: 'low', file: 'k8s/deployment.yaml', title: 'No memory or CPU limit', detail: 'One runaway pod can take the whole node down.', fix: 'Set Memory and CPUs under Server settings.' });
    }
    if (c.k8s.ingressHost && !c.k8s.tlsSecret) {
      add({ id: 'CT-024', severity: 'medium', file: 'k8s/ingress.yaml', title: 'The ingress serves plain HTTP', detail: 'Traffic, cookies and tokens cross the network unencrypted.', fix: 'Add a TLS secret name (for example from cert-manager).' });
    }
    const tag = c.k8s.image.split('/').pop() ?? '';
    if (!tag.includes(':') && !tag.includes('@') || tag.endsWith(':latest')) {
      add({ id: 'CT-016', severity: 'low', file: 'k8s/deployment.yaml', title: 'The image has no version tag or uses :latest', detail: 'It is unclear which build is running, and you cannot roll back to a named one.', fix: 'Use a version tag such as the commit id.' });
    }
    if (c.k8s.githubActions && !c.k8s.scanImage) {
      add({ id: 'CT-015', severity: 'low', file: '.github/workflows/image.yml', title: 'Images are pushed without a vulnerability scan', detail: 'A known vulnerability in a base image or a library goes live unnoticed.', fix: 'Turn on "Scan the image for vulnerabilities".' });
    }
  }

  const seen = new Set<string>();
  return out
    .filter((f) => { const k = `${f.id}|${f.title}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id));
}
