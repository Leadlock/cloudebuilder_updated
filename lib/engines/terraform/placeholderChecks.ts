/**
 * Problems in the generated Terraform that AWS would only report halfway through an apply, after other resources were already built:
 *
 *  - a value that is still a placeholder (REPLACE-WITH-YOUR-CERTIFICATE-ID, a container image): the design names what to supply but
 *    nobody has supplied it;
 *  - a Route 53 hosted zone for a domain AWS reserves (example.com and its relatives), which AWS refuses with "reserved by AWS".
 *
 * Found by a real deployment that built 45 resources and then failed on exactly these two. Each is reported once, by resource, in plain
 * words, so the plan stops here instead.
 */

export interface GeneratedFile { filename: string; content: string }

const PLACEHOLDER = /REPLACE-WITH-YOUR-([A-Z0-9-]+)/;

const HINTS: Record<string, string> = {
  'CERTIFICATE-ID': 'Enter the ARN of your ACM certificate (AWS Certificate Manager, in the same region), or, for a test only, set the load balancer listener to HTTP.',
  'CONTAINER-IMAGE': 'Enter the container image to run, for example nginx:latest for a test or your own image URI.',
};

/** Domains AWS will not create a hosted zone for, and the names that can never be a real domain. */
const RESERVED_DOMAIN = /(^|\.)(example\.(com|net|org)|example|invalid|test|localhost|local)$/i;

export function isReservedDomain(name: string): boolean {
  return RESERVED_DOMAIN.test(name.trim().replace(/\.$/, ''));
}

/** One plain-language problem per resource, for every placeholder or reserved domain in the generated files. */
export function placeholderProblems(files: GeneratedFile[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const add = (key: string, text: string) => { if (!seen.has(key)) { seen.add(key); problems.push(text); } };

  for (const file of files) {
    if (!file.filename.endsWith('.tf') && !file.filename.endsWith('.tfvars')) continue;
    let current = '';
    for (const line of file.content.split('\n')) {
      const header = /^\s*(resource|data)\s+"([a-z0-9_]+)"\s+"([^"]+)"/.exec(line);
      if (header) current = `${header[1] === 'data' ? 'data.' : ''}${header[2]}.${header[3]}`;

      const placeholder = PLACEHOLDER.exec(line);
      if (placeholder) {
        const kind = placeholder[1]!;
        const where = current || file.filename;
        add(`ph|${where}|${kind}`, `${where} still has the placeholder value "REPLACE-WITH-YOUR-${kind}". AWS would refuse it, and only after other resources were already built. ${HINTS[kind] ?? 'Replace it with your real value.'}`);
      }

      if (current.startsWith('aws_route53_zone.')) {
        const zone = /^\s*name\s*=\s*"([^"]+)"/.exec(line);
        if (zone && isReservedDomain(zone[1]!)) {
          add(`dom|${current}`, `The Route 53 hosted zone ${current} is for "${zone[1]}", a domain AWS reserves, so it cannot be created ("InvalidDomainName: reserved by AWS"). AWS only says so when it gets to the zone, after other resources already exist. Enter the real domain you own on the Route 53 resource, or remove Route 53 from the design.`);
        }
      }
    }
  }
  return problems;
}
