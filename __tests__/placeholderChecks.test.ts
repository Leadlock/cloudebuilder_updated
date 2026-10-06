import { placeholderProblems, isReservedDomain } from '@/lib/engines/terraform/placeholderChecks';

const tf = (content: string) => [{ filename: 'main.tf', content }];

describe('reserved domains', () => {
  it.each(['example.com', 'microservices.example.com', 'shop.example.org', 'a.b.example.net', 'x.test', 'x.invalid', 'localhost', 'Example.COM.'])('%s is reserved', (d) => expect(isReservedDomain(d)).toBe(true));
  it.each(['mycompany.com', 'example-shop.com', 'notexample.com', 'examples.io', 'app.mycompany.example.co.uk'])('%s is a real name', (d) => expect(isReservedDomain(d)).toBe(false));
});

describe('placeholderProblems', () => {
  it('names the resource that still has the certificate placeholder, with the way out', () => {
    const out = placeholderProblems(tf(`resource "aws_lb_listener" "alb_listener" {
  certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/REPLACE-WITH-YOUR-CERTIFICATE-ID"
}`));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('aws_lb_listener.alb_listener');
    expect(out[0]).toMatch(/ACM certificate/);
    expect(out[0]).toMatch(/HTTP/);
  });

  it('says which kind of value a container image placeholder is', () => {
    const out = placeholderProblems(tf(`resource "aws_ecs_task_definition" "web" {\n  image = "REPLACE-WITH-YOUR-CONTAINER-IMAGE"\n}`));
    expect(out[0]).toMatch(/aws_ecs_task_definition\.web/);
    expect(out[0]).toMatch(/nginx:latest/);
  });

  it('reports each placeholder once per resource, even when it appears several times', () => {
    const out = placeholderProblems(tf(`resource "aws_ecs_task_definition" "web" {\n  a = "REPLACE-WITH-YOUR-CONTAINER-IMAGE"\n  b = "REPLACE-WITH-YOUR-CONTAINER-IMAGE"\n}`));
    expect(out).toHaveLength(1);
  });

  it('blocks a Route 53 zone for a domain AWS reserves, and allows a real one', () => {
    const bad = placeholderProblems(tf(`resource "aws_route53_zone" "dns" {\n  name = "microservices.example.com"\n}`));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/reserved/);
    expect(bad[0]).toContain('aws_route53_zone.dns');
    expect(placeholderProblems(tf(`resource "aws_route53_zone" "dns" {\n  name = "mycompany.com"\n}`))).toEqual([]);
  });

  it('does not touch other attributes that happen to say example.com, or non-Terraform files', () => {
    expect(placeholderProblems(tf(`resource "aws_cloudfront_distribution" "cf" {\n  name = "origin.example.com"\n}`))).toEqual([]);
    expect(placeholderProblems([{ filename: 'README.md', content: 'REPLACE-WITH-YOUR-CERTIFICATE-ID' }])).toEqual([]);
  });

  it('finds nothing in a design with real values', () => {
    expect(placeholderProblems(tf(`resource "aws_lb_listener" "l" {\n  certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate/abc-123"\n}`))).toEqual([]);
  });
});

describe('the generator stops the plan for the two mistakes a real deployment hit', () => {
  it('a verified design still carrying its placeholder certificate and example.com domain is blocked, naming both', async () => {
    const { loadChunks } = await import('@/lib/ai/knowledgeBase');
    const { sampleOf } = await import('@/lib/ai/verifiedBase');
    const { evaluateSpec } = await import('@/lib/ai/architectureSpec');
    const { terraformGenerator } = await import('@/lib/engines/terraform/TerraformGenerator');
    const ev = evaluateSpec(sampleOf(loadChunks().find((c) => c.id === 'pattern-aws-microservices')!));
    expect(ev.ok).toBe(true);
    const g = ev.graph!;
    const result = terraformGenerator.generate({
      architectureId: 'a', projectId: 'p', projectName: 'microservices',
      resources: g.nodes.map((n) => ({ id: n.id, resourceType: n.resourceType, provider: n.provider, label: n.label, positionX: 0, positionY: 0, configJson: JSON.stringify(n.config), region: null, groupId: n.groupId ?? null, locked: false, architectureId: 'a' })),
      connections: g.edges.map((e) => ({ id: e.id, label: e.label ?? null, edgeType: e.edgeType ?? null, sourceId: e.source, targetId: e.target, architectureId: 'a' })),
    } as never);
    const text = (result.blocking ?? []).join('\n');
    expect(text).toMatch(/REPLACE-WITH-YOUR-CERTIFICATE-ID/);
    expect(text).toMatch(/aws_route53_zone/);
    expect(text).toMatch(/reserved/);
  });
});
