import OpenAI from 'openai';
import { awsResources } from '../resources/aws';
import { azureResources } from '../resources/azure';
import { db } from '../../src/prisma/db';

// Azure AI Foundry's "v1" API is OpenAI-SDK-compatible: point the standard
// client at "<endpoint>/openai/v1" with the resource's API key and call
// client.responses.create(...) exactly as against OpenAI itself — no
// Azure-specific client class or api-version query param needed. The env var
// holds the full deployment URL as copied from the Foundry portal (ending in
// "/responses"); strip that suffix to get the SDK's base URL.
function foundryBaseURL(): string {
  const endpoint = process.env.AZURE_AI_FOUNDRY_ENDPOINT ?? '';
  return endpoint.replace(/\/responses\/?$/, '');
}

let _client: OpenAI | null = null;
function foundryClient(): OpenAI {
  if (!_client) {
    const baseURL = foundryBaseURL();
    const apiKey = process.env.AZURE_AI_FOUNDRY_API_KEY;
    if (!baseURL || !apiKey) {
      throw new Error(
        'Azure AI Foundry is not configured — set AZURE_AI_FOUNDRY_ENDPOINT and AZURE_AI_FOUNDRY_API_KEY.'
      );
    }
    _client = new OpenAI({ baseURL, apiKey });
  }
  return _client;
}

const FOUNDRY_MODEL = process.env.AZURE_AI_FOUNDRY_DEPLOYMENT || 'gpt-4o';

/** Shape of the JSON graph the LLM is prompted to emit — unverified until validateAgainstRde runs. */
interface RawAiResource {
  id: string;
  resourceType: string;
  label?: string;
  config?: Record<string, unknown>;
  parentId?: string | null;
}

interface RawAiConnection {
  sourceId: string;
  targetId: string;
  label?: string;
}

interface RawAiGraph {
  resources?: RawAiResource[];
  connections?: RawAiConnection[];
}

// Distilled from the app's own scoring engines — lib/engines/assessment/rules/{aws,azure}.ts
// (CRITICAL/HIGH security findings) and lib/engines/validation/ArchitectureValidator.ts
// (availability/SPOF/structural findings). Generating architectures that already satisfy
// these means they land on the canvas with a high security/quality score and few Auto-Fix
// findings, instead of the user having to fix AI output by hand. Keep this in sync when a
// new CRITICAL/HIGH rule is added to either rules file — re-run the extraction described in
// that file's history if this list goes stale.
const QUALITY_GUIDELINES: Record<'aws' | 'azure' | 'common', string[]> = {
  common: [
    'Never design a single point of failure: no single compute instance serving production traffic (use ≥2 instances or an auto-scaling group behind a load balancer), no single-AZ deployment (spread across ≥2 availability zones/subnets), no non-HA database tier.',
    'Front any internet-facing compute tier with a load balancer; add a WAF if the workload is public-facing.',
    'Add a caching layer (e.g. Redis/ElastiCache, Azure Cache for Redis) for typical web/API workloads, and a CDN in front of static assets.',
    'Every nested resource needs a correct parentId pointing to an existing container resource of the same cloud provider (e.g. a subnet\'s parentId is its VPC/VNet\'s id) — never nest a resource under a container from the other provider.',
    'Enable encryption at rest by default on every storage/database resource unless the user explicitly asks otherwise.',
    'Set backup/retention config to at least 7 days on databases that support it.',
  ],
  aws: [
    'S3 buckets: publicAccess=false with all four Block Public Access settings on, unless the user explicitly wants a public bucket (then front it with CloudFront + OAC instead of a public bucket).',
    'RDS: publiclyAccessible=false, storageEncrypted=true, multiAZ=true for production, backup retention ≥7 days.',
    'EC2: require IMDSv2 (metadata options httpTokens=required).',
    'Security groups: never allow inbound 22 (SSH) or 3389 (RDP) from 0.0.0.0/0 — omit the rule or scope it to a specific admin CIDR.',
    'EKS: disable/restrict the public API endpoint (private endpoint access, or restrict public access CIDRs).',
    'ECS: do not auto-assign public IPs to tasks — run them in private subnets behind a load balancer.',
    'IAM: never attach AdministratorAccess — scope roles to least privilege for what the workload actually needs.',
  ],
  azure: [
    'Storage accounts: require secure transfer, and disallow anonymous blob access (serve public content via Front Door/CDN with a private origin or SAS instead).',
    'Azure SQL: disable public network access (use a private endpoint) and enable Transparent Data Encryption.',
    'Cosmos DB: disable public network access, use private endpoints.',
    'NSGs: never allow inbound 22 (SSH) or 3389 (RDP) from any source — omit the rule or scope it to a specific admin range.',
    'AKS: enable Kubernetes RBAC with Entra integration.',
  ],
};

function buildQualityGuidelines(provider: 'aws' | 'azure'): string {
  const bullets = [...QUALITY_GUIDELINES.common, ...QUALITY_GUIDELINES[provider]];
  return bullets.map((b) => `- ${b}`).join('\n');
}

