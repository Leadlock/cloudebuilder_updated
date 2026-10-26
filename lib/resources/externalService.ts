/**
 * The "Third-party service" canvas node: a SaaS or hosted product the workload depends on (Datadog, MongoDB Atlas, Auth0, Stripe, Cloudflare ...).
 * It is drawn and connected like any resource, counts in the cost estimate when a monthly cost is entered, and is reviewed through the questions
 * in lib/engines/assessment/externalQuestions.ts, whose answers are stored as settings of the node. It creates NO infrastructure: Terraform
 * skips it (see TerraformGenerator), because the service is not in the cloud account.
 */
import type { ConfigField, ResourceDefinition } from '@/types';
import { EXTERNAL_QUESTIONS } from '@/lib/engines/assessment/externalQuestions';

const ANSWER_OPTIONS = [
  { label: 'Not answered yet', value: '' },
  { label: 'Yes', value: 'yes' },
  { label: 'Partly', value: 'partial' },
  { label: 'No', value: 'no' },
  { label: 'Not applicable', value: 'na' },
  { label: "Don't know", value: 'unknown' },
];

const SECTION: Record<string, string> = {
  security: 'Security review',
  reliability: 'Reliability review',
  operational_excellence: 'Operations review',
  cost_optimization: 'Operations review',
};

const questionFields: ConfigField[] = EXTERNAL_QUESTIONS.map((q) => ({
  key: q.key, label: q.label, type: 'select', defaultValue: '', options: ANSWER_OPTIONS, section: SECTION[q.pillar] ?? 'Security review',
  description: q.question,
}));

export const EXTERNAL_DEFAULT_CONFIG: Record<string, unknown> = {
  vendor: '', kind: 'other', dataHeld: 'none', connection: 'internet', vendorRegion: '', monthlyCostUsd: 0,
  ...Object.fromEntries(EXTERNAL_QUESTIONS.map((q) => [q.key, ''])),
};

const configSchema: ConfigField[] = [
  { key: 'vendor', label: 'Service or vendor', type: 'text', defaultValue: '', required: true, placeholder: 'Datadog, MongoDB Atlas, Auth0 ...', description: 'The name of the product, so the review and the findings can say which one they are about.' },
  {
    key: 'kind', label: 'What it is used for', type: 'select', defaultValue: 'other',
    options: [
      { label: 'Database or data platform', value: 'database' }, { label: 'Monitoring or observability', value: 'monitoring' }, { label: 'Sign-in and identity', value: 'identity' },
      { label: 'Payments', value: 'payments' }, { label: 'CDN, edge or security', value: 'edge' }, { label: 'Email, SMS or messaging', value: 'messaging' },
      { label: 'Analytics or data warehouse', value: 'analytics' }, { label: 'Source code, CI or CD', value: 'devtools' }, { label: 'AI or ML service', value: 'ai' }, { label: 'Other', value: 'other' },
    ],
  },
  {
    key: 'dataHeld', label: 'Data it holds or receives', type: 'select', defaultValue: 'none',
    options: [
      { label: 'None', value: 'none' }, { label: 'Non-sensitive data', value: 'internal' }, { label: 'Personal data', value: 'personal' }, { label: 'Regulated data (payments, health, financial)', value: 'regulated' },
    ],
    description: 'Decides how much the security answers below matter. Be honest: it is not checked.',
  },
  {
    key: 'connection', label: 'How the workload reaches it', type: 'select', defaultValue: 'internet',
    options: [{ label: 'Over the public internet', value: 'internet' }, { label: 'Private link, VPN or peering', value: 'private' }, { label: 'Runs inside your own account', value: 'own-account' }],
  },
  { key: 'vendorRegion', label: 'Where its data is held', type: 'text', defaultValue: '', placeholder: 'eu-west-1, EU, global ...' },
  { key: 'monthlyCostUsd', label: 'Monthly cost (USD)', type: 'number', defaultValue: 0, min: 0, max: 1_000_000, description: 'What this service costs you each month, so it counts in the estimate. CloudBuilder cannot price it for you.' },
  ...questionFields,
];

function definition(cloud: 'aws' | 'azure'): ResourceDefinition {
  return {
    type: `${cloud}_external_service`,
    label: 'Third-party service',
    service: 'SaaS or hosted product',
    description: 'A product outside your cloud account that the workload depends on. It is drawn, costed and reviewed, but nothing is created for it.',
    provider: cloud,
    category: 'monitoring',
    icon: 'ExternalLink',
    color: '#64748B',
    bgColor: '#F1F5F9',
    borderColor: '#64748B',
    monthlyBaseCost: 0,
    defaultConfig: { ...EXTERNAL_DEFAULT_CONFIG },
    configSchema,
    costCalculator: (config) => {
      const cost = Math.max(0, Number(config['monthlyCostUsd']) || 0);
      return { monthlyCost: cost, breakdown: [{ label: 'Subscription or usage, as entered', cost }] };
    },
  };
}

export const externalServiceResources: ResourceDefinition[] = [definition('aws'), definition('azure')];
