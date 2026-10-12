import { foundryClient, FOUNDRY_MODEL } from '../ai/foundryClient';
import { buildGenerationContext } from '../ai/knowledgeBase';
import { detectServiceNotices, designTypesOf, unsupportedServiceNames, type ServiceNotices } from '../ai/serviceCoverage';
import { sanitizeSpecInput, type SanitizeReport } from '../ai/specSanitizer';
import { repairSpecInput } from '../ai/specRepair';
import { closestVerifiedDesign, adjustPrompt } from '../ai/verifiedBase';
import { evaluateSpec } from '../ai/architectureSpec';
import { awsResources } from '../resources/aws';
import { azureResources } from '../resources/azure';
import { db } from '../../src/prisma/db';
import { generateWithRepair, type RepairAttempt } from '../ai/architectRepair';
import type { DeploymentInput } from '../ai/architectureSpec';
import type { CanvasNode, CanvasEdge, QuestionnaireResult, QuestionnaireAnswers, ArchitectureQuestion, IdentifiedGap } from '@/types';


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
  /** Remaining validation problems when ok is false (or, with needsReview, the ones the person still has to look at). */
  issues: string[];
  /** True when no design passed every gate, so the closest one is returned for the person to review instead of an error. */
  needsReview?: boolean;
  /** Title of the verified pattern the design was rebuilt from, when the AI's own design could not pass. */
  basedOnPattern?: string;
  /** The verified pattern itself was returned (the AI could not adapt it either). */
  verifiedFallback?: boolean;
  /** What CloudCraft's own verified fixes changed in the design after the AI wrote it. */
  autoRepairs?: string[];
  stage: string;
  historyId: string;
}

/**
 * Robust fallback heuristic generator that generates smart, contextual questions
 * and flags architectural gaps even if Azure AI Foundry is unreachable or offline.
 */
