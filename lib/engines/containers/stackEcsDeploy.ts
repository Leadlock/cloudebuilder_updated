/**
 * "Deploy to ECS Fargate" for a whole project (Frontend + Backend + API): one ECS service per service, behind one Application Load Balancer
 * that sends traffic to the public service only.
 *
 * How it differs from a single service (ecsDeploy.ts), which it shares its safety rules with:
 *  - Terraform creates one ECR repository per service that is built from source, one cluster, one task definition and one ECS service per service,
 *    and one load balancer whose only target is the public service (the Frontend, else the API, else the Backend).
 *  - The services find each other by the same short names as in Docker Compose (`api`, `backend`) through ECS Service Connect, so the generated
 *    nginx configuration and BACKEND_URL / API_URL work unchanged.
 *  - Secrets are read by ECS from SSM Parameter Store at /<project>/<NAME> when a task starts; values never enter Terraform, its state or any file.
 *  - The tasks accept traffic from the load balancer (the public service) and from each other only; the execution role reads this project's
 *    parameters only; the tasks have an empty role; images are scanned on push; a failing deployment rolls back (circuit breaker).
 *  - A database is not run on Fargate (it has no persistent disk these templates manage): use RDS and a DATABASE_URL secret.
 *
 * For a release CloudBuilder runs (`forRelease`), the images are built inside the account (CodeBuild) and the services are created with no tasks;
 * CloudBuilder then points each service at the new images and starts them, so Terraform never replaces what a release changed.
 */
import { REGION, TAG, q, validCidr, type DeployCost } from './ec2Deploy';
import { FARGATE_CPU, fargateMemoryOptions } from './ecsDeploy';
import { codeBuildTf } from './stackEc2Deploy';

export interface StackEcsConfig {
  region: string;
  /** Fargate CPU units of every service: 256, 512, 1024, 2048 or 4096. */
  cpu: number;
  /** Task memory in MB; which values are allowed depends on the CPU. */
  memoryMb: number;
  /** Tasks per service. */
  desiredCount: number;
  /** Who can reach the load balancer. */
  allowedCidr: string;
  /** ACM certificate ARN. When set the load balancer serves HTTPS and redirects HTTP to it. */
  certificateArn: string;
  imageTag: string;
}

export const defaultStackEcs = (): StackEcsConfig => ({ region: 'us-east-1', cpu: 512, memoryMb: 1024, desiredCount: 1, allowedCidr: '0.0.0.0/0', certificateArn: '', imageTag: 'latest' });

export interface StackEcsLayer {
  name: string;
  /** The port the service listens on inside its container. */
  port: number;
  built: boolean;
  /** The ready-made image, when it is not built. */
  image: string;
  /** Plain variables, including the addresses of the other services. */
  env: Array<{ key: string; value: string }>;
  secrets: string[];
  healthPath: string;
}

export interface StackEcsSpec {
  project: string;
  ecs: StackEcsConfig;
  layers: StackEcsLayer[];
  /** The name of the public service. */
  entry: string;
  /** Every secret of every service, once each. */
  secrets: string[];
}

const CERT_ARN = /^arn:aws:acm:[a-z0-9-]+:\d{12}:certificate\/[A-Za-z0-9-]+$/;
/** A Terraform string literal: JSON escaping, plus no interpolation or directive can start inside it. */
const hcl = (s: string) => JSON.stringify(s).replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');

const builtOf = (s: StackEcsSpec) => s.layers.filter((l) => l.built).map((l) => l.name);
const entryOf = (s: StackEcsSpec) => s.layers.find((l) => l.name === s.entry)!;

