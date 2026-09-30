import { foundryClient, FOUNDRY_MODEL } from '../ai/foundryClient';
import { buildGenerationContext } from '../ai/knowledgeBase';
import { detectServiceNotices, type ServiceNotices } from '../ai/serviceCoverage';
import { sanitizeSpecInput, type SanitizeReport } from '../ai/specSanitizer';
import { awsResources } from '../resources/aws';
import { azureResources } from '../resources/azure';
import { db } from '../../src/prisma/db';
import { generateWithRepair, type RepairAttempt } from '../ai/architectRepair';
import type { DeploymentInput } from '../ai/architectureSpec';
import type { CanvasNode, CanvasEdge } from '@/types';


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

export { withHints, withSettingHints, withContainmentHints } from '../ai/repairHints';
import { withHints } from '../ai/repairHints';

export interface ValidatedGeneration {
  ok: boolean;
  /** Compiled, laid-out canvas graph — present only when every deploy-readiness gate passed. */
  graph?: { nodes: CanvasNode[]; edges: CanvasEdge[] };
  /** Account-specific values (ACM certificate ARN, container image…) the user must supply before deploying. */
  deploymentInputs: DeploymentInput[];
  attempts: RepairAttempt[];
  /** Services the request named that CloudCraft cannot model, or that are missing from the design. */
  notices: ServiceNotices;
  /** Setting names the AI got wrong in the accepted design: `renamed` were fixed losslessly, `dropped` fell back to defaults. */
  sanitized: SanitizeReport;
  /** Remaining validation problems when ok is false. */
  issues: string[];
  stage: string;
  historyId: string;
}

export class AiGeneratorService {
  /**
   * Generates an architecture the way the fine-tuning dataset was built: the model emits a compact
   * ArchitectureSpec, which is compiled and must pass every deploy-readiness gate (assessment,
   * hardening, validator, connectivity, layout, addressing, Terraform render). A design that fails is
   * sent back to the model with the exact issues, up to `maxAttempts` times. Nothing that fails a gate
   * is ever returned — on failure the caller gets the remaining issues instead.
   */
  static async generateValidatedArchitecture(
    prompt: string,
    projectId: string,
    environmentId: string,
    provider: 'aws' | 'azure' = 'aws',
    // Each pass usually clears one stage (settings, then containment, then the gates), so an untuned
    // model needs more rounds than a tuned one, which should pass first time.
    maxAttempts = 5,
  ): Promise<ValidatedGeneration> {
    // Only add a provider hint when the request doesn't already name a cloud, so prompts that do
    // (e.g. "AWS primary with Azure DR") reach the model exactly as written.
    const namesCloud = /\b(aws|azure|multi-?cloud)\b/i.test(prompt);
    const request = namesCloud ? prompt : `${prompt}\n\nTarget cloud: ${provider === 'azure' ? 'Azure' : 'AWS'}.`;
    // Ground the model in the knowledge base: closest verified example plus exact settings and placement
    // rules. Empty when the knowledge base is disabled or unavailable — generation works without it.
    const context = await buildGenerationContext(prompt, provider);
    const userPrompt = context ? `${request}\n\n${context}` : request;

    let sanitized: SanitizeReport = { renamed: [], dropped: [] };
    const outcome = await generateWithRepair(async (messages) => {
      const response = await foundryClient().responses.create({
        model: FOUNDRY_MODEL,
        input: messages,
        text: { format: { type: 'json_object' } },
      });
      return response.output_text || '';
    }, userPrompt, maxAttempts, withHints, (json) => {
      // Rename near-miss setting names and drop invented ones before validating; the last call is the accepted attempt.
      const cleaned = sanitizeSpecInput(json);
      sanitized = cleaned.report;
      return cleaned.value;
    });

    const last = outcome.attempts[outcome.attempts.length - 1]!;
    let historyId = '';
    if (outcome.ok) {
      try {
        const { architectureRepository } = await import('../repositories/architectureRepository');
        const architecture = await architectureRepository.findByEnvironment(environmentId);
        if (architecture) {
          const record = await db.orm.public.AIGenerationHistory.create({
            id: crypto.randomUUID(), projectId, architectureId: architecture.id, prompt, provider,
            model: FOUNDRY_MODEL, architectureJson: JSON.stringify(outcome.spec), createdAt: new Date().toISOString(),
          });
          historyId = record.id;
        }
      } catch (err) {
        console.warn('[AiGeneratorService] Failed to record generation history:', (err as Error)?.message);
      }
    }

    return {
      ok: outcome.ok,
      graph: outcome.graph,
      deploymentInputs: outcome.deploymentInputs ?? [],
      attempts: outcome.attempts,
      // Judged against what the user asked for, not what the model produced: an unsupported service the model
      // silently swapped for another one must still be reported.
      notices: detectServiceNotices(prompt, outcome.graph?.nodes.map((n) => n.resourceType)),
      sanitized,
      issues: outcome.ok ? [] : last.issues.map((i) => i.message),
      stage: last.stage,
      historyId,
    };
  }

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

