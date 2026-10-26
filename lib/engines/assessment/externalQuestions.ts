/**
 * Review questions for a third-party service in the architecture (Datadog, MongoDB Atlas, Auth0, Stripe, Cloudflare ...).
 *
 * AWS and Azure publish Well-Architected guidance for their own services only. A third-party service cannot be read from the cloud account, so
 * its review rests on what the team answers about it, the same way the workload questionnaire does. Each answer is stored on the service's node
 * (its settings), so a design that uses two services carries two sets of answers, and each gets its own findings.
 *
 * "Yes" passes, "Partly" counts as half a failure, "No" fails, "Not applicable" is left out, "Don't know" is insufficient data and an unanswered
 * question is not evaluated: neither of the last two is ever a pass. Questions are written so that "Yes" is the good answer. The answer is the
 * team's, not something CloudBuilder verified: findings and reports say so.
 */
import type { SecurityCategory, Severity, WaPillarId } from './types';

export interface ExternalQuestion {
  /** Stable id, also the suffix of the setting key and the rule id. Never reuse or renumber. */
  id: string;
  /** Key in the node's configuration that holds the answer ("yes" | "partial" | "no" | "na" | "unknown" | ""). */
  key: string;
  pillar: Extract<WaPillarId, 'security' | 'reliability' | 'operational_excellence' | 'cost_optimization'>;
  severity: Extract<Severity, 'HIGH' | 'MEDIUM' | 'LOW'>;
  category: SecurityCategory;
  /** The setting's label in the node's properties. */
  label: string;
  question: string;
  why: string;
  /** Finding title when the answer is not "Yes". */
  gap: string;
  risk: string;
  recommendation: string;
  steps: readonly string[];
  practice: string;
}