export function validateStackEcs(s: StackEcsSpec): string[] {
  const e = s.ecs;
  const out: string[] = [];
  // Load balancer and target group names allow only letters, digits and hyphens, up to 32 characters.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(s.project)) out.push('ECS: the project name becomes the load balancer name, so it may use only lowercase letters, digits and "-" (no "_"), up to 32 characters.');
  if (!REGION.test(e.region)) out.push('ECS: region looks like us-east-1.');
  if (!(FARGATE_CPU as readonly number[]).includes(e.cpu)) out.push('ECS: CPU must be 256, 512, 1024, 2048 or 4096.');
  else if (!fargateMemoryOptions(e.cpu).includes(e.memoryMb)) out.push(`ECS: with ${e.cpu} CPU units memory must be one of ${fargateMemoryOptions(e.cpu).join(', ')} MB.`);
  if (!Number.isInteger(e.desiredCount) || e.desiredCount < 1 || e.desiredCount > 20) out.push('ECS: the number of tasks per service must be 1 to 20.');
  if (!validCidr(e.allowedCidr)) out.push('ECS: "who can connect" must be an IPv4 range such as 203.0.113.0/24 (or 0.0.0.0/0 for everyone).');
  if (e.certificateArn !== '' && !CERT_ARN.test(e.certificateArn)) out.push('ECS: the certificate must be an ACM certificate ARN (arn:aws:acm:region:account:certificate/id).');
  if (!TAG.test(e.imageTag)) out.push('ECS: image tag may use letters, digits, "_", "." and "-" (up to 128 characters).');
  for (const l of s.layers) {
    if (!Number.isInteger(l.port) || l.port < 1 || l.port > 65535) out.push(`ECS: ${l.name}: port must be 1-65535.`);
    if (!l.built && !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(l.image)) out.push(`ECS: ${l.name}: the image name is not valid.`);
  }
  return out;
}

export function stackEcsWarnings(s: StackEcsSpec): string[] {
  const w: string[] = [];
  if (s.ecs.certificateArn === '') w.push('ECS: the load balancer serves plain HTTP. Add an ACM certificate ARN to serve HTTPS and redirect HTTP to it.');
  if (s.ecs.allowedCidr === '0.0.0.0/0') w.push(`ECS: the ${s.entry} will be open to the whole internet. Narrow "who can connect" if it is not public.`);
  if (s.ecs.imageTag === 'latest' && builtOf(s).length > 0) w.push('ECS: the "latest" tag is used. A version tag (for example the commit id) makes it clear what is running and allows a rollback.');
  if (s.secrets.length > 0) w.push(`ECS: deploy.sh asks for ${s.secrets.join(', ')} and stores each in SSM Parameter Store as /${s.project}/<NAME>; the services cannot start without them.`);
  w.push('ECS: there is no database on Fargate. Use RDS (or another managed database) and keep its connection URL in a secret named DATABASE_URL.');
  return w;
}

const HOURS = 730;
const FARGATE_VCPU_HOUR = 0.04048;
const FARGATE_GB_HOUR = 0.004445;
const ALB_HOUR = 0.0225;
const ALB_LCU_HOUR = 0.008;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** List-price estimate (us-east-1, Linux/x86) of the tasks, the load balancer and their public IPs. */
export function estimateStackEcsCost(s: StackEcsSpec): DeployCost {
  const e = s.ecs;
  const tasks = s.layers.length * e.desiredCount;
  const per = (e.cpu / 1024) * FARGATE_VCPU_HOUR + (e.memoryMb / 1024) * FARGATE_GB_HOUR;
  const lines = [
    { label: `${tasks} Fargate task${tasks === 1 ? '' : 's'} (${s.layers.length} service${s.layers.length === 1 ? '' : 's'} x ${e.desiredCount}, ${e.cpu / 1024} vCPU, ${e.memoryMb / 1024} GB each)`, monthlyUsd: round2(per * HOURS * tasks) },
    { label: 'Application Load Balancer', monthlyUsd: round2((ALB_HOUR + ALB_LCU_HOUR) * HOURS) },
    { label: `Public IPv4 addresses (${tasks} task${tasks === 1 ? '' : 's'} + 2 for the load balancer)`, monthlyUsd: round2(0.005 * HOURS * (tasks + 2)) },
    { label: 'CloudWatch Logs (1 GB)', monthlyUsd: 0.5 },
  ];
  const notes = [`Excludes data transfer out, ECR storage (about $0.10 per GB-month, ${builtOf(s).length} repositor${builtOf(s).length === 1 ? 'y' : 'ies'}) and load balancer traffic beyond the minimum.`];
  if (e.region !== 'us-east-1') notes.push(`Priced for us-east-1; ${e.region} is usually a little higher.`);
  return { monthlyUsd: round2(lines.reduce((t, l) => t + l.monthlyUsd, 0)), lines, notes };
}

// ─── Terraform ───────────────────────────────────────────────────────────────

function servicesLocal(s: StackEcsSpec): string {
  return s.layers.map((l) => `    ${l.name} = {
      port    = ${l.port}
      health  = ${hcl(l.healthPath || '/')}
      image   = ${hcl(l.built ? '' : l.image)}
      env     = {
${l.env.map((v) => `        ${hcl(v.key)} = ${hcl(v.value)}`).join('\n')}
      }
      secrets = [${l.secrets.map(hcl).join(', ')}]
    }`).join('\n');
}

