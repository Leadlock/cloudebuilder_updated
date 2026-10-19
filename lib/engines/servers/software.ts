/**
 * "Server software": programs CloudBuilder installs on an EC2 instance or Azure VM the first time it starts (a web server, a runtime, a database),
 * so the server is ready to use without anyone logging in to it.
 *
 * Only what is in this catalog can be installed: the script is built from the package names and commands below, never from text a person
 * types, so there is no way to slip a command in through a setting. The one free-text input (a start page) is escaped and written to a file.
 * The script is plain bash, safe to run twice (it leaves a marker when done), retries while the network comes up, and logs to
 * /var/log/cloudbuilder-setup.log. `scripts/verify-server-software.ts` runs it for real on Amazon Linux and Ubuntu in CI.
 */

/** Which package manager the server's operating system uses. */
export type PackageFamily = 'dnf' | 'apt';

export interface SoftwareItem {
  id: string;
  label: string;
  description: string;
  kind: 'web server' | 'runtime' | 'database' | 'tool';
  packages: Record<PackageFamily, string[]>;
  /** The systemd service to enable and start, when there is one. */
  service?: Record<PackageFamily, string>;
  /** Ports that must be reachable from outside for it to be useful (databases are never listed: they are not meant to be exposed). */
  ports?: number[];
  /** Extra commands that must run after the packages are installed and before the service starts. */
  after?: Partial<Record<PackageFamily, string[]>>;
  /** A command that succeeds when it is installed (CI runs it). */
  verify: Record<PackageFamily, string>;
  /** Cannot be installed together with these (they would fight over the same port). */
  conflictsWith?: string[];
  /** A short note shown next to it. */
  note?: string;
  /** Folder web pages are served from, for the start page. */
  docRoot?: Record<PackageFamily, string>;
}

export const SOFTWARE: readonly SoftwareItem[] = [
  { id: 'nginx', label: 'nginx', kind: 'web server', description: 'Web server and reverse proxy.',
    packages: { dnf: ['nginx'], apt: ['nginx'] }, service: { dnf: 'nginx', apt: 'nginx' }, ports: [80, 443], conflictsWith: ['apache'],
    docRoot: { dnf: '/usr/share/nginx/html', apt: '/var/www/html' }, verify: { dnf: 'nginx -v', apt: 'nginx -v' } },
  { id: 'apache', label: 'Apache HTTP Server', kind: 'web server', description: 'The Apache web server (httpd).',
    packages: { dnf: ['httpd'], apt: ['apache2'] }, service: { dnf: 'httpd', apt: 'apache2' }, ports: [80, 443], conflictsWith: ['nginx'],
    docRoot: { dnf: '/var/www/html', apt: '/var/www/html' }, verify: { dnf: 'httpd -v', apt: 'apache2 -v' } },
  { id: 'php', label: 'PHP', kind: 'runtime', description: 'PHP with FastCGI (php-fpm). Wiring it to the web server is up to you.',
    packages: { dnf: ['php8.2', 'php8.2-fpm'], apt: ['php-cli', 'php-fpm'] }, verify: { dnf: 'php -v', apt: 'php -v' },
    note: 'Installed, not connected to the web server.' },
  { id: 'nodejs', label: 'Node.js', kind: 'runtime', description: 'Node.js and npm from the operating system.',
    packages: { dnf: ['nodejs', 'npm'], apt: ['nodejs', 'npm'] }, verify: { dnf: 'node --version', apt: 'node --version' } },
  { id: 'python', label: 'Python 3', kind: 'runtime', description: 'Python 3 with pip and virtual environments.',
    packages: { dnf: ['python3', 'python3-pip'], apt: ['python3', 'python3-pip', 'python3-venv'] }, verify: { dnf: 'python3 --version', apt: 'python3 --version' } },
  { id: 'java', label: 'Java (JRE)', kind: 'runtime', description: 'A headless Java runtime for running .jar applications.',
    packages: { dnf: ['java-21-amazon-corretto-headless'], apt: ['default-jre-headless'] }, verify: { dnf: 'java -version', apt: 'java -version' } },
  { id: 'docker', label: 'Docker', kind: 'tool', description: 'Docker engine, started at boot. The login user is added to the docker group.',
    packages: { dnf: ['docker'], apt: ['docker.io'] }, service: { dnf: 'docker', apt: 'docker' }, verify: { dnf: 'docker --version', apt: 'docker --version' } },
  { id: 'git', label: 'Git', kind: 'tool', description: 'The git command.',
    packages: { dnf: ['git'], apt: ['git'] }, verify: { dnf: 'git --version', apt: 'git --version' } },
  { id: 'mariadb', label: 'MariaDB', kind: 'database', description: 'MySQL-compatible database, listening on this server only.',
    packages: { dnf: ['mariadb105-server'], apt: ['mariadb-server'] }, service: { dnf: 'mariadb', apt: 'mariadb' },
    verify: { dnf: 'mariadb --version', apt: 'mariadb --version' }, note: 'Not reachable from outside the server.' },
  { id: 'postgresql', label: 'PostgreSQL', kind: 'database', description: 'PostgreSQL database, listening on this server only.',
    packages: { dnf: ['postgresql15-server'], apt: ['postgresql'] }, service: { dnf: 'postgresql', apt: 'postgresql' },
    after: { dnf: ['[ -s /var/lib/pgsql/data/PG_VERSION ] || su postgres -c "initdb -D /var/lib/pgsql/data"'] }, verify: { dnf: 'psql --version', apt: 'psql --version' }, note: 'Not reachable from outside the server.' },
  { id: 'redis', label: 'Redis', kind: 'database', description: 'Redis key-value store, listening on this server only.',
    packages: { dnf: ['redis6'], apt: ['redis-server'] }, service: { dnf: 'redis6', apt: 'redis-server' },
    verify: { dnf: 'redis6-server --version', apt: 'redis-server --version' }, note: 'Not reachable from outside the server.' },
];

