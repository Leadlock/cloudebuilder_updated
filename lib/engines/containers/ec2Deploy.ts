/**
 * "Deploy to EC2" for a container template: a small Terraform project that runs the generated image on one EC2 instance, plus an
 * optional GitHub Actions workflow that builds the image and pushes it to ECR.
 *
 * How it works
 *  - Terraform creates an ECR repository, one EC2 instance (Amazon Linux 2023) with an instance role, and a security group.
 *  - The instance's start-up script installs Docker and sets up a systemd service that logs in to ECR, pulls the image and runs it.
 *    If the image or a secret is not there yet the service just retries every 30 seconds, so the instance can be created before the
 *    first image is pushed.
 *  - user_data.sh is a static file (loaded with file()), not a Terraform template, so no form value is ever interpreted as HCL.
 *
 * Safety defaults
 *  - No SSH and no key pair: use SSM Session Manager (the role has AmazonSSMManagedInstanceCore).
 *  - Only the app port is open, to the CIDR in the form (0.0.0.0/0 is allowed but flagged with a warning).
 *  - IMDSv2 required, encrypted root volume, ECR scan on push, image pulls limited to this repository.
 *  - Secret values never enter Terraform, its state or user_data: the instance reads them from SSM Parameter Store
 *    (SecureString) at /<app>/<NAME> when the service starts. The role can read only that path.
 */
import type { ContainerConfig } from './dockerTemplates';

export interface Ec2Config {
  enabled: boolean;
  region: string;
  instanceType: string;
  /** Who can reach the app port. */
  allowedCidr: string;
  volumeGb: number;
  imageTag: string;
  elasticIp: boolean;
  /** Also generate the GitHub Actions workflow that builds and pushes the image. */
  githubActions: boolean;
}

export const defaultEc2 = (): Ec2Config => ({
  enabled: false, region: 'us-east-1', instanceType: 't3.small', allowedCidr: '0.0.0.0/0', volumeGb: 20, imageTag: 'latest', elasticIp: false, githubActions: true,
});

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const INSTANCE_TYPE = /^[a-z][a-z0-9]{0,6}\.[a-z0-9]{1,12}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function validCidr(v: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(v);
  return !!m && m.slice(1, 5).every((o) => Number(o) <= 255) && Number(m[5]) <= 32;
}

export function validateEc2(c: ContainerConfig): string[] {
  const e = c.ec2;
  if (!e.enabled) return [];
  const out: string[] = [];
  if (!REGION.test(e.region)) out.push('EC2: region looks like us-east-1.');
  if (!INSTANCE_TYPE.test(e.instanceType)) out.push('EC2: instance type looks like t3.small.');
  if (!validCidr(e.allowedCidr)) out.push('EC2: "who can connect" must be an IPv4 range such as 203.0.113.0/24 (or 0.0.0.0/0 for everyone).');
  if (!Number.isInteger(e.volumeGb) || e.volumeGb < 8 || e.volumeGb > 1000) out.push('EC2: disk size must be 8 to 1000 GB.');
  if (!TAG.test(e.imageTag)) out.push('EC2: image tag may use letters, digits, "_", "." and "-" (up to 128 characters).');
  return out;
}

export function ec2Warnings(c: ContainerConfig): string[] {
  const e = c.ec2;
  if (!e.enabled) return [];
  const w: string[] = [];
  if (e.allowedCidr === '0.0.0.0/0') w.push(`EC2: port ${c.port} will be open to the whole internet. Narrow "who can connect" if the app is not public.`);
  if (c.postgres || c.redis) w.push('EC2: PostgreSQL and Redis are not started on the instance. Use RDS / ElastiCache and put the connection settings in the environment variables.');
  if (e.imageTag === 'latest') w.push('EC2: the "latest" tag is used. It works, but a version tag (for example the commit id) makes it clear what is running.');
  if (c.env.some((v) => v.secret)) w.push(`EC2: create each secret in SSM Parameter Store as a SecureString named /${c.appName}/<NAME> before the service can start.`);
  return w;
}

