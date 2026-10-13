/**
 * Optional "deploy to AWS ECS Fargate" bundle for a container template: Terraform for an image repository, a cluster, a task definition,
 * a service behind an Application Load Balancer, and optional autoscaling, plus deploy.sh / destroy.sh and a GitHub Actions workflow.
 *
 * No servers to look after: Fargate runs the container. Safe by default, like the EC2 bundle:
 *  - secrets are read by ECS from SSM Parameter Store when a task starts (task definition "secrets"), never written to Terraform;
 *  - the tasks accept traffic only from the load balancer; the load balancer accepts traffic only from the range you choose;
 *  - the execution role can read this app's parameters only; the task itself has an empty role;
 *  - images are scanned on push, and a failing deployment rolls back (circuit breaker).
 */
import type { ContainerConfig } from './dockerTemplates';
import { GITHUB_REPO, REGION, TAG, q, secretNames, validCidr, type DeployCost } from './ec2Deploy';

export interface EcsConfig {
  enabled: boolean;
  region: string;
  /** Fargate CPU units: 256, 512, 1024, 2048 or 4096. */
  cpu: number;
  /** Task memory in MB; which values are allowed depends on the CPU. */
  memoryMb: number;
  desiredCount: number;
  autoscaling: boolean;
  minCount: number;
  maxCount: number;
  /** Who can reach the load balancer. */
  allowedCidr: string;
  /** ACM certificate ARN. When set the load balancer serves HTTPS and redirects HTTP to it. */
  certificateArn: string;
  imageTag: string;
  githubActions: boolean;
  githubRepo: string;
  scanImage: boolean;
}

export const defaultEcs = (): EcsConfig => ({
  enabled: false, region: 'us-east-1', cpu: 256, memoryMb: 512, desiredCount: 2, autoscaling: false, minCount: 2, maxCount: 6,
  allowedCidr: '0.0.0.0/0', certificateArn: '', imageTag: 'latest', githubActions: true, githubRepo: '', scanImage: true,
});

export const FARGATE_CPU = [256, 512, 1024, 2048, 4096] as const;

/** Memory (MB) Fargate accepts for each CPU size. */
export function fargateMemoryOptions(cpu: number): number[] {
  const range = (from: number, to: number, step: number) => { const out: number[] = []; for (let m = from; m <= to; m += step) out.push(m); return out; };
  switch (cpu) {
    case 256: return [512, 1024, 2048];
    case 512: return range(1024, 4096, 1024);
    case 1024: return range(2048, 8192, 1024);
    case 2048: return range(4096, 16384, 1024);
    case 4096: return range(8192, 30720, 1024);
    default: return [];
  }
}

const CERT_ARN = /^arn:aws:acm:[a-z0-9-]+:\d{12}:certificate\/[A-Za-z0-9-]+$/;

export function validateEcs(c: ContainerConfig): string[] {
  const e = c.ecs;
  if (!e.enabled) return [];
  const out: string[] = [];
  // Load balancer and target group names allow only letters, digits and hyphens, up to 32 characters.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(c.appName)) out.push('ECS: the app name becomes the load balancer name, so it may use only lowercase letters, digits and "-" (no "_"), up to 32 characters.');
  if (!REGION.test(e.region)) out.push('ECS: region looks like us-east-1.');
  if (!(FARGATE_CPU as readonly number[]).includes(e.cpu)) out.push('ECS: CPU must be 256, 512, 1024, 2048 or 4096.');
  else if (!fargateMemoryOptions(e.cpu).includes(e.memoryMb)) out.push(`ECS: with ${e.cpu} CPU units memory must be one of ${fargateMemoryOptions(e.cpu).join(', ')} MB.`);
  if (!Number.isInteger(e.desiredCount) || e.desiredCount < 1 || e.desiredCount > 50) out.push('ECS: the number of tasks must be 1 to 50.');
  if (e.autoscaling) {
    if (!Number.isInteger(e.minCount) || !Number.isInteger(e.maxCount) || e.minCount < 1 || e.maxCount < e.minCount || e.maxCount > 100) out.push('ECS: autoscaling needs a minimum of at least 1 and a maximum that is not below it (up to 100).');
  }
  if (!validCidr(e.allowedCidr)) out.push('ECS: "who can connect" must be an IPv4 range such as 203.0.113.0/24 (or 0.0.0.0/0 for everyone).');
  if (e.certificateArn !== '' && !CERT_ARN.test(e.certificateArn)) out.push('ECS: the certificate must be an ACM certificate ARN (arn:aws:acm:region:account:certificate/id).');
  if (!TAG.test(e.imageTag)) out.push('ECS: image tag may use letters, digits, "_", "." and "-" (up to 128 characters).');
  if (e.githubRepo !== '' && !GITHUB_REPO.test(e.githubRepo)) out.push('ECS: GitHub repository looks like owner/name.');
  return out;
}