export const EXTERNAL_QUESTIONS: readonly ExternalQuestion[] = [
  {
    id: 'EXT-SEC-01', key: 'q_signin', pillar: 'security', severity: 'MEDIUM', category: 'Identity & access',
    label: 'People sign in with SSO and MFA',
    question: 'Do people reach this service through single sign-on and multi-factor authentication, rather than shared or password-only accounts?',
    why: 'A password-only account on a service holding your data or controlling your systems is one phishing message away from a breach.',
    gap: 'People can sign in to the third-party service without SSO and MFA',
    risk: 'A stolen or shared password gives an attacker the same access as the owner of the account.',
    recommendation: 'Enforce SSO and MFA for every person on the service, and remove shared accounts.',
    steps: ['Connect the service to your identity provider (SAML or OIDC).', 'Require MFA, and turn off password sign-in where the service allows it.', 'Remove shared and unused accounts.'],
    practice: 'Identity management — strong sign-in',
  },
  {
    id: 'EXT-SEC-02', key: 'q_encrypt', pillar: 'security', severity: 'HIGH', category: 'Data protection',
    label: 'Data is encrypted at rest and in transit',
    question: 'Is the data this service holds or receives encrypted at rest and in transit, and do you know who holds the keys?',
    why: 'Data that leaves your account is protected only by what the provider does with it.',
    gap: 'The third-party service does not encrypt your data at rest and in transit, or you cannot tell',
    risk: 'Data can be read in transit or from a stolen disk or backup.',
    recommendation: 'Use the service only over TLS, confirm encryption at rest in the provider\'s security documentation, and prefer customer-managed keys for sensitive data.',
    steps: ['Read the provider\'s security documentation or audit report for encryption at rest and in transit.', 'Disable any plain-text endpoint.', 'Use customer-managed keys where the service offers them for sensitive data.'],
    practice: 'Protecting data at rest and in transit',
  },
  {
    id: 'EXT-SEC-03', key: 'q_access', pillar: 'security', severity: 'MEDIUM', category: 'Identity & access',
    label: 'Keys and roles are least-privilege and rotated',
    question: 'Are the API keys, tokens and roles your workload uses for this service limited to what is needed, stored in a secrets manager, and rotated?',
    why: 'A key with full access that lives in code or an environment file turns one leak into a full compromise of the service.',
    gap: 'Access to the third-party service is broader than needed or its keys are not managed',
    risk: 'A leaked key can read or change everything in the service.',
    recommendation: 'Use a separate, least-privilege key per workload, keep it in a secrets manager and rotate it.',
    steps: ['Create one scoped key or role per workload.', 'Keep keys in AWS Secrets Manager, Parameter Store or Azure Key Vault, never in code.', 'Rotate keys on a schedule and when someone leaves.'],
    practice: 'Permissions management — least privilege',
  },
  {
    id: 'EXT-SEC-04', key: 'q_network', pillar: 'security', severity: 'MEDIUM', category: 'Network exposure',
    label: 'Traffic stays private or is IP-restricted',
    question: 'Does traffic between your workload and this service use a private connection (private link, VPN, peering) or an IP allow-list, rather than the open internet alone?',
    why: 'A service reachable from anywhere depends entirely on its sign-in to keep attackers out.',
    gap: 'The third-party service is reachable from the open internet without network restrictions',
    risk: 'Attackers anywhere can try to reach the service with stolen credentials.',
    recommendation: 'Use the provider\'s private connectivity or restrict access to your workload\'s fixed addresses.',
    steps: ['Check whether the provider offers private link, VPN or peering.', 'Otherwise allow only your NAT or egress addresses.'],
    practice: 'Protecting networks',
  },
  {
    id: 'EXT-SEC-05', key: 'q_assurance', pillar: 'security', severity: 'MEDIUM', category: 'Data protection',
    label: 'Independent audit report reviewed, data agreement in place',
    question: 'Have you reviewed the provider\'s independent audit report (for example SOC 2 or ISO 27001) and signed a data-processing agreement where personal data is involved?',
    why: 'The audit report is the only independent evidence of how the provider runs the service, and the agreement is what binds them to it.',
    gap: 'The third-party provider has not been assessed or contracted for the data it holds',
    risk: 'You carry the compliance risk of a provider you have not assessed.',
    recommendation: 'Obtain and review the provider\'s latest audit report and sign the data-processing agreement before sending it real data.',
    steps: ['Request the SOC 2 Type II or ISO 27001 report and read the exceptions.', 'Sign the data-processing agreement.', 'Record the review date and set a yearly reminder.'],
    practice: 'Governance — supplier assurance',
  },
  {
    id: 'EXT-SEC-06', key: 'q_residency', pillar: 'security', severity: 'MEDIUM', category: 'Data protection',
    label: 'Data location meets residency rules',
    question: 'Is the data held in a region that meets your data-residency and regulatory requirements, and do you know where backups and support staff are?',
    why: 'Where data lives decides which laws apply to it and who can compel access to it.',
    gap: 'The location of data held by the third-party service is not confirmed against residency rules',
    risk: 'Data may be stored or accessed from a place your regulations do not allow.',
    recommendation: 'Choose the service\'s region deliberately and confirm where backups and support access sit.',
    steps: ['Select the region in the service\'s settings.', 'Ask the provider where backups and support access are.', 'Record the answer with your compliance team.'],
    practice: 'Data classification and residency',
  },
  {
    id: 'EXT-SEC-07', key: 'q_audit', pillar: 'security', severity: 'LOW', category: 'Logging & audit',
    label: 'Its audit logs are kept and reviewable',
    question: 'Can you see who did what in this service (its audit log), and are those logs kept or sent to your own logging?',
    why: 'Without an audit trail you cannot tell what an attacker or a mistake changed.',
    gap: 'There is no usable audit trail for the third-party service',
    risk: 'A breach or a bad change cannot be investigated.',
    recommendation: 'Turn on the service\'s audit log and send it to your own log store where possible.',
    steps: ['Enable audit logging in the service.', 'Stream or export the log to your logging account.'],
    practice: 'Detection — logging',
  },
  {
    id: 'EXT-REL-01', key: 'q_sla', pillar: 'reliability', severity: 'MEDIUM', category: 'Resilience',
    label: 'Its availability SLA meets the workload\'s needs',
    question: 'Do you know the provider\'s availability commitment (SLA), and is it as high as what your workload promises its own users?',
    why: 'Your workload cannot be more available than the services it depends on.',
    gap: 'The third-party service\'s availability is not confirmed against the workload\'s needs',
    risk: 'An outage at the provider takes your workload down beyond what you promised.',
    recommendation: 'Compare the provider\'s SLA with your own target and plan for the difference.',
    steps: ['Find the provider\'s SLA and its exclusions.', 'Compare it with your availability target.'],
    practice: 'Workload architecture — dependencies',
  },
  {
    id: 'EXT-REL-02', key: 'q_degrade', pillar: 'reliability', severity: 'HIGH', category: 'Resilience',
    label: 'The workload copes when it is down',
    question: 'If this service is slow or unavailable, does your workload keep working in a reduced way (timeouts, retries with back-off, a fallback), rather than failing completely?',
    why: 'A hard dependency without timeouts turns the provider\'s outage into yours.',
    gap: 'The workload fails completely when the third-party service is unavailable',
    risk: 'One outage at the provider stops your whole workload.',
    recommendation: 'Add timeouts, retries with back-off and a degraded mode, and test it by switching the service off.',
    steps: ['Set short timeouts on every call.', 'Retry with exponential back-off and jitter.', 'Decide what the workload does without the service, and test it.'],
    practice: 'Failure management — graceful degradation',
  },
  {
    id: 'EXT-REL-03', key: 'q_backup', pillar: 'reliability', severity: 'HIGH', category: 'Data protection',
    label: 'Its data is backed up and a restore has been tried',
    question: 'If the service holds data you cannot recreate, is it backed up (by the provider or exported by you) and have you tested getting it back?',
    why: 'Providers delete data by accident, lose it in incidents, and close accounts. A backup you have never restored is a hope.',
    gap: 'Data held by the third-party service has no tested backup',
    risk: 'Permanent data loss.',
    recommendation: 'Back the data up outside the service, or confirm and test the provider\'s own backups and restore.',
    steps: ['Find out what the provider backs up and for how long.', 'Export the data on a schedule to your own storage.', 'Practise a restore.'],
    practice: 'Backup and recovery',
  },
  {
    id: 'EXT-REL-04', key: 'q_exit', pillar: 'reliability', severity: 'MEDIUM', category: 'Resilience',
    label: 'There is an exit plan',
    question: 'Could you export your data in a usable format and replace this service within a time you could live with (an exit plan)?',
    why: 'A provider can raise prices, change terms, be acquired or shut down.',
    gap: 'There is no exit plan for the third-party service',
    risk: 'You are locked in, and a change on the provider\'s side becomes an emergency for you.',
    recommendation: 'Write down how to export the data and what would replace the service, and keep the export working.',
    steps: ['Check what export formats the service offers.', 'Name a replacement and the effort to move.', 'Try the export once a year.'],
    practice: 'Change management — supplier exit',
  },
  {
    id: 'EXT-OPS-01', key: 'q_monitor', pillar: 'operational_excellence', severity: 'MEDIUM', category: 'Operations',
    label: 'Its health is monitored and alerts reach the team',
    question: 'Do you monitor this service\'s health (its status page, your own checks of calls to it) and do alerts reach someone who will act?',
    why: 'Customers often notice a provider problem before you do unless you watch for it.',
    gap: 'The third-party service is not monitored',
    risk: 'Outages and slowdowns are found by customers, not by the team.',
    recommendation: 'Subscribe to the provider\'s status feed and alert on failed or slow calls to it.',
    steps: ['Subscribe to the provider\'s status notifications.', 'Alarm on error rate and latency of calls to the service.'],
    practice: 'Understanding workload health',
  },
  {
    id: 'EXT-OPS-02', key: 'q_owner', pillar: 'operational_excellence', severity: 'LOW', category: 'Operations',
    label: 'It has an owner and a support route',
    question: 'Is there a named owner for this service on your side, and a support contract or route that fits how much the workload depends on it?',
    why: 'When something breaks at 3 a.m. someone must know whom to call and the provider must answer.',
    gap: 'The third-party service has no named owner or suitable support route',
    risk: 'Slow response to incidents and unmanaged renewals, access and cost.',
    recommendation: 'Name an owner, and choose a support plan that matches the service\'s importance.',
    steps: ['Record the owner and a deputy.', 'Check the support plan\'s response times against your needs.'],
    practice: 'Organization — ownership',
  },
  {
    id: 'EXT-COST-01', key: 'q_cost', pillar: 'cost_optimization', severity: 'LOW', category: 'Cost',
    label: 'Its cost is tracked and capped',
    question: 'Is the cost of this service tracked, with a budget or usage alert, so a usage spike does not become a surprise bill?',
    why: 'Usage-based services can grow faster than the budget they were chosen for.',
    gap: 'The cost of the third-party service is not tracked or capped',
    risk: 'Unexpected bills and unused licences.',
    recommendation: 'Set a budget alert or usage cap and review the bill monthly.',
    steps: ['Set a spend or usage alert in the service.', 'Review the invoice against what is used each month.'],
    practice: 'Expenditure awareness',
  },
];
