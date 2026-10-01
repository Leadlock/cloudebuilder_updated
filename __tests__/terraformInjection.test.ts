/**
 * Generated Terraform must never turn user-typed text into code. Every payload below is a real way to break out of an
 * HCL string; before hclSafety.ts existed each one injected a `provisioner "local-exec"` into the output.
 */
import { generateCanonicalTerraform } from '@/lib/engines/assessment/autofix';
import { terraformGenerator } from '@/lib/engines/terraform/TerraformGenerator';
import { generateTerraform as legacyGenerate } from '@/lib/analysis';
import { assertSafeHcl, escapeHclHeredoc, escapeHclString, TerraformSafetyError } from '@/lib/engines/terraform/hclSafety';
import { renderBackendConfig } from '@/lib/terraform/execution/backendConfig';
import { StateBackendSchema } from '@/lib/terraform/execution/backendSchema';

const node = (id: string, resourceType: string, config: Record<string, unknown>, label = id) =>
  ({ id, type: 'cloudNode', resourceType, provider: 'aws', label, position: { x: 0, y: 0 }, config }) as never;

const QUOTE_BREAK = 'x"\n  provisioner "local-exec" {\n    command = "echo PWNED"\n  }\n  tags = { a = "';
const SAME_LINE = 'x" } provisioner "local-exec" { command = "echo PWNED" } resource "aws_s3_bucket" "y" { bucket = "z';
const INTERPOLATION = '${file("/etc/passwd")}%{ for x in [1] }x%{ endfor }';

