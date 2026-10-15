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
import { REGION } from './shared';
import { hostPorts, hostSoftwareSh, hostSoftwareWarnings, validateHostSoftware } from './hostSoftware';
import { databaseOf, dbRunArgs, DB_SINGLE_MACHINE_NOTE } from './databases';
import { companionServices } from './companions';
import type { ContainerConfig } from './dockerTemplates';
import { usesExistingImage } from './existingImageUse';
import { ec2HourlyUsd } from '@/lib/engines/cost/awsPricing';

/** A Terraform interpolation, written so that no escaping is needed inside a template string. */
export const tfRef = (expr: string): string => '$' + '{' + expr + '}';

/** The value of the app_url output: an address and port for a database, a URL with the health path for an application. `host` is the Terraform reference of the public address. */
export const appUrlValue = (c: ContainerConfig, host: string): string =>
  databaseOf(c) ? `"${tfRef(host)}:${tfRef('var.app_port')}"` : `"http://${tfRef(host)}:${tfRef('var.app_port')}${c.healthPath}"`;

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
  /** "owner/name" of the GitHub repository. When set, Terraform also creates the AWS role the workflow signs in with. */
  githubRepo: string;
  /** Scan the built image with Trivy in the workflow and stop before pushing if it has a fixable HIGH or CRITICAL vulnerability. */
  scanImage: boolean;
  /** Software installed on the instance itself, by id (see lib/engines/servers/software.ts). */
  software: string[];
  /** One line for the home page of a web server installed this way. */
  pageText: string;
}

export const defaultEc2 = (): Ec2Config => ({
  enabled: false, region: 'us-east-1', instanceType: 't3.small', allowedCidr: '0.0.0.0/0', volumeGb: 20, imageTag: 'latest', elasticIp: false, githubActions: true, githubRepo: '', scanImage: true, software: [], pageText: '',
});

export { REGION };
const INSTANCE_TYPE = /^[a-z][a-z0-9]{0,6}\.[a-z0-9]{1,12}$/;
export const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
export const GITHUB_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export function validCidr(v: string): boolean {
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
  if (e.githubRepo !== '' && !GITHUB_REPO.test(e.githubRepo)) out.push('EC2: GitHub repository looks like owner/name.');
  out.push(...validateHostSoftware('EC2', e.software, c.port));
  return out;
}

export function ec2Warnings(c: ContainerConfig): string[] {
  const e = c.ec2;
  if (!e.enabled) return [];
  const w: string[] = [];
  if (e.allowedCidr === '0.0.0.0/0') w.push(`EC2: port ${c.port} will be open to the whole internet. Narrow "who can connect" if the app is not public.`);
  if (companionServices(c).length > 0) w.push('EC2: PostgreSQL and Redis are not started on the instance. Use RDS / ElastiCache and put the connection settings in the environment variables.');
  if (!usesExistingImage(c) && e.imageTag === 'latest') w.push('EC2: the "latest" tag is used. It works, but a version tag (for example the commit id) makes it clear what is running.');
  if (c.env.some((v) => v.secret)) w.push(`EC2: create each secret in SSM Parameter Store as a SecureString named /${c.appName}/<NAME> before the service can start.`);
  w.push(...hostSoftwareWarnings('EC2', e.software, e.allowedCidr));
  return w;
}

// ─── monthly cost ────────────────────────────────────────────────────────────

export interface Ec2CostLine { label: string; monthlyUsd: number }
/** What a deploy target costs a month at list price; shared by every target. */
export type DeployCost = Ec2Cost;
export interface Ec2Cost { monthlyUsd: number; lines: Ec2CostLine[]; notes: string[] }

const HOURS = 730;
const GP3_PER_GB = 0.08;
const PUBLIC_IPV4_PER_HOUR = 0.005;

