import { runAwsPreflight, regionFromTfvars, type PreflightClients } from '@/lib/terraform/execution/preflight';
import type { DbArchitectureResource } from '@/lib/repositories/architectureRepository';

const rds = (id: string, label: string, config: Record<string, unknown>): DbArchitectureResource => ({
  id, label, resourceType: 'aws_rds', provider: 'aws', configJson: JSON.stringify(config), positionX: 0, positionY: 0, region: null, groupId: null, locked: false, architectureId: 'a',
} as DbArchitectureResource);

/** A fake AWS that offers exactly these versions of one engine. */
function fakeAws(offered: string[]): { clients: PreflightClients; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const send = jest.fn(async (command: { input: { Engine: string; EngineVersion?: string } }) => {
    calls.push(command.input);
    const { EngineVersion } = command.input;
    const list = EngineVersion ? offered.filter((v) => v === EngineVersion) : offered;
    return { DBEngineVersions: list.map((v) => ({ EngineVersion: v })) };
  });
  return { clients: { rds: { send } }, calls };
}

const OFFERED = ['16.8', '16.9', '16.10', '16.11', '15.14', '17.5'];

describe('database engine version check', () => {
  test('a version AWS offers passes, with one question to AWS', async () => {
    const f = fakeAws(OFFERED);
    expect(await runAwsPreflight({ resources: [rds('d', 'Orders DB', { engine: 'postgres', engineVersion: '16.9' })], region: 'us-east-1', clients: f.clients })).toEqual([]);
    expect(f.calls).toHaveLength(1);
  });

  test('a version AWS no longer offers is a plain-language problem naming the database, the region and what is available', async () => {
    const f = fakeAws(OFFERED);
    const [p] = await runAwsPreflight({ resources: [rds('d', 'Orders DB (PostgreSQL)', { engine: 'postgres', engineVersion: '16.4' })], region: 'us-east-1', clients: f.clients });
    expect(p).toMatch(/"Orders DB \(PostgreSQL\)" ask for postgres 16\.4, which AWS no longer offers in us-east-1/);
    expect(p).toMatch(/Versions available now include 16\.8, 16\.9, 16\.10, 16\.11/);      // same major, oldest to newest, numeric order
    expect(p).not.toMatch(/15\.14|17\.5/);
    expect(p).toMatch(/enter only the major version \(16\)/);
    expect(p).toMatch(/after the other resources had already been built/);
  });

  test('two databases asking for the same missing version are one problem, asked once', async () => {
    const f = fakeAws(OFFERED);
    const problems = await runAwsPreflight({
      resources: [rds('a', 'Orders DB', { engine: 'postgres', engineVersion: '16.4' }), rds('b', 'Payments DB', { engine: 'postgres', engineVersion: '16.4' })],
      region: 'us-east-1', clients: f.clients,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/databases "Orders DB", "Payments DB"/);
    expect(f.calls.filter((c) => c['EngineVersion'] === '16.4')).toHaveLength(1);
  });

  test('when AWS cannot be asked (no permission, network) it says nothing and never blocks', async () => {
    const clients: PreflightClients = { rds: { send: async () => { throw Object.assign(new Error('AccessDenied'), { name: 'AccessDeniedException' }); } } };
    expect(await runAwsPreflight({ resources: [rds('d', 'DB', { engine: 'postgres', engineVersion: '16.4' })], region: 'us-east-1', clients })).toEqual([]);
  });

  test('resources it cannot judge are ignored: no version, an unknown engine, other types, bad config', async () => {
    const f = fakeAws(OFFERED);
    const bad = rds('x', 'Bad', {}); bad.configJson = '{ nope';
    const other = { ...rds('y', 'Lambda', { engine: 'postgres', engineVersion: '16.4' }), resourceType: 'aws_lambda' } as DbArchitectureResource;
    const problems = await runAwsPreflight({
      resources: [rds('a', 'No version', { engine: 'postgres', engineVersion: '' }), rds('b', 'Oracle', { engine: 'oracle-ee', engineVersion: '19' }), other, bad],
      region: 'us-east-1', clients: f.clients,
    });
    expect(problems).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  test('when the whole major is gone, the newest of the engine are shown instead', async () => {
    const f = fakeAws(['16.9', '17.5', '17.6']);
    const [p] = await runAwsPreflight({ resources: [rds('d', 'Old DB', { engine: 'postgres', engineVersion: '12.4' })], region: 'eu-west-1', clients: f.clients });
    expect(p).toMatch(/include 16\.9, 17\.5, 17\.6/);
  });
});

describe('regionFromTfvars', () => {
  test('reads the deployment region the generated files state', () => {
    expect(regionFromTfvars('environment = "production"\naws_region   = "us-east-1"\n')).toBe('us-east-1');
    expect(regionFromTfvars('aws_region = "eu-north-1"')).toBe('eu-north-1');
  });
  test('null when there is none', () => {
    expect(regionFromTfvars('environment = "x"')).toBeNull();
    expect(regionFromTfvars(undefined)).toBeNull();
  });
});