function getHeuristicQuestionnaire(prompt: string, provider: 'aws' | 'azure'): QuestionnaireResult {
  const lower = prompt.toLowerCase();
  const isAws = provider === 'aws';

  const gaps: IdentifiedGap[] = [];
  const questions: ArchitectureQuestion[] = [];

  // Gap 1: Traffic Scale & Auto-scaling
  gaps.push({
    id: 'gap-scale',
    title: 'Workload Traffic & Scaling Strategy Unspecified',
    description: 'The initial request does not specify expected concurrency or whether auto-scaling groups/container autoscaling should be provisioned.',
    severity: 'important',
    addressedByQuestionId: 'q-scale',
  });

  questions.push({
    id: 'q-scale',
    category: 'scale',
    categoryLabel: 'Traffic & Scale',
    question: 'What is the expected traffic scale and scaling strategy?',
    rationale: 'Determines whether to provision elastic load balancers, auto-scaling groups, or serverless auto-concurrency.',
    options: [
      {
        id: 'opt-high-scale',
        label: 'Production High-Traffic (Auto-Scaling + ALB)',
        description: 'Automatic horizontal scaling across instances/containers with health checks.',
        isRecommended: true,
        technicalImpact: isAws ? 'ALB + Auto Scaling Group / ECS Fargate autoscaling' : 'Azure Application Gateway + VMSS / AKS autoscaling',
      },
      {
        id: 'opt-med-scale',
        label: 'Steady Moderate Workload (Multi-Instance)',
        description: 'Fixed 2-instance redundant pool behind load balancer.',
        isRecommended: false,
        technicalImpact: '2 worker instances balanced across availability zones',
      },
      {
        id: 'opt-low-scale',
        label: 'Cost-Optimized / Staging (Single Instance)',
        description: 'Minimal footprint for non-critical dev/testing environments.',
        isRecommended: false,
        technicalImpact: 'Single node, non-HA, lowest monthly cost',
      },
    ],
    defaultOptionId: 'opt-high-scale',
  });

  // Gap 2: High Availability & Multi-AZ
  gaps.push({
    id: 'gap-ha',
    title: 'High Availability & Zone Redundancy Not Defined',
    description: 'Production architectures must span at least 2 Availability Zones to prevent single points of failure (SPOF).',
    severity: 'critical',
    addressedByQuestionId: 'q-ha',
  });

  questions.push({
    id: 'q-ha',
    category: 'availability',
    categoryLabel: 'High Availability (Multi-AZ)',
    question: 'How resilient should the deployment be against data center outages?',
    rationale: 'Required to meet SLA uptime targets and eliminate single points of failure.',
    options: [
      {
        id: 'opt-multi-az',
        label: 'Multi-AZ Active-Active (Recommended for 99.99% SLA)',
        description: 'Spans Subnet AZ-A & Subnet AZ-B with standby database replication.',
        isRecommended: true,
        technicalImpact: isAws ? '2 Availability Zones (us-east-1a, 1b) + RDS Multi-AZ' : '2 Availability Zones + Azure SQL Zone Redundancy',
      },
      {
        id: 'opt-single-az',
        label: 'Single-AZ (Cost Sensitive)',
        description: 'All compute and storage in a single zone.',
        isRecommended: false,
        technicalImpact: 'SPOF risk during cloud provider zone incidents',
      },
    ],
    defaultOptionId: 'opt-multi-az',
  });

  // Gap 3: Security, WAF & Network Isolation
  gaps.push({
    id: 'gap-security',
    title: 'WAF & Subnet Security Perimeter Missing',
    description: 'Workloads handling user traffic should be shielded behind a Web Application Firewall with strict private subnet isolation.',
    severity: 'critical',
    addressedByQuestionId: 'q-security',
  });

  questions.push({
    id: 'q-security',
    category: 'security',
    categoryLabel: 'Security & Network Isolation',
    question: 'What level of security perimeter and network isolation is required?',
    rationale: 'Protects user data, prevents SQL injection/DDoS, and satisfies security review gates.',
    options: [
      {
        id: 'opt-sec-enterprise',
        label: 'Enterprise Hardened (WAF + Private Subnets + KMS)',
        description: 'Web Application Firewall (OWASP top 10), private app/data subnets, KMS customer encryption.',
        isRecommended: true,
        technicalImpact: isAws ? 'AWS WAF + Private VPC Subnets + KMS Keys + Strict Security Groups' : 'Azure WAF + Private VNet Subnets + Azure Key Vault + NSGs',
      },
      {
        id: 'opt-sec-standard',
        label: 'Standard (Private Subnets & Firewalls)',
        description: 'VPC/VNet segmentation with security groups/NSGs, no WAF.',
        isRecommended: false,
        technicalImpact: 'Isolated subnets with default cloud encryption',
      },
      {
        id: 'opt-sec-basic',
        label: 'Basic / Direct Public Access',
        description: 'Minimal networking restrictions (suitable only for sandbox prototypes).',
        isRecommended: false,
        technicalImpact: 'Publicly reachable instances (triggers security findings)',
      },
    ],
    defaultOptionId: 'opt-sec-enterprise',
  });

  // Gap 4: Compute Runtime
  const isServerlessRequested = lower.includes('lambda') || lower.includes('serverless') || lower.includes('function');
  const isK8sRequested = lower.includes('kubernetes') || lower.includes('k8s') || lower.includes('eks') || lower.includes('aks') || lower.includes('container') || lower.includes('docker') || lower.includes('ecs');

  questions.push({
    id: 'q-compute',
    category: 'compute',
    categoryLabel: 'Compute Platform',
    question: 'Which compute runtime best matches your deployment model?',
    rationale: 'Defines how application code is hosted, updated, and scaled.',
    options: [
      {
        id: 'opt-comp-containers',
        label: isAws ? 'Managed Containers (AWS ECS Fargate)' : 'Managed Containers (Azure Container Apps / AKS)',
        description: 'Serverless container orchestration without managing underlying VMs.',
        isRecommended: !isServerlessRequested,
        technicalImpact: isAws ? 'ECS Service + Task Definitions in Private Subnets' : 'AKS / Container Apps with autoscaling',
      },
      {
        id: 'opt-comp-serverless',
        // Only services CloudCraft can model: an option naming one it cannot (API Gateway / API Management) would end in
        // an "unsupported service" warning after the user picked it.
        label: isAws ? 'Serverless (AWS Lambda functions)' : 'Serverless (Azure Functions)',
        description: 'Event-driven, zero idle cost, instant scale per request.',
        isRecommended: isServerlessRequested,
        technicalImpact: isAws ? 'Lambda Functions with event triggers' : 'Azure Functions with event triggers',
      },
      {
        id: 'opt-comp-vms',
        label: isAws ? 'Virtual Machines (EC2 Instances)' : 'Virtual Machines (Azure VMs)',
        description: 'Dedicated virtual servers with full OS control.',
        isRecommended: false,
        technicalImpact: isAws ? 'EC2 Auto Scaling Group' : 'Azure VM Scale Set',
      },
    ],
    defaultOptionId: isServerlessRequested ? 'opt-comp-serverless' : 'opt-comp-containers',
  });

  // Gap 5: Database & Caching
  const hasRedis = lower.includes('redis') || lower.includes('cache');
  questions.push({
    id: 'q-database',
    category: 'database',
    categoryLabel: 'Database & In-Memory Caching',
    question: 'How should the persistence and caching tier be configured?',
    rationale: 'Ensures data durability, fast query response times, and automated backups.',
    options: [
      {
        id: 'opt-db-cache-ha',
        label: isAws ? 'Multi-AZ Managed Database + Redis Cluster' : 'Zone-Redundant PostgreSQL/SQL + Redis Cache',
        description: 'Primary/standby database with automated 7-day backup retention and in-memory caching.',
        isRecommended: true,
        technicalImpact: isAws ? 'AWS RDS Multi-AZ + ElastiCache Redis' : 'Azure Database for PostgreSQL + Azure Cache for Redis',
      },
      {
        id: 'opt-db-only',
        label: 'Managed Database Only (No In-Memory Cache)',
        description: 'Direct queries to database without caching layer.',
        isRecommended: false,
        technicalImpact: 'Standard RDS / Azure SQL without Redis node',
      },
    ],
    defaultOptionId: 'opt-db-cache-ha',
  });

  // Gap 6: CDN & Static Storage
  questions.push({
    id: 'q-storage',
    category: 'storage',
    categoryLabel: 'CDN & Content Delivery',
    question: 'How should frontend assets and user uploaded media be delivered?',
    rationale: 'Accelerates global page loads and protects origin object buckets.',
    options: [
      {
        id: 'opt-cdn-storage',
        label: isAws ? 'CloudFront CDN + S3 (Block Public Access + OAC)' : 'Azure Front Door / CDN + Storage Account (Private Origin)',
        description: 'Global edge caching with strict Origin Access Control so bucket remains 100% private.',
        isRecommended: true,
        technicalImpact: isAws ? 'CloudFront Distribution + S3 Bucket (all BPA enabled)' : 'Azure Front Door + Azure Storage Account',
      },
      {
        id: 'opt-storage-only',
        label: 'Object Storage Only',
        description: 'Direct bucket access without edge CDN caching.',
        isRecommended: false,
        technicalImpact: 'S3 / Blob Storage only',
      },
    ],
    defaultOptionId: 'opt-cdn-storage',
  });

  return {
    summary: `Based on your request ("${prompt.slice(0, 70)}${prompt.length > 70 ? '…' : ''}"), we identified ${gaps.length} architectural dimensions requiring clarification before generating a production-grade topology.`,
    identifiedGaps: gaps,
    questions,
    suggestedProjectName: prompt.slice(0, 35).trim(),
  };
}

