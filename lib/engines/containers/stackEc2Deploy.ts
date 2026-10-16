/**
 * "Deploy to EC2" for a whole project (Frontend + Backend + API + Database): one EC2 server that runs the project's Docker Compose file.
 *
 * How it differs from a single service (ec2Deploy.ts), which it shares its safety rules with:
 *  - Terraform creates one ECR repository per service that is built from source, a private S3 bucket that holds the compose file, one instance
 *    and one security group that opens only the public service's port.
 *  - The instance installs Docker and the Compose plugin (the download is checked against a pinned checksum), then runs a systemd service that
 *    fetches the compose file and the image tag from S3, logs in to ECR, reads the secrets from SSM Parameter Store, pulls the images and
 *    runs `docker compose up`. A new release is therefore: push the images, let Terraform replace the compose file, restart the service.
 *    The instance is never replaced for that, so the database volume on its disk survives.
 *  - Secret values never enter Terraform, its state, S3 or user_data: they are read from SSM at /<project>/<NAME> when the service starts.
 *  - No SSH and no key pair (Session Manager), IMDSv2 only, encrypted disk, scan on push, the bucket blocks all public access.
 */
import { defaultConfig, type ContainerConfig } from './dockerTemplates';
import { defaultEc2, estimateEc2Cost, validateEc2, validCidr, q, tfRef, type Ec2Config, type DeployCost } from './ec2Deploy';
import { DB_SINGLE_MACHINE_NOTE } from './databases';

/** The Docker Compose release the server installs, and the checksum of its Linux x86_64 binary (from the checksum file published with the release). */
export const COMPOSE_VERSION = 'v5.6.0';
export const COMPOSE_SHA256 = '40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a';

/** What every deployment target needs to know about the project. Built by stackProject.ts, which owns the compose file. */
export interface StackDeployBase {
  name: string;
  /** The services that are built from source and so need an image repository (a service that uses a ready-made image does not). */
  built: string[];
  /** The one service that is open to the network. */
  entry: { service: string; port: number; path: string };
  /** Every secret of every service, once each. */
  secrets: string[];
  /** The secrets of the database: when left empty, a random value is generated for them. */
  generated: string[];
  databaseLabel: string | null;
  /** The compose file the server runs: images from the registry, `${REGISTRY}` and `${TAG}` filled in on the server. */
  compose: string;
}

export interface StackDeploySpec extends StackDeployBase { ec2: Ec2Config }

/** The commands that install the Docker Compose plugin, as a pinned release that is refused unless it matches its published checksum (the same on every server). */
export function composePluginSh(): string {
  return `# Neither Amazon Linux nor Ubuntu has a current Compose plugin in its packages: install a pinned release and refuse any file that does not match its published checksum.
PLUGIN_DIR=/usr/local/lib/docker/cli-plugins
mkdir -p "$PLUGIN_DIR"
for ATTEMPT in 1 2 3 4 5; do
  curl -fsSL -o "$PLUGIN_DIR/docker-compose" "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" && break
  [ "$ATTEMPT" = 5 ] && { echo "Could not download Docker Compose" >&2; exit 1; }
  sleep 10
done
echo "${COMPOSE_SHA256}  $PLUGIN_DIR/docker-compose" | sha256sum -c -
chmod 755 "$PLUGIN_DIR/docker-compose"
`;
}

export const stackEc2Defaults = (): Ec2Config => ({ ...defaultEc2(), enabled: true, instanceType: 't3.medium', volumeGb: 30, githubActions: false });

/** The settings checked as a single service's are (region, instance type, CIDR, disk, tag), against the one port that is open. */
function asSingle(s: StackDeploySpec): ContainerConfig {
  return { ...defaultConfig('node'), appName: s.name, port: s.entry.port, ec2: { ...s.ec2, enabled: true, githubRepo: '', software: [] } };
}

export function validateStackEc2(s: StackDeploySpec): string[] {
  return validateEc2(asSingle(s));
}