// A real block starting a line — the only way an injected provisioner could take effect.
const HEREDOC_BODY = /<<-?EOF\n[\s\S]*?\n[ \t]*EOF[ \t]*(?=\n|$)/g;
const dangerous = (tf: string) => /^\s*provisioner\s+"?[\w-]+"?\s*\{/im.test(tf.replace(HEREDOC_BODY, ''));

describe('user-controlled values cannot inject HCL', () => {
  const cases: [string, ReturnType<typeof node>][] = [
    ['bucket name', node('a', 'aws_s3', { bucketName: QUOTE_BREAK })],
    ['bucket name (single line)', node('a', 'aws_s3', { bucketName: SAME_LINE })],
    ['instance type', node('a', 'aws_ec2', { instanceType: QUOTE_BREAK })],
    ['security group description', node('a', 'aws_sg', { description: QUOTE_BREAK })],
    ['label', node('a', 'aws_s3', {}, QUOTE_BREAK)],
    ['resource id', node(QUOTE_BREAK, 'aws_s3', {})],
    ['tag key and value', node('a', 'aws_s3', { tags: { [QUOTE_BREAK]: QUOTE_BREAK } })],
    ['interpolation', node('a', 'aws_s3', { bucketName: INTERPOLATION })],
    ['resource type', node('a', 'aws_s3"\nprovisioner "local-exec" {}', {})],
  ];

  it.each(cases)('full generator: %s', (_name, n) => {
    const tf = generateCanonicalTerraform([n], []);
    expect(dangerous(tf)).toBe(false);
    expect(tf).not.toContain('PWNED_UNESCAPED');
  });

  it.each(cases)('legacy generator: %s', (_name, n) => {
    const tf = legacyGenerate([n], [], 'aws');
    expect(dangerous(tf)).toBe(false);
  });

  it('keeps the user\'s text, escaped, instead of dropping it', () => {
    const tf = generateCanonicalTerraform([node('a', 'aws_s3', {}, 'My "quoted" bucket')], []);
    expect(tf).toContain('My \\"quoted\\" bucket');
  });

  it('a heredoc user-data script cannot close its heredoc early, but keeps newlines', () => {
    const script = '#!/bin/bash\necho hi\nEOF\n  provisioner "local-exec" { command = "PWNED" }\necho ${HOME}\n';
    const tf = generateCanonicalTerraform([node('a', 'aws_ec2', { userData: script })], []);
    expect(dangerous(tf)).toBe(false);
    expect(tf).toContain('echo hi');
    expect(tf).toContain('$${HOME}');          // literal ${HOME} for the shell, not a Terraform interpolation
  });

  it('region and resource type on the row are validated', () => {
    const out = terraformGenerator.generate({
      architectureId: 'arch', projectId: 'proj',
      resources: [{ id: 'r1', resourceType: 'aws_s3', provider: 'aws', label: 'b', positionX: 0, positionY: 0, configJson: '{}', region: 'us-east-1"\nprovisioner "local-exec" {}', groupId: null, locked: false, architectureId: 'arch' }],
      connections: [],
    });
    expect(out.files.some((f) => dangerous(f.content))).toBe(false);
  });

  it('an ordinary label that merely mentions the word "provisioner" still generates', () => {
    expect(() => generateCanonicalTerraform([node('a', 'aws_s3', {}, 'Provisioner service bucket')], [])).not.toThrow();
  });

  it('two ids that collide after cleaning still resolve to two distinct resources', () => {
    const tf = generateCanonicalTerraform([node('a b', 'aws_s3', {}, 'one'), node('a_b', 'aws_s3', {}, 'two')], []);
    expect((tf.match(/resource "aws_s3_bucket"/g) ?? []).length).toBe(2);
  });
});

describe('assertSafeHcl', () => {
  it('refuses provisioners, external data sources, modules and non-HashiCorp sources — but ignores comments', () => {
    expect(() => assertSafeHcl([{ filename: 'main.tf', content: 'resource "x" "y" {\n  provisioner "local-exec" {\n  }\n}' }])).toThrow(TerraformSafetyError);
    expect(() => assertSafeHcl([{ filename: 'main.tf', content: 'data "external" "e" {\n}' }])).toThrow(TerraformSafetyError);
    expect(() => assertSafeHcl([{ filename: 'main.tf', content: 'module "m" {\n  source = "git::https://evil"\n}' }])).toThrow(TerraformSafetyError);
    expect(() => assertSafeHcl([{ filename: 'main.tf', content: 'required_providers {\n  aws = {\n    source = "evil/aws"\n  }\n}' }])).toThrow(TerraformSafetyError);
    expect(() => assertSafeHcl([{ filename: 'main.tf', content: '# provisioner "local-exec" {\nresource "x" "y" {}\n' }])).not.toThrow();
    expect(() => assertSafeHcl([{ filename: 'main.tf', content: 'required_providers {\n  aws = {\n    source = "hashicorp/aws"\n  }\n}' }])).not.toThrow();
  });
});

describe('escaping primitives', () => {
  it('escapeHclString neutralises quotes, backslashes, newlines and interpolation', () => {
    expect(escapeHclString('a"b\\c\nd${e}%{f}')).toBe('a\\"b\\\\c\\nd$${e}%%{f}');
  });
  it('escapeHclHeredoc keeps lines but disables interpolation and the terminator', () => {
    expect(escapeHclHeredoc('x\n  EOF\ny ${z}')).toBe('x\n  EOF_\ny $${z}');
  });
});

describe('state backend', () => {
  it('rejects names that could close a string or add HCL, and accepts real ones', () => {
    expect(StateBackendSchema.safeParse({ provider: 'aws', bucket: 'my-tf-state', key: 'envs/prod/terraform.tfstate', region: 'us-east-1', dynamodbTable: 'tf-locks' }).success).toBe(true);
    expect(StateBackendSchema.safeParse({ provider: 'aws', bucket: 'b"\n}', key: 'k', region: 'us-east-1' }).success).toBe(false);
    expect(StateBackendSchema.safeParse({ provider: 'aws', bucket: 'my-tf-state', key: 'k"\nprovisioner', region: 'us-east-1' }).success).toBe(false);
    expect(StateBackendSchema.safeParse({ provider: 'azure', resourceGroupName: 'rg-state', storageAccountName: 'tfstate123', containerName: 'tfstate', key: 'prod.tfstate' }).success).toBe(true);
    expect(StateBackendSchema.safeParse({ provider: 'azure', resourceGroupName: 'rg"', storageAccountName: 'x', containerName: 'c', key: 'k' }).success).toBe(false);
  });
  it('renderBackendConfig escapes whatever still reaches it', () => {
    const hcl = renderBackendConfig({ provider: 'aws', bucket: 'b"\nprovisioner "x" {}', key: 'k', region: 'us-east-1' });
    expect(hcl.split('\n').some((l) => /^\s*provisioner/.test(l))).toBe(false);
  });
});