export function ecsWarnings(c: ContainerConfig): string[] {
  const e = c.ecs;
  if (!e.enabled) return [];
  const w: string[] = [];
  if (e.certificateArn === '') w.push('ECS: the load balancer serves plain HTTP. Add an ACM certificate ARN to serve HTTPS and redirect HTTP to it.');
  if (e.allowedCidr === '0.0.0.0/0') w.push('ECS: the load balancer is open to the whole internet. Narrow "who can connect" if the app is not public.');
  if (c.postgres || c.redis) w.push('ECS: PostgreSQL and Redis are not started. Use RDS / ElastiCache and put the connection settings in the environment variables.');
  if (e.imageTag === 'latest') w.push('ECS: the "latest" tag is used. A version tag (for example the commit id) makes it clear what is running and allows a rollback.');
  if (c.env.some((v) => v.secret)) w.push(`ECS: create each secret in SSM Parameter Store as a SecureString named /${c.appName}/<NAME> before the service can start (deploy.sh asks for them).`);
  return w;
}

// ─── cost ────────────────────────────────────────────────────────────────────

const HOURS = 730;
const FARGATE_VCPU_HOUR = 0.04048;
const FARGATE_GB_HOUR = 0.004445;
const ALB_HOUR = 0.0225;
const ALB_LCU_HOUR = 0.008;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** List-price estimate (us-east-1, Linux/x86) of the tasks, the load balancer and their public IPs. Undefined when ECS is off. */
export function estimateEcsCost(c: ContainerConfig): DeployCost | undefined {
  const e = c.ecs;
  if (!e.enabled) return undefined;
  const tasks = e.autoscaling ? e.minCount : e.desiredCount;
  const per = (e.cpu / 1024) * FARGATE_VCPU_HOUR + (e.memoryMb / 1024) * FARGATE_GB_HOUR;
  const lines = [
    { label: `${tasks} Fargate task${tasks === 1 ? '' : 's'} (${e.cpu / 1024} vCPU, ${e.memoryMb / 1024} GB)`, monthlyUsd: round2(per * HOURS * tasks) },
    { label: 'Application Load Balancer', monthlyUsd: round2((ALB_HOUR + ALB_LCU_HOUR) * HOURS) },
    { label: `Public IPv4 addresses (${tasks} task${tasks === 1 ? '' : 's'} + 2 for the load balancer)`, monthlyUsd: round2(0.005 * HOURS * (tasks + 2)) },
    { label: 'CloudWatch Logs (1 GB)', monthlyUsd: 0.5 },
  ];
  const notes = ['Excludes data transfer out, ECR storage (about $0.10 per GB-month) and load balancer traffic beyond the minimum.'];
  if (e.autoscaling) notes.push(`Priced at the minimum of ${e.minCount} tasks; every extra task adds ${round2(per * HOURS)} a month while it runs.`);
  if (e.region !== 'us-east-1') notes.push(`Priced for us-east-1; ${e.region} is usually a little higher.`);
  return { monthlyUsd: round2(lines.reduce((t, l) => t + l.monthlyUsd, 0)), lines, notes };
}

// ─── Terraform ───────────────────────────────────────────────────────────────

/** A Terraform string literal: JSON escaping, plus no interpolation or directive can start inside it. */
const hcl = (s: string) => JSON.stringify(s).replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');

function mainTf(c: ContainerConfig): string {
  const plain = c.env.filter((v) => !v.secret);
  const secrets = secretNames(c);
  const https = c.ecs.certificateArn !== '';
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
  secret_arns = {
${secrets.map((k) => `    ${k} = "arn:aws:ssm:\${var.region}:\${data.aws_caller_identity.current.account_id}:parameter/\${var.app_name}/${k}"`).join('\n')}
  }
}

# ── Image registry ──────────────────────────────────────────────────────────

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

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/\${var.app_name}"
  retention_in_days = 30
  tags              = local.tags
}

