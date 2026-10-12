import { readFileSync } from 'fs';
import { evaluateSpec } from '@/lib/ai/architectureSpec';
import { repairSpecInput, describeSpecRepair } from '@/lib/ai/specRepair';
import { sanitizeSpecInput } from '@/lib/ai/specSanitizer';

type Spec = { resources: { id: string; type: string; parent?: string; config?: Record<string, unknown> }[]; connections: { from: string; to: string }[] };
const good = JSON.parse(readFileSync('datasets/ai-architect/validation.jsonl', 'utf8').split('\n').filter(Boolean)
  .map((l) => (JSON.parse(l) as { messages: { content: string }[] }).messages[2]!.content)
  // An EC2 Auto Scaling three-tier design (the tests below take its parts apart); the dataset's order changes whenever it is regenerated.
  .find((c) => c.trim().startsWith('{') && c.includes('"id":"waf-alb"') && c.includes('"id":"asg-a"') && !c.includes('"id":"queue"'))!) as Spec;
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
    expect(report).toMatchObject({ certificates: 1, waf: 1, connections: 2 });
    const out = value as Spec;
    expect(out.resources.find((r) => r.id === 'alb')!.config!['certificateArn']).toMatch(/REPLACE-WITH-YOUR-CERTIFICATE-ID$/);
    expect(out.connections).toEqual(expect.arrayContaining([{ from: 'waf-alb', to: 'alb' }, { from: 'alb', to: 'asg-a' }, { from: 'alb', to: 'asg-b' }]));

    const result = evaluateSpec(value, { autoRepair: true });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.deploymentInputs?.some((d) => /certificate/i.test(`${d.setting} ${d.resourceLabel}`))).toBe(true);   // the person is still told to supply the real one
  });

  it('connects a firewall, internet gateway and NAT gateways the AI left floating', () => {
    const s = clone(good);
    s.connections = s.connections.filter((c) => c.from !== 'waf-alb' && !(c.from === 'igw') && !(c.to === 'igw') && !(c.to.startsWith('nat-')));
    expect(evaluateSpec(s, { autoRepair: true }).ok).toBe(false);
    const { value, report } = repairSpecInput(s);
    expect(report.connections).toBe(4);
    expect((value as Spec).connections).toEqual(expect.arrayContaining([{ from: 'waf-alb', to: 'alb' }, { from: 'igw', to: 'alb' }, { from: 'nat-a', to: 'igw' }, { from: 'nat-b', to: 'igw' }]));
    expect(evaluateSpec(value, { autoRepair: true }).ok).toBe(true);
  });

  it('connects a cache and a bucket that nothing calls to the compute that should use them', () => {
    const spec = {
      name: 'x', summary: 'y',
      resources: [
        { id: 'cloud', type: 'aws_cloud_boundary', label: 'AWS' },
        { id: 'fn', type: 'aws_lambda', label: 'Processing Lambda', parent: 'cloud' },
        { id: 'cache', type: 'aws_elasticache', label: 'Redis', parent: 'cloud' },
        { id: 'bucket', type: 'aws_s3', label: 'Uploads', parent: 'cloud' },
      ],
      connections: [] as { from: string; to: string }[],
    };
    const { report, value } = repairSpecInput(spec);
    expect(report.connections).toBe(2);
    expect((value as typeof spec).connections).toEqual(expect.arrayContaining([{ from: 'fn', to: 'cache' }, { from: 'fn', to: 'bucket' }]));
  });

  it('gives subnets that share an address range their own, and declares a missing internet gateway', () => {
    const s = clone(good);
    for (const r of s.resources) if (r.type === 'aws_subnet' && r.config) delete r.config['cidrBlock'];     // every subnet falls back to the same default
    s.resources = s.resources.filter((r) => r.id !== 'igw');
    const { value, report } = repairSpecInput(s);
    expect(report.addressing).toBe(6);
    expect(report.gateway).toBe(1);
    const subnets = (value as Spec).resources.filter((r) => r.type === 'aws_subnet').map((r) => r.config!['cidrBlock']);
    expect(new Set(subnets).size).toBe(6);
    expect(subnets.every((c) => /^\d+\.\d+\.\d+\.0\/24$/.test(String(c)))).toBe(true);
    const result = evaluateSpec(value, { autoRepair: true });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('Azure: adds missing network security groups and secures SQL and Redis defaults, and then the design passes', async () => {
    const { loadChunks } = await import('@/lib/ai/knowledgeBase');
    const { sampleOf } = await import('@/lib/ai/verifiedBase');
    const chunk = loadChunks().find((c) => c.id === 'pattern-azure-gateway-app-service')!;
    const azure = clone(sampleOf(chunk)) as Spec;
    expect(evaluateSpec(azure).ok).toBe(true);
    const nsgIds = azure.resources.filter((r) => r.type === 'azure_nsg').map((r) => r.id);
    azure.resources = azure.resources.filter((r) => r.type !== 'azure_nsg');
    azure.connections = azure.connections.filter((c) => !nsgIds.includes(c.from));
    for (const r of azure.resources) {
      if (r.type === 'azure_sql' && r.config) { delete r.config['auditingEnabled']; delete r.config['publicNetworkAccess']; }
      if (r.type === 'azure_redis' && r.config) r.config['publicNetworkAccessEnabled'] = true;
    }
    expect(evaluateSpec(azure, { autoRepair: true }).ok).toBe(false);
    const { value, report } = repairSpecInput(azure);
    expect(report.nsgs).toBe(nsgIds.length);
    expect(report.secured).toBeGreaterThan(0);
    const result = evaluateSpec(value, { autoRepair: true });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  describe('Azure mistakes seen in the 101-prompt run', () => {
    const azure = async (): Promise<Spec> => {
      const { loadChunks } = await import('@/lib/ai/knowledgeBase');
      const { sampleOf } = await import('@/lib/ai/verifiedBase');
      return clone(sampleOf(loadChunks().find((c) => c.id === 'pattern-azure-gateway-app-service')!)) as Spec;
    };
    const passes = (spec: unknown) => { const r = evaluateSpec(spec, { autoRepair: true }); return { ok: r.ok, issues: r.issues }; };

    it('attaches a network security group that was created but connected to nothing, and places it in the network', async () => {
      const a = await azure();
      const web = a.resources.find((r) => r.id === 'nsg-web')!;
      a.connections = a.connections.filter((c) => c.from !== 'nsg-web');
      delete (web as { parent?: string }).parent;
      expect(passes(a).ok).toBe(false);
      const { value, report } = repairSpecInput(a);
      expect(report.groups).toBeGreaterThan(0);
      expect(passes(value)).toEqual({ ok: true, issues: [] });
    });

    it('moves a workload placed in the network itself into its subnet', async () => {
      const a = await azure();
      const subnet = a.resources.find((r) => r.id === 'web-subnet' || r.type === 'azure_subnet')!;
      const agw = a.resources.find((r) => r.type === 'azure_app_gateway')!;
      agw.parent = subnet.parent;       // the VNet instead of the web subnet
      expect(passes(a).ok).toBe(false);
      const { value, report } = repairSpecInput(a);
      expect(report.placed).toBe(1);
      expect(passes(value)).toEqual({ ok: true, issues: [] });
    });

    it('removes a traffic line drawn from a subnet', async () => {
      const a = await azure();
      const agw = a.resources.find((r) => r.type === 'azure_app_gateway')!;
      a.connections.push({ from: agw.parent!, to: agw.id });
      expect(passes(a).ok).toBe(false);
      const { value, report } = repairSpecInput(a);
      expect(report.containerEdges).toBe(1);
      expect(passes(value)).toEqual({ ok: true, issues: [] });
    });

    it('connects a storage account nothing uses to the app, and resets an invented setting choice', async () => {
      const a = await azure();
      a.connections = a.connections.filter((c) => c.to !== 'storage');
      const app = a.resources.find((r) => r.type === 'azure_app_service')!;
      app.config = { ...(app.config ?? {}), skuName: 'P99xl' };
      expect(passes(a).ok).toBe(false);
      const { value, report } = repairSpecInput(a);
      expect(report.connections).toBeGreaterThan(0);
      expect(report.choices).toBe(1);
      expect(passes(value)).toEqual({ ok: true, issues: [] });
    });
  });

  it('spreads subnets with no zone across two zones (sanitizer) so the single-zone check passes', () => {
    const { value } = sanitizeSpecInput(sloppy());
    const zones = new Set((value as Spec).resources.filter((r) => r.type === 'aws_subnet').map((r) => r.config!['availabilityZone']));
    expect(zones.size).toBe(2);
  });

  it('leaves a design that is already fine untouched', () => {
    const { value, report } = repairSpecInput(good);
    expect(report).toEqual({ firewalls: 0, reversed: 0, privateEndpoints: 0, flexSubnets: 0, certificates: 0, waf: 0, connections: 0, addressing: 0, gateway: 0, secured: 0, nsgs: 0, placed: 0, containerEdges: 0, groups: 0, choices: 0 });
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
    expect(describeSpecRepair({ firewalls: 1, reversed: 1, privateEndpoints: 1, flexSubnets: 1, certificates: 1, waf: 1, connections: 2, addressing: 3, gateway: 1, secured: 2, nsgs: 3, placed: 1, containerEdges: 1, groups: 1, choices: 1 })).toHaveLength(15);
    expect(describeSpecRepair({ firewalls: 0, reversed: 0, privateEndpoints: 0, flexSubnets: 0, certificates: 0, waf: 0, connections: 0, addressing: 0, gateway: 0, secured: 0, nsgs: 0, placed: 0, containerEdges: 0, groups: 0, choices: 0 })).toEqual([]);
  });

  it('never makes input that is not a design worse', () => {
    expect(repairSpecInput(null).value).toBeNull();
    expect(repairSpecInput({ resources: 'x' }).value).toEqual({ resources: 'x' });
  });
});
