/**
 * One JSON-returning model call, injectable so every AI cost feature can be tested without the network.
 * Uses the same Azure AI Foundry deployment as the rest of CloudBuilder's AI (lib/ai/foundryClient.ts).
 */
import { foundryClient, FOUNDRY_MODEL } from '@/lib/ai/foundryClient';
import { extractJson } from '@/lib/ai/architectRepair';

export type AskModel = (system: string, user: string) => Promise<Record<string, unknown> | undefined>;

/** True when a model is configured and AI cost help is not switched off (CLOUDCRAFT_AI_COST=off). */
export function aiCostAvailable(): boolean {
  if (process.env['CLOUDCRAFT_AI_COST'] === 'off') return false;
  return Boolean(process.env['AZURE_AI_FOUNDRY_ENDPOINT'] && process.env['AZURE_AI_FOUNDRY_API_KEY']);
}

export const askFoundryJson: AskModel = async (system, user) => {
  const response = await foundryClient().responses.create({
    model: FOUNDRY_MODEL,
    input: [{ role: 'system', content: system }, { role: 'user', content: user }],
    text: { format: { type: 'json_object' } },
  });
  const raw = (response as { output_text?: string }).output_text ?? '';
  const parsed = extractJson(raw);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
};
