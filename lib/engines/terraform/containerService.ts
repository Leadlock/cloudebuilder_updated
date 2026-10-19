/**
 * Terraform for the "Container service" canvas node: one EC2 instance that runs a Docker image from its own ECR repository.
 *
 * The instance, its role and its start-up script are the same ones the Container Templates "Deploy to EC2" bundle uses
 * (lib/engines/containers/ec2Deploy.ts), so a design drawn on the canvas and a bundle downloaded from the panel behave the same:
 * IMDSv2 only, encrypted disk, no SSH (Session Manager), ECR scan on push, secrets read from SSM Parameter Store at start.
 * The image is built and pushed by the workflow / deploy.sh from Container Templates; until it exists the service retries every 30 seconds.
 */
import { containerConfigFromNode, nodeProblems } from '../containers/nodeConfig';
import { userDataSh } from '../containers/ec2Deploy';

/** Text that goes inside a Terraform heredoc: nothing in it may start an interpolation or a directive. */
const heredoc = (s: string) => s.replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');
const q = (v: string) => JSON.stringify(v);

export function containerServiceBlocks(name: string, cfg: Record<string, unknown>, subnetRef: string | null, sgRef: string | null): string[] {
  const problems = nodeProblems(cfg);
  if (problems.length > 0) {
    return [`# CloudBuilder: the container service "${name}" was not generated. Fix: ${problems.join(' ').replace(/[\r\n]+/g, ' ')}`];
  }
  const c = containerConfigFromNode(cfg);
  const app = c.appName;
  const out: string[] = [];

  out.push(`data "aws_ssm_parameter" "${name}_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}`);

  const existing = c.image !== '';
  if (!existing) out.push(`resource "aws_ecr_repository" "${name}" {
  name                 = ${q(app)}
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Name      = ${q(app)}
    ManagedBy = "CloudCraft"
  }
}`);

  out.push(`data "aws_caller_identity" "${name}" {}

data "aws_iam_policy_document" "${name}_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "${name}" {
  name               = ${q(`${app}-ec2`)}
  assume_role_policy = data.aws_iam_policy_document.${name}_assume.json
  tags = {
    ManagedBy = "CloudCraft"
  }
}

resource "aws_iam_role_policy_attachment" "${name}_ssm" {
  role       = aws_iam_role.${name}.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "${name}_access" {
${existing ? '' : `  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "EcrPullThisRepository"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = [aws_ecr_repository.${name}.arn]
  }
`}  statement {
    sid       = "ReadThisAppsSecrets"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:aws:ssm:\${var.aws_region}:\${data.aws_caller_identity.${name}.account_id}:parameter/${app}/*"]
  }
}

resource "aws_iam_role_policy" "${name}" {
  name   = ${q(`${app}-${existing ? 'secrets' : 'ecr-and-secrets'}`)}
  role   = aws_iam_role.${name}.id
  policy = data.aws_iam_policy_document.${name}_access.json
}

resource "aws_iam_instance_profile" "${name}" {
  name = ${q(`${app}-ec2`)}
  role = aws_iam_role.${name}.name
}`);

  let sg = sgRef;
  if (!sg) {
    const vpc = subnetRef ? `\n  vpc_id      = ${subnetRef.replace(/\.id$/, '.vpc_id')}` : '';
    out.push(`resource "aws_security_group" "${name}" {
  name        = ${q(`${app}-ec2`)}
  description = ${q(`Access to ${app}`)}${vpc}

  ingress {
    description = "The app port"
    from_port   = ${c.port}
    to_port     = ${c.port}
    protocol    = "tcp"
    cidr_blocks = [${q(c.ec2.allowedCidr)}]
  }

  # Outbound is open so the instance can pull its image, read its secrets and reach Session Manager.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name      = ${q(`${app}-ec2`)}
    ManagedBy = "CloudCraft"
  }
}`);
    sg = `[aws_security_group.${name}.id]`;
  }

  const lines = [
    `resource "aws_instance" "${name}" {`,
    `  ami                    = data.aws_ssm_parameter.${name}_ami.value`,
    `  instance_type          = ${q(c.ec2.instanceType)}`,
  ];
  if (subnetRef) lines.push(`  subnet_id              = ${subnetRef}`);
  lines.push(`  vpc_security_group_ids = ${sg}`);
  lines.push(`  iam_instance_profile   = aws_iam_instance_profile.${name}.name`);
  lines.push(`  user_data              = <<-EOT\n${heredoc(userDataSh(c))}EOT`);
  lines.push(`  user_data_replace_on_change = true`);
  lines.push(`  metadata_options {`, `    http_endpoint = "enabled"`, `    http_tokens   = "required"`, `  }`);
  lines.push(`  root_block_device {`, `    volume_size = ${c.ec2.volumeGb}`, `    volume_type = "gp3"`, `    encrypted   = true`, `  }`);
  lines.push(`  tags = {`, `    Name      = ${q(app)}`, `    ManagedBy = "CloudCraft"`, `  }`, `}`);
  out.push(lines.join('\n'));

  if (c.ec2.elasticIp) {
    out.push(`resource "aws_eip" "${name}" {
  instance = aws_instance.${name}.id
  domain   = "vpc"
  tags = {
    Name      = ${q(app)}
    ManagedBy = "CloudCraft"
  }
}`);
  }
  return out;
}