/** List-price estimate (us-east-1, on demand, Linux) of what the EC2 deployment costs a month; undefined when it is switched off. */
export function estimateEc2Cost(c: ContainerConfig): Ec2Cost | undefined {
  const e = c.ec2;
  if (!e.enabled) return undefined;
  const hourly = ec2HourlyUsd(e.instanceType);
  const lines: Ec2CostLine[] = [
    { label: `Instance ${e.instanceType}`, monthlyUsd: round2((hourly ?? 0) * HOURS) },
    { label: `Disk ${e.volumeGb} GB (gp3)`, monthlyUsd: round2(e.volumeGb * GP3_PER_GB) },
    { label: 'Public IPv4 address', monthlyUsd: round2(PUBLIC_IPV4_PER_HOUR * HOURS) },
  ];
  const notes = ['Excludes data transfer out, ECR storage (about $0.10 per GB-month) and SSM Parameter Store (standard parameters are free).'];
  if (hourly === undefined) notes.push(`${e.instanceType} is not in the price table, so its price is left out of the total.`);
  if (e.region !== 'us-east-1') notes.push(`Priced for us-east-1; ${e.region} is usually a little higher.`);
  return { monthlyUsd: round2(lines.reduce((t, l) => t + l.monthlyUsd, 0)), lines, notes };
}
const round2 = (n: number) => Math.round(n * 100) / 100;

export const secretNames = (c: ContainerConfig) => c.env.filter((v) => v.secret).map((v) => v.key);

// ─── Terraform ───────────────────────────────────────────────────────────────

function mainTf(c: ContainerConfig): string {
  const eip = c.ec2.elasticIp;
  return `terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.81"
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

${usesExistingImage(c) ? '' : `# ── Image registry ──────────────────────────────────────────────────────────

resource "aws_ecr_repository" "app" {
  name                 = var.app_name
  image_tag_mutability = "MUTABLE"
  force_delete         = true # so destroy.sh can remove the repository together with its images

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

`}# ── Instance role: Session Manager, ${usesExistingImage(c) ? 'read' : 'pull this image, read'} this app's secrets ──

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
${usesExistingImage(c) ? '' : `  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "EcrPullThisRepository"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = [aws_ecr_repository.app.arn]
  }
`}  statement {
    sid       = "ReadThisAppsSecrets"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:aws:ssm:\${var.region}:\${data.aws_caller_identity.current.account_id}:parameter/\${var.app_name}/*"]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "\${var.app_name}-${usesExistingImage(c) ? 'secrets' : 'ecr-and-secrets'}"
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
${hostPorts(c.ec2.software).map((port) => `
  ingress {
    description = "Web server (port ${port})"
    from_port   = ${port}
    to_port     = ${port}
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }
`).join('')}
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
  user_data_replace_on_change = ${databaseOf(c) ? 'false' : 'true'}

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
${databaseOf(c) ? `
  # A database keeps its data on this machine: nothing may replace the machine (and with it the data). That includes a changed setting
  # (user_data) and AWS publishing a newer image than the one it started from (ami, which is looked up by name).
  lifecycle {
    ignore_changes = [user_data, ami]
  }
` : ''}}
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
  description = "Name used for the instance, ${usesExistingImage(c) ? '' : 'repository, '}role and secret path."
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
${c.ec2.githubRepo && !usesExistingImage(c) ? `
variable "github_repository" {
  description = "GitHub repository (owner/name) allowed to push images and restart the service."
  type        = string
  default     = "${c.ec2.githubRepo}"
}

variable "create_github_oidc_provider" {
  description = "An AWS account can have only one GitHub identity provider. Set to false if yours already exists."
  type        = bool
  default     = true
}
` : ''}`;
}

function outputsTf(c: ContainerConfig): string {
  const ip = c.ec2.elasticIp ? 'aws_eip.app.public_ip' : 'aws_instance.app.public_ip';
  return `${usesExistingImage(c) ? '' : `output "ecr_repository_url" {
  description = "Push the image here."
  value       = aws_ecr_repository.app.repository_url
}

`}output "instance_id" {
  value = aws_instance.app.id
}

output "public_ip" {
  value = ${ip}
}

output "app_url" {
  value = ${appUrlValue(c, ip)}
}

output "connect" {
  description = "Open a shell on the server (no SSH needed)."
  value       = "aws ssm start-session --target \${aws_instance.app.id} --region \${var.region}"
}
${c.ec2.githubRepo && !usesExistingImage(c) ? `
output "github_role_arn" {
  description = "Save this in GitHub as the secret AWS_ROLE_TO_ARN."
  value       = aws_iam_role.github.arn
}
` : ''}`;
}

// ─── start-up script ─────────────────────────────────────────────────────────