# ── Roles: ECS starts the task with the execution role; the task itself has none ─

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
    sid       = "ReadThisAppsSecrets"
    actions   = ["ssm:GetParameters", "ssm:GetParameter"]
    resources = ["arn:aws:ssm:\${var.region}:\${data.aws_caller_identity.current.account_id}:parameter/\${var.app_name}/*"]
  }
}

resource "aws_iam_role_policy" "secrets" {
  name   = "\${var.app_name}-read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.secrets.json
}

# The app's own identity. It has no permissions: give it only what your code needs.
resource "aws_iam_role" "task" {
  name               = "\${var.app_name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.tasks_assume.json
  tags               = local.tags
}

# ── Network access: internet -> load balancer -> tasks ────────────────────────

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
    description = "To the tasks"
    from_port   = var.app_port
    to_port     = var.app_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

resource "aws_security_group" "task" {
  name        = "\${var.app_name}-task"
  description = "Tasks of \${var.app_name}: only the load balancer can reach them"
  vpc_id      = local.vpc_id

  ingress {
    description     = "From the load balancer"
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Outbound is open so tasks can pull the image, read their secrets and call other services.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

# ── Load balancer ────────────────────────────────────────────────────────────

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
  port        = var.app_port
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"

  health_check {
    path                = var.health_path
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
# ── Cluster, task definition and service ─────────────────────────────────────

resource "aws_ecs_cluster" "app" {
  name = var.app_name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = local.tags
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.app_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory_mb
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = var.app_name
    image     = "\${aws_ecr_repository.app.repository_url}:\${var.image_tag}"
    essential = true
    portMappings = [{
      containerPort = var.app_port
      protocol      = "tcp"
    }]
    environment = [
${plain.map((v) => `      { name = ${hcl(v.key)}, value = ${hcl(v.value)} },`).join('\n')}
    ]
    secrets = [for name, arn in local.secret_arns : { name = name, valueFrom = arn }]
    linuxParameters = {
      initProcessEnabled = true
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "app"
      }
    }
  }])

  tags = local.tags
}

resource "aws_ecs_service" "app" {
  name            = var.app_name
  cluster         = aws_ecs_cluster.app.id
  task_definition = aws_ecs_task_definition.app.arn
  launch_type     = "FARGATE"
  desired_count   = var.desired_count

  health_check_grace_period_seconds = 60

  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true # the default VPC has no NAT; set vpc_id / subnet_ids to private subnets with a NAT to turn this off
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = var.app_name
    container_port   = var.app_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.${c.ecs.certificateArn ? 'https' : 'http'}]
${c.ecs.autoscaling ? `
  lifecycle {
    ignore_changes = [desired_count]
  }
` : ''}
  tags = local.tags
}
${c.ecs.autoscaling ? `
resource "aws_appautoscaling_target" "app" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/\${aws_ecs_cluster.app.name}/\${aws_ecs_service.app.name}"
  min_capacity       = var.min_count
  max_capacity       = var.max_count
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "\${var.app_name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.app.service_namespace
  scalable_dimension = aws_appautoscaling_target.app.scalable_dimension
  resource_id        = aws_appautoscaling_target.app.resource_id

  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
` : ''}`;
}

function variablesTf(c: ContainerConfig): string {
  const e = c.ecs;
  return `variable "region" {
  description = "AWS Region to deploy to."
  type        = string
  default     = ${hcl(e.region)}
}

variable "app_name" {
  description = "Name used for the repository, cluster, service and secret path."
  type        = string
  default     = ${hcl(c.appName)}
}

variable "app_port" {
  description = "Port the container listens on."
  type        = number
  default     = ${c.port}
}

variable "health_path" {
  description = "Path the load balancer calls to check the app is healthy."
  type        = string
  default     = ${hcl(c.healthPath)}
}

variable "image_tag" {
  description = "Image tag to run. deploy.sh sets it."
  type        = string
  default     = ${hcl(e.imageTag)}
}

variable "cpu" {
  description = "Fargate CPU units (256, 512, 1024, 2048, 4096)."
  type        = number
  default     = ${e.cpu}
}

variable "memory_mb" {
  description = "Task memory in MB (must be valid for the CPU)."
  type        = number
  default     = ${e.memoryMb}
}