export function stackEc2Warnings(s: StackDeploySpec): string[] {
  const w: string[] = [];
  if (s.ec2.allowedCidr === '0.0.0.0/0') w.push(`EC2: ${s.entry.service} (port ${s.entry.port}) will be open to the whole internet. Narrow "who can connect" if it is not public.`);
  if (s.ec2.imageTag === 'latest') w.push('EC2: the "latest" tag is used. It works, but a version tag (for example the commit id) makes it clear what is running.');
  if (s.secrets.length > 0) w.push(`EC2: deploy.sh asks for ${s.secrets.join(', ')} and stores each in SSM Parameter Store as /${s.name}/<NAME>.`);
  if (s.databaseLabel) w.push(`EC2: ${s.databaseLabel} runs on the same server as the application, with its data on the server's disk. ${DB_SINGLE_MACHINE_NOTE}`);
  w.push('EC2: the server serves HTTP only, with no load balancer, and is not replaced automatically if it fails.');
  return w;
}

export function estimateStackEc2Cost(s: StackDeploySpec): DeployCost {
  const c = estimateEc2Cost(asSingle(s))!;
  return { ...c, notes: [...c.notes, `Excludes the S3 bucket for the compose file (a few kilobytes) and one ECR repository per service (${s.built.length}).`] };
}

// ─── Terraform ───────────────────────────────────────────────────────────────

