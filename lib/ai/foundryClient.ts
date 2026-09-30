import OpenAI from 'openai';

// Azure AI Foundry's "v1" API is OpenAI-SDK-compatible: point the standard client at
// "<endpoint>/openai/v1" with the resource's API key. AZURE_AI_FOUNDRY_ENDPOINT holds the full
// deployment URL copied from the portal (ending in "/responses"); strip that suffix for the SDK.
export function foundryBaseURL(): string {
  return (process.env.AZURE_AI_FOUNDRY_ENDPOINT ?? '').replace(/\/responses\/?$/, '');
}

let _client: OpenAI | null = null;
export function foundryClient(): OpenAI {
  if (!_client) {
    const baseURL = foundryBaseURL();
    const apiKey = process.env.AZURE_AI_FOUNDRY_API_KEY;
    if (!baseURL || !apiKey) {
      throw new Error('Azure AI Foundry is not configured — set AZURE_AI_FOUNDRY_ENDPOINT and AZURE_AI_FOUNDRY_API_KEY.');
    }
    _client = new OpenAI({ baseURL, apiKey });
  }
  return _client;
}

/** Chat/generation deployment (the fine-tuned model once it is deployed). */
export const FOUNDRY_MODEL = process.env.AZURE_AI_FOUNDRY_DEPLOYMENT || 'gpt-4o-mini';

/** Embedding deployment used to search the knowledge base. */
export const FOUNDRY_EMBEDDING_MODEL = process.env.AZURE_AI_FOUNDRY_EMBEDDING_DEPLOYMENT || 'text-embedding-3-small';