variable "desired_count" {
  description = "Number of tasks to run."
  type        = number
  default     = ${e.desiredCount}
}
${e.autoscaling ? `
variable "min_count" {
  type    = number
  default = ${e.minCount}
}

variable "max_count" {
  type    = number
  default = ${e.maxCount}
}
` : ''}
variable "allowed_cidr" {
  description = "Who can reach the load balancer (IPv4 range)."
  type        = string
  default     = ${hcl(e.allowedCidr)}
}
${e.certificateArn ? `
variable "certificate_arn" {
  description = "ACM certificate for HTTPS."
  type        = string
  default     = ${hcl(e.certificateArn)}
}
` : ''}
variable "vpc_id" {
  description = "Leave empty to use the default VPC."
  type        = string
  default     = ""
}

variable "subnet_ids" {
  description = "Leave empty to use every subnet of the VPC. Give at least two, in different availability zones."
  type        = list(string)
  default     = []
}
${e.githubRepo ? `
variable "github_repository" {
  description = "GitHub repository (owner/name) allowed to push images and deploy."
  type        = string
  default     = ${hcl(e.githubRepo)}
}

variable "create_github_oidc_provider" {
  description = "An AWS account can have only one GitHub identity provider. Set to false if yours already exists."
  type        = bool
  default     = true
}
` : ''}`;
}

function outputsTf(c: ContainerConfig): string {
  const scheme = c.ecs.certificateArn ? 'https' : 'http';
  return `output "ecr_repository_url" {
  description = "Push the image here."
  value       = aws_ecr_repository.app.repository_url
}

output "cluster_name" {
  value = aws_ecs_cluster.app.name
}

output "service_name" {
  value = aws_ecs_service.app.name
}

output "app_url" {
  value = "${scheme}://\${aws_lb.app.dns_name}${c.healthPath}"
}

output "logs" {
  description = "Follow the application logs."
  value       = "aws logs tail \${aws_cloudwatch_log_group.app.name} --follow --region \${var.region}"
}
${c.ecs.githubRepo ? `
output "github_role_arn" {
  description = "Save this in GitHub as the secret AWS_ROLE_TO_ARN."
  value       = aws_iam_role.github.arn
}
` : ''}`;
}

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
    sid       = "DeployThisService"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = [aws_ecs_service.app.id]
  }
}

resource "aws_iam_role_policy" "github" {
  name   = "\${var.app_name}-github-deploy"
  role   = aws_iam_role.github.id
  policy = data.aws_iam_policy_document.github.json
}
`;
}

// ─── GitHub Actions ──────────────────────────────────────────────────────────

function workflowYml(c: ContainerConfig): string {
  return `# Builds the image, scans it, pushes it to ECR and rolls the ECS service to it.
# One-time setup in the GitHub repository (Settings, Secrets and variables, Actions):
${c.ecs.githubRepo
    ? `#   secret   AWS_ROLE_TO_ARN   run: terraform -chdir=ecs output -raw github_role_arn
#   variable ECS_CLUSTER       run: terraform -chdir=ecs output -raw cluster_name   (optional: leave unset to skip the rollout step)`
    : `#   secret   AWS_ROLE_TO_ARN   an IAM role GitHub can assume (OIDC) with ECR push access and ecs:UpdateService.
#                              Tip: set "GitHub repository" in Container Templates and Terraform creates this role for you.
#   variable ECS_CLUSTER       the cluster_name Terraform printed (optional: leave unset to skip the rollout step)`}
name: deploy-${c.appName}

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

env:
  AWS_REGION: ${c.ecs.region}
  ECR_REPOSITORY: ${c.appName}
  ECS_SERVICE: ${c.appName}

jobs:
  build-and-deploy:
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
          docker build --platform linux/amd64 -t "$REGISTRY/$ECR_REPOSITORY:\${{ github.sha }}" -t "$REGISTRY/$ECR_REPOSITORY:${c.ecs.imageTag}" .
${c.ecs.scanImage ? `
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

      - name: Roll the service to the new image
        if: \${{ vars.ECS_CLUSTER != '' }}
        run: |
          aws ecs update-service --cluster "\${{ vars.ECS_CLUSTER }}" --service "$ECS_SERVICE" --force-new-deployment >/dev/null
          aws ecs wait services-stable --cluster "\${{ vars.ECS_CLUSTER }}" --services "$ECS_SERVICE"
`;
}

// ─── one-command scripts ─────────────────────────────────────────────────────

