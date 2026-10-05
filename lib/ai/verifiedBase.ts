/**
 * Verified starting designs.
 *
 * CloudCraft's knowledge base holds a handful of complete designs that pass every deploy-readiness gate (three-tier on EC2, ECS,
 * serverless, static site, the Azure equivalents, multi-cloud…). When the model cannot produce a design of its own that passes, the
 * closest of these is the dependable answer: either as the starting point the model is asked to change as little as possible, or,
 * as a last resort, as the design itself. Either way it is checked here with the same gates before it is used.
 */
import { evaluateSpec } from './architectureSpec';
import { providersFor, searchKnowledgeBase, type KbChunk } from './knowledgeBase';

const SAMPLE_MARKER = 'Sample design (JSON):';

export interface VerifiedBase {
  /** Pattern title, e.g. "Pattern: three-tier web application on EC2 Auto Scaling". */
  title: string;
  patternId: string;
  /** The design as the model writes it (the spec format), checked to pass every gate. */
  spec: unknown;
}

type Search = (query: string, opts: { kinds: ['pattern']; providers: string[]; k: number }) => Promise<KbChunk[]>;

/** The design inside a pattern chunk, or null if it has none or does not parse. */
export function sampleOf(chunk: KbChunk): unknown | null {
  const at = chunk.text.indexOf(SAMPLE_MARKER);
  if (at < 0) return null;
  try { return JSON.parse(chunk.text.slice(at + SAMPLE_MARKER.length).trim()); } catch { return null; }
}

/** The closest verified design for the request, or null when there is none that still passes the gates. */
export async function closestVerifiedDesign(prompt: string, fallbackProvider: 'aws' | 'azure', search: Search = searchKnowledgeBase as Search): Promise<VerifiedBase | null> {
  // Never throws: this is a fallback, so if the knowledge base is unavailable the caller simply has no verified design to use.
  try {
    const providers = providersFor(prompt, fallbackProvider);
    const found: KbChunk[] = await search(prompt, { kinds: ['pattern'], providers, k: 3 });
    for (const chunk of found) {
      const spec = sampleOf(chunk);
      if (spec && evaluateSpec(spec).ok) return { title: chunk.title.replace(/^Pattern:\s*/i, ''), patternId: chunk.id, spec };
    }
  } catch { /* fall through */ }
  return null;
}

/** The request for the "change this verified design as little as possible" pass. */
export function adjustPrompt(request: string, base: VerifiedBase): string {
  return `${request}\n\nStart from this verified design (${base.title}). It already passes every CloudCraft check. Return the COMPLETE design as one JSON object, changing only what the request needs (names, region, sizes, database engine, extra or removed services). Keep everything else exactly as it is: the ids, parents, availability zones, security groups and connections. Every resource you add must be connected and placed like its neighbours.\n\nVerified design:\n${JSON.stringify(base.spec)}`;
}
