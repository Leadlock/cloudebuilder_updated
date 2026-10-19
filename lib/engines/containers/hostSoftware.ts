/**
 * "Install on the server" for the Container Templates that run on a virtual machine (an EC2 instance or an Azure VM): software installed on the
 * machine itself, next to the container, for example nginx in front of the app or a command-line database client. The script is the same one the
 * canvas nodes use (lib/engines/servers/software.ts). Docker is not offered here: the start-up script already installs it.
 */
import { planSoftware, softwareScript, webPorts, type PackageFamily } from '../servers/software';

/** The software a VM template can install: everything in the catalog except Docker, which is always installed. */
const hostItems = (ids: unknown) => planSoftware(Array.isArray(ids) ? ids.filter((i) => i !== 'docker') : []);

/** Ports (80, 443) the chosen software wants open. */
export const hostPorts = (ids: unknown): number[] => webPorts(hostItems(ids).items);

/**
 * Shell lines for the VM's start-up script: write the install script to a file and run it. A failure is logged (and kept in
 * /var/log/cloudcraft-setup.log) but does not stop the app from starting, because the app is what the template is for.
 */
export function hostSoftwareSh(ids: unknown, o: { family: PackageFamily; loginUser: string; pageText: string }): string {
  const { items } = hostItems(ids);
  if (items.length === 0) return '';
  const body = softwareScript(items, o);
  return `
# Software chosen in CloudBuilder: ${items.map((i) => i.label).join(', ')}. Its log is /var/log/cloudcraft-setup.log.
cat > /usr/local/bin/cloudcraft-software <<'CLOUDCRAFT_SOFTWARE'
${body}CLOUDCRAFT_SOFTWARE
chmod 755 /usr/local/bin/cloudcraft-software
bash /usr/local/bin/cloudcraft-software || echo "Installing the chosen software failed: see /var/log/cloudcraft-setup.log. The app is started anyway."
`;
}

/** Problems with the settings that would produce a broken machine. */
export function validateHostSoftware(prefix: string, ids: unknown, appPort: number): string[] {
  const out: string[] = [];
  if (ids !== undefined && !Array.isArray(ids)) return [`${prefix}: the list of software must be a list.`];
  const { items } = hostItems(ids);
  if (items.some((i) => i.ports) && (appPort === 80 || appPort === 443)) out.push(`${prefix}: the web server needs port 80 and 443, which the app already uses. Change the app port, or leave the web server out.`);
  return out;
}

/** Warnings (never errors) about the chosen software, for a machine whose web ports are open to `allowedCidr`. */
export const hostSoftwareWarnings = (prefix: string, ids: unknown, allowedCidr: string): string[] => {
  const w = hostItems(ids).warnings.map((m) => `${prefix}: ${m}`);
  if (Array.isArray(ids) && ids.includes('docker')) w.push(`${prefix}: Docker is always installed here, so it was not added twice.`);
  if (hostPorts(ids).length > 0 && allowedCidr === '0.0.0.0/0') w.push(`${prefix}: the web server on ports 80 and 443 will be open to the whole internet. Narrow "who can connect" if the site is not public.`);
  return w;
};