function deploySh(c: ContainerConfig): string {
  const secrets = secretNames(c);
  return `#!/usr/bin/env bash
# One command to deploy ${c.appName} to AWS ECS Fargate: bash deploy.sh
#   1. creates the image repository with Terraform (first run)
#   2. stores any secret values in AWS (asks once, hidden), never in a file
#   3. builds the image for Fargate's CPU type and pushes it
#   4. creates or updates the cluster, load balancer and service, then waits until the app answers
# Run it again to release a new version (IMAGE_TAG=v2 bash deploy.sh uses another tag). Add --yes to skip the Terraform confirmation.
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(c.appName)}
REGION=${q(c.ecs.region)}
TAG="\${IMAGE_TAG:-${c.ecs.imageTag}}"
SECRETS=(${secrets.map(q).join(' ')})
APPROVE=""
[ "\${1:-}" = "--yes" ] && APPROVE="-auto-approve"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing tool: $1. $2"; exit 1; }; }
need terraform "Install it from https://developer.hashicorp.com/terraform/install"
need aws       "Install the AWS CLI from https://aws.amazon.com/cli/"
need docker    "Install Docker Desktop from https://www.docker.com/products/docker-desktop"
aws sts get-caller-identity >/dev/null 2>&1 || { echo "You are not signed in to AWS. Run: aws configure (or aws sso login)"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and try again."; exit 1; }

echo "==> 1/4  Image repository (Terraform)"
terraform -chdir=ecs init -input=false >/dev/null
terraform -chdir=ecs apply -target=aws_ecr_repository.app -var "image_tag=$TAG" \${APPROVE:+-auto-approve}

echo "==> 2/4  Secrets"
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

echo "==> 3/4  Build and push the image"
REPO=$(terraform -chdir=ecs output -raw ecr_repository_url)
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "\${REPO%%/*}"
# Fargate runs x86_64 here. Building for it explicitly makes this work from Apple Silicon Macs too.
docker build --platform linux/amd64 -t "$REPO:$TAG" .
docker push "$REPO:$TAG"

echo "==> 4/4  Cluster, load balancer and service (Terraform)"
terraform -chdir=ecs apply -var "image_tag=$TAG" \${APPROVE:+-auto-approve}
CLUSTER=$(terraform -chdir=ecs output -raw cluster_name)
SERVICE=$(terraform -chdir=ecs output -raw service_name)
# An unchanged task definition (same tag, new image) still needs a push to the tasks.
aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment >/dev/null

URL=$(terraform -chdir=ecs output -raw app_url)
WAIT="\${DEPLOY_WAIT_SECONDS:-600}"
END=$((SECONDS + WAIT))
echo "    Waiting for $URL ..."
UP=""
while [ "$SECONDS" -lt "$END" ]; do
  if curl -fsS -k -m 5 -o /dev/null "$URL" >/dev/null 2>&1; then UP=yes; break; fi
  sleep 10
done
if [ -n "$UP" ]; then
  echo "Done. ${c.appName} is running at $URL"
else
  echo "Not answering yet. A new service can take several minutes. Check again, or read the logs:"
  echo "  $(terraform -chdir=ecs output -raw logs)"
fi
`;
}