/**
 * The model is told not to, but the questionnaire is the last thing the user sees before a design is generated: an option
 * naming a service CloudCraft cannot model would only turn into an "unsupported" warning after they chose it. Such options
 * are removed; a question left with nothing to choose from is removed too, and a default that was removed is re-pointed.
 */
export function dropUnsupportedOptions(questions: ArchitectureQuestion[]): ArchitectureQuestion[] {
  const out: ArchitectureQuestion[] = [];
  for (const q of questions) {
    const options = (Array.isArray(q.options) ? q.options : []).filter((o) => detectServiceNotices(`${o.label ?? ''} ${o.description ?? ''} ${o.technicalImpact ?? ''}`).unsupported.length === 0);
    if (options.length === 0) continue;
    const stillThere = (id: string | undefined) => options.some((o) => o.id === id);
    const fallback = options.find((o) => o.isRecommended) ?? options[0]!;
    out.push({ ...q, options, defaultOptionId: stillThere(q.defaultOptionId) ? q.defaultOptionId : fallback.id });
  }
  return out;
}

export class AiGeneratorService {
  /**
   * Generates dynamic discovery questions and identifies architectural gaps for a given prompt.
   * Leverages gpt-4o-mini via Azure AI Foundry with automatic heuristic fallback.
   */
  static async generateQuestionnaire(
    prompt: string,
    provider: 'aws' | 'azure' = 'aws'
  ): Promise<QuestionnaireResult> {
    try {
      const systemPrompt = `You are a Principal Cloud Architect specializing in ${provider.toUpperCase()} enterprise infrastructure.
Your task is to analyze the user's workload requirements and generate an interactive scoping questionnaire to fill any architectural gaps.

Analyze the prompt for missing production details such as:
1. Expected traffic volume, concurrency, and auto-scaling rules.
2. High Availability (HA), Multi-AZ redundancy, and fault tolerance.
3. Security, Web Application Firewall (WAF), DDoS protection, and subnet isolation.
4. Compute tier (Containers / ECS / EKS / AKS vs Serverless / Lambda vs VMs / EC2).
5. Data persistence, automated backup retention (>= 7 days), encryption at rest, and caching (Redis).
6. CDN / Edge distribution (CloudFront / Front Door) and secure object storage with blocked public access.

Output MUST be a single valid JSON object strictly matching this schema:
{
  "summary": "Brief explanation of gaps found and rationale for questions",
  "suggestedProjectName": "Concise 3-5 word name for the project",
  "identifiedGaps": [
    {
      "id": "gap-1",
      "title": "Short title of missing specification",
      "description": "Why this matters for production",
      "severity": "critical" | "important" | "suggestion",
      "addressedByQuestionId": "q-1"
    }
  ],
  "questions": [
    {
      "id": "q-1",
      "category": "scale" | "availability" | "security" | "compute" | "database" | "storage" | "network" | "observability",
      "categoryLabel": "Human-friendly category title",
      "question": "Clear, precise question",
      "rationale": "Why this question is critical for the architecture",
      "options": [
        {
          "id": "opt-1",
          "label": "Option title",
          "description": "Short explanation",
          "isRecommended": true | false,
          "technicalImpact": "Specific resources or settings this enables"
        }
      ],
      "defaultOptionId": "opt-1"
    }
  ]
}

Provide 4 to 6 questions. Ensure exactly one option per question has "isRecommended": true, and "defaultOptionId" matches that option.
CloudCraft cannot model these services yet, so NEVER offer them as options (not even inside a description): ${unsupportedServiceNames().join(', ')}. Offer only services that exist in the ${provider.toUpperCase()} catalog.`;

      const response = await foundryClient().responses.create({
        model: FOUNDRY_MODEL,
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Workload description: "${prompt}"\nTarget Cloud Provider: ${provider.toUpperCase()}` },
        ],
        text: { format: { type: 'json_object' } },
      });

      const outputText = response.output_text || '{}';
      const parsed = JSON.parse(outputText) as Partial<QuestionnaireResult>;

      if (parsed.questions && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
        return {
          summary: parsed.summary || 'Please review and customize the following architectural specifications.',
          suggestedProjectName: parsed.suggestedProjectName || prompt.slice(0, 35).trim(),
          identifiedGaps: parsed.identifiedGaps || [],
          questions: dropUnsupportedOptions(parsed.questions),
        };
      }
    } catch (err) {
      console.warn('[AiGeneratorService] Failed to generate AI questionnaire via Foundry, using heuristic discovery:', (err as Error)?.message);
    }

    return getHeuristicQuestionnaire(prompt, provider);
  }

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
    /** Choices from the scoping questionnaire (question → chosen option), if the user went through it. */
    answers?: QuestionnaireAnswers,
    requirementsSummary?: string,
    // Each pass usually clears one stage (settings, then containment, then the gates), so an untuned
    // model needs more rounds than a tuned one, which should pass first time.
    maxAttempts = 5,
  ): Promise<ValidatedGeneration> {
    // Only add a provider hint when the request doesn't already name a cloud, so prompts that do
    // (e.g. "AWS primary with Azure DR") reach the model exactly as written.
    const namesCloud = /\b(aws|azure|multi-?cloud)\b/i.test(prompt);
    let request = namesCloud ? prompt : `${prompt}\n\nTarget cloud: ${provider === 'azure' ? 'Azure' : 'AWS'}.`;
    if (answers && Object.keys(answers).length > 0) {
      const list = Object.entries(answers).map(([k, v]) => `• ${k}: ${v}`).join('\n');
      request += `\n\nUSER SPECIFICATIONS & ANSWERS:\n${list}`;
    }
    if (requirementsSummary) request += `\n\nADDITIONAL USER REQUIREMENTS:\n${requirementsSummary}`;
    // Ground the model in the knowledge base: closest verified example plus exact settings and placement
    // rules. Empty when the knowledge base is disabled or unavailable — generation works without it.
    const context = await buildGenerationContext(prompt, provider);
    const userPrompt = context ? `${request}\n\n${context}` : request;

    let sanitized: SanitizeReport = { renamed: [], dropped: [] };
    const run = (promptText: string, attempts: number) => generateWithRepair(async (messages) => {
      const response = await foundryClient().responses.create({
        model: FOUNDRY_MODEL,
        input: messages,
        text: { format: { type: 'json_object' } },
      });
      return response.output_text || '';
    }, promptText, attempts, withHints, (json) => {
      // Rename near-miss setting names and drop invented ones before validating; the last call is the accepted attempt.
      const cleaned = sanitizeSpecInput(json);
      // Then the mechanical repairs the AI keeps getting wrong (certificate placeholder, WAF, parts left unconnected).
      const repaired = repairSpecInput(cleaned.value);
      sanitized = { ...cleaned.report, specRepairs: repaired.report };
      return repaired.value;
    }, { autoRepair: true });

    let outcome = await run(userPrompt, maxAttempts);

    // The dependable ladder when the AI's own design does not pass: (1) ask it to change the closest VERIFIED design as little as
    // possible; (2) if that still fails, use the verified design itself. A verified design passed every gate before it was stored and is
    // checked again here, so this never returns something that fails.
    let basedOnPattern: string | undefined;
    let verifiedFallback = false;
    if (!outcome.ok) {
      const base = await closestVerifiedDesign(prompt, provider);
      if (base) {
        const second = await run(adjustPrompt(request, base), 2);
        if (second.ok) {
          outcome = { ...second, attempts: [...outcome.attempts, ...second.attempts] };
          basedOnPattern = base.title;
        } else {
          const ev = evaluateSpec(base.spec);
          if (ev.ok && ev.graph) {
            outcome = { ok: true, attempts: [...outcome.attempts, ...second.attempts], spec: ev.spec, graph: ev.graph, deploymentInputs: ev.deploymentInputs };
            basedOnPattern = base.title;
            verifiedFallback = true;
          }
        }
      }
    }

    const last = outcome.attempts[outcome.attempts.length - 1]!;
    // No design passed every gate: hand back the closest one for review instead of an error. It is clearly flagged, and the deploy
    // checks (readiness, Terraform preflight) still stop anything unfit from being deployed.
    const needsReview = !outcome.ok && !!outcome.best;
    const chosen = outcome.ok ? outcome : outcome.best;
    let historyId = '';
    if (outcome.ok || needsReview) {
      try {
        const { architectureRepository } = await import('../repositories/architectureRepository');
        const architecture = await architectureRepository.findByEnvironment(environmentId);
        if (architecture) {
          const record = await db.orm.public.AIGenerationHistory.create({
            id: crypto.randomUUID(), projectId, architectureId: architecture.id, prompt, provider,
            model: FOUNDRY_MODEL, architectureJson: JSON.stringify(chosen?.spec), createdAt: new Date().toISOString(),
          });
          historyId = record.id;
        }
      } catch (err) {
        console.warn('[AiGeneratorService] Failed to record generation history:', (err as Error)?.message);
      }
    }

    return {
      ok: outcome.ok || needsReview,
      needsReview,
      basedOnPattern,
      verifiedFallback,
      autoRepairs: outcome.ok ? outcome.autoRepairs : outcome.best?.autoRepairs,
      graph: chosen?.graph,
      deploymentInputs: chosen?.deploymentInputs ?? [],
      attempts: outcome.attempts,
      // Judged against what the user asked for, not what the model produced: an unsupported service the model
      // silently swapped for another one must still be reported.
      notices: detectServiceNotices(request, chosen?.graph ? designTypesOf(chosen.graph.nodes) : undefined),
      sanitized,
      issues: outcome.ok ? [] : (outcome.best?.issues ?? last.issues).map((i) => i.message),
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
