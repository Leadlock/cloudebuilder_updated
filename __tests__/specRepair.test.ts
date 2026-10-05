import { readFileSync } from 'fs';
import { evaluateSpec } from '@/lib/ai/architectureSpec';
import { repairSpecInput, describeSpecRepair } from '@/lib/ai/specRepair';
import { sanitizeSpecInput } from '@/lib/ai/specSanitizer';

type Spec = { resources: { id: string; type: string; parent?: string; config?: Record<string, unknown> }[]; connections: { from: string; to: string }[] };
const good = JSON.parse(readFileSync('datasets/ai-architect/validation.jsonl', 'utf8').split('\n').filter(Boolean)
  .map((l) => (JSON.parse(l) as { messages: { content: string }[] }).messages[2]!.content)
  .find((c) => c.trim().startsWith('{') && c.includes('"id":"waf-alb"'))!) as Spec;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** The kind of design the AI hands back: no certificate, no WAF, the load balancer not connected to the servers, no zones set. */
function sloppy(): Spec {
  const s = clone(good);
  s.resources = s.resources.filter((r) => r.type !== 'aws_waf');
  // (monitoring only touches the load balancer, so it does not bridge the servers back to it.)
  s.connections = s.connections.filter((c) => c.from !== 'waf-alb' && !(c.from === 'alb' && c.to.startsWith('asg-')) && !(c.from === 'cloudwatch' && c.to !== 'alb') && !(c.from.startsWith('asg-') && c.to.startsWith('nat-')));
  for (const r of s.resources) {
    if (r.type === 'aws_alb') delete r.config!['certificateArn'];
    if (r.type === 'aws_subnet' && r.config) delete r.config['availabilityZone'];
  }
  return s;
}

describe('specRepair', () => {
  it('the starting design passes and the sloppy one does not', () => {
    expect(evaluateSpec(good).ok).toBe(true);
    expect(evaluateSpec(sloppy(), { autoRepair: true }).ok).toBe(false);
  });

  it('adds a certificate placeholder, a WAF and the missing connections, and then the design passes', () => {
    const cleaned = sanitizeSpecInput(sloppy());
    const { value, report } = repairSpecInput(cleaned.value);
    expect(report).toEqual({ certificates: 1, waf: 1, connections: 2 });
    const out = value as Spec;
    expect(out.resources.find((r) => r.id === 'alb')!.config!['certificateArn']).toMatch(/REPLACE-WITH-YOUR-CERTIFICATE-ID$/);
    expect(out.connections).toEqual(expect.arrayContaining([{ from: 'waf-alb', to: 'alb' }, { from: 'alb', to: 'asg-a' }, { from: 'alb', to: 'asg-b' }]));

    const result = evaluateSpec(value, { autoRepair: true });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.deploymentInputs?.some((d) => /certificate/i.test(`${d.setting} ${d.resourceLabel}`))).toBe(true);   // the person is still told to supply the real one
  });

  it('spreads subnets with no zone across two zones (sanitizer) so the single-zone check passes', () => {
    const { value } = sanitizeSpecInput(sloppy());
    const zones = new Set((value as Spec).resources.filter((r) => r.type === 'aws_subnet').map((r) => r.config!['availabilityZone']));
    expect(zones.size).toBe(2);
  });

  it('leaves a design that is already fine untouched', () => {
    const { value, report } = repairSpecInput(good);
    expect(report).toEqual({ certificates: 0, waf: 0, connections: 0 });
    expect(value).toEqual(good);
  });

  it('does not touch an internal load balancer', () => {
    const s = sloppy();
    s.resources.find((r) => r.id === 'alb')!.config!['scheme'] = 'internal';
    const { report } = repairSpecInput(s);
    expect(report.certificates).toBe(0);
    expect(report.waf).toBe(0);
  });

  it('describes what it did', () => {
    expect(describeSpecRepair({ certificates: 1, waf: 1, connections: 2 })).toHaveLength(3);
    expect(describeSpecRepair({ certificates: 0, waf: 0, connections: 0 })).toEqual([]);
  });

  it('never makes input that is not a design worse', () => {
    expect(repairSpecInput(null).value).toBeNull();
    expect(repairSpecInput({ resources: 'x' }).value).toEqual({ resources: 'x' });
  });
});