function destroySh(c: ContainerConfig): string {
  const secrets = secretNames(c);
  return `#!/usr/bin/env bash
# Removes everything deploy.sh created (service, load balancer, image repository with its images, roles): bash destroy.sh
set -euo pipefail
cd "$(dirname "$0")"

APP=${q(c.appName)}
REGION=${q(c.ecs.region)}
SECRETS=(${secrets.map(q).join(' ')})

command -v terraform >/dev/null 2>&1 || { echo "Missing tool: terraform"; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "Missing tool: aws"; exit 1; }

echo "This permanently deletes the service, the load balancer and the image repository of $APP."
read -r -p "Type the app name ($APP) to continue: " ANSWER
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

function readme(c: ContainerConfig): string {
  const e = c.ecs;
  const secrets = secretNames(c);
  return `# Deploy ${c.appName} to AWS ECS Fargate

## Quick start

You need Terraform, the AWS CLI and Docker installed, and to be signed in to AWS (\`aws configure\` or \`aws sso login\`). Then, from
the folder that contains your app and these files:

\`\`\`bash
bash deploy.sh
\`\`\`

It creates the image repository, ${secrets.length ? 'asks for your secret values (hidden), ' : ''}builds and pushes your image, creates the cluster, load balancer and service, and prints
the address. To release a new version run it again (\`IMAGE_TAG=v2 bash deploy.sh\` to use another tag). To remove everything:

\`\`\`bash
bash destroy.sh
\`\`\`

## What gets created

- An ECR repository, an ECS cluster and a Fargate service running ${e.autoscaling ? `${e.minCount} to ${e.maxCount}` : e.desiredCount} task${e.desiredCount === 1 && !e.autoscaling ? '' : 's'} (${e.cpu / 1024} vCPU, ${e.memoryMb / 1024} GB each).
- An Application Load Balancer that accepts ${e.certificateArn ? 'HTTPS (HTTP is redirected)' : 'HTTP'} from \`${e.allowedCidr}\` and sends it to the tasks. Tasks accept traffic only from the load balancer.
- A role that lets ECS pull the image and read \`/${c.appName}/*\` in SSM Parameter Store, and an empty role for the app itself.
- A failed deployment rolls back by itself (deployment circuit breaker). Logs go to CloudWatch (\`/ecs/${c.appName}\`, 30 days).
${e.autoscaling ? `- Autoscaling keeps average CPU near 60% between ${e.minCount} and ${e.maxCount} tasks.\n` : ''}${secrets.length ? `- Secrets (${secrets.join(', ')}) live in SSM Parameter Store as \`/${c.appName}/<NAME>\`. They are never written to Terraform, its state or any file.\n` : ''}
## Logs and status

\`\`\`bash
aws logs tail /ecs/${c.appName} --follow --region ${e.region}
aws ecs describe-services --region ${e.region} --cluster ${c.appName} --services ${c.appName}
\`\`\`

## Common problems

- **Tasks keep stopping**: read the logs. A missing secret in SSM ("ResourceInitializationError") is the usual cause; run \`bash deploy.sh\` again to be asked for it.
- **503 from the load balancer**: the health check path (\`${c.healthPath}\`) must return a 2xx or 3xx on port ${c.port}. New tasks get 60 seconds to start.
- **"exec format error"**: the image was built for the wrong CPU type. \`deploy.sh\` builds for x86_64; if you push another way, add \`--platform linux/amd64\`.
- **Cannot reach the address**: the load balancer accepts traffic only from \`${e.allowedCidr}\`.
${e.githubActions ? `
## Optional: deploy automatically when you push to GitHub

\`.github/workflows/deploy.yml\` builds, scans and pushes the image on every push to \`main\` and rolls the service to it.
${e.githubRepo ? `
Terraform already created the AWS role it signs in with. In GitHub (Settings, then Secrets and variables, then Actions):

1. Add a **secret** named \`AWS_ROLE_TO_ARN\`: \`terraform -chdir=ecs output -raw github_role_arn\`
2. Add a **variable** named \`ECS_CLUSTER\`: \`terraform -chdir=ecs output -raw cluster_name\` (makes it roll the service after each push)

If your account already has a GitHub identity provider, set \`create_github_oidc_provider\` to \`false\` in \`ecs/variables.tf\` first.
` : `
It needs an AWS role GitHub can sign in with. Enter your repository as owner/name in Container Templates ("GitHub repository") and generate again to have Terraform create it.
`}` : ''}
## What to know

- The default VPC has no NAT gateway, so tasks get public IPs to pull images. They still accept traffic only from the load balancer.
- Terraform keeps its record in \`ecs/terraform.tfstate\`. Keep that folder; \`bash destroy.sh\` needs it.
- Costs: Fargate tasks, the load balancer and the public IPv4 addresses bill every hour.
`;
}

export function generateEcsFiles(c: ContainerConfig): Array<{ path: string; content: string; executable?: boolean }> {
  if (!c.ecs.enabled) return [];
  return [
    { path: 'deploy.sh', content: deploySh(c), executable: true },
    { path: 'destroy.sh', content: destroySh(c), executable: true },
    { path: 'ecs/main.tf', content: mainTf(c) },
    { path: 'ecs/variables.tf', content: variablesTf(c) },
    { path: 'ecs/outputs.tf', content: outputsTf(c) },
    ...(c.ecs.githubRepo ? [{ path: 'ecs/github_oidc.tf', content: githubOidcTf() }] : []),
    { path: 'ecs/.gitignore', content: '.terraform/\n*.tfstate\n*.tfstate.*\ncrash.log\n' },
    { path: 'ecs/README.md', content: readme(c) },
    ...(c.ecs.githubActions ? [{ path: '.github/workflows/deploy.yml', content: workflowYml(c) }] : []),
  ];
}