function mainTf(s: StackEcsSpec, release: boolean): string {
  const https = s.ecs.certificateArn !== '';
  const built = builtOf(s);
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

# Network: the account's default VPC unless vpc_id / subnet_ids are given. The load balancer needs subnets in two availability zones.
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
  built = [${built.map((l) => `"${l}"`).join(', ')}]
${release && built.length > 0 ? '  source_bucket = "${substr(var.app_name, 0, 24)}-src-${data.aws_caller_identity.current.account_id}"\n' : ''}  # Every service: its port, health path, ready-made image (empty when it is built), plain variables and the names of its secrets.
  services = {
${servicesLocal(s)}
  }
  entry = ${hcl(s.entry)}
}

data "aws_subnets" "in_vpc" {
  count = length(var.subnet_ids) == 0 ? 1 : 0
  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

locals {
  subnet_ids = length(var.subnet_ids) == 0 ? data.aws_subnets.in_vpc[0].ids : var.subnet_ids
}
${built.length > 0 ? `
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

locals {
  repo_urls = { for k, r in aws_ecr_repository.svc : k => r.repository_url }
}
` : `
locals {
  repo_urls = {}
}
`}${release ? codeBuildTf({ built }) : ''}
resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/\${var.app_name}"
  retention_in_days = 30
  tags              = local.tags
}

# ── Roles: ECS starts a task with the execution role; the tasks themselves have none ─

data "aws_iam_policy_document" "tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "\${var.app_name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "secrets" {
  statement {
    sid       = "ReadThisProjectsSecrets"
    actions   = ["ssm:GetParameters", "ssm:GetParameter"]
    resources = ["arn:aws:ssm:\${var.region}:\${data.aws_caller_identity.current.account_id}:parameter/\${var.app_name}/*"]
  }
}

resource "aws_iam_role_policy" "secrets" {
  name   = "\${var.app_name}-read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.secrets.json
}

# The services' own identity. It has no permissions: give it only what your code needs.
resource "aws_iam_role" "task" {
  name               = "\${var.app_name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.tasks_assume.json
  tags               = local.tags
}

# ── Network access: internet -> load balancer -> the public service; services -> each other ──

resource "aws_security_group" "alb" {
  name        = "\${var.app_name}-alb"
  description = "Load balancer of \${var.app_name}"
  vpc_id      = local.vpc_id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }
${https ? `
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }
` : ''}
  egress {
    description = "To the public service"
    from_port   = local.services[local.entry].port
    to_port     = local.services[local.entry].port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

resource "aws_security_group" "task" {
  name        = "\${var.app_name}-task"
  description = "Tasks of \${var.app_name}: only the load balancer and each other can reach them"
  vpc_id      = local.vpc_id

  ingress {
    description     = "From the load balancer to the public service"
    from_port       = local.services[local.entry].port
    to_port         = local.services[local.entry].port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  ingress {
    description = "The services talk to each other"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }

  # Outbound is open so tasks can pull images, read their secrets and call other services.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

# ── Load balancer: its only target is the public service ─────────────────────

resource "aws_lb" "app" {
  name                       = var.app_name
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = local.subnet_ids
  drop_invalid_header_fields = true
  tags                       = local.tags
}

resource "aws_lb_target_group" "app" {
  name        = var.app_name
  port        = local.services[local.entry].port
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"

  health_check {
    path                = local.services[local.entry].health
    matcher             = "200-399"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 30
  tags                 = local.tags
}
${https ? `
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
` : `
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
`}
# ── Cluster, and one task definition and service per service ─────────────────

resource "aws_ecs_cluster" "app" {
  name = var.app_name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = local.tags
}

# Service Connect: the services reach each other by their short names (api, backend), as in Docker Compose.
resource "aws_service_discovery_http_namespace" "app" {
  name = "\${var.app_name}.internal"
  tags = local.tags
}

resource "aws_ecs_task_definition" "svc" {
  for_each                 = local.services
  family                   = "\${var.app_name}-\${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory_mb
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
${release ? '  skip_destroy             = true # a release registers its own revisions; the one a running service uses must stay active when this changes\n' : ''}
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = each.key
    image     = each.value.image != "" ? each.value.image : "\${lookup(local.repo_urls, each.key, "")}:\${var.image_tag}"
    essential = true
    portMappings = [{
      name          = "app"
      containerPort = each.value.port
      protocol      = "tcp"
    }]
    environment = [for k, v in each.value.env : { name = k, value = v }]
    secrets     = [for n in each.value.secrets : { name = n, valueFrom = "arn:aws:ssm:\${var.region}:\${data.aws_caller_identity.current.account_id}:parameter/\${var.app_name}/\${n}" }]
    linuxParameters = {
      initProcessEnabled = true
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = each.key
      }
    }
  }])

  tags = local.tags
}

resource "aws_ecs_service" "svc" {
  for_each        = local.services
  name            = each.key
  cluster         = aws_ecs_cluster.app.id
  task_definition = aws_ecs_task_definition.svc[each.key].arn
  launch_type     = "FARGATE"
  desired_count   = ${release ? '0 # CloudBuilder starts the services once their images are built and their secrets are stored' : 'var.desired_count'}
${release ? '' : '  wait_for_steady_state = true\n'}
  health_check_grace_period_seconds = each.key == local.entry ? 60 : null

  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true # the default VPC has no NAT; set vpc_id / subnet_ids to private subnets with a NAT to turn this off
  }

  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.app.arn
    service {
      port_name      = "app"
      discovery_name = each.key
      client_alias {
        port     = each.value.port
        dns_name = each.key
      }
    }
    log_configuration {
      log_driver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "\${each.key}-connect"
      }
    }
  }

  dynamic "load_balancer" {
    for_each = each.key == local.entry ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.app.arn
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.${https ? 'https' : 'http'}]
${release ? `
  # A release points each service at a new task definition and a task count itself; Terraform must not undo that.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
` : ''}
  tags = local.tags
}
`;
}

function variablesTf(s: StackEcsSpec): string {
  const e = s.ecs;
  return `variable "region" {
  description = "AWS Region to deploy to."
  type        = string
  default     = "${e.region}"
}

