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

  // ── EC2 ──
  if (c.ec2.enabled) {
    if (c.ec2.allowedCidr === '0.0.0.0/0') {
      add({ id: 'CT-011', severity: 'medium', file: 'ec2/variables.tf', title: `Port ${c.port} is open to the whole internet`,
        detail: 'Fine for a public website, risky for an internal tool or an API with no login.', fix: 'Set "Who can connect" to your office or VPN range.' });
    }
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
    if (c.ec2.githubActions && !c.ec2.scanImage) {
      add({ id: 'CT-015', severity: 'low', file: '.github/workflows/deploy.yml', title: 'Images are pushed without a vulnerability scan',
        detail: 'A known vulnerability in a base image or a library goes live unnoticed.', fix: 'Turn on "Scan the image for vulnerabilities".' });
    }
    if (c.ec2.imageTag === 'latest') {
      add({ id: 'CT-016', severity: 'low', file: 'ec2/variables.tf', title: 'The deployed image tag is "latest"', detail: 'It is unclear which build is running, and you cannot roll back to a named one.', fix: 'Deploy a version tag such as the commit id.' });
    }
  }

  const seen = new Set<string>();
  return out
    .filter((f) => { const k = `${f.id}|${f.title}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id));
}
