import { readFileSync } from 'fs';
import { sanitizeSpecInput, describeSanitized, spreadSubnetZones } from '@/lib/ai/specSanitizer';
import { evaluateSpec, parseSpec } from '@/lib/ai/architectureSpec';

// A design from the training set — verified to pass every deploy-readiness gate.
// A design from the dataset that has a load-balancer WAF (the test below removes it). Not "the first row": which design comes first changes whenever the dataset is rebuilt.
const good = JSON.parse(readFileSync('datasets/ai-architect/validation.jsonl', 'utf8').split('\n').filter(Boolean)
  .map((l) => (JSON.parse(l) as { messages: { content: string }[] }).messages[2]!.content)
  .find((c) => c.trim().startsWith('{') && c.includes('"id":"waf-alb"'))!);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

const spec = (config: Record<string, unknown>, type = 'aws_subnet') => ({
  name: 'x', summary: 'y', resources: [{ id: 'a', type, label: 'A', config }], connections: [],
});

describe('renaming near-miss setting names', () => {
  it('renames snake_case, other casings and hyphenated spellings to the real setting, keeping the value', () => {
    for (const bad of ['cidr_block', 'CIDRBlock', 'cidrblock', 'cidr-block']) {
      const { value, report } = sanitizeSpecInput(spec({ [bad]: '10.0.0.0/24' }));
      expect((value as ReturnType<typeof spec>).resources[0]!.config).toEqual({ cidrBlock: '10.0.0.0/24' });
      expect(report.renamed).toEqual([{ type: 'aws_subnet', from: bad, to: 'cidrBlock', resources: ['a'] }]);
      expect(report.dropped).toEqual([]);
    }
  });

  it('does not overwrite a real setting that is also present', () => {
    const { value, report } = sanitizeSpecInput(spec({ cidrBlock: '10.0.1.0/24', cidr_block: '10.9.9.0/24' }));
    expect((value as ReturnType<typeof spec>).resources[0]!.config).toEqual({ cidrBlock: '10.0.1.0/24' });
    expect(report.dropped).toHaveLength(1);
  });
});

describe('dropping invented settings', () => {
  it('drops a setting that matches nothing, keeps the rest, and says which resource it was on', () => {
    const { value, report } = sanitizeSpecInput({
      name: 'x', summary: 'y', connections: [],
      resources: [
        { id: 'db-1', type: 'aws_rds', label: 'DB', config: { allocatedStorageGb: 100, multiAz: true } },
        { id: 'db-2', type: 'aws_rds', label: 'DB2', config: { allocatedStorageGb: 200 } },
      ],
    });
    const res = (value as { resources: { config: Record<string, unknown> }[] }).resources;
    expect(res[0]!.config).toEqual({ multiAz: true });
    expect(res[1]!.config).toEqual({});
    expect(report.dropped).toEqual([{ type: 'aws_rds', setting: 'allocatedStorageGb', resources: ['db-1', 'db-2'] }]);
    expect(describeSanitized(report)[0]).toContain('aws_rds.allocatedStorageGb (db-1, db-2)');
  });

  it('warns only about drops — renames are lossless and stay quiet', () => {
    expect(describeSanitized({ renamed: [{ type: 't', from: 'a_b', to: 'aB', resources: ['x'] }], dropped: [] })).toEqual([]);
  });
});

describe('leaves everything else alone', () => {
  it('does not touch valid settings, unknown resource types, or values (a wrong value is a real mistake to repair)', () => {
    const input = spec({ cidrBlock: '10.0.0.0/24', availabilityZone: 'us-east-1a' });
    expect(sanitizeSpecInput(input).value).toEqual(input);
    expect(sanitizeSpecInput(spec({ whatever: 1 }, 'aws_not_real')).report.dropped).toEqual([]);
    // invalid VALUE for a known setting is preserved so the validator can report it
    const badValue = spec({ periodSeconds: 45 }, 'aws_cloudwatch');
    expect((sanitizeSpecInput(badValue).value as typeof badValue).resources[0]!.config).toEqual({ periodSeconds: 45 });
    expect(parseSpec(sanitizeSpecInput(badValue).value).issues[0]!.code).toBe('BAD_CONFIG_VALUE');
  });

  it('never mutates its input and passes non-designs straight through', () => {
    const input = spec({ cidr_block: '10.0.0.0/24' });
    const before = JSON.stringify(input);
    sanitizeSpecInput(input);
    expect(JSON.stringify(input)).toBe(before);
    for (const junk of [null, 'text', 42, { resources: 'nope' }, []]) expect(sanitizeSpecInput(junk).value).toEqual(junk);
  });
});