variable "app_name" {
  description = "Name used for the cluster, load balancer, repositories, roles and secret path."
  type        = string
  default     = "${s.project}"
}

variable "cpu" {
  description = "Fargate CPU units of every service."
  type        = number
  default     = ${e.cpu}
}

variable "memory_mb" {
  description = "Task memory (MB) of every service; it must suit the CPU."
  type        = number
  default     = ${e.memoryMb}
}

variable "desired_count" {
  description = "Tasks per service."
  type        = number
  default     = ${e.desiredCount}
}

variable "allowed_cidr" {
  description = "Who can reach the load balancer (IPv4 range)."
  type        = string
  default     = "${e.allowedCidr}"
}

variable "certificate_arn" {
  description = "ACM certificate for HTTPS (empty: plain HTTP)."
  type        = string
  default     = "${e.certificateArn}"
}

variable "image_tag" {
  description = "The tag of the images the services run."
  type        = string
  default     = "${e.imageTag}"
}

variable "vpc_id" {
  description = "Leave empty to use the default VPC."
  type        = string
  default     = ""
}

variable "subnet_ids" {
  description = "Leave empty to use every subnet of the VPC. Give subnets in at least two availability zones."
  type        = list(string)
  default     = []
}
`;
}

function outputsTf(s: StackEcsSpec, release: boolean): string {
  const scheme = s.ecs.certificateArn !== '' ? 'https' : 'http';
  const built = builtOf(s).length > 0;
  return `output "cluster" {
  value = aws_ecs_cluster.app.name
}

output "services" {
  description = "The ECS services, one per service of the project."
  value       = keys(local.services)
}

output "image_tag" {
  value = var.image_tag
}

output "alb_dns" {
  value = aws_lb.app.dns_name
}

output "app_url" {
  value = "${scheme}://\${aws_lb.app.dns_name}${entryOf(s).healthPath || '/'}"
}
${built ? `
output "ecr_repositories" {
  description = "Where each service's image is pushed."
  value       = local.repo_urls
}
` : ''}${release ? `
output "region" {
  value = var.region
}

output "registry" {
  description = "Where the images are pushed and pulled."
  value       = "\${data.aws_caller_identity.current.account_id}.dkr.ecr.\${var.region}.amazonaws.com"
}

output "ssm_prefix" {
  description = "Where the secrets are in Parameter Store."
  value       = "/\${var.app_name}"
}

output "desired_count" {
  value = var.desired_count
}
${built ? `
output "codebuild_project" {
  value = aws_codebuild_project.build.name
}

output "source_bucket" {
  value = aws_s3_bucket.source.id
}
` : ''}` : ''}`;
}

// ─── scripts ─────────────────────────────────────────────────────────────────

export function stackEcsDeploySh(s: StackEcsSpec): string {
  const built = builtOf(s);
  const total = 5;
  return `#!/usr/bin/env bash
