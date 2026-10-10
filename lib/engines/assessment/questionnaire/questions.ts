/**
 * Well-Architected questionnaire: the questions a diagram cannot answer.
 *
 * CloudCraft's automated checks read the architecture as drawn, which says almost nothing about how a workload is run: deployment
 * habits, on-call, backups that have actually been restored, who owns the budget. A real Well-Architected review is mostly about those
 * things, so four of the six pillars rested on one to five automated checks. These questions fill that gap.
 *
 * How they count (see questionRules.ts): each answered question is one check in its pillar, weighted by its severity, exactly like an
 * automated check. "Yes" passes, "Partly" counts as half a failure, "No" fails. An unanswered question is NOT EVALUATED and a "Don't
 * know" is INSUFFICIENT DATA: neither is ever treated as a pass, they only lower coverage.
 *
 * Questions are cloud-neutral and shared: one answer counts under the AWS framework and the Azure framework when a design uses both.
 * Sustainability is an AWS pillar only (the Azure Well-Architected Framework has five pillars), so those questions apply to AWS.
 */
import type { SecurityCategory, Severity, WaPillarId } from '../types';

export type QuestionAnswer = 'yes' | 'partial' | 'no' | 'na' | 'unknown';

export const QUESTION_ANSWERS: readonly QuestionAnswer[] = ['yes', 'partial', 'no', 'na', 'unknown'];

export const ANSWER_LABEL: Record<QuestionAnswer, string> = {
  yes: 'Yes',
  partial: 'Partly',
  no: 'No',
  na: 'Not applicable',
  unknown: "Don't know",
};

export interface QuestionDefinition {
  /** Stable key stored with the answer, e.g. "REL-01". Never reuse or renumber an id. */
  id: string;
  pillar: WaPillarId;
  /** Which frameworks the question belongs to. Sustainability is AWS only. */
  providers: ReadonlyArray<'aws' | 'azure'>;
  /** Severity when the answer is "No". Only a few are HIGH: those are the ones where the gap can cause an outage or a breach by itself. */
  severity: Extract<Severity, 'HIGH' | 'MEDIUM' | 'LOW'>;
  category: SecurityCategory;
  /** The question as asked. Written so that "Yes" is the good answer. */
  question: string;
  /** One sentence on why it matters. */
  why: string;
  /** Finding title when the answer is not "Yes". */
  gap: string;
  /** What the person is risking by not having it. */
  risk: string;
  recommendation: string;
  steps: readonly string[];
  /** Framework practice label, descriptive rather than numbered. */
  practice: string;
}

const both = ['aws', 'azure'] as const;
const aws = ['aws'] as const;

