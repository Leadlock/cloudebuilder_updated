/**
 * Terraform pieces for "server software" on an EC2 instance or an Azure VM (see lib/engines/servers/software.ts): the first-boot script, a current
 * operating-system image found by name instead of a fixed id, and a firewall that opens only the web ports, only to the range the person chose.
 */
import { escapeHclHeredoc } from './hclSafety';
import { validCidr } from '../containers/ec2Deploy';
import { awsFamily, azureFamily, combineStartupScripts, planSoftware, softwareScript, webPorts, type PackageFamily, type SoftwareItem } from '../servers/software';

const q = (v: string) => JSON.stringify(v);

export interface StartupPlan {
  /** The complete script to run at first boot ('' when there is none). */
  script: string;
  items: SoftwareItem[];
  ports: number[];
  warnings: string[];
}

function plan(label: string, cfg: Record<string, unknown>, family: PackageFamily | null, loginUser: string, own: string): StartupPlan {
  const { items, warnings } = planSoftware(cfg['serverSoftware']);
  if (items.length === 0) return { script: own, items: [], ports: [], warnings };
  if (!family) {
    warnings.push(`${label}: software can be installed on Amazon Linux 2023, Ubuntu and Debian (AWS) and Ubuntu and Debian (Azure). This operating system is not one of them, so nothing was installed; the startup script you wrote still runs.`);
    return { script: own, items: [], ports: [], warnings };
  }
  // The person's own script was made safe for a heredoc with the rest of the design; this part is made safe here (the start page text is the only free text in it).
  const script = combineStartupScripts(escapeHclHeredoc(softwareScript(items, { family, loginUser, pageText: String(cfg['serverPageText'] ?? '') })), own);
  const ports = webPorts(items);
  const cidr = String(cfg['webAccessCidr'] ?? '').trim();
  if (ports.length > 0) {
    if (cidr === '') warnings.push(`${label}: ${items.filter((i) => i.ports).map((i) => i.label).join(', ')} will be installed, but no port is open: set "Who can reach the web server" (an IPv4 range, or 0.0.0.0/0 for everyone).`);
    else if (!validCidr(cidr)) warnings.push(`${label}: "Who can reach the web server" must be an IPv4 range such as 203.0.113.0/24. No port was opened.`);
    else if (cidr === '0.0.0.0/0') warnings.push(`${label}: the web ports ${ports.join(' and ')} are open to the whole internet. Narrow "Who can reach the web server" if the site is not public.`);
  }
  return { script, items, ports, warnings };
}

export const awsStartup = (label: string, cfg: Record<string, unknown>): StartupPlan =>
  plan(label, cfg, awsFamily(cfg['os']), /Amazon Linux/i.test(String(cfg['os'] ?? '')) ? 'ec2-user' : 'ubuntu', String(cfg['userData'] ?? ''));

export const azureStartup = (label: string, cfg: Record<string, unknown>): StartupPlan =>
  plan(label, cfg, azureFamily(cfg), String(cfg['adminUsername'] ?? 'azureuser'), String(cfg['customData'] ?? ''));

/** The ports to open: only when the range is valid and a web server is selected. Returns the cidr to use, or null. */
export function openCidr(p: StartupPlan, cfg: Record<string, unknown>): string | null {
  const cidr = String(cfg['webAccessCidr'] ?? '').trim();
  return p.ports.length > 0 && validCidr(cidr) ? cidr : null;
}

// ─── AWS ─────────────────────────────────────────────────────────────────────

const LEGACY_AMI = 'ami-0c55b159cbfafe1f0';
/** Graviton instance families (t4g, c6g, m7g, ...): they need the arm64 image. */
const isArm = (cfg: Record<string, unknown>) => cfg['arch'] === 'arm64' || /^[a-z]+\d+g[a-z]*\./.test(String(cfg['instanceType'] ?? ''));

/** The name of the public SSM parameter that always holds the latest image of this operating system, or null when there is none. */
export function amiParameter(os: unknown, arm: boolean): string | null {
  const v = String(os ?? '');
  if (/Amazon Linux 2023/i.test(v)) return `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${arm ? 'arm64' : 'x86_64'}`;
  if (/Ubuntu 24\.04/i.test(v)) return `/aws/service/canonical/ubuntu/server/24.04/stable/current/${arm ? 'arm64' : 'amd64'}/hvm/ebs-gp3/ami-id`;
  if (/Debian 12/i.test(v)) return `/aws/service/debian/release/12/latest/${arm ? 'arm64' : 'amd64'}`;
  return null;
}

/**
 * The image for an instance: the one the person typed, or (when they typed none, or left the old placeholder, which is a single region's
 * image from years ago) the latest image of the chosen operating system, looked up when Terraform runs.
 */
export function awsImage(name: string, cfg: Record<string, unknown>): { block: string | null; ref: string } {
  const typed = String(cfg['ami'] ?? '').trim();
  const param = amiParameter(cfg['os'], isArm(cfg));
  if ((typed === '' || typed === LEGACY_AMI) && param) {
    return { block: `data "aws_ssm_parameter" "${name}_ami" {\n  name = ${q(param)}\n}`, ref: `data.aws_ssm_parameter.${name}_ami.value` };
  }
  return { block: null, ref: q(typed || LEGACY_AMI) };
}

/** A security group that opens the web ports to one range, and lets the server reach the internet to install its packages. */
export function awsWebSecurityGroup(name: string, subnetRef: string | null, ports: number[], cidr: string): string {
  const vpc = subnetRef ? `\n  vpc_id      = ${subnetRef.replace(/\.id$/, '.vpc_id')}` : '';
  return `resource "aws_security_group" "${name}_web" {
  name        = ${q(`${name}-web`.replace(/_/g, '-'))}
  description = "Web ports of ${name}"${vpc}
${ports.map((p) => `
  ingress {
    description = "Port ${p}"
    from_port   = ${p}
    to_port     = ${p}
    protocol    = "tcp"
    cidr_blocks = [${q(cidr)}]
  }`).join('\n')}

  # Outbound is open so the server can download its packages.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name      = ${q(`${name}-web`)}
    ManagedBy = "CloudBuilder"
  }
}`;
}

// ─── Azure ───────────────────────────────────────────────────────────────────

/** A network security group on the VM's network interface that opens the web ports to one range. */
export function azureWebNsg(name: string, rgName: string, rgLoc: string, ports: number[], cidr: string): string {
  return `resource "azurerm_network_security_group" "${name}_web" {
  name                = ${q(`${name}-web-nsg`.replace(/_/g, '-'))}
  location            = ${rgLoc}
  resource_group_name = ${rgName}
${ports.map((p, i) => `
  security_rule {
    name                       = "web-${p}"
    priority                   = ${100 + i * 10}
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "${p}"
    source_address_prefix      = ${q(cidr)}
    destination_address_prefix = "*"
  }`).join('\n')}

  tags = {
    ManagedBy = "CloudBuilder"
  }
}

resource "azurerm_network_interface_security_group_association" "${name}_web" {
  network_interface_id      = azurerm_network_interface.${name}_nic.id
  network_security_group_id = azurerm_network_security_group.${name}_web.id
}`;
}