const secretNames = (c: ContainerConfig) => c.env.filter((v) => v.secret).map((v) => v.key);

// ─── Terraform ───────────────────────────────────────────────────────────────

function mainTf(c: ContainerConfig): string {
  const eip = c.ec2.elasticIp;
  return `terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}

# Latest Amazon Linux 2023 (Docker, the AWS CLI and the SSM agent are available on it).
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

# Network: the account's default VPC unless vpc_id / subnet_id are given.
data "aws_vpc" "default" {
  count   = var.vpc_id == "" ? 1 : 0
  default = true
}

locals {
  vpc_id = var.vpc_id == "" ? data.aws_vpc.default[0].id : var.vpc_id
  tags = {
    Name      = var.app_name
    ManagedBy = "CloudCraft"
  }
}

data "aws_subnets" "in_vpc" {
  count = var.subnet_id == "" ? 1 : 0
  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

locals {
  subnet_id = var.subnet_id == "" ? sort(data.aws_subnets.in_vpc[0].ids)[0] : var.subnet_id
}

# ── Image registry ──────────────────────────────────────────────────────────

resource "aws_ecr_repository" "app" {
  name                 = var.app_name
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 10 most recent images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

# ── Instance role: Session Manager, pull this image, read this app's secrets ──

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "\${var.app_name}-ec2"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "app" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "EcrPullThisRepository"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = [aws_ecr_repository.app.arn]
  }
  statement {
    sid       = "ReadThisAppsSecrets"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:aws:ssm:\${var.region}:\${data.aws_caller_identity.current.account_id}:parameter/\${var.app_name}/*"]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "\${var.app_name}-ecr-and-secrets"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_instance_profile" "app" {
  name = "\${var.app_name}-ec2"
  role = aws_iam_role.app.name
}

# ── Network access: only the app port. No SSH: use Session Manager. ───────────

resource "aws_security_group" "app" {
  name        = "\${var.app_name}-ec2"
  description = "Access to \${var.app_name}"
  vpc_id      = local.vpc_id

  ingress {
    description = "Application port"
    from_port   = var.app_port
    to_port     = var.app_port
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  egress {
    description = "Outbound (image pulls, updates, AWS APIs)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

# ── The server ───────────────────────────────────────────────────────────────

resource "aws_instance" "app" {
  ami                         = data.aws_ssm_parameter.al2023.value
  instance_type               = var.instance_type
  subnet_id                   = local.subnet_id
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.app.name
  associate_public_ip_address = true

  user_data                   = file("\${path.module}/user_data.sh")
  user_data_replace_on_change = true

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2 only
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.volume_gb
    encrypted   = true
  }

  tags = local.tags
}
${eip ? `
resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"
  tags     = local.tags
}
` : ''}`;
}

function variablesTf(c: ContainerConfig): string {
  const e = c.ec2;
  return `variable "region" {
  description = "AWS Region to deploy to."
  type        = string
  default     = "${e.region}"
}

variable "app_name" {
  description = "Name used for the instance, repository, role and secret path."
  type        = string
  default     = "${c.appName}"
}

variable "app_port" {
  description = "Port the container listens on."
  type        = number
  default     = ${c.port}
}

variable "instance_type" {
  type    = string
  default = "${e.instanceType}"
}

variable "volume_gb" {
  type    = number
  default = ${e.volumeGb}
}

variable "allowed_cidr" {
  description = "Who can reach the app port (IPv4 range)."
  type        = string
  default     = "${e.allowedCidr}"
}

variable "vpc_id" {
  description = "Leave empty to use the default VPC."
  type        = string
  default     = ""
}

variable "subnet_id" {
  description = "Leave empty to use the first subnet of the VPC. It must give instances a public IP, or use a NAT, for image pulls."
  type        = string
  default     = ""
}
`;
}