export const QUESTIONS: readonly QuestionDefinition[] = [
  // ── Operational Excellence ────────────────────────────────────────────────
  {
    id: 'OPS-01', pillar: 'operational_excellence', providers: both, severity: 'MEDIUM', category: 'Operations',
    question: 'Is the workload deployed by an automated pipeline from infrastructure as code, rather than by hand in the console?',
    why: 'Hand-made changes cannot be reviewed, repeated or rolled back, and they drift away from what the design says.',
    gap: 'Deployments are not fully automated',
    risk: 'Changes that nobody reviewed, environments that differ from each other, and slow, error-prone releases.',
    recommendation: 'Deploy through a pipeline from version-controlled infrastructure as code (the Terraform CloudCraft generates is a starting point).',
    steps: ['Keep the infrastructure code in version control and require review of changes.', 'Run plan and apply from a pipeline, not from a laptop or the console.'],
    practice: 'Design for operations — automate deployment',
  },
  {
    id: 'OPS-02', pillar: 'operational_excellence', providers: both, severity: 'MEDIUM', category: 'Operations',
    question: 'Can you roll back a bad release quickly, using a rollback you have actually tried?',
    why: 'The speed of recovery from a bad change decides how long customers are affected.',
    gap: 'There is no tested way to roll back a release',
    risk: 'A faulty release stays in production while people work out how to undo it.',
    recommendation: 'Use a deployment approach that supports quick reversal (blue/green, canary or versioned releases) and rehearse the rollback.',
    steps: ['Keep the previous version deployable.', 'Practise a rollback in a non-production environment and time it.'],
    practice: 'Mitigate deployment risks',
  },
  {
    id: 'OPS-03', pillar: 'operational_excellence', providers: both, severity: 'MEDIUM', category: 'Operations',
    question: 'Are there written runbooks or playbooks for the common operational tasks and incidents?',
    why: 'Under pressure people skip steps and rely on whoever happens to remember the procedure.',
    gap: 'There are no runbooks for routine tasks and incidents',
    risk: 'Slow, inconsistent response that depends on individuals.',
    recommendation: 'Write a short runbook for each alarm and each routine task, and keep them where the on-call person can find them.',
    steps: ['List the alarms the workload raises and write a first-response runbook for each.', 'Review the runbooks after every incident.'],
    practice: 'Prepare — document operational procedures',
  },
  {
    id: 'OPS-04', pillar: 'operational_excellence', providers: both, severity: 'HIGH', category: 'Monitoring',
    question: 'Is there an on-call rotation, with alerts that reach a person and a clear escalation path?',
    why: 'An alarm that nobody receives is the same as no alarm.',
    gap: 'Alerts do not reliably reach someone who can act',
    risk: 'Outages are found by customers, and handled late.',
    recommendation: 'Route alarms to an on-call rotation (paging or chat with acknowledgement) and define who escalates to whom.',
    steps: ['Send alarms to a paging or on-call tool, not only to an inbox.', 'Write down the escalation path and review it when the team changes.'],
    practice: 'Operate — respond to events',
  },
  {
    id: 'OPS-05', pillar: 'operational_excellence', providers: both, severity: 'LOW', category: 'Operations',
    question: 'After an incident, do you hold a blameless review and track the follow-up actions to completion?',
    why: 'Without a review the same failure returns.',
    gap: 'Incidents are not reviewed and followed up',
    risk: 'Repeated incidents from the same causes.',
    recommendation: 'Hold a short blameless review after each significant incident and track the actions like any other work.',
    steps: ['Record what happened, why, and what changes.', 'Assign an owner and a date to every action.'],
    practice: 'Evolve — learn from operations',
  },
  {
    id: 'OPS-06', pillar: 'operational_excellence', providers: both, severity: 'MEDIUM', category: 'Monitoring',
    question: 'Do you define and watch service-level indicators or objectives (availability, error rate, latency) for this workload?',
    why: 'You cannot tell whether the workload is healthy, or getting worse, without a measure of what healthy means.',
    gap: 'There are no service-level indicators or objectives',
    risk: 'Degradation goes unnoticed until customers complain.',
    recommendation: 'Pick a few indicators that reflect the customer experience, set targets, and alert when they are at risk.',
    steps: ['Choose availability, error rate and latency indicators.', 'Set a target for each and alert on the budget being used up.'],
    practice: 'Operate — understand workload health',
  },
  {
    id: 'OPS-07', pillar: 'operational_excellence', providers: both, severity: 'LOW', category: 'Operations',
    question: 'Are changes peer-reviewed and tested in a non-production environment before they reach production?',
    why: 'A second pair of eyes and a test environment catch most mistakes cheaply.',
    gap: 'Changes reach production without review or pre-production testing',
    risk: 'Preventable mistakes reach customers.',
    recommendation: 'Require review for every change and promote through a test environment first.',
    steps: ['Enforce review in the code host.', 'Deploy to a test environment that mirrors production before releasing.'],
    practice: 'Design for operations — test changes',
  },
  {
    id: 'OPS-08', pillar: 'operational_excellence', providers: both, severity: 'LOW', category: 'Operations',
    question: 'Is it clear who owns the workload and each of its components, and is the team trained to operate them?',
    why: 'Unowned components are the ones that are not patched, monitored or fixed.',
    gap: 'Ownership of the workload and its components is unclear',
    risk: 'Gaps in operation, and slow decisions during incidents.',
    recommendation: 'Name an owner for the workload and for each component, and make sure the team can operate what it owns.',
    steps: ['Record the owner of each component, for example as a tag.', 'Check that more than one person can operate each one.'],
    practice: 'Organization — define ownership',
  },

  // ── Reliability ───────────────────────────────────────────────────────────
  {
    id: 'REL-01', pillar: 'reliability', providers: both, severity: 'HIGH', category: 'Resilience',
    question: 'In the last 12 months, have you restored the workload\'s data from a backup in a test, and checked that it worked?',
    why: 'A backup that has never been restored is a hope, not a recovery plan.',
    gap: 'Backups have not been tested by restoring them',
    risk: 'Data that cannot be recovered when it is needed, discovered only during an incident.',
    recommendation: 'Restore from a recent backup into a test environment on a schedule, and verify the data and the time it took.',
    steps: ['Schedule a restore test at least once a year, ideally automated.', 'Record how long it took and what had to be done by hand.'],
    practice: 'Back up data — verify recovery',
  },
  {
    id: 'REL-02', pillar: 'reliability', providers: both, severity: 'MEDIUM', category: 'Resilience',
    question: 'Have you agreed and written down how long the workload may be down (RTO) and how much data it may lose (RPO)?',
    why: 'These two numbers decide the whole design of backup and failover; without them you cannot tell if it is good enough.',
    gap: 'Recovery time and recovery point objectives are not defined',
    risk: 'A design that is too weak for what the business needs, or far more expensive than it needs to be.',
    recommendation: 'Agree RTO and RPO with the business, write them down, and check the design meets them.',
    steps: ['Ask the business how long an outage and how much data loss is acceptable.', 'Compare with the backup, replication and failover design.'],
    practice: 'Plan for disaster recovery — define objectives',
  },
  {
    id: 'REL-03', pillar: 'reliability', providers: both, severity: 'HIGH', category: 'Resilience',
    question: 'Have you tested failover or disaster recovery in the last 12 months?',
    why: 'Recovery steps that have never been exercised fail in ways nobody expected.',
    gap: 'Disaster recovery and failover have not been tested',
    risk: 'A real failure turns into a long outage while the procedure is worked out.',
    recommendation: 'Run a failover or disaster-recovery exercise at least yearly and fix what it exposes.',
    steps: ['Fail over a non-critical environment, or run a tabletop exercise with the real runbook.', 'Record the gaps and fix them.'],
    practice: 'Plan for disaster recovery — test it',
  },
  {
    id: 'REL-04', pillar: 'reliability', providers: both, severity: 'MEDIUM', category: 'Resilience',
    question: 'Do you load-test or capacity-plan, so you know the limits of the workload before peak traffic arrives?',
    why: 'The first time you find the limit should not be during a launch or a sale.',
    gap: 'Capacity limits are not tested or planned',
    risk: 'Outages at the busiest moments, when they cost the most.',
    recommendation: 'Load-test against the expected peak plus a margin, and plan capacity from the result.',
    steps: ['Test with realistic traffic at and above the expected peak.', 'Note the first thing that gives way and fix or scale it.'],
    practice: 'Design for scaling — know your limits',
  },
  {
    id: 'REL-05', pillar: 'reliability', providers: both, severity: 'MEDIUM', category: 'Resilience',
    question: 'Do you know the service quotas and limits the workload depends on, and are you alerted before you reach them?',
    why: 'Quotas are a common, avoidable cause of outages and failed scale-outs.',
    gap: 'Service quotas are not tracked',
    risk: 'Scaling or deployment fails because a limit was reached without warning.',
    recommendation: 'List the quotas that matter, alert when usage nears them, and raise them ahead of need.',
    steps: ['Review quotas for the services in the design.', 'Create alerts at about 80% of each important quota.'],
    practice: 'Manage service quotas and constraints',
  },
  {
    id: 'REL-06', pillar: 'reliability', providers: both, severity: 'LOW', category: 'Resilience',
    question: 'Do you run game days or failure-injection tests to confirm the workload copes when parts fail?',
    why: 'Resilience you have not tested is a belief, not a property.',
    gap: 'Resilience is not tested with game days or failure injection',
    risk: 'Failure modes are found in production.',
    recommendation: 'Practise failures on purpose (an instance, a zone, a dependency) and confirm the workload recovers by itself.',
    steps: ['Start in a test environment with one failure at a time.', 'Fix whatever does not recover automatically.'],
    practice: 'Test reliability',
  },

  // ── Security ──────────────────────────────────────────────────────────────
  {
    id: 'SEC-01', pillar: 'security', providers: both, severity: 'HIGH', category: 'Identity & access',
    question: 'Do people sign in through single sign-on with multi-factor authentication, with no shared accounts or long-lived access keys?',
    why: 'Stolen or shared credentials are the most common way in.',
    gap: 'Human access does not use single sign-on with MFA',
    risk: 'Account takeover through a leaked password or key, with no way to tell who did what.',
    recommendation: 'Use your identity provider for all human access, require MFA, and replace long-lived keys with short-lived credentials.',
    steps: ['Federate sign-in to your identity provider and enforce MFA.', 'Remove shared accounts and rotate or delete long-lived access keys.'],
    practice: 'Identity and access management',
  },
  {
    id: 'SEC-02', pillar: 'security', providers: both, severity: 'MEDIUM', category: 'Identity & access',
    question: 'Are permissions limited to what each person and service needs, and reviewed at least every quarter?',
    why: 'Access tends to accumulate; unreviewed access is unnecessary attack surface.',
    gap: 'Permissions are not reviewed or kept to least privilege',
    risk: 'Excess access that can be misused, by mistake or by an attacker.',
    recommendation: 'Grant least privilege, remove unused access, and review who can do what on a regular schedule.',
    steps: ['Review roles and users at least quarterly.', 'Remove permissions that have not been used.'],
    practice: 'Identity and access management — least privilege',
  },
  {
    id: 'SEC-03', pillar: 'security', providers: both, severity: 'HIGH', category: 'Key management',
    question: 'Are secrets (passwords, tokens, keys) kept in a secrets manager and rotated, instead of in code or configuration files?',
    why: 'Secrets in source control or images are copied everywhere and almost never rotated.',
    gap: 'Secrets are stored in code or configuration, or are not rotated',
    risk: 'A leaked repository or image hands an attacker working credentials.',
    recommendation: 'Move secrets to a secrets manager, fetch them at runtime, and rotate them on a schedule.',
    steps: ['Search the code and images for embedded secrets and remove them.', 'Store and rotate them in a managed secrets service.'],
    practice: 'Protect data — manage secrets',
  },
  {
    id: 'SEC-04', pillar: 'security', providers: both, severity: 'MEDIUM', category: 'Threat detection',
    question: 'Is there a written incident-response plan for security events, and has it been exercised?',
    why: 'In a breach the first hours decide the damage, and nobody should be inventing the process then.',
    gap: 'There is no exercised incident-response plan',
    risk: 'Slow, disorganised response to a security event.',
    recommendation: 'Write a plan covering roles, contacts, containment and communication, and rehearse it.',
    steps: ['Name who leads, who decides and who communicates.', 'Run a tabletop exercise at least once a year.'],
    practice: 'Incident response',
  },
  {
    id: 'SEC-05', pillar: 'security', providers: both, severity: 'MEDIUM', category: 'Workload hardening',
    question: 'Are operating-system and dependency patches applied on a defined schedule, including urgent security fixes?',
    why: 'Most exploited vulnerabilities already have a fix available.',
    gap: 'Patching is not done on a defined schedule',
    risk: 'Known vulnerabilities stay exploitable for months.',
    recommendation: 'Patch on a regular cadence, with a faster path for critical security fixes, and rebuild images rather than patching by hand.',
    steps: ['Define how quickly critical and routine patches must be applied.', 'Track dependencies and base images for known vulnerabilities.'],
    practice: 'Protect compute resources',
  },
  {
    id: 'SEC-06', pillar: 'security', providers: both, severity: 'MEDIUM', category: 'Data protection',
    question: 'Is the data classified, with retention and deletion rules that match the compliance requirements you must meet?',
    why: 'You cannot protect, retain or delete data correctly if you do not know what it is.',
    gap: 'Data is not classified and retention rules are not defined',
    risk: 'Sensitive data handled like ordinary data, and retention or deletion obligations missed.',
    recommendation: 'Classify the data the workload handles and set protection, retention and deletion rules for each class.',
    steps: ['List the kinds of data stored and how sensitive each is.', 'Set retention and deletion for each and check it against your compliance needs.'],
    practice: 'Data protection — classify data',
  },

  // ── Performance Efficiency ────────────────────────────────────────────────
  {
    id: 'PERF-01', pillar: 'performance_efficiency', providers: both, severity: 'MEDIUM', category: 'Performance',
    question: 'Have you set performance targets (for example response time and throughput) and measured the workload against them?',
    why: 'Without a target there is no way to say the workload is fast enough, or to notice it getting slower.',
    gap: 'Performance targets are not defined or measured',
    risk: 'Slowness that nobody can quantify, and tuning effort spent on the wrong things.',
    recommendation: 'Define a few performance targets that reflect the user experience and measure against them regularly.',
    steps: ['Pick response-time and throughput targets.', 'Measure them in production and in tests.'],
    practice: 'Architecture selection — define targets',
  },
  {
    id: 'PERF-02', pillar: 'performance_efficiency', providers: both, severity: 'MEDIUM', category: 'Performance',
    question: 'Do you collect performance metrics and traces, and review them regularly?',
    why: 'Bottlenecks show up in the data long before they show up as complaints.',
    gap: 'Performance is not monitored or reviewed',
    risk: 'Gradual degradation and bottlenecks that are found late.',
    recommendation: 'Collect metrics and distributed traces for the main user journeys and review the dashboards on a schedule.',
    steps: ['Build a dashboard for the key journeys.', 'Review it regularly and after every release.'],
    practice: 'Monitor performance',
  },
  {
    id: 'PERF-03', pillar: 'performance_efficiency', providers: both, severity: 'LOW', category: 'Performance',
    question: 'Do you re-evaluate instance types and services at least once a year for better price-performance?',
    why: 'New instance families and services are often faster and cheaper than what was chosen years ago.',
    gap: 'Instance and service choices are not revisited',
    risk: 'Paying more for less performance than is available.',
    recommendation: 'Review compute and database choices yearly against the current offerings and test promising ones.',
    steps: ['List the largest costs and their instance or service types.', 'Benchmark a newer option before changing.'],
    practice: 'Evolve — keep up with new offerings',
  },
  {
    id: 'PERF-04', pillar: 'performance_efficiency', providers: both, severity: 'LOW', category: 'Performance',
    question: 'Is performance tested as part of each release, so slowdowns are caught before production?',
    why: 'A slowdown found in a pipeline costs minutes; the same one found in production costs customers.',
    gap: 'Performance is not tested as part of releases',
    risk: 'Regressions reach production unnoticed.',
    recommendation: 'Add a performance check to the release pipeline and fail the release when targets are missed.',
    steps: ['Add a repeatable performance test to the pipeline.', 'Compare each release with the previous result.'],
    practice: 'Test performance',
  },
  {
    id: 'PERF-05', pillar: 'performance_efficiency', providers: both, severity: 'LOW', category: 'Performance',
    question: 'Do you review slow queries and database indexes on a regular basis?',
    why: 'Database access is the most common performance bottleneck, and a missing index is its most common cause.',
    gap: 'Slow queries and indexes are not reviewed',
    risk: 'Growing latency and load on the database as data grows.',
    recommendation: 'Capture slow queries and review them and the indexes regularly, especially after data growth.',
    steps: ['Turn on slow-query logging or a performance tool.', 'Review the top queries each month.'],
    practice: 'Data management — optimize access',
  },

  // ── Cost Optimization ─────────────────────────────────────────────────────
  {
    id: 'COST-01', pillar: 'cost_optimization', providers: both, severity: 'MEDIUM', category: 'Cost',
    question: 'Does someone own the cloud budget for this workload, with alerts when spending goes above plan?',
    why: 'Cost problems are cheapest to fix in the first week and most expensive in the first quarter.',
    gap: 'There is no owned budget with spending alerts',
    risk: 'Surprise bills and no one accountable for them.',
    recommendation: 'Name a budget owner, set a budget, and alert on forecast and actual overspend.',
    steps: ['Create a budget for the workload with alerts to the owner.', 'Turn on anomaly detection if your provider offers it.'],
    practice: 'Expenditure awareness — budgets and ownership',
  },
  {
    id: 'COST-02', pillar: 'cost_optimization', providers: both, severity: 'MEDIUM', category: 'Cost',
    question: 'Are resources tagged so their cost can be attributed to a team or product?',
    why: 'Costs that cannot be attributed cannot be managed.',
    gap: 'Resources are not tagged for cost attribution',
    risk: 'Nobody can tell what drives the bill.',
    recommendation: 'Define a small set of required tags (owner, product, environment) and enforce them.',
    steps: ['Agree the tags and add them to the infrastructure code.', 'Report cost by tag every month.'],
    practice: 'Expenditure awareness — allocate cost',
  },
  {
    id: 'COST-03', pillar: 'cost_optimization', providers: both, severity: 'MEDIUM', category: 'Cost',
    question: 'Do you review usage regularly and remove or shrink resources that are idle or oversized?',
    why: 'Capacity added "just in case" is rarely taken away unless somebody looks.',
    gap: 'Idle and oversized resources are not reviewed',
    risk: 'Paying for capacity that is not used.',
    recommendation: 'Review utilisation monthly and act on resources that are idle or consistently underused.',
    steps: ['Use the provider\'s right-sizing recommendations.', 'Delete or shrink what is not needed.'],
    practice: 'Optimize over time — right-size',
  },
  {
    id: 'COST-04', pillar: 'cost_optimization', providers: both, severity: 'LOW', category: 'Cost',
    question: 'Have you considered commitment discounts (Savings Plans or reservations) for steady load, and spot or low-priority capacity for interruptible work?',
    why: 'On-demand prices are the highest; steady workloads can usually be covered for much less.',
    gap: 'Discount and spot options have not been considered',
    risk: 'Paying the on-demand price for predictable usage.',
    recommendation: 'Commit to the steady baseline of usage and use spot or low-priority capacity for work that tolerates interruption.',
    steps: ['Look at the last months of usage for a stable baseline.', 'Cover that baseline with a commitment sized below it.'],
    practice: 'Pricing models',
  },
  {
    id: 'COST-05', pillar: 'cost_optimization', providers: both, severity: 'LOW', category: 'Cost',
    question: 'Are non-production environments stopped or scaled down outside working hours?',
    why: 'Development and test environments are idle most of the week.',
    gap: 'Non-production environments run around the clock',
    risk: 'Paying for idle environments evenings and weekends.',
    recommendation: 'Schedule non-production environments off outside working hours, or scale them to the minimum.',
    steps: ['Schedule start and stop for development and test.', 'Remove environments that are no longer used.'],
    practice: 'Optimize over time — schedule non-production',
  },

  // ── Sustainability (AWS pillar) ───────────────────────────────────────────
  {
    id: 'SUS-01', pillar: 'sustainability', providers: aws, severity: 'LOW', category: 'Sustainability',
    question: 'Did you consider environmental impact when choosing regions and services (for example regions powered by more renewable energy)?',
    why: 'Where and on what a workload runs affects the energy it uses and how that energy is produced.',
    gap: 'Environmental impact was not considered in region and service choices',
    risk: 'A larger carbon footprint than the workload needs.',
    recommendation: 'Include carbon impact among the criteria for choosing regions and services, within your latency and compliance limits.',
    steps: ['Compare candidate regions for their sustainability data.', 'Prefer a lower-impact region where latency and data rules allow.'],
    practice: 'Region selection',
  },
  {
    id: 'SUS-02', pillar: 'sustainability', providers: aws, severity: 'LOW', category: 'Sustainability',
    question: 'Do you measure the workload\'s environmental impact (for example with the provider\'s carbon footprint reporting)?',
    why: 'What is not measured cannot be reduced.',
    gap: 'Environmental impact is not measured',
    risk: 'No way to tell whether changes make the workload more or less efficient.',
    recommendation: 'Use carbon reporting and utilisation data to set a baseline and track improvement.',
    steps: ['Turn on carbon footprint reporting for the account.', 'Review it alongside cost each quarter.'],
    practice: 'Understand your impact',
  },
  {
    id: 'SUS-03', pillar: 'sustainability', providers: aws, severity: 'LOW', category: 'Sustainability',
    question: 'Do you set retention and lifecycle rules so data is not kept longer than it is needed?',
    why: 'Stored data uses energy and money for as long as it exists.',
    gap: 'Data is kept without retention or lifecycle rules',
    risk: 'Growing storage that serves no purpose.',
    recommendation: 'Set retention and tiering rules for stored data, backups and logs, and delete what is no longer needed.',
    steps: ['Define how long each kind of data must be kept.', 'Apply lifecycle rules to move it to cheaper storage and then delete it.'],
    practice: 'Data — remove or minimize what you store',
  },
  {
    id: 'SUS-04', pillar: 'sustainability', providers: aws, severity: 'LOW', category: 'Sustainability',
    question: 'Do you prefer managed or shared services and efficient hardware over self-managed servers that sit partly idle?',
    why: 'Shared services run at higher utilisation, so the same work uses less hardware.',
    gap: 'Self-managed, partly idle servers are preferred over managed or shared services',
    risk: 'More hardware and energy than the work needs.',
    recommendation: 'Use managed, serverless or container platforms where they fit, and choose efficient instance families.',
    steps: ['List the servers with low average utilisation.', 'Consolidate or move them to a managed or serverless service.'],
    practice: 'Hardware and services — use efficient options',
  },
  {
    id: 'SUS-05', pillar: 'sustainability', providers: aws, severity: 'LOW', category: 'Sustainability',
    question: 'Does capacity follow demand (autoscaling or schedules), rather than staying at peak size all the time?',
    why: 'Capacity that sits idle still draws power; matching it to demand is the biggest single sustainability saving for most workloads.',
    gap: 'Capacity does not follow demand',
    risk: 'Hardware and energy used around the clock for load that only exists part of the time.',
    recommendation: 'Scale with demand using autoscaling or schedules, and scale non-production down when it is not in use.',
    steps: ['Find the resources that run at a fixed size all day and check their utilisation.', 'Add autoscaling or a schedule to the ones that are mostly idle.'],
    practice: 'Alignment to demand',
  },
] as const;

export const QUESTIONS_BY_ID: ReadonlyMap<string, QuestionDefinition> = new Map(QUESTIONS.map((q) => [q.id, q]));

/** Questions for a design: those whose pillar exists in at least one of the frameworks the design uses. */
export function questionsFor(providers: ReadonlyArray<'aws' | 'azure'>): QuestionDefinition[] {
  return QUESTIONS.filter((q) => q.providers.some((p) => providers.includes(p)));
}

export interface StoredAnswer {
  answer: QuestionAnswer;
  note?: string;
}
export type QuestionnaireAnswers = Record<string, StoredAnswer>;