export function userDataSh(c: ContainerConfig): string {
  const app = c.appName;
  const plain = c.env.filter((v) => !v.secret);
  const secrets = secretNames(c);
  const run = dbRunArgs(c, app);
  return `#!/bin/bash
# Runs once when the instance first starts. Installs Docker and a systemd service that pulls and runs ${app}.
set -euo pipefail

dnf install -y docker
systemctl enable --now docker
${hostSoftwareSh(c.ec2.software, { family: 'dnf', loginUser: 'ec2-user', pageText: c.ec2.pageText })}
cat > /usr/local/bin/${app}-run <<'RUNNER'
#!/bin/bash
# Started by systemd. Safe to re-run: it fetches the current image and secrets every time, so a restart picks up a new push.
set -euo pipefail

TOKEN=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 120")
REGION=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
${usesExistingImage(c) ? `IMAGE=${q(c.image)}
` : `ACCOUNT=$(aws sts get-caller-identity --query Account --output text --region "$REGION")
IMAGE="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/${app}:${c.ec2.imageTag}"

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
`}docker pull "$IMAGE"

ENV_FILE=/run/${app}.env
umask 077
cat > "$ENV_FILE" <<'ENVFILE'
${plain.map((v) => `${v.key}=${v.value}`).join('\n')}
ENVFILE
${secrets.map((k) => `# A failed read stops the script (set -e), so the app never starts with an empty secret.
VALUE=$(aws ssm get-parameter --name /${app}/${k} --with-decryption --query Parameter.Value --output text --region "$REGION")
printf '%s=%s\\n' '${k}' "$VALUE" >> "$ENV_FILE"`).join('\n')}

docker rm -f ${app} >/dev/null 2>&1 || true
exec docker run --name ${app} --init --env-file "$ENV_FILE" -p ${c.port}:${c.port}${run.volume} --memory ${c.memoryLimit} --cpus ${c.cpuLimit} "$IMAGE"${run.command}
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
# If the image ${usesExistingImage(c) ? 'cannot be pulled yet' : 'is not pushed yet'}, or a secret is missing, try again in 30 seconds.
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
# One-time setup in the GitHub repository (Settings, Secrets and variables, Actions):
${c.ec2.githubRepo
    ? `#   secret   AWS_ROLE_TO_ARN   run: terraform -chdir=ec2 output -raw github_role_arn
#   variable EC2_INSTANCE_ID   run: terraform -chdir=ec2 output -raw instance_id   (optional: leave unset to skip the restart step)`
    : `#   secret   AWS_ROLE_TO_ARN   an IAM role GitHub can assume (OIDC) with ECR push access (and ssm:SendCommand to restart the service).
#                              Tip: set "GitHub repository" in Container Templates and Terraform creates this role for you.
#   variable EC2_INSTANCE_ID   the instance_id Terraform printed (optional: leave unset to skip the restart step)`}
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

      - name: Build
        env:
          REGISTRY: \${{ steps.ecr.outputs.registry }}
        run: |
          docker build -t "$REGISTRY/$ECR_REPOSITORY:\${{ github.sha }}" -t "$REGISTRY/$ECR_REPOSITORY:${c.ec2.imageTag}" .
${c.ec2.scanImage ? `
      # Stops the deploy before anything is pushed if the image has a HIGH or CRITICAL vulnerability that already has a fix.
      - name: Scan the image (Trivy)
        uses: aquasecurity/trivy-action@915b19bbe73b92a6cf82a1bc12b087c9a19a5fe2 # v0.28.0
        with:
          image-ref: \${{ steps.ecr.outputs.registry }}/\${{ env.ECR_REPOSITORY }}:\${{ github.sha }}
          severity: HIGH,CRITICAL
          ignore-unfixed: true
          exit-code: '1'
          vuln-type: os,library
` : ''}
      - name: Push
        env:
          REGISTRY: \${{ steps.ecr.outputs.registry }}
        run: docker push "$REGISTRY/$ECR_REPOSITORY" --all-tags

      - name: Restart the service on the instance
        if: \${{ vars.EC2_INSTANCE_ID != '' }}
        run: |
          aws ssm send-command \\
            --instance-ids "\${{ vars.EC2_INSTANCE_ID }}" \\
            --document-name AWS-RunShellScript \\
            --parameters 'commands=["systemctl restart ${c.appName}.service"]'
