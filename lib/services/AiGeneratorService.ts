import { GoogleGenAI } from '@google/genai';
import { awsResources } from '../resources/aws';
import { azureResources } from '../resources/azure';
import { db } from '../../src/prisma/db';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
   * Generates a cloud architecture from a prompt using Gemini.
   * The AI is constrained to the RDE catalog — unsupported resource types are rejected.
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
4. Generate realistic, production-like configurations.`;

    const response = await ai.models.generateContent({
      model: 'gemini-1.5-pro',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
      },
    });

    const outputText = response.text || '{}';
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
        `[AiGeneratorService] Gemini produced unsupported resource types (removed): ${rejected.join(', ')}`
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
          model: 'gemini-1.5-pro',
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

