/** The package for the AWS Well-Architected Agent: the Terraform and a README, nothing else, the same every time. */
import { readZip } from '@/lib/deploy/project/zip';
import { AgentPackageError, agentPackageReadme, buildAgentPackage } from '@/lib/wellArchitectedTool/agentPackage';

const input = {
  projectName: 'Shop', generatedAt: '2026-10-26T10:00:00.000Z', warnings: ['Unsupported AWS resource type: aws_foo (resource: x)'],
  files: [{ filename: 'variables.tf', content: 'variable "db_password" {\n  type = string\n  sensitive = true\n}\n' }, { filename: 'main.tf', content: 'resource "aws_vpc" "main" {}\n' }, { filename: 'empty.tf', content: '  \n' }],
};
const names = (b: Buffer) => readZip(b).files.map((f) => f.path);

describe('the package', () => {
  it('holds the README and the Terraform files (not the empty ones), in a fixed order', () => {
    expect(names(buildAgentPackage(input))).toEqual(['README.md', 'terraform/main.tf', 'terraform/variables.tf']);
  });
  it('is byte-for-byte the same for the same project', () => {
    expect(buildAgentPackage(input).equals(buildAgentPackage({ ...input, files: [...input.files].reverse() }))).toBe(true);
  });
  it('says how to use it, what is missing from it, and the generator\'s notes', () => {
    const md = agentPackageReadme({ ...input, files: input.files.slice(0, 2), blocking: ['placeholder left in aws_instance.web'] });
    expect(md).toContain('terraform/main.tf');
    expect(md).toContain('No Terraform state, no credentials');
    expect(md).toContain('third-party service');
    expect(md).toContain('Unsupported AWS resource type');
    expect(md).toContain('## Fix before applying');
    expect(md).toContain('placeholder left in aws_instance.web');
    expect(md).toContain('check the current AWS documentation');
  });
  it('refuses a package with no Terraform, and a file name that could leave the folder', () => {
    expect(() => buildAgentPackage({ ...input, files: [] })).toThrow(AgentPackageError);
    expect(() => buildAgentPackage({ ...input, files: [{ filename: '../evil.tf', content: 'x' }] })).toThrow(/not allowed/);
    expect(() => buildAgentPackage({ ...input, files: [{ filename: 'a b.tf', content: 'x' }] })).toThrow(/not allowed/);
    expect(() => buildAgentPackage({ ...input, files: [{ filename: 'terraform.tfstate', content: 'x' }] })).toThrow(/not allowed/);
  });
});