# One command to deploy ${s.project} (${s.layers.map((l) => l.name).join(', ')}) to ECS Fargate: bash deploy.sh
#   1. creates the image repositories with Terraform (first run)
#   2. stores the secret values in AWS (asks once, hidden), never in a file
#   3. builds each service's image for Fargate and pushes it
#   4. creates / updates the cluster, the services and the load balancer with Terraform, asking you to confirm
#   5. waits until the ${s.entry} answers
# Run it again to release a new version. Add --yes to skip the Terraform confirmation.
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(s.project)}
REGION=${q(s.ecs.region)}
SECRETS=(${s.secrets.map(q).join(' ')})
BUILT=(${built.map(q).join(' ')})
APPROVE=""
[ "\${1:-}" = "--yes" ] && APPROVE="-auto-approve"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing tool: $1. $2"; exit 1; }; }
need terraform "Install it from https://developer.hashicorp.com/terraform/install"
need aws       "Install the AWS CLI from https://aws.amazon.com/cli/"
${built.length > 0 ? `need docker    "Install Docker Desktop from https://www.docker.com/products/docker-desktop"
` : ''}aws sts get-caller-identity >/dev/null 2>&1 || { echo "You are not signed in to AWS. Run: aws configure (or aws sso login)"; exit 1; }
${built.length > 0 ? `docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and try again."; exit 1; }
` : ''}
echo "==> 1/${total}  Image repositories (Terraform)"
terraform -chdir=ecs init -input=false >/dev/null
${built.length > 0 ? `terraform -chdir=ecs apply -input=false -auto-approve -target=aws_ecr_repository.svc -target=aws_ecr_lifecycle_policy.svc >/dev/null
` : `echo "    Every service uses a ready-made image: no repositories needed."
`}
echo "==> 2/${total}  Secrets"
for NAME in \${SECRETS[@]+"\${SECRETS[@]}"}; do
  if aws ssm get-parameter --region "$REGION" --name "/$APP/$NAME" >/dev/null 2>&1; then
    echo "    $NAME: already stored"
  else
    read -r -s -p "    Value for $NAME (hidden): " VALUE; echo
    [ -n "$VALUE" ] || { echo "    $NAME cannot be empty."; exit 1; }
    [[ "$VALUE" =~ ^[A-Za-z0-9._~-]+$ ]] || { echo "    $NAME may use only letters, digits and . _ ~ - (no spaces or other symbols)."; exit 1; }
    TMP=$(mktemp); chmod 600 "$TMP"
    printf '%s' "$VALUE" > "$TMP"
    aws ssm put-parameter --region "$REGION" --name "/$APP/$NAME" --type SecureString --value "file://$TMP" >/dev/null
    rm -f "$TMP"; unset VALUE
    echo "    $NAME: stored"
  fi
done

${built.length > 0 ? `echo "==> 3/${total}  Build and push the images"
TAG=$(terraform -chdir=ecs output -raw image_tag)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
for LAYER in \${BUILT[@]+"\${BUILT[@]}"}; do
  echo "    $LAYER"
  # Fargate runs x86_64 here. Building for it explicitly makes this work from Apple Silicon Macs too.
  docker build --platform linux/amd64 -t "$REGISTRY/$APP-$LAYER:$TAG" "./$LAYER"
  docker push "$REGISTRY/$APP-$LAYER:$TAG"
done
` : `echo "==> 3/${total}  Images"
echo "    Every service uses a ready-made image: nothing to build."
`}
echo "==> 4/${total}  Cluster, services and load balancer (Terraform)"
terraform -chdir=ecs apply \${APPROVE:+-auto-approve}

echo "==> 5/${total}  Wait for the ${s.entry}"
URL=$(terraform -chdir=ecs output -raw app_url)
WAIT="\${DEPLOY_WAIT_SECONDS:-300}"
END=$((SECONDS + WAIT))
echo "    Waiting for $URL ..."
UP=""
while [ "$SECONDS" -lt "$END" ]; do
  if curl -fsS -m 5 -o /dev/null "$URL" >/dev/null 2>&1; then UP=yes; break; fi
  sleep 10
done
if [ -n "$UP" ]; then
  echo "Done. ${s.project} is running at $URL"
else
  echo "Not answering yet. See the services in the ECS console (cluster $APP), or the logs in CloudWatch (log group /ecs/$APP)."
fi
`;
}

export function stackEcsDestroySh(s: StackEcsSpec): string {
  return `#!/usr/bin/env bash
