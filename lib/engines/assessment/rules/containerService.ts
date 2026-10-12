/**
 * Assessment rules for the "Container service" canvas node (aws_container_service): a Docker container on one EC2 instance.
 *
 * AWS-CTR-001 and -003 have no Auto-Fix: what they check lives in the Dockerfile and the workflow, which Container Templates generates, so a change
 * to the setting alone would not change what Terraform creates. Fix them in Container Templates.
 *
 * They read the same plain settings the resource definition shows (lib/resources/aws.ts) and Container Templates uses, so a finding here
 * matches the finding the same configuration gets in the panel (lib/engines/containers/checks.ts). The instance itself is generated with
 * IMDSv2 only, an encrypted disk, no SSH and ECR scan on push (lib/engines/terraform/containerService.ts), so those need no rule.
 */
import type { RuleDefinition } from '../types';
import { REVIEWED, configEvaluator, rule, PUBLIC_CIDRS } from '../ruleHelpers';

const V = '1.0.0';
const TF = 'TF-AWS';
const common = { version: V, lastReviewed: REVIEWED, provider: 'aws' as const, service: 'Container service (Docker on EC2)', scope: 'resource' as const, resourceTypes: ['aws_container_service'] };
const WA = {
  sec: (practice: string) => ({ pillar: 'security' as const, practice }),
};
/** Ports of databases and caches: a container service listening on one of these is almost certainly not meant for the internet. */
const DATA_PORTS = new Set([1433, 3306, 5432, 5984, 6379, 9200, 11211, 27017]);

export const containerServiceRules: RuleDefinition[] = [
  rule({
    ...common,
    id: 'AWS-CTR-001',
    domain: 'SECURITY', category: 'Workload hardening', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'The container runs as the root user',
    description: 'The container process runs as root inside the container.',
    rationale: 'CIS Docker Benchmark 4.1: run containers as a non-root user. A compromised app then has root inside the container, which makes escaping it easier.',
    risk: 'A flaw in the app gives the attacker root in the container.', impact: 'Easier container escape and wider damage from an app compromise.',
    wellArchitected: WA.sec('SEC 3 — Manage permissions'),
    references: ['AWS-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Run the container as a non-root user (the Dockerfile from Container Templates does this when "Run as non-root" is on).', manualSteps: ['Turn on "Run as non-root user".', 'Rebuild and push the image.', 'Check the app does not write outside its own folders.'] },
    evaluate: configEvaluator(['runAsNonRoot'], { runAsNonRoot: 'Enabled / Yes' }, (c) => c.runAsNonRoot === false
      ? { status: 'FAIL', observation: 'The container runs as root.' }
      : { status: 'PASS', observation: 'The container runs as a non-root user.' }),
  }),
  rule({
    ...common,
    id: 'AWS-CTR-002',
    domain: 'SECURITY', category: 'Network exposure', severity: 'MEDIUM', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'The container port is open to the whole internet',
    description: 'The security group lets any address connect to the app port.',
    rationale: 'Open to everyone is right for a public website and wrong for an internal tool or an API with no login. Raised to HIGH when the port is a database or cache port.',
    risk: 'The app is reachable by anyone.', impact: 'Larger attack surface and exposure of anything the app serves.',
    wellArchitected: WA.sec('SEC 5 — Protect network resources'),
    references: ['AWS-WA-security', TF],
    soc1: ['SOC1-LA-01'],
    remediation: { recommendation: 'Limit "Who can connect" to your own network or a load balancer, or put the service behind an Application Load Balancer with a WAF.', manualSteps: ['Set the allowed range to your office, VPN or VPC range.'] },
    autoFix: {
      safety: 'MANUAL_ONLY', safetyReason: 'Only you know who is supposed to reach the app; narrowing it blindly could cut off real users.',
      description: 'Manual: set the range that may connect.', patch: () => ({}),
      architectureImpact: 'Only the range you choose can connect.', costImpact: 'NONE',
    },
    evaluate: configEvaluator(['allowedCidr'], { allowedCidr: 'A private range' }, (c) => {
      const open = PUBLIC_CIDRS.has(String(c.allowedCidr));
      if (!open) return { status: 'PASS', observation: `Only ${String(c.allowedCidr)} can connect.` };
      const dataPort = DATA_PORTS.has(Number(c.port));
      return { status: 'FAIL', severity: dataPort ? 'HIGH' : 'MEDIUM', observation: `Any address can connect to port ${String(c.port)}${dataPort ? ', which is a database or cache port' : ''}.` };
    }, ['port']),
  }),
  rule({
    ...common,
    id: 'AWS-CTR-003',
    domain: 'SECURITY', category: 'Workload hardening', severity: 'LOW', priority: 'RECOMMENDED_IMPROVEMENT',
    title: 'Images are pushed without a vulnerability scan',
    description: 'The deploy workflow does not scan the image before it is pushed.',
    rationale: 'A known vulnerability in a base image or library goes live unnoticed. ECR scans on push, but only after the image is stored; the workflow scan stops it first.',
    risk: 'Vulnerable images are deployed.', impact: 'Known exploits reach production.',
    wellArchitected: WA.sec('SEC 6 — Protect compute resources'),
    references: ['AWS-WA-security', TF],
    soc1: ['SOC1-OP-02'],
    remediation: { recommendation: 'Turn on the Trivy scan in the generated GitHub Actions workflow.', manualSteps: ['Turn on "Scan the image for vulnerabilities".', 'Regenerate the workflow in Container Templates.'] },
    evaluate: configEvaluator(['scanImage'], { scanImage: 'Enabled / Yes' }, (c) => c.scanImage === false
      ? { status: 'FAIL', observation: 'The image is not scanned before it is pushed.' }
      : { status: 'PASS', observation: 'The image is scanned (Trivy) before it is pushed.' }),
  }),
  rule({
    ...common,
    id: 'AWS-CTR-004',
    domain: 'OPERATIONAL_EXCELLENCE', category: 'Operations', severity: 'LOW', priority: 'OPTIONAL_OPTIMIZATION',
    title: 'The deployed image tag is "latest"',
    description: 'The instance runs whatever image carries the tag "latest" at the time it starts.',
    rationale: 'A floating tag makes it unclear which build is running and prevents a rollback to a named version.',
    risk: 'An unknown build is running; a bad push is live at the next restart.', impact: 'Slower incident response and no clean rollback.',
    wellArchitected: { pillar: 'operational_excellence' as const, practice: 'Perform operations as code' },
    references: ['AWS-WA-operational_excellence', TF],
    soc1: ['SOC1-OP-02'],
    remediation: { recommendation: 'Deploy a version tag, for example the commit id.', manualSteps: ['Set an image tag such as v1 or the commit id.', 'Push the image with that tag.'] },
    autoFix: {
      safety: 'MANUAL_ONLY', safetyReason: 'The tag has to exist in the image repository; only you know which one to use.',
      description: 'Manual: set a version tag.', patch: () => ({}),
      architectureImpact: 'The instance runs a named build.', costImpact: 'NONE',
    },
    evaluate: configEvaluator(['imageTag'], { imageTag: 'A version tag' }, (c) => c.imageTag === 'latest'
      ? { status: 'FAIL', observation: 'The image tag is "latest".' }
      : { status: 'PASS', observation: `The image tag is ${String(c.imageTag)}.` }),
  }),
];
