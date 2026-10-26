/**
 * A public CloudFront distribution gets a managed AWS WAF web ACL in the generated Terraform (Security Hub CloudFront.6): created in us-east-1 with its
 * own provider, switchable, and never added on top of a web ACL the design or the person already supplied.
 */
import { TerraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import type { DbArchitectureConnection, DbArchitectureResource } from '@/lib/repositories/architectureRepository';

const res = (id: string, resourceType: string, config: Record<string, unknown> = {}): DbArchitectureResource => ({
  id, resourceType, provider: 'aws', label: id, positionX: 0, positionY: 0, configJson: JSON.stringify({ name: id, ...config }), region: null, groupId: null, locked: false, architectureId: 'a',
} as DbArchitectureResource);
const conn = (sourceId: string, targetId: string): DbArchitectureConnection => ({ id: `${sourceId}-${targetId}`, label: null, edgeType: null, sourceId, targetId, architectureId: 'a' });
const gen = (resources: DbArchitectureResource[], connections: DbArchitectureConnection[] = []) => {
  const r = new TerraformGenerator().generate({ architectureId: 'a', projectId: 'p', resources, connections });
  return { main: r.files.find((f) => f.filename === 'main.tf')?.content ?? '', providers: r.files.find((f) => f.filename === 'providers.tf')?.content ?? '', warnings: r.warnings };
};

describe('the managed web ACL', () => {
  it('is added by default, in us-east-1, with the two managed rule groups, and associated with the distribution', () => {
    const { main, providers } = gen([res('cdn', 'aws_cloudfront')]);
    expect(main).toContain('resource "aws_wafv2_web_acl" "cdn_waf"');
    expect(main).toMatch(/aws_wafv2_web_acl" "cdn_waf" \{\n\s+provider = aws\.us_east_1/);
    expect(main).toContain('scope    = "CLOUDFRONT"');
    expect(main).toContain('AWSManagedRulesCommonRuleSet');
    expect(main).toContain('AWSManagedRulesKnownBadInputsRuleSet');
    expect(main).toContain('web_acl_id          = aws_wafv2_web_acl.cdn_waf.arn');
    expect(providers).toMatch(/provider "aws" \{\n\s+alias\s+= "us_east_1"\n\s+region = "us-east-1"/);
    // the distribution itself is created with the default provider
    expect(main.slice(main.indexOf('resource "aws_cloudfront_distribution"'), main.indexOf('resource "aws_wafv2_web_acl"'))).not.toContain('provider =');
  });

  it('is not added when switched off: no web ACL, no extra provider', () => {
    const { main, providers } = gen([res('cdn', 'aws_cloudfront', { managedWaf: false })]);
    expect(main).not.toContain('aws_wafv2_web_acl');
    expect(main).not.toContain('web_acl_id');
    expect(providers).not.toContain('us_east_1');
  });

  it('is not added on top of a web ACL id the person gave, which is used as it is', () => {
    const arn = 'arn:aws:wafv2:us-east-1:111122223333:global/webacl/mine/abc';
    const { main, providers } = gen([res('cdn', 'aws_cloudfront', { webAclId: arn })]);
    expect(main).toContain(`web_acl_id          = "${arn}"`);
    expect(main).not.toContain('aws_wafv2_web_acl');
    expect(providers).not.toContain('us_east_1');
  });

  it('is not added to a distribution imported from a live account', () => {
    expect(gen([res('cdn', 'aws_cloudfront', { importState: 'imported' })]).main).not.toContain('aws_wafv2_web_acl');
  });
});

describe('a WAF drawn next to the distribution', () => {
  it('is associated with it (it used to be generated but never attached) and replaces the managed one', () => {
    const { main, providers } = gen([res('cdn', 'aws_cloudfront'), res('edge_waf', 'aws_waf', { scope: 'CLOUDFRONT', managedRuleGroups: ['AWSManagedRulesCommonRuleSet'] })], [conn('edge_waf', 'cdn')]);
    expect(main).toContain('web_acl_id          = aws_wafv2_web_acl.edge_waf.arn');
    expect(main).toMatch(/aws_wafv2_web_acl" "edge_waf" \{\n\s+provider = aws\.us_east_1/);
    expect(main).not.toContain('cdn_waf');
    expect(providers).toContain('alias  = "us_east_1"');
  });

  it('works whichever way the line is drawn', () => {
    expect(gen([res('cdn', 'aws_cloudfront'), res('w', 'aws_waf', { scope: 'CLOUDFRONT' })], [conn('cdn', 'w')]).main).toContain('web_acl_id          = aws_wafv2_web_acl.w.arn');
  });

  it('is not attached when it is a regional one (AWS cannot): the person is told, and the managed ACL is used', () => {
    const { main, warnings } = gen([res('cdn', 'aws_cloudfront'), res('w', 'aws_waf', { scope: 'REGIONAL' })], [conn('w', 'cdn')]);
    expect(warnings.some((x) => /scope is not CLOUDFRONT/.test(x))).toBe(true);
    expect(main).toContain('web_acl_id          = aws_wafv2_web_acl.cdn_waf.arn');
    expect(main).not.toMatch(/aws_wafv2_web_acl" "w" \{\n\s+provider/);
  });

  it('a CLOUDFRONT-scope WAF with no distribution still gets the us-east-1 provider it needs', () => {
    const { main, providers } = gen([res('w', 'aws_waf', { scope: 'CLOUDFRONT' })]);
    expect(main).toMatch(/aws_wafv2_web_acl" "w" \{\n\s+provider = aws\.us_east_1/);
    expect(providers).toContain('alias  = "us_east_1"');
  });
});