describe('with the validator', () => {
  it('a design whose settings were all written snake_case passes once cleaned', () => {
    const broken = clone(good);
    for (const r of broken.resources) {
      if (!r.config) continue;
      r.config = Object.fromEntries(Object.entries(r.config).map(([k, v]) => [k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), v]));
    }
    const hasSnake = broken.resources.some((r: { config?: Record<string, unknown> }) => r.config && Object.keys(r.config).some((k) => k.includes('_')));
    expect(hasSnake).toBe(true);
    expect(evaluateSpec(broken).ok).toBe(false);                       // strict validation rejects it…
    expect(evaluateSpec(sanitizeSpecInput(broken).value).ok).toBe(true); // …cleaning recovers the exact design
  });

  it('an invented setting is dropped, but the safety gates still judge the resulting design', () => {
    const withInvented = clone(good);
    withInvented.resources[0].config = { ...(withInvented.resources[0].config ?? {}), totallyMadeUpSetting: true };
    expect(evaluateSpec(withInvented).ok).toBe(false);
    expect(evaluateSpec(sanitizeSpecInput(withInvented).value).ok).toBe(true);

    // Drop the WAF the design needs → cleaning cannot hide that: the assessment gate still fails it.
    const noWaf = clone(good);
    const waf = noWaf.resources.find((r: { id: string }) => r.id.endsWith('waf-alb'));
    expect(waf).toBeDefined(); // fails loudly if the fixture ever stops containing a WAF
    {
      noWaf.resources = noWaf.resources.filter((r: unknown) => r !== waf);
      noWaf.connections = noWaf.connections.filter((c: { from: string; to: string }) => c.from !== waf.id && c.to !== waf.id);
      expect(evaluateSpec(sanitizeSpecInput(noWaf).value).ok).toBe(false);
    }
  });
});

describe('spreadSubnetZones', () => {
  const sub = (id: string, az: string | undefined, isPublic: boolean) => ({ id, type: 'aws_subnet', config: { cidrBlock: '10.0.0.0/24', isPublic, ...(az ? { availabilityZone: az } : {}) } });
  const zonesOf = (rs: { config?: unknown }[]) => rs.map((r) => (r.config as { availabilityZone?: string }).availabilityZone);

  it('moves every second subnet of a kind to another zone when the design put them all in one', () => {
    const rs = [sub('public_subnet_1', 'us-east-1a', true), sub('public_subnet_2', 'us-east-1a', true), sub('private_subnet_1', 'us-east-1a', false), sub('private_subnet_2', 'us-east-1a', false)];
    const moved = spreadSubnetZones(rs);
    expect(zonesOf(rs)).toEqual(['us-east-1a', 'us-east-1b', 'us-east-1a', 'us-east-1b']);
    expect(moved).toEqual(['public_subnet_2', 'private_subnet_2']);
  });

  it('alternates overall when each kind has only one subnet', () => {
    const rs = [sub('public', 'eu-west-1a', true), sub('private', 'eu-west-1a', false)];
    spreadSubnetZones(rs);
    expect(zonesOf(rs)).toEqual(['eu-west-1a', 'eu-west-1b']);
  });

  it('leaves alone designs that already use two zones, have no zone, or have one subnet', () => {
    const ok = [sub('a', 'us-east-1a', true), sub('b', 'us-east-1b', true)];
    expect(spreadSubnetZones(ok)).toEqual([]);
    const none = [sub('a', undefined, true), sub('b', undefined, true)];
    expect(spreadSubnetZones(none)).toEqual([]);
    expect(spreadSubnetZones([sub('a', 'us-east-1a', true)])).toEqual([]);
  });

  it('is applied by sanitizeSpecInput and reported to the user', () => {
    const out = sanitizeSpecInput({ resources: [sub('s1', 'us-east-1a', true), sub('s2', 'us-east-1a', true)] });
    expect(out.report.zonesSpread).toEqual(['s2']);
    expect(describeSanitized(out.report).join(' ')).toMatch(/spread 1 of them across two zones/);
  });
});