# Removes everything deploy.sh created (cluster, services, load balancer, image repositories with their images, roles): bash destroy.sh
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(s.project)}
REGION=${q(s.ecs.region)}
SECRETS=(${s.secrets.map(q).join(' ')})

command -v terraform >/dev/null 2>&1 || { echo "Missing tool: terraform"; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "Missing tool: aws"; exit 1; }

echo "This permanently deletes the cluster, services, load balancer and image repositories of $APP."
read -r -p "Type the project name ($APP) to continue: " ANSWER
[ "$ANSWER" = "$APP" ] || { echo "Cancelled."; exit 1; }

terraform -chdir=ecs init -input=false >/dev/null
terraform -chdir=ecs destroy -auto-approve

for NAME in \${SECRETS[@]+"\${SECRETS[@]}"}; do
  read -r -p "Also delete the stored secret $NAME? [y/N] " DEL
  if [ "$DEL" = "y" ] || [ "$DEL" = "Y" ]; then
    aws ssm delete-parameter --region "$REGION" --name "/$APP/$NAME" >/dev/null 2>&1 && echo "    $NAME deleted" || echo "    $NAME not found"
  fi
done
echo "Done."
`;
}

function readme(s: StackEcsSpec): string {
  const built = builtOf(s);
  return `# Deploy ${s.project} to ECS Fargate

Every service of this project runs as its own ECS service on Fargate (no servers to look after). One load balancer sends the internet to the ${s.entry}; the other services are reachable only from inside.

## Quick start

You need Terraform, the AWS CLI${built.length > 0 ? ' and Docker' : ''} installed, and to be signed in to AWS (\`aws configure\` or \`aws sso login\`). From the project folder (the one with \`deploy.sh\`):

\`\`\`bash
bash deploy.sh
\`\`\`

It creates ${built.length > 0 ? 'the image repositories, ' : ''}asks for the secret values (${s.secrets.length ? s.secrets.join(', ') : 'none are needed'}), ${built.length > 0 ? 'builds and pushes each image, ' : ''}creates the cluster, the services and the load balancer, and prints the address of the ${s.entry}.

To release a new version change \`image_tag\` in \`ecs/variables.tf\` and run \`bash deploy.sh\` again. To remove everything: \`bash destroy.sh\`.

## What gets created

${built.length > 0 ? `- ECR repositories: ${built.map((l) => `\`${s.project}-${l}\``).join(', ')} (scanned on push, the 10 latest images kept).\n` : ''}- One ECS cluster, and for each service (${s.layers.map((l) => `\`${l.name}\``).join(', ')}) a task definition and a service. A failing deployment rolls back by itself.
- ECS Service Connect, so the services reach each other by the same short names as in Docker Compose (\`api\`, \`backend\`).
- An Application Load Balancer whose only target is the ${s.entry} (port ${entryOf(s).port}), open to \`${s.ecs.allowedCidr}\`${s.ecs.certificateArn ? ', HTTPS with your certificate' : ' over plain HTTP'}.
- An execution role that can read \`/${s.project}/*\` in SSM Parameter Store, and an empty role for the tasks.

## What to know

- There is no database on Fargate. Use RDS (or another managed database) and put its connection URL in a secret named \`DATABASE_URL\`.
- Secrets are stored in SSM Parameter Store as \`/${s.project}/<NAME>\` and read by ECS when a task starts. They are never written to Terraform, its state or any file generated here.
- The tasks get public IPs because the default VPC has no NAT gateway. Only the load balancer can reach the public service; the other services accept connections from the project's own tasks only.
- Terraform keeps its record in \`ecs/terraform.tfstate\`. Keep that folder; \`bash destroy.sh\` needs it.
`;
}

export function generateStackEcsFiles(s: StackEcsSpec, opts: { forRelease?: boolean } = {}): Array<{ path: string; content: string; executable?: boolean }> {
  const release = opts.forRelease === true;
  return [
    { path: 'deploy.sh', content: stackEcsDeploySh(s), executable: true },
    { path: 'destroy.sh', content: stackEcsDestroySh(s), executable: true },
    { path: 'ecs/main.tf', content: mainTf(s, release) },
    { path: 'ecs/variables.tf', content: variablesTf(s) },
    { path: 'ecs/outputs.tf', content: outputsTf(s, release) },
    { path: 'ecs/.gitignore', content: '.terraform/\n*.tfstate\n*.tfstate.*\ncrash.log\n' },
    { path: 'ecs/README.md', content: readme(s) },
  ];
}