const SOFTWARE_BY_ID: ReadonlyMap<string, SoftwareItem> = new Map(SOFTWARE.map((s) => [s.id, s]));
const SOFTWARE_IDS: readonly string[] = SOFTWARE.map((s) => s.id);

export interface SoftwarePlan {
  /** What will be installed, in catalog order. */
  items: SoftwareItem[];
  /** Why something was left out or cannot work (shown to the person). */
  warnings: string[];
}

/** The package family of an AWS instance, from its operating system label. Null when CloudBuilder cannot install software on it. */
export function awsFamily(os: unknown): PackageFamily | null {
  const v = String(os ?? '');
  if (/Amazon Linux 2023/i.test(v)) return 'dnf';
  if (/Ubuntu|Debian/i.test(v)) return 'apt';
  return null;
}

/** The package family of an Azure VM, from its image. Null for Windows and for images CloudBuilder has not been taught. */
export function azureFamily(cfg: Record<string, unknown>): PackageFamily | null {
  if (cfg['osType'] === 'Windows') return null;
  const publisher = String(cfg['imagePublisher'] ?? 'Canonical');
  return /^(Canonical|Debian)$/i.test(publisher) ? 'apt' : null;
}

/** Turns the selected ids into a plan: unknown ids are dropped, conflicts are resolved to the first, and every dropped thing is explained. */
export function planSoftware(ids: unknown): SoftwarePlan {
  const warnings: string[] = [];
  const asked = Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : [];
  const items: SoftwareItem[] = [];
  for (const id of asked) {
    const item = SOFTWARE_BY_ID.get(id);
    if (!item) { warnings.push(`"${id.slice(0, 40)}" is not in the list of software CloudBuilder can install, so it was left out.`); continue; }
    if (items.some((i) => i.id === id)) continue;
    const clash = items.find((i) => i.conflictsWith?.includes(id));
    if (clash) { warnings.push(`${item.label} was left out: it cannot run together with ${clash.label} (both use port 80). Choose one.`); continue; }
    items.push(item);
  }
  items.sort((a, b) => SOFTWARE_IDS.indexOf(a.id) - SOFTWARE_IDS.indexOf(b.id));
  return { items, warnings };
}