`;
}

// ─── GitHub sign-in role (optional) ──────────────────────────────────────────

function githubOidcTf(): string {
  return `# The AWS side of "GitHub can deploy": an identity provider for GitHub and one role that only this repository's main branch can assume.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_github_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  github_oidc_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:\${var.github_repository}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github" {
  name               = "\${var.app_name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "github" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPushThisRepository"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.app.arn]
  }
  statement {
    sid       = "RestartTheService"
    actions   = ["ssm:SendCommand"]
    resources = [
      aws_instance.app.arn,
      "arn:aws:ssm:\${var.region}::document/AWS-RunShellScript",
    ]
  }
}

resource "aws_iam_role_policy" "github" {
  name   = "\${var.app_name}-github-deploy"
  role   = aws_iam_role.github.id
  policy = data.aws_iam_policy_document.github.json
}
`;
}

// ─── one-command scripts ─────────────────────────────────────────────────────

export const q = (v: string) => `'${v}'`; // every value here is validated to contain no quote

function deploySh(c: ContainerConfig): string {
  const secrets = secretNames(c);
  const ex = usesExistingImage(c);
  const total = ex ? 3 : 4;
  return `#!/usr/bin/env bash
# One command to deploy ${c.appName} to EC2: bash deploy.sh
#   1. creates the server${ex ? '' : ' and image repository'} with Terraform (first run), asking you to confirm
#   2. stores any secret values in AWS (asks once, hidden), never in a file
${ex ? `#   3. starts the app (the server pulls ${c.image}) and waits until it answers` : `#   3. builds the image for the server's CPU type and pushes it
#   4. restarts the app and waits until it answers`}
# Run it again to release a new version. Add --yes to skip the Terraform confirmation.
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(c.appName)}
REGION=${q(c.ec2.region)}
${ex ? '' : `TAG=${q(c.ec2.imageTag)}\n`}SECRETS=(${secrets.map(q).join(' ')})
APPROVE=""
[ "\${1:-}" = "--yes" ] && APPROVE="-auto-approve"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing tool: $1. $2"; exit 1; }; }
need terraform "Install it from https://developer.hashicorp.com/terraform/install"
need aws       "Install the AWS CLI from https://aws.amazon.com/cli/"
${ex ? '' : `need docker    "Install Docker Desktop from https://www.docker.com/products/docker-desktop"
`}aws sts get-caller-identity >/dev/null 2>&1 || { echo "You are not signed in to AWS. Run: aws configure (or aws sso login)"; exit 1; }
${ex ? '' : `docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and try again."; exit 1; }
`}
echo "==> 1/${total}  Server${ex ? '' : ' and image repository'} (Terraform)"
terraform -chdir=ec2 init -input=false >/dev/null
terraform -chdir=ec2 apply \${APPROVE:+-auto-approve}

echo "==> 2/${total}  Secrets"
for NAME in \${SECRETS[@]+"\${SECRETS[@]}"}; do
  if aws ssm get-parameter --region "$REGION" --name "/$APP/$NAME" >/dev/null 2>&1; then
    echo "    $NAME: already stored"
  else
    read -r -s -p "    Value for $NAME (hidden): " VALUE; echo
    [ -n "$VALUE" ] || { echo "    $NAME cannot be empty."; exit 1; }
    TMP=$(mktemp); chmod 600 "$TMP"
    printf '%s' "$VALUE" > "$TMP"
    aws ssm put-parameter --region "$REGION" --name "/$APP/$NAME" --type SecureString --value "file://$TMP" >/dev/null
    rm -f "$TMP"; unset VALUE
    echo "    $NAME: stored"
  fi
done

${ex ? '' : `echo "==> 3/4  Build and push the image"
REPO=$(terraform -chdir=ec2 output -raw ecr_repository_url)
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "\${REPO%%/*}"
# The server is x86_64. Building for it explicitly makes this work from Apple Silicon Macs too.
docker build --platform linux/amd64 -t "$REPO:$TAG" .
docker push "$REPO:$TAG"

`}echo "==> ${total}/${total}  Start the app"
INSTANCE_ID=$(terraform -chdir=ec2 output -raw instance_id)
if aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \\
     --parameters "commands=[\\"systemctl restart $APP.service\\"]" >/dev/null 2>&1; then
  echo "    Restart sent."
