/**
 * Tells the user when a request names cloud services CloudCraft cannot model — instead of the generator
 * quietly substituting other services (or failing with a generic message).
 *
 * "Supported" is never hard-coded: each service lists the resource type(s) that would model it, and it counts
 * as supported only if one of them exists in the live catalog. Add `aws_api_gateway` to lib/resources and the
 * API Gateway warning disappears by itself (and the "asked for it but it is missing from the design" check
 * starts applying to it).
 */
import { CATALOG_TYPES } from './architectureSpec';
import { getResourceDefinition } from '@/lib/resources';

interface ServiceEntry {
  name: string;
  /** Matches the service as a user would write it. */
  pattern: RegExp;
  /** Catalog types that model this service (may not exist yet). */
  types: string[];
  /** Existing types that cover part of what the service does — offered as the closest alternative. */
  nearest?: string[];
}

const S = (name: string, pattern: RegExp, types: string[], nearest?: string[]): ServiceEntry => ({ name, pattern, types, nearest });

export const SERVICES: ServiceEntry[] = [
  // ── Modelled today (checked against the design: asked for it, is it there?) ──
  S('EC2', /\bec2\b/i, ['aws_ec2', 'aws_auto_scaling']), S('S3', /\bs3\b/i, ['aws_s3']), S('RDS', /\brds\b/i, ['aws_rds']), S('Aurora', /\baurora\b/i, ['aws_rds']), // Aurora is an RDS engine option, so it is modelled
  S('DynamoDB', /\bdynamo\s?db\b/i, ['aws_dynamodb']), S('Lambda', /\blambda\b/i, ['aws_lambda']),
  S('ECS', /\becs\b|\bfargate\b/i, ['aws_ecs']), S('EKS', /\beks\b/i, ['aws_eks']),
  S('CloudFront', /\bcloud\s?front\b/i, ['aws_cloudfront']), S('SQS', /\bsqs\b/i, ['aws_sqs']),
  S('ElastiCache/Redis', /\belasticache\b|\bredis\b/i, ['aws_elasticache', 'azure_redis']),
  S('WAF', /\bwaf\b/i, ['aws_waf', 'azure_waf']), S('Route 53', /\broute\s?53\b/i, ['aws_route53']),
  S('KMS', /\bkms\b/i, ['aws_kms']), S('Key Vault', /\bkey\s?vault\b/i, ['azure_key_vault']),
  S('Cosmos DB', /\bcosmos\s?db\b/i, ['azure_cosmos_db']), S('Azure SQL', /\bazure sql\b/i, ['azure_sql']),
  S('App Service', /\bapp\s?service\b/i, ['azure_app_service']), S('Azure Functions', /\bazure functions\b/i, ['azure_functions']),
  S('AKS', /\baks\b/i, ['azure_aks']), S('Front Door', /\bfront\s?door\b/i, ['azure_front_door']), S('Azure Bastion', /\bbastion\b/i, ['azure_bastion']),

  // ── Not modelled today ──
  S('API Gateway', /\bapi\s?gateway\b/i, ['aws_api_gateway'], ['aws_alb', 'aws_lambda']),
  S('Step Functions', /\bstep\s?functions?\b/i, ['aws_step_functions'], ['aws_lambda', 'aws_sqs']),
  S('SNS', /\bsns\b|simple notification service/i, ['aws_sns'], ['aws_sqs']),
  S('EventBridge', /\bevent\s?bridge\b/i, ['aws_eventbridge'], ['aws_sqs', 'aws_lambda']),
  S('Kinesis', /\bkinesis\b/i, ['aws_kinesis'], ['aws_sqs']),
  S('Glue', /\baws glue\b|\bglue\b(?!\s+(?:code|logic|layer|between))/i, ['aws_glue']), S('Redshift', /\bredshift\b/i, ['aws_redshift']),
  S('Athena', /\bathena\b/i, ['aws_athena']), S('SageMaker', /\bsage\s?maker\b/i, ['aws_sagemaker']),
  S('Cognito', /\bcognito\b/i, ['aws_cognito'], ['aws_iam']), S('Secrets Manager', /\bsecrets\s?manager\b/i, ['aws_secrets_manager'], ['aws_kms']),
  S('ECR', /\becr\b|\belastic container registry\b/i, ['aws_ecr']), S('EFS', /\befs\b|\belastic file system\b/i, ['aws_efs'], ['aws_ebs']),
  S('OpenSearch', /\bopen\s?search\b|\belasticsearch\b/i, ['aws_opensearch']), S('MSK / Kafka', /\bmsk\b|\bkafka\b/i, ['aws_msk'], ['aws_sqs']),
  S('CloudTrail', /\bcloud\s?trail\b/i, ['aws_cloudtrail'], ['aws_cloudwatch']), S('GuardDuty', /\bguard\s?duty\b/i, ['aws_guardduty']),
  S('Transit Gateway', /\btransit gateway\b/i, ['aws_transit_gateway']), S('SES', /\bses\b|simple email service/i, ['aws_ses']),
  S('AppSync', /\bapp\s?sync\b/i, ['aws_appsync']),  S('Service Bus', /\bservice\s?bus\b/i, ['azure_service_bus']), S('Event Hubs', /\bevent\s?hubs?\b/i, ['azure_event_hubs']),
  S('Event Grid', /\bevent\s?grid\b/i, ['azure_event_grid']), S('Logic Apps', /\blogic\s?apps?\b/i, ['azure_logic_apps'], ['azure_functions']),
  S('API Management', /\bapi management\b|\bapim\b/i, ['azure_api_management'], ['azure_app_gateway', 'azure_functions']),
  S('Synapse', /\bsynapse\b/i, ['azure_synapse']), S('Data Factory', /\bdata factory\b/i, ['azure_data_factory']),
  S('Databricks', /\bdatabricks\b/i, ['azure_databricks']), S('Azure Container Registry', /\bcontainer registry\b|\bacr\b/i, ['azure_acr']),
  S('Azure Firewall', /\bazure firewall\b/i, ['azure_firewall'], ['azure_nsg']),
  S('Application Insights / Azure Monitor', /\bapplication insights\b|\bazure monitor\b/i, ['azure_monitor']),
  S('Azure OpenAI / Cognitive Services', /\bazure openai\b|\bcognitive services\b/i, ['azure_openai']),
];