/**
 * Validates and filters AI-generated graph output against the RDE catalog.
 * Rejects any resource whose type is not in the supported catalog.
 * Returns { validated: graph, rejected: string[] } where rejected lists unsupported types.
 */
function validateAgainstRde(
  graph: RawAiGraph,
  validTypes: Set<string>
): { resources: RawAiResource[]; connections: RawAiConnection[]; rejected: string[] } {
  const rejected: string[] = [];
  const validResources = (graph.resources ?? []).filter((r) => {
    if (!validTypes.has(r.resourceType)) {
      rejected.push(r.resourceType);
      return false;
    }
    return true;
  });

  const validIds = new Set(validResources.map((r) => r.id));
  const validConnections = (graph.connections ?? []).filter(
    (c) => validIds.has(c.sourceId) && validIds.has(c.targetId)
  );

  return { resources: validResources, connections: validConnections, rejected };
}

export class AiGeneratorService {
  /**
   * Generates a cloud architecture from a prompt using the Azure AI Foundry
   * deployment configured via AZURE_AI_FOUNDRY_*. The AI is constrained to
   * the RDE catalog — unsupported resource types are rejected.
   */
  static async generateArchitecture(
    prompt: string,
    projectId: string,
    environmentId: string,
    provider: 'aws' | 'azure' = 'aws'
  ): Promise<{ architectureJson: { resources: RawAiResource[]; connections: RawAiConnection[] }; historyId: string; rejectedTypes: string[] }> {
    // Select the correct resource catalog for the target provider
    const resources = provider === 'aws' ? awsResources : azureResources;

    // Narrow the valid-type set to just the target provider for prompt efficiency
    const providerValidTypes = new Set(resources.map(r => r.type));

    // Create a catalog summary for the LLM
    const catalog = resources.map(r => ({
      type: r.type,
      label: r.label,
      isContainer: r.isContainer ?? false,
      allowedChildren: r.allowedChildren ?? [],
      configSchema: (r.configSchema ?? []).map(c => ({
        key: c.key,
        type: c.type,
        defaultValue: c.defaultValue,
      })),
    }));

    const systemPrompt = `You are an expert ${provider.toUpperCase()} cloud architect. Given a user prompt, generate a JSON representation of a cloud architecture.

IMPORTANT: Use ONLY the resource types defined in this catalog. Do NOT invent resource types.
Catalog:
${JSON.stringify(catalog, null, 2)}

Output must be valid JSON matching this exact schema:
{
  "resources": [
    { "id": "unique-id", "resourceType": "<type from catalog>", "label": "...", "config": { ... }, "parentId": null | "parent-id" }
  ],
  "connections": [
    { "sourceId": "unique-id", "targetId": "unique-id2", "label": "..." }
  ]
}

Rules:
1. Only use resource types from the catalog above.
2. Set parentId correctly for nested resources (e.g. subnets inside VPCs).
3. If a service the user asks for is not in the catalog, omit it or map it to the closest supported type.
4. Generate realistic, production-like configurations.

Architecture quality guidelines (violating these lowers the design's security/reliability score in CloudCraft's own review engine — follow them by default unless the user's prompt explicitly asks for something less secure or a minimal/dev-only setup):
${buildQualityGuidelines(provider)}`;

    const response = await foundryClient().responses.create({
      model: FOUNDRY_MODEL,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      text: { format: { type: 'json_object' } },
    });

    const outputText = response.output_text || '{}';
    let rawGraph: RawAiGraph;
    try {
      rawGraph = JSON.parse(outputText);
    } catch {
      rawGraph = { resources: [], connections: [] };
    }

    // Validate the AI's output against the RDE — reject unsupported types
    const { resources: validResources, connections: validConnections, rejected } =
      validateAgainstRde(rawGraph, providerValidTypes);

    if (rejected.length > 0) {
      console.warn(
        `[AiGeneratorService] Foundry produced unsupported resource types (removed): ${rejected.join(', ')}`
      );
    }

    const validatedGraph = { resources: validResources, connections: validConnections };
    const validatedJson = JSON.stringify(validatedGraph);

    let historyId = '';
    try {
      const { architectureRepository } = await import('../repositories/architectureRepository');
      const architecture = await architectureRepository.findByEnvironment(environmentId);
      if (architecture) {
        const record = await db.orm.public.AIGenerationHistory.create({
          id: crypto.randomUUID(),
          projectId,
          architectureId: architecture.id,
          prompt,
          provider,
          model: FOUNDRY_MODEL,
          architectureJson: validatedJson,
          createdAt: new Date().toISOString(),
        });
        historyId = record.id;
      }
    } catch (err) {
      console.warn('[AiGeneratorService] Failed to record generation history:', (err as Error)?.message);
    }

    return {
      architectureJson: validatedGraph,
      historyId,
      rejectedTypes: rejected,
    };
  }
}