else
  echo "    The server is not reachable by Session Manager yet (normal on a new server). It starts the app by itself within a minute or two."
fi

${databaseOf(c) ? `ADDRESS=$(terraform -chdir=ec2 output -raw app_url)
echo "Done. ${databaseOf(c)!.label} is starting at $ADDRESS (allowed from ${c.ec2.allowedCidr} only)."
echo "The first start takes a minute or two. It is not reachable from the internet, so connect from inside that range."
echo "Logs: aws ssm start-session --region $REGION --target $INSTANCE_ID   then   sudo journalctl -u $APP.service -f"
` : `URL=$(terraform -chdir=ec2 output -raw app_url)
WAIT="\${DEPLOY_WAIT_SECONDS:-300}"
END=$((SECONDS + WAIT))
echo "    Waiting for $URL ..."
UP=""
while [ "$SECONDS" -lt "$END" ]; do
  if curl -fsS -m 5 -o /dev/null "$URL" >/dev/null 2>&1; then UP=yes; break; fi
  sleep 10
done
if [ -n "$UP" ]; then
  echo "Done. ${c.appName} is running at $URL"
else
  echo "Not answering yet. The first start can take a few minutes. Check $URL again, or read the logs:"
  echo "  aws ssm start-session --region $REGION --target $INSTANCE_ID   then   sudo journalctl -u $APP.service -f"
fi
`}`;
}

function destroySh(c: ContainerConfig): string {
  const secrets = secretNames(c);
  return `#!/usr/bin/env bash
# Removes everything deploy.sh created (server, ${usesExistingImage(c) ? '' : 'image repository with its images, '}roles): bash destroy.sh
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(c.appName)}
REGION=${q(c.ec2.region)}
SECRETS=(${secrets.map(q).join(' ')})

command -v terraform >/dev/null 2>&1 || { echo "Missing tool: terraform"; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "Missing tool: aws"; exit 1; }

echo "This permanently deletes the server${usesExistingImage(c) ? "" : " and the image repository"} of $APP."
read -r -p "Type the app name ($APP) to continue: " ANSWER
[ "$ANSWER" = "$APP" ] || { echo "Cancelled."; exit 1; }

terraform -chdir=ec2 init -input=false >/dev/null
terraform -chdir=ec2 destroy -auto-approve

for NAME in \${SECRETS[@]+"\${SECRETS[@]}"}; do
  read -r -p "Also delete the stored secret $NAME? [y/N] " DEL
  if [ "$DEL" = "y" ] || [ "$DEL" = "Y" ]; then
    aws ssm delete-parameter --region "$REGION" --name "/$APP/$NAME" >/dev/null 2>&1 && echo "    $NAME deleted" || echo "    $NAME not found"
  fi
done
echo "Done."
`;
}

// ─── README ──────────────────────────────────────────────────────────────────

function ec2Readme(c: ContainerConfig): string {
  const secrets = secretNames(c);
  const gh = c.ec2.githubRepo;
  return `# Deploy ${c.appName} to EC2

## Quick start

You need Terraform, the AWS CLI and Docker installed, and to be signed in to AWS (\`aws configure\` or \`aws sso login\`). Then, from
the folder that contains your app and these files:

\`\`\`bash
bash deploy.sh
\`\`\`

That is all. It creates the server, ${secrets.length ? 'asks for your secret values (hidden), ' : ''}${usesExistingImage(c) ? `starts ${c.image} (nothing is built)` : 'builds and pushes your image, starts the app'} and prints
its address. Terraform shows what it will create and asks you to type \`yes\` first (add \`--yes\` to skip that).

To release a new version, run \`bash deploy.sh\` again. To remove everything and stop paying for it:

\`\`\`bash
bash destroy.sh
\`\`\`

## What gets created

- ${usesExistingImage(c) ? `One EC2 server (Amazon Linux 2023) that pulls \`${c.image}\` and runs it under systemd.` : 'An ECR repository (where your image is stored) and one EC2 server (Amazon Linux 2023) running your image under systemd.'}
- A role for the server that can only ${usesExistingImage(c) ? 'read' : 'pull this image and read'} this app's secrets, and a security group that opens only port ${c.port}
  to \`${c.ec2.allowedCidr}\`. There is no SSH.
${secrets.length ? `- Secrets (${secrets.join(', ')}) are stored in AWS SSM Parameter Store as \`/${c.appName}/<NAME>\` and read by the server when it starts.
  They are never written to Terraform, to its state or to any file.
` : ''}
## Look inside the server