function outputsTf(c: ContainerConfig): string {
  const ip = c.ec2.elasticIp ? 'aws_eip.app.public_ip' : 'aws_instance.app.public_ip';
  return `output "ecr_repository_url" {
  description = "Push the image here."
  value       = aws_ecr_repository.app.repository_url
}

output "instance_id" {
  value = aws_instance.app.id
}

output "public_ip" {
  value = ${ip}
}

output "app_url" {
  value = "http://\${${ip}}:\${var.app_port}${c.healthPath}"
}

output "connect" {
  description = "Open a shell on the server (no SSH needed)."
  value       = "aws ssm start-session --target \${aws_instance.app.id} --region \${var.region}"
}
`;
}

// ─── start-up script ─────────────────────────────────────────────────────────

function userDataSh(c: ContainerConfig): string {
  const app = c.appName;
  const plain = c.env.filter((v) => !v.secret);
  const secrets = secretNames(c);
  return `#!/bin/bash
# Runs once when the instance first starts. Installs Docker and a systemd service that pulls and runs ${app}.
set -euo pipefail

dnf install -y docker
systemctl enable --now docker

cat > /usr/local/bin/${app}-run <<'RUNNER'
#!/bin/bash
# Started by systemd. Safe to re-run: it fetches the current image and secrets every time, so a restart picks up a new push.
set -euo pipefail

TOKEN=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 120")
REGION=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text --region "$REGION")
IMAGE="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/${app}:${c.ec2.imageTag}"

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
docker pull "$IMAGE"

ENV_FILE=/run/${app}.env
umask 077
cat > "$ENV_FILE" <<'ENVFILE'
${plain.map((v) => `${v.key}=${v.value}`).join('\n')}
ENVFILE
${secrets.map((k) => `# A failed read stops the script (set -e), so the app never starts with an empty secret.
VALUE=$(aws ssm get-parameter --name /${app}/${k} --with-decryption --query Parameter.Value --output text --region "$REGION")
printf '%s=%s\\n' '${k}' "$VALUE" >> "$ENV_FILE"`).join('\n')}

docker rm -f ${app} >/dev/null 2>&1 || true
exec docker run --name ${app} --init --env-file "$ENV_FILE" -p ${c.port}:${c.port} --memory ${c.memoryLimit} --cpus ${c.cpuLimit} "$IMAGE"
RUNNER
chmod 755 /usr/local/bin/${app}-run

cat > /etc/systemd/system/${app}.service <<'UNIT'
[Unit]
Description=${app} container
After=docker.service network-online.target
Requires=docker.service

[Service]
ExecStart=/usr/local/bin/${app}-run
ExecStop=/usr/bin/docker stop ${app}
# If the image is not pushed yet, or a secret is missing, try again in 30 seconds.
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now ${app}.service
`;
}

// ─── GitHub Actions ──────────────────────────────────────────────────────────

function workflowYml(c: ContainerConfig): string {
  return `# Builds the image and pushes it to ECR, then restarts the service on the instance.
# One-time setup in the GitHub repository:
#   secret   AWS_ROLE_TO_ARN   an IAM role GitHub can assume (OIDC) with ECR push access (and ssm:SendCommand to restart the service)
#   variable EC2_INSTANCE_ID   the instance_id Terraform printed (optional: leave unset to skip the restart step)
name: deploy-${c.appName}

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

env:
  AWS_REGION: ${c.ec2.region}
  ECR_REPOSITORY: ${c.appName}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: \${{ secrets.AWS_ROLE_TO_ARN }}
          aws-region: \${{ env.AWS_REGION }}

      - id: ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push
        env:
          REGISTRY: \${{ steps.ecr.outputs.registry }}
        run: |
          docker build -t "$REGISTRY/$ECR_REPOSITORY:\${{ github.sha }}" -t "$REGISTRY/$ECR_REPOSITORY:${c.ec2.imageTag}" .
          docker push "$REGISTRY/$ECR_REPOSITORY" --all-tags

      - name: Restart the service on the instance
        if: \${{ vars.EC2_INSTANCE_ID != '' }}
        run: |
          aws ssm send-command \\
            --instance-ids "\${{ vars.EC2_INSTANCE_ID }}" \\
            --document-name AWS-RunShellScript \\
            --parameters 'commands=["systemctl restart ${c.appName}.service"]'
`;
}