/** Ports the selected software wants reachable from outside. */
export const webPorts = (items: readonly SoftwareItem[]): number[] => [...new Set(items.flatMap((i) => i.ports ?? []))].sort((a, b) => a - b);

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** One line of plain text for the start page: no line breaks, no control characters, at most 200 characters. */
export function cleanPageText(v: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
}

export interface ScriptOptions {
  family: PackageFamily;
  /** The account people sign in as, to add to the docker group (ubuntu, ec2-user, azureuser). */
  loginUser: string;
  /** Text for the start page of a web server. Empty leaves the default page. */
  pageText?: string;
}

/** The first-boot script. Empty string when nothing is selected. */
export function softwareScript(items: readonly SoftwareItem[], o: ScriptOptions): string {
  if (items.length === 0) return '';
  const apt = o.family === 'apt';
  const lines: string[] = [
    '#!/bin/bash',
    `# Installed by CloudBuilder the first time this server starts: ${items.map((i) => i.label).join(', ')}.`,
    '# Safe to run twice. Progress is logged to /var/log/cloudbuilder-setup.log.',
    'set -euo pipefail',
    'exec > >(tee -a /var/log/cloudbuilder-setup.log) 2>&1',
    'MARKER=/var/lib/cloudbuilder-setup.done',
    'if [ -f "$MARKER" ]; then echo "CloudBuilder setup already done."; exit 0; fi',
    ...(apt ? ['export DEBIAN_FRONTEND=noninteractive'] : []),
    '',
    '# The network can take a moment to come up: try a few times before giving up.',
    'retry() { for i in 1 2 3 4 5 6; do "$@" && return 0; echo "Attempt $i failed: $*"; sleep 10; done; return 1; }',
    '# Start a service now and at every boot (skipped where there is no systemd, for example in a test container).',
    'start_service() { if [ -d /run/systemd/system ]; then systemctl enable --now "$1"; else echo "No systemd here: not starting $1."; fi; }',
    '',
    apt ? 'retry apt-get update -y' : 'retry dnf -y makecache',
  ];
  const page = cleanPageText(o.pageText);
  for (const item of items) {
    lines.push('', `# ${item.label}`);
    lines.push(`retry ${apt ? 'apt-get install -y' : 'dnf -y install'} ${item.packages[o.family].join(' ')}`);
    for (const cmd of item.after?.[o.family] ?? []) lines.push(cmd);
    if (item.id === 'docker') lines.push(`if id -u ${o.loginUser} >/dev/null 2>&1; then usermod -aG docker ${o.loginUser}; fi`);
    if (item.docRoot && page !== '') {
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(page)}</title></head><body><h1>${escapeHtml(page)}</h1></body></html>`;
      lines.push(`mkdir -p ${item.docRoot[o.family]}`, `cat > ${item.docRoot[o.family]}/index.html <<'CLOUDBUILDER_PAGE'`, html, 'CLOUDBUILDER_PAGE');
    }
    if (item.service) lines.push(`start_service ${item.service[o.family]}`);
  }
  lines.push('', 'touch "$MARKER"', 'echo "CloudBuilder setup finished."', '');
  return lines.join('\n');
}

/** The user's own startup script, without its first "#!" line, so it can follow the software script in one file. */
function stripShebang(script: string): string {
  return script.replace(/^#![^\n]*\n?/, '');
}

/** The software script followed by whatever the person wrote themselves. Their script alone when nothing is selected. */
export function combineStartupScripts(software: string, own: string): string {
  const mine = own.trim();
  if (software === '') return own;
  return mine === '' ? software : `${software}\n# ── your own startup script ──\n${stripShebang(mine)}\n`;
}