\`\`\`bash
aws ssm start-session --region ${c.ec2.region} --target <instance_id>
sudo journalctl -u ${c.appName}.service -f      # logs
sudo docker ps                                    # the running container
\`\`\`

(\`terraform -chdir=ec2 output\` shows the instance id.)

## Common problems

- **"Not signed in to AWS"**: run \`aws configure\`, or \`aws sso login\` if your company uses SSO.
- **The address does not answer for a few minutes**: a new server installs Docker first. The app starts by itself once the image and secrets exist.
- **The address never answers**: the port is open only to \`${c.ec2.allowedCidr}\`. If that is not your network, change \`allowed_cidr\` in \`ec2/variables.tf\` and run \`bash deploy.sh\` again.
- **"exec format error" in the logs**: the image was built for the wrong CPU type. \`deploy.sh\` builds for the server's type; if you push another way, add \`--platform linux/amd64\`.
${c.ec2.githubActions && !usesExistingImage(c) ? `
## Optional: deploy automatically when you push to GitHub

\`.github/workflows/deploy.yml\` builds and pushes the image on every push to \`main\` and restarts the app.
${gh ? `
The AWS role it signs in with is already created by Terraform. Two things to do in GitHub (Settings, then Secrets and variables, then Actions):

1. Add a **secret** named \`AWS_ROLE_TO_ARN\`. Its value: \`terraform -chdir=ec2 output -raw github_role_arn\`
2. Add a **variable** named \`EC2_INSTANCE_ID\`. Its value: \`terraform -chdir=ec2 output -raw instance_id\` (this makes it restart the app after each push; optional)

If your AWS account already has a GitHub identity provider, set \`create_github_oidc_provider\` to \`false\` in \`ec2/variables.tf\` before \`bash deploy.sh\`.
` : `
It needs an AWS role that GitHub can sign in with. The easy way: enter your repository as owner/name in Container Templates ("GitHub repository")
and generate again. Terraform then creates the role and prints its ARN. Without it, create the role yourself (OIDC) and save its ARN as the secret \`AWS_ROLE_TO_ARN\`.
`}` : ''}
## What to know

${databaseOf(c) ? DB_SINGLE_MACHINE_NOTE : `- This is a single server: HTTP only, no load balancer, and no automatic replacement if it fails. For HTTPS or several servers,
  put an Application Load Balancer in front or move to ECS.`}
- Terraform keeps its record of what it built in \`ec2/terraform.tfstate\`. Keep that folder; \`bash destroy.sh\` needs it.
- Costs: the server, its disk and the public IPv4 address bill every hour, ${usesExistingImage(c) ? '' : 'and ECR bills for storage.'}
`;
}

export function generateEc2Files(c: ContainerConfig): Array<{ path: string; content: string; executable?: boolean }> {
  if (!c.ec2.enabled) return [];
  return [
    { path: 'deploy.sh', content: deploySh(c), executable: true },
    { path: 'destroy.sh', content: destroySh(c), executable: true },
    { path: 'ec2/main.tf', content: mainTf(c) },
    { path: 'ec2/variables.tf', content: variablesTf(c) },
    { path: 'ec2/outputs.tf', content: outputsTf(c) },
    ...(c.ec2.githubRepo && !usesExistingImage(c) ? [{ path: 'ec2/github_oidc.tf', content: githubOidcTf() }] : []),
    { path: 'ec2/user_data.sh', content: userDataSh(c) },
    { path: 'ec2/.gitignore', content: '.terraform/\n*.tfstate\n*.tfstate.*\ncrash.log\n' },
    { path: 'ec2/README.md', content: ec2Readme(c) },
    ...(c.ec2.githubActions && !usesExistingImage(c) ? [{ path: '.github/workflows/deploy.yml', content: workflowYml(c) }] : []),
  ];
}
