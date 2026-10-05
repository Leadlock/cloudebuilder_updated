/**
 * Designs the AI gets slightly wrong are fixed with CloudCraft's own verified remediations, and a design that still cannot pass is
 * returned flagged for review instead of an error.
 */
import { readFileSync } from 'fs';
import { evaluateSpec } from '@/lib/ai/architectureSpec';
import { generateWithRepair } from '@/lib/ai/architectRepair';
import { sanitizeSpecInput } from '@/lib/ai/specSanitizer';

// A design from the training set that passes every gate, with a subnet.
const good = JSON.parse(readFileSync('datasets/ai-architect/validation.jsonl', 'utf8').split('\n').filter(Boolean)
  .map((l) => (JSON.parse(l) as { messages: { content: string }[] }).messages[2]!.content)
  .find((c) => c.trim().startsWith('{') && c.includes('"type":"aws_subnet"'))!) as { resources: { id: string; type: string; config?: Record<string, unknown> }[] };
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

function withPublicIps(): typeof good {
  const bad = clone(good);
  for (const r of bad.resources) if (r.type === 'aws_subnet') r.config = { ...(r.config ?? {}), mapPublicIpOnLaunch: true };
  return bad;
}

describe('auto repair', () => {
  it('the starting design passes, and the broken one fails without repair', () => {
    expect(evaluateSpec(good).ok).toBe(true);
    const broken = evaluateSpec(withPublicIps());
    expect(broken.ok).toBe(false);
    expect(broken.issues.some((i) => /AWS-VPC-001/.test(i.message))).toBe(true);
  });

  it('applies the rule\'s own fix and then passes, saying what it changed', () => {
    const fixed = evaluateSpec(withPublicIps(), { autoRepair: true });
    expect(fixed.ok).toBe(true);
    expect(fixed.autoRepairs?.some((a) => a.startsWith('AWS-VPC-001'))).toBe(true);
    const subnets = fixed.graph!.nodes.filter((n) => n.resourceType === 'aws_subnet');
    expect(subnets.length).toBeGreaterThan(0);
    expect(subnets.every((n) => n.config.mapPublicIpOnLaunch !== true)).toBe(true);
  });

  it('does not touch a design that already passes', () => {
    const r = evaluateSpec(good, { autoRepair: true });
    expect(r.ok).toBe(true);
    expect(r.autoRepairs).toBeUndefined();
  });

  it('generateWithRepair succeeds on the first attempt instead of asking the model again', async () => {
    const complete = jest.fn(async () => JSON.stringify(withPublicIps()));
    const out = await generateWithRepair(complete, 'prompt', 3, undefined, (j) => sanitizeSpecInput(j).value, { autoRepair: true });
    expect(out.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(out.autoRepairs?.length).toBeGreaterThan(0);
  });

  it('when nothing passes, returns the closest design as best effort instead of nothing', async () => {
    const stillBad = clone(good);
    (stillBad as { connections?: unknown[] }).connections = [];     // nothing connected: no verified fix exists for that
    const out = await generateWithRepair(async () => JSON.stringify(stillBad), 'prompt', 2, undefined, (j) => sanitizeSpecInput(j).value, { autoRepair: true });
    expect(out.ok).toBe(false);
    expect(out.best?.graph.nodes.length).toBeGreaterThan(0);
    expect(out.best?.issues.length).toBeGreaterThan(0);
  });
});