    const FEW_SHOT_EXAMPLE_AWS = {
      resources: [
        { id: "vpc-1", resourceType: "aws_vpc", label: "Production VPC", config: { cidrBlock: "10.0.0.0/16" }, parentId: null },
        { id: "sub-pub-1", resourceType: "aws_subnet", label: "Public Subnet 1A", config: { cidrBlock: "10.0.1.0/24", availabilityZone: "us-east-1a", isPublic: true }, parentId: "vpc-1" },
        { id: "sub-pub-2", resourceType: "aws_subnet", label: "Public Subnet 1B", config: { cidrBlock: "10.0.2.0/24", availabilityZone: "us-east-1b", isPublic: true }, parentId: "vpc-1" },
        { id: "sub-priv-1", resourceType: "aws_subnet", label: "App Subnet 1A", config: { cidrBlock: "10.0.3.0/24", availabilityZone: "us-east-1a", isPublic: false }, parentId: "vpc-1" },
        { id: "sub-priv-2", resourceType: "aws_subnet", label: "App Subnet 1B", config: { cidrBlock: "10.0.4.0/24", availabilityZone: "us-east-1b", isPublic: false }, parentId: "vpc-1" },
        { id: "sub-data-1", resourceType: "aws_subnet", label: "Data Subnet 1A", config: { cidrBlock: "10.0.5.0/24", availabilityZone: "us-east-1a", isPublic: false }, parentId: "vpc-1" },
        { id: "sub-data-2", resourceType: "aws_subnet", label: "Data Subnet 1B", config: { cidrBlock: "10.0.6.0/24", availabilityZone: "us-east-1b", isPublic: false }, parentId: "vpc-1" },
        { id: "cdn-1", resourceType: "aws_cloudfront", label: "CloudFront CDN", config: {}, parentId: null },
        { id: "alb-1", resourceType: "aws_alb", label: "Application Load Balancer", config: { internetFacing: true }, parentId: "sub-pub-1" },
        { id: "asg-1", resourceType: "aws_auto_scaling", label: "App Auto Scaling (AZ-A)", config: { minSize: 2, maxSize: 8 }, parentId: "sub-priv-1" },
        { id: "asg-2", resourceType: "aws_auto_scaling", label: "App Auto Scaling (AZ-B)", config: { minSize: 2, maxSize: 8 }, parentId: "sub-priv-2" },
        { id: "rds-1", resourceType: "aws_rds", label: "PostgreSQL Database", config: { multiAZ: true, storageEncrypted: true }, parentId: "sub-data-1" },
        { id: "cache-1", resourceType: "aws_elasticache", label: "Redis Cluster", config: { numCacheNodes: 2 }, parentId: "sub-data-2" }
      ],
      connections: [
        { sourceId: "cdn-1", targetId: "alb-1", label: "HTTPS" },
        { sourceId: "alb-1", targetId: "asg-1", label: "HTTP Traffic (AZ-A)" },
        { sourceId: "alb-1", targetId: "asg-2", label: "HTTP Traffic (AZ-B)" },
        { sourceId: "asg-1", targetId: "cache-1", label: "Cache Reads/Writes" },
        { sourceId: "asg-2", targetId: "cache-1", label: "Cache Reads/Writes" },
        { sourceId: "asg-1", targetId: "rds-1", label: "Database Queries" },
        { sourceId: "asg-2", targetId: "rds-1", label: "Database Queries" }
      ]
    };

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

Connection & Topology Rules:
1. Multi-AZ Balance: When designing high-availability architectures, create subnets in multiple AZs (e.g. us-east-1a and us-east-1b) and balance compute/app resources across both zones.
2. Ingress & Routing: Ingress flows Edge (CDN/CloudFront/Front Door) -> Load Balancer (ALB/App Gateway) -> Compute Instances in private subnets.
3. Data Tier: Compute instances connect directly to the Cache (Redis/ElastiCache) for fast lookups AND to the Database (RDS/Postgres/SQL) for persistence. Do NOT connect Database to Cache.
4. Set parentId correctly for nested resources (e.g. subnets inside VPCs, instances inside subnets).
5. Generate realistic, production-like configurations.

Architecture quality guidelines (violating these lowers the design's security/reliability score in CloudCraft's own review engine — follow them by default unless the user's prompt explicitly asks for something less secure or a minimal/dev-only setup):
${buildQualityGuidelines(provider)}

Gold Standard Reference Example (AWS Multi-Tier HA Pattern):
${JSON.stringify(FEW_SHOT_EXAMPLE_AWS, null, 2)}`;

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