export interface ServiceNotices {
  /** Named in the request, cannot be modelled. `nearest` = labels of existing types that cover part of it. */
  unsupported: { service: string; nearest: string[] }[];
  /** Named in the request, supported, but absent from the generated design. */
  missing: { service: string }[];
}

/** "no Redis", "without a CDN"… — a service mentioned only to be excluded is not requested. */
const NEGATION = /(?:\bno|\bnot|\bwithout|\bavoid|\bexclude|\bexcluding|n't\s+need|\bskip)\s+(?:a\s+|an\s+|the\s+|any\s+)?(?:\w+\s+){0,2}$/i;
const isNegated = (text: string, index: number): boolean => NEGATION.test(text.slice(Math.max(0, index - 40), index));

const label = (type: string) => getResourceDefinition(type)?.label ?? type;

/**
 * @param designTypes resource types in the generated design; omit to only detect unsupported services
 * @param catalog     types that exist (defaults to the live catalog; overridable for tests)
 */
export function detectServiceNotices(prompt: string, designTypes?: string[], catalog: ReadonlySet<string> = new Set(CATALOG_TYPES)): ServiceNotices {
  const unsupported: ServiceNotices['unsupported'] = []; const missing: ServiceNotices['missing'] = [];
  const present = new Set(designTypes ?? []);
  for (const svc of SERVICES) {
    const m = svc.pattern.exec(prompt);
    if (!m || isNegated(prompt, m.index)) continue;
    const modelled = svc.types.filter((t) => catalog.has(t));
    if (modelled.length === 0) {
      unsupported.push({ service: svc.name, nearest: (svc.nearest ?? []).filter((t) => catalog.has(t)).map(label) });
    } else if (designTypes && !modelled.some((t) => present.has(t))) {
      missing.push({ service: svc.name });
    }
  }
  return { unsupported, missing };
}

/** Plain sentences for the UI. */
export function describeNotices(n: ServiceNotices): string[] {
  return [
    ...n.unsupported.map((u) => `${u.service} isn't supported by CloudCraft yet${u.nearest.length ? ` — closest available: ${u.nearest.join(', ')}` : ''}.`),
    ...n.missing.map((m) => `You asked for ${m.service}, but it isn't in the design.`),
  ];
}