// ─── README ──────────────────────────────────────────────────────────────────

function ec2Readme(c: ContainerConfig): string {
  const secrets = secretNames(c);
  return `# Deploy ${c.appName} to EC2

This folder is a Terraform project. It creates an ECR repository, one EC2 instance and the access it needs. The instance pulls the image
from ECR and runs it with systemd, restarting it if it stops.

## 1. Create the infrastructure

\`\`\`bash
cd ec2
terraform init
terraform apply
\`\`\`

Needs Terraform 1.5+ and AWS credentials that can create EC2, IAM, ECR and security group resources.
Terraform prints \`ecr_repository_url\`, \`instance_id\`, \`public_ip\` and \`app_url\`.
${secrets.length ? `
## 2. Create the secrets (before the service can start)

Each one is a SecureString in SSM Parameter Store, in the same Region. Values must be a single line.

\`\`\`bash
${secrets.map((k) => `aws ssm put-parameter --region ${c.ec2.region} --name /${c.appName}/${k} --type SecureString --value '...'`).join('\n')}
\`\`\`

Secrets never go into Terraform or its state.
` : ''}
## ${secrets.length ? '3' : '2'}. Push the image

${c.ec2.githubActions ? `Push to \`main\` and the workflow in \`.github/workflows/\` builds and pushes the image (see the comments at the top of that file for the one-time setup).

Or by hand:` : 'By hand:'}

\`\`\`bash
REPO=$(terraform -chdir=ec2 output -raw ecr_repository_url)
aws ecr get-login-password --region ${c.ec2.region} | docker login --username AWS --password-stdin "\${REPO%%/*}"
docker build -t "$REPO:${c.ec2.imageTag}" .
docker push "$REPO:${c.ec2.imageTag}"
\`\`\`

The instance retries every 30 seconds, so it starts the app by itself soon after the image is there. To pick up a new image at once:

\`\`\`bash
aws ssm send-command --region ${c.ec2.region} --instance-ids <instance_id> --document-name AWS-RunShellScript --parameters 'commands=["systemctl restart ${c.appName}.service"]'
\`\`\`

## Look inside the server

There is no SSH. Use Session Manager:

\`\`\`bash
aws ssm start-session --region ${c.ec2.region} --target <instance_id>
sudo journalctl -u ${c.appName}.service -f      # logs
sudo docker ps                                    # running container
\`\`\`

## What to know

- The app port (${c.port}) is open to \`${c.ec2.allowedCidr}\`. Change \`allowed_cidr\` to narrow it.
- This is a single server: no load balancer, no automatic replacement if it fails, HTTP only. For HTTPS or more than one server,
  put an Application Load Balancer in front or move to ECS.
- Costs: the instance, its disk and the public IPv4 address bill every hour, and ECR bills for storage. Run \`terraform destroy\` when done.
`;
}

export function generateEc2Files(c: ContainerConfig): Array<{ path: string; content: string }> {
  if (!c.ec2.enabled) return [];
  return [
    { path: 'ec2/main.tf', content: mainTf(c) },
    { path: 'ec2/variables.tf', content: variablesTf(c) },
    { path: 'ec2/outputs.tf', content: outputsTf(c) },
    { path: 'ec2/user_data.sh', content: userDataSh(c) },
    { path: 'ec2/README.md', content: ec2Readme(c) },
    ...(c.ec2.githubActions ? [{ path: '.github/workflows/deploy.yml', content: workflowYml(c) }] : []),
  ];
}