function mainTf(s: StackDeploySpec): string {
  const eip = s.ec2.elasticIp;
  const repos = s.built.length > 0;
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
  # The services that are built from source, one image repository each.
  built = [${s.built.map((l) => `"${l}"`).join(', ')}]
  # The release bucket: the name the server works out for itself (user_data.sh) has to match.
  release_bucket = "\${substr(var.app_name, 0, 30)}-\${data.aws_caller_identity.current.account_id}"
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
${repos ? `
# ── Image registry: one repository per service that is built ────────────────

resource "aws_ecr_repository" "svc" {
  for_each             = toset(local.built)
  name                 = "\${var.app_name}-\${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true # so destroy.sh can remove the repositories together with their images

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "svc" {
  for_each   = aws_ecr_repository.svc
  repository = each.value.name
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
` : ''}
# ── Release bucket: the compose file and the image tag the server runs ───────
# Private, encrypted, never public. Holds no secret: secrets are read from SSM Parameter Store.

resource "aws_s3_bucket" "release" {
  bucket        = local.release_bucket
  force_destroy = true # so destroy.sh can remove it
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "release" {
  bucket                  = aws_s3_bucket.release.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "release" {
  bucket = aws_s3_bucket.release.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "release" {
  bucket = aws_s3_bucket.release.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Changing compose.deploy.yml and running terraform apply (deploy.sh does) is a new release of the services; the server is not replaced.
resource "aws_s3_object" "compose" {
  bucket                 = aws_s3_bucket.release.id
  key                    = "compose.yml"
  source                 = "\${path.module}/compose.deploy.yml"
  etag                   = filemd5("\${path.module}/compose.deploy.yml")
  server_side_encryption = "AES256"
}

resource "aws_s3_object" "release_env" {
  bucket                 = aws_s3_bucket.release.id
  key                    = "release.env"
  content                = "TAG=\${var.image_tag}\\n"
  server_side_encryption = "AES256"
}

# ── Instance role: Session Manager, pull these images, read the compose file and this project's secrets ──

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
${repos ? `  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "EcrPullTheseRepositories"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = [for r in aws_ecr_repository.svc : r.arn]
  }
` : ''}  statement {
    sid       = "ReadTheReleaseFiles"
    actions   = ["s3:GetObject"]
    resources = ["\${aws_s3_bucket.release.arn}/compose.yml", "\${aws_s3_bucket.release.arn}/release.env"]
  }
  statement {
    sid       = "ReadThisProjectsSecrets"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:aws:ssm:\${var.region}:\${data.aws_caller_identity.current.account_id}:parameter/\${var.app_name}/*"]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "\${var.app_name}-release-and-secrets"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_instance_profile" "app" {
  name = "\${var.app_name}-ec2"
  role = aws_iam_role.app.name
}

# ── Network access: only the public service's port. No SSH: use Session Manager. ──

resource "aws_security_group" "app" {
  name        = "\${var.app_name}-ec2"
  description = "Access to \${var.app_name}"
  vpc_id      = local.vpc_id

  ingress {
    description = "${s.entry.service} (the only service open to the network)"
    from_port   = var.entry_port
    to_port     = var.entry_port
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
  user_data_replace_on_change = ${s.databaseLabel ? 'false' : 'true'}

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
${s.databaseLabel ? `
  # The database keeps its data on this machine: nothing may replace the machine (and with it the data). That includes a changed setting
  # (user_data) and AWS publishing a newer image than the one it started from (ami, which is looked up by name).
  lifecycle {
    ignore_changes = [user_data, ami]
  }
` : ''}
  depends_on = [aws_s3_object.compose, aws_s3_object.release_env]
}
${eip ? `
resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"
  tags     = local.tags
}
` : ''}`;
}

function variablesTf(s: StackDeploySpec): string {
  const e = s.ec2;
  return `variable "region" {
  description = "AWS Region to deploy to."
  type        = string
  default     = "${e.region}"
}

variable "app_name" {
  description = "Name used for the instance, repositories, bucket, role and secret path."
  type        = string
  default     = "${s.name}"
}

variable "entry_port" {
  description = "The port of the ${s.entry.service}, the only service open to the network."
  type        = number
  default     = ${s.entry.port}
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
  description = "Who can reach the ${s.entry.service} (IPv4 range)."
  type        = string
  default     = "${e.allowedCidr}"
}

variable "image_tag" {
  description = "The tag of the images the server runs."
  type        = string
  default     = "${e.imageTag}"
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

function outputsTf(s: StackDeploySpec): string {
  const ip = s.ec2.elasticIp ? 'aws_eip.app.public_ip' : 'aws_instance.app.public_ip';
  return `${s.built.length > 0 ? `output "ecr_repositories" {
  description = "Where each service's image is pushed."
  value       = { for k, r in aws_ecr_repository.svc : k => r.repository_url }
}

` : ''}output "release_bucket" {
  value = aws_s3_bucket.release.id
}

output "image_tag" {
  value = var.image_tag
}

output "instance_id" {
  value = aws_instance.app.id
}

output "public_ip" {
  value = ${ip}
}

output "app_url" {
  value = "http://${tfRef(ip)}:${tfRef('var.entry_port')}${s.entry.path}"
}

output "connect" {
  description = "Open a shell on the server (no SSH needed)."
  value       = "aws ssm start-session --target \${aws_instance.app.id} --region \${var.region}"
}
`;
}

// ─── start-up script ─────────────────────────────────────────────────────────

export function stackUserDataSh(s: StackDeploySpec): string {
  const app = s.name;
  return `#!/bin/bash
# Runs once when the instance first starts. Installs Docker and the Compose plugin, and a systemd service that runs ${app}'s compose file.
set -euo pipefail

dnf install -y docker
systemctl enable --now docker

${composePluginSh()}
cat > /usr/local/bin/${app}-run <<'RUNNER'
#!/bin/bash
# Started by systemd. Safe to re-run: it fetches the current compose file, tag and secrets every time, so a restart is a new release.
set -euo pipefail

APP=${q(app)}
DIR="/opt/$APP"
TOKEN=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 120")
REGION=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text --region "$REGION")
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
# The same name Terraform gives the release bucket.
BUCKET="\${APP:0:30}-$ACCOUNT"

umask 077
mkdir -p "$DIR"
cd "$DIR"
aws s3 cp "s3://$BUCKET/compose.yml" compose.yml --region "$REGION" --only-show-errors
aws s3 cp "s3://$BUCKET/release.env" release.env --region "$REGION" --only-show-errors
${s.built.length > 0 ? `aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
` : ''}
# The settings file for Compose: where the images are, which tag, and the secrets (single-quoted so nothing in a value is interpreted).
{
  printf 'REGISTRY=%s\\n' "$REGISTRY"
  cat release.env
} > .env
${s.secrets.map((k) => `# A failed read stops the script (set -e), so the services never start with an empty secret.
VALUE=$(aws ssm get-parameter --name /${app}/${k} --with-decryption --query Parameter.Value --output text --region "$REGION")
printf "%s='%s'\\n" '${k}' "$VALUE" >> .env`).join('\n')}

docker compose -p "$APP" -f compose.yml pull --quiet
exec docker compose -p "$APP" -f compose.yml up --remove-orphans
RUNNER
chmod 755 /usr/local/bin/${app}-run

cat > /etc/systemd/system/${app}.service <<'UNIT'
[Unit]
Description=${app} (docker compose)
After=docker.service network-online.target
Requires=docker.service

[Service]
ExecStart=/usr/local/bin/${app}-run
ExecStop=/usr/bin/docker compose -p ${app} -f /opt/${app}/compose.yml stop
# If an image is not pushed yet, or a secret is missing, try again in 30 seconds.
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now ${app}.service
`;
}

// ─── one-command scripts ─────────────────────────────────────────────────────

export function stackDeploySh(s: StackDeploySpec): string {
  const total = 4;
  return `#!/usr/bin/env bash
# One command to deploy ${s.name} (${s.built.length > 0 ? s.built.join(', ') : 'ready-made images'}${s.databaseLabel ? `, ${s.databaseLabel}` : ''}) to one EC2 server: bash deploy.sh
#   1. creates the server, the image repositories and the release bucket with Terraform (first run), asking you to confirm
#   2. stores the secret values in AWS (asks once, hidden), never in a file
#   3. builds each service's image for the server's CPU type and pushes it
#   4. restarts the services on the server and waits until the ${s.entry.service} answers
# Run it again to release a new version. Add --yes to skip the Terraform confirmation.
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(s.name)}
REGION=${q(s.ec2.region)}
SECRETS=(${s.secrets.map(q).join(' ')})
GENERATED=(${s.generated.map(q).join(' ')})
BUILT=(${s.built.map(q).join(' ')})
APPROVE=""
[ "\${1:-}" = "--yes" ] && APPROVE="-auto-approve"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing tool: $1. $2"; exit 1; }; }
need terraform "Install it from https://developer.hashicorp.com/terraform/install"
need aws       "Install the AWS CLI from https://aws.amazon.com/cli/"
${s.built.length > 0 ? `need docker    "Install Docker Desktop from https://www.docker.com/products/docker-desktop"
need openssl   "Needed to generate a random database password"
` : `need openssl   "Needed to generate a random database password"
`}aws sts get-caller-identity >/dev/null 2>&1 || { echo "You are not signed in to AWS. Run: aws configure (or aws sso login)"; exit 1; }
${s.built.length > 0 ? `docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and try again."; exit 1; }
` : ''}
is_generated() { local n; for n in \${GENERATED[@]+"\${GENERATED[@]}"}; do [ "$n" = "$1" ] && return 0; done; return 1; }

echo "==> 1/${total}  Server, image repositories and release bucket (Terraform)"
terraform -chdir=ec2 init -input=false >/dev/null
terraform -chdir=ec2 apply \${APPROVE:+-auto-approve}

echo "==> 2/${total}  Secrets"
for NAME in \${SECRETS[@]+"\${SECRETS[@]}"}; do
  if aws ssm get-parameter --region "$REGION" --name "/$APP/$NAME" >/dev/null 2>&1; then
    echo "    $NAME: already stored"
  else
    if is_generated "$NAME"; then
      read -r -s -p "    Value for $NAME (hidden; press Enter to generate a random one): " VALUE; echo
      [ -n "$VALUE" ] || { VALUE=$(openssl rand -hex 24); echo "    $NAME: generated"; }
    else
      read -r -s -p "    Value for $NAME (hidden): " VALUE; echo
    fi
    [ -n "$VALUE" ] || { echo "    $NAME cannot be empty."; exit 1; }
    # The value ends up inside a connection URL and a settings file, so it must not contain anything that needs quoting.
    [[ "$VALUE" =~ ^[A-Za-z0-9._~-]+$ ]] || { echo "    $NAME may use only letters, digits and . _ ~ - (no spaces or other symbols)."; exit 1; }
    TMP=$(mktemp); chmod 600 "$TMP"
    printf '%s' "$VALUE" > "$TMP"
    aws ssm put-parameter --region "$REGION" --name "/$APP/$NAME" --type SecureString --value "file://$TMP" >/dev/null
    rm -f "$TMP"; unset VALUE
    echo "    $NAME: stored"
  fi
done

${s.built.length > 0 ? `echo "==> 3/${total}  Build and push the images"
TAG=$(terraform -chdir=ec2 output -raw image_tag)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
for LAYER in \${BUILT[@]+"\${BUILT[@]}"}; do
  echo "    $LAYER"
  # The server is x86_64. Building for it explicitly makes this work from Apple Silicon Macs too.
  docker build --platform linux/amd64 -t "$REGISTRY/$APP-$LAYER:$TAG" "./$LAYER"
  docker push "$REGISTRY/$APP-$LAYER:$TAG"
done
` : `echo "==> 3/${total}  Images"
echo "    Every service uses a ready-made image: nothing to build."
`}
echo "==> ${total}/${total}  Start the services"
INSTANCE_ID=$(terraform -chdir=ec2 output -raw instance_id)
if aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \\
     --parameters "commands=[\\"systemctl restart $APP.service\\"]" >/dev/null 2>&1; then
  echo "    Restart sent."
else
  echo "    The server is not reachable by Session Manager yet (normal on a new server). It starts the services by itself within a few minutes."
fi

URL=$(terraform -chdir=ec2 output -raw app_url)
WAIT="\${DEPLOY_WAIT_SECONDS:-420}"
END=$((SECONDS + WAIT))
echo "    Waiting for $URL ..."
UP=""
while [ "$SECONDS" -lt "$END" ]; do
  if curl -fsS -m 5 -o /dev/null "$URL" >/dev/null 2>&1; then UP=yes; break; fi
  sleep 10
done
if [ -n "$UP" ]; then
  echo "Done. ${s.name} is running at $URL"
else
  echo "Not answering yet. The first start installs Docker and pulls every image, which can take several minutes. Try $URL again, or read the logs:"
  echo "  aws ssm start-session --region $REGION --target $INSTANCE_ID   then   sudo journalctl -u $APP.service -f"
fi
`;
}

export function stackDestroySh(s: StackDeploySpec): string {
  return `#!/usr/bin/env bash
# Removes everything deploy.sh created (server, image repositories with their images, release bucket, roles): bash destroy.sh
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(s.name)}
REGION=${q(s.ec2.region)}
SECRETS=(${s.secrets.map(q).join(' ')})

command -v terraform >/dev/null 2>&1 || { echo "Missing tool: terraform"; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "Missing tool: aws"; exit 1; }

echo "This permanently deletes the server of $APP${s.databaseLabel ? `, including the ${s.databaseLabel} data on its disk` : ''}, its image repositories and its release bucket."
read -r -p "Type the project name ($APP) to continue: " ANSWER
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

function stackEc2Readme(s: StackDeploySpec): string {
  return `# Deploy ${s.name} to EC2

One EC2 server runs all the services of this project with Docker Compose.

## Quick start

You need Terraform, the AWS CLI${s.built.length > 0 ? ' and Docker' : ''} installed, and to be signed in to AWS (\`aws configure\` or \`aws sso login\`). From the project folder (the one with \`deploy.sh\`):

\`\`\`bash
bash deploy.sh
\`\`\`

It creates the server${s.built.length > 0 ? ', one image repository per service' : ''} and a private release bucket, asks for the secret values (${s.secrets.length ? s.secrets.join(', ') : 'none are needed'}${s.generated.length ? `; press Enter at ${s.generated.join(', ')} to generate a random one` : ''}), ${s.built.length > 0 ? 'builds and pushes each image, ' : ''}starts the services and prints the address of the ${s.entry.service}.

To release a new version run \`bash deploy.sh\` again. To remove everything: \`bash destroy.sh\`.

## What gets created

- One EC2 server (Amazon Linux 2023) that runs \`ec2/compose.deploy.yml\` with Docker Compose, under systemd.
${s.built.length > 0 ? `- ECR repositories: ${s.built.map((l) => `\`${s.name}-${l}\``).join(', ')}.\n` : ''}- A private S3 bucket (never public) that holds the compose file and the image tag. It holds no secret.
- A role that lets the server only: pull these images, read those two files, and read \`/${s.name}/*\` in SSM Parameter Store.
- A security group that opens **only port ${s.entry.port}** (the ${s.entry.service}) to \`${s.ec2.allowedCidr}\`. The other services${s.databaseLabel ? ' and the database' : ''} are reachable only from inside the server. There is no SSH.

## How a release works

1. \`deploy.sh\` builds and pushes the images with the tag in \`ec2/variables.tf\` (\`image_tag\`).
2. Terraform replaces the compose file and tag in the bucket. **The server is not replaced.**
3. \`deploy.sh\` restarts the service. On every start the server downloads the compose file and tag, signs in to ECR, reads the secrets, pulls the images and runs \`docker compose up\`.

## Look inside the server

\`\`\`bash
aws ssm start-session --region ${s.ec2.region} --target <instance_id>
sudo journalctl -u ${s.name}.service -f          # logs of every service
sudo docker compose -p ${s.name} -f /opt/${s.name}/compose.yml ps
\`\`\`

(\`terraform -chdir=ec2 output\` shows the instance id.)

## What to know

${s.databaseLabel ? `- ${s.databaseLabel} runs on the same server, in the volume \`database-data\` on its disk. ${DB_SINGLE_MACHINE_NOTE}\n` : ''}- This is a single server: HTTP only, no load balancer, no automatic replacement if it fails. For HTTPS or several servers put an Application Load Balancer in front, or move to ECS.
- Secrets are stored in SSM Parameter Store as \`/${s.name}/<NAME>\`. They are never written to Terraform, its state, the bucket or any file generated here.
- Terraform keeps its record in \`ec2/terraform.tfstate\`. Keep that folder; \`bash destroy.sh\` needs it.
- Costs: the server, its disk and the public IPv4 address bill every hour; ECR bills for storage.
`;
}

export function generateStackEc2Files(s: StackDeploySpec): Array<{ path: string; content: string; executable?: boolean }> {
  return [
    { path: 'deploy.sh', content: stackDeploySh(s), executable: true },
    { path: 'destroy.sh', content: stackDestroySh(s), executable: true },
    { path: 'ec2/main.tf', content: mainTf(s) },
    { path: 'ec2/variables.tf', content: variablesTf(s) },
    { path: 'ec2/outputs.tf', content: outputsTf(s) },
    { path: 'ec2/user_data.sh', content: stackUserDataSh(s) },
    { path: 'ec2/compose.deploy.yml', content: s.compose },
    { path: 'ec2/.gitignore', content: '.terraform/\n*.tfstate\n*.tfstate.*\ncrash.log\n' },
    { path: 'ec2/README.md', content: stackEc2Readme(s) },
  ];
}

export { validCidr };
