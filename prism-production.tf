################################################################################
# PRISM — AWS Production Architecture + Osaka DR (Terraform HCL)
# Primary Region: ap-south-1 (Mumbai)
# DR Region:      ap-northeast-3 (Osaka)
################################################################################

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
  }
}

# --- Providers ---
provider "aws" {
  region = "ap-south-1" # Mumbai Primary Region
}

provider "aws" {
  alias  = "osaka"
  region = "ap-northeast-3" # Osaka DR Region
}

# --- KMS Encryption Keys ---
resource "aws_kms_key" "primary" {
  description             = "PRISM KMS Key for RDS, S3, and EBS encryption (ap-south-1)"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name        = "prism-primary-kms-key"
    Environment = "production"
  }
}

resource "aws_kms_key" "dr" {
  provider                = aws.osaka
  description             = "PRISM KMS Key for Osaka DR replication (ap-northeast-3)"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name        = "prism-dr-kms-key"
    Environment = "production-dr"
  }
}

# ==============================================================================
# S3 REGIONAL STORAGE (ap-south-1)
# ==============================================================================

# 1. Frontend Bucket — Static site
resource "aws_s3_bucket" "frontend" {
  bucket_prefix = "prism-frontend-static-"
  force_destroy = false

  tags = {
    Name        = "Amazon S3 — Frontend Bucket"
    Purpose     = "Static site hosting"
    Environment = "production"
  }
}

resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.primary.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

# 2. Uploads Bucket — User files
resource "aws_s3_bucket" "uploads" {
  bucket_prefix = "prism-user-uploads-"

  tags = {
    Name        = "Amazon S3 — Uploads Bucket"
    Purpose     = "User files"
    Environment = "production"
  }
}

resource "aws_s3_bucket_versioning" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.primary.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

# 3. Config Snapshots Bucket
resource "aws_s3_bucket" "config" {
  bucket_prefix = "prism-aws-config-snapshots-"

  tags = {
    Name        = "Amazon S3 — Config Bucket"
    Purpose     = "AWS Config snapshots"
    Environment = "production"
  }
}

resource "aws_s3_bucket_versioning" "config" {
  bucket = aws_s3_bucket.config.id
  versioning_configuration {
    status = "Enabled"
  }
}

# 4. CloudTrail Audit Logs Bucket
resource "aws_s3_bucket" "cloudtrail" {
  bucket_prefix = "prism-cloudtrail-audit-logs-"

  tags = {
    Name        = "Amazon S3 — CloudTrail Logs Bucket"
    Purpose     = "API activity audit trail"
    Environment = "production"
  }
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  versioning_configuration {
    status = "Enabled"
  }
}

# ==============================================================================
# S3 DISASTER RECOVERY (ap-northeast-3 Osaka — CRR)
# ==============================================================================

# Osaka DR Replica: Frontend
resource "aws_s3_bucket" "frontend_crr" {
  provider      = aws.osaka
  bucket_prefix = "prism-frontend-crr-osaka-"

  tags = {
    Name        = "Amazon S3 — Frontend CRR copy (Osaka)"
    Region      = "ap-northeast-3"
    Environment = "production-dr"
  }
}

resource "aws_s3_bucket_versioning" "frontend_crr" {
  provider = aws.osaka
  bucket   = aws_s3_bucket.frontend_crr.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Osaka DR Replica: Uploads
resource "aws_s3_bucket" "uploads_crr" {
  provider      = aws.osaka
  bucket_prefix = "prism-uploads-crr-osaka-"

  tags = {
    Name        = "Amazon S3 — Uploads CRR copy (Osaka)"
    Region      = "ap-northeast-3"
    Environment = "production-dr"
  }
}

resource "aws_s3_bucket_versioning" "uploads_crr" {
  provider = aws.osaka
  bucket   = aws_s3_bucket.uploads_crr.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Osaka DR Replica: CloudTrail
resource "aws_s3_bucket" "cloudtrail_crr" {
  provider      = aws.osaka
  bucket_prefix = "prism-cloudtrail-crr-osaka-"

  tags = {
    Name        = "Amazon S3 — CloudTrail Logs CRR copy (Osaka)"
    Region      = "ap-northeast-3"
    Environment = "production-dr"
  }
}

resource "aws_s3_bucket_versioning" "cloudtrail_crr" {
  provider = aws.osaka
  bucket   = aws_s3_bucket.cloudtrail_crr.id
  versioning_configuration {
    status = "Enabled"
  }
}

# IAM Role for S3 Cross-Region Replication (CRR)
resource "aws_iam_role" "replication" {
  name = "prism-s3-cross-region-replication-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "s3.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_policy" "replication" {
  name = "prism-s3-replication-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
        Effect   = "Allow"
        Resource = [aws_s3_bucket.frontend.arn, aws_s3_bucket.uploads.arn, aws_s3_bucket.cloudtrail.arn]
      },
      {
        Action = [
          "s3:GetObjectVersionForReplication",
          "s3:GetObjectVersionAcl",
          "s3:GetObjectVersionTagging"
        ]
        Effect = "Allow"
        Resource = [
          "${aws_s3_bucket.frontend.arn}/*",
          "${aws_s3_bucket.uploads.arn}/*",
          "${aws_s3_bucket.cloudtrail.arn}/*"
        ]
      },
      {
        Action = [
          "s3:ReplicateObject",
          "s3:ReplicateDelete",
          "s3:ReplicateTags"
        ]
        Effect = "Allow"
        Resource = [
          "${aws_s3_bucket.frontend_crr.arn}/*",
          "${aws_s3_bucket.uploads_crr.arn}/*",
          "${aws_s3_bucket.cloudtrail_crr.arn}/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "replication" {
  role       = aws_iam_role.replication.name
  policy_arn = aws_iam_policy.replication.arn
}

resource "aws_s3_bucket_replication_configuration" "frontend_replication" {
  depends_on = [aws_s3_bucket_versioning.frontend]
  role       = aws_iam_role.replication.arn
  bucket     = aws_s3_bucket.frontend.id

  rule {
    id     = "frontend-crr-to-osaka"
    status = "Enabled"

    destination {
      bucket        = aws_s3_bucket.frontend_crr.arn
      storage_class = "STANDARD_IA"
    }
  }
}

resource "aws_s3_bucket_replication_configuration" "uploads_replication" {
  depends_on = [aws_s3_bucket_versioning.uploads]
  role       = aws_iam_role.replication.arn
  bucket     = aws_s3_bucket.uploads.id

  rule {
    id     = "uploads-crr-to-osaka"
    status = "Enabled"

    destination {
      bucket        = aws_s3_bucket.uploads_crr.arn
      storage_class = "STANDARD_IA"
    }
  }
}

resource "aws_s3_bucket_replication_configuration" "cloudtrail_replication" {
  depends_on = [aws_s3_bucket_versioning.cloudtrail]
  role       = aws_iam_role.replication.arn
  bucket     = aws_s3_bucket.cloudtrail.id

  rule {
    id     = "cloudtrail-crr-to-osaka"
    status = "Enabled"

    destination {
      bucket        = aws_s3_bucket.cloudtrail_crr.arn
      storage_class = "GLACIER"
    }
  }
}

# ==============================================================================
# LOGGING SERVICES
# ==============================================================================

# AWS CloudTrail
resource "aws_cloudtrail" "main" {
  name                          = "prism-production-cloudtrail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true

  tags = {
    Name        = "AWS CloudTrail"
    Description = "API activity logging"
  }
}

# AWS Config Recorder
resource "aws_iam_role" "config_role" {
  name = "prism-aws-config-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "config.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "config_policy" {
  role       = aws_iam_role.config_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"
}

resource "aws_config_configuration_recorder" "main" {
  name     = "prism-compliance-recorder"
  role_arn = aws_iam_role.config_role.arn

  recording_group {
    all_supported                 = true
    include_global_resource_types = true
  }
}

resource "aws_config_delivery_channel" "main" {
  name           = "prism-config-delivery-channel"
  s3_bucket_name = aws_s3_bucket.config.id
  depends_on     = [aws_config_configuration_recorder.main]
}

# ==============================================================================
# EDGE LAYER (Global CDN & WAF)
# ==============================================================================

# WAF / Layer 7 Protection
resource "aws_wafv2_web_acl" "waf" {
  name        = "prism-cloudflare-waf"
  description = "WAF / L7 protection for ALB and static ingress"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "prismWafMetrics"
    sampled_requests_enabled   = true
  }
}

# BigRock / CloudFront CDN
resource "aws_cloudfront_distribution" "cdn" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "BigRock CDN — Global Edge distribution"
  default_root_object = "index.html"

  origin {
    domain_name = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id   = "S3-frontend-origin"
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-frontend-origin"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Name        = "BigRock CDN"
    Description = "Edge distribution"
  }
}

# ==============================================================================
# VPC 10.0.0.0/16 (ap-south-1)
# ==============================================================================

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "VPC 10.0.0.0/16 (ap-south-1)"
  }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "Internet Gateway"
  }
}

# Public Subnets (AZ-1 & AZ-2)
resource "aws_subnet" "pub1" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "ap-south-1a"
  map_public_ip_on_launch = true

  tags = {
    Name = "Public Subnet AZ-1"
  }
}

resource "aws_subnet" "pub2" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.2.0/24"
  availability_zone       = "ap-south-1b"
  map_public_ip_on_launch = true

  tags = {
    Name = "Public Subnet AZ-2"
  }
}

# Private Subnets (AZ-1 & AZ-2)
resource "aws_subnet" "priv1" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.10.0/24"
  availability_zone = "ap-south-1a"

  tags = {
    Name = "Private Subnet AZ-1"
  }
}

resource "aws_subnet" "priv2" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.20.0/24"
  availability_zone = "ap-south-1b"

  tags = {
    Name = "Private Subnet AZ-2"
  }
}

# Database Subnets (AZ-1 & AZ-2)
resource "aws_subnet" "db1" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.30.0/24"
  availability_zone = "ap-south-1a"

  tags = {
    Name = "Database Subnet AZ-1"
  }
}

resource "aws_subnet" "db2" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.31.0/24"
  availability_zone = "ap-south-1b"

  tags = {
    Name = "Database Subnet AZ-2"
  }
}

resource "aws_db_subnet_group" "db_group" {
  name       = "prism-database-subnet-group"
  subnet_ids = [aws_subnet.db1.id, aws_subnet.db2.id]

  tags = {
    Name = "Database Subnet Group"
  }
}

# NAT Gateways
resource "aws_eip" "nat1" {
  domain = "vpc"
}

resource "aws_nat_gateway" "nat1" {
  allocation_id = aws_eip.nat1.id
  subnet_id     = aws_subnet.pub1.id

  tags = {
    Name = "NAT Gateway AZ-1"
  }
}

resource "aws_eip" "nat2" {
  domain = "vpc"
}

resource "aws_nat_gateway" "nat2" {
  allocation_id = aws_eip.nat2.id
  subnet_id     = aws_subnet.pub2.id

  tags = {
    Name = "NAT Gateway AZ-2"
  }
}

# Route Tables
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }

  tags = {
    Name = "Public Route Table"
  }
}

resource "aws_route_table_association" "pub1" {
  subnet_id      = aws_subnet.pub1.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "pub2" {
  subnet_id      = aws_subnet.pub2.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "priv1" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat1.id
  }

  tags = {
    Name = "Private Route Table AZ-1"
  }
}

resource "aws_route_table_association" "priv1" {
  subnet_id      = aws_subnet.priv1.id
  route_table_id = aws_route_table.priv1.id
}

resource "aws_route_table" "priv2" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat2.id
  }

  tags = {
    Name = "Private Route Table AZ-2"
  }
}

resource "aws_route_table_association" "priv2" {
  subnet_id      = aws_subnet.priv2.id
  route_table_id = aws_route_table.priv2.id
}

# ==============================================================================
# SECURITY GROUPS
# ==============================================================================

resource "aws_security_group" "alb_sg" {
  name        = "prism-alb-security-group"
  description = "Inbound HTTPS/HTTP from Internet & Cloudflare"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "ec2_sg" {
  name        = "prism-ec2-backend-sg"
  description = "Backend EC2 instances security group"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb_sg.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "db_sg" {
  name        = "prism-database-sg"
  description = "PostgreSQL DB access from EC2"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ec2_sg.id]
  }
}

# ==============================================================================
# COMPUTE & LOAD BALANCING
# ==============================================================================

# Application Load Balancer
resource "aws_lb" "alb" {
  name               = "prism-alb-public"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb_sg.id]
  subnets            = [aws_subnet.pub1.id, aws_subnet.pub2.id]

  tags = {
    Name = "Elastic Load Balancing"
  }
}

resource "aws_lb_target_group" "backend" {
  name     = "prism-backend-tg"
  port     = 8080
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id

  health_check {
    path = "/healthz"
    port = "8080"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.alb.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
}

# EC2 Backend API AZ-1 + Encrypted EBS
resource "aws_instance" "ec2_az1" {
  ami                  = "ami-0dee22c13ea7a9a67" # Amazon Linux 2023 in ap-south-1
  instance_type        = "t3.medium"
  subnet_id            = aws_subnet.priv1.id
  vpc_security_group_ids = [aws_security_group.ec2_sg.id]
  iam_instance_profile = aws_iam_instance_profile.ec2_profile.name

  tags = {
    Name        = "Amazon EC2 — Backend API AZ-1"
    Environment = "production"
  }
}

resource "aws_ebs_volume" "ebs_az1" {
  availability_zone = "ap-south-1a"
  size              = 100
  encrypted         = true
  kms_key_id        = aws_kms_key.primary.arn

  tags = {
    Name = "Amazon EBS — Encrypted volume AZ-1"
  }
}

resource "aws_volume_attachment" "att_az1" {
  device_name = "/dev/xvdf"
  volume_id   = aws_ebs_volume.ebs_az1.id
  instance_id = aws_instance.ec2_az1.id
}

# EC2 Backend API AZ-2 + Encrypted EBS
resource "aws_instance" "ec2_az2" {
  ami                  = "ami-0dee22c13ea7a9a67"
  instance_type        = "t3.medium"
  subnet_id            = aws_subnet.priv2.id
  vpc_security_group_ids = [aws_security_group.ec2_sg.id]
  iam_instance_profile = aws_iam_instance_profile.ec2_profile.name

  tags = {
    Name        = "Amazon EC2 — Backend API AZ-2"
    Environment = "production"
  }
}

resource "aws_ebs_volume" "ebs_az2" {
  availability_zone = "ap-south-1b"
  size              = 100
  encrypted         = true
  kms_key_id        = aws_kms_key.primary.arn

  tags = {
    Name = "Amazon EBS — Encrypted volume AZ-2"
  }
}

resource "aws_volume_attachment" "att_az2" {
  device_name = "/dev/xvdf"
  volume_id   = aws_ebs_volume.ebs_az2.id
  instance_id = aws_instance.ec2_az2.id
}

resource "aws_lb_target_group_attachment" "ec2a" {
  target_group_arn = aws_lb_target_group.backend.arn
  target_id        = aws_instance.ec2_az1.id
  port             = 8080
}

resource "aws_lb_target_group_attachment" "ec2b" {
  target_group_arn = aws_lb_target_group.backend.arn
  target_id        = aws_instance.ec2_az2.id
  port             = 8080
}

# ==============================================================================
# DATABASE (Amazon RDS PostgreSQL Primary, Multi-AZ Standby & Read Replica)
# ==============================================================================

# PostgreSQL Primary (Multi-AZ with Standby in AZ-2)
resource "aws_db_instance" "rdsp" {
  identifier             = "prism-postgres-primary"
  engine                 = "postgres"
  engine_version         = "15.4"
  instance_class         = "db.r6g.large"
  allocated_storage      = 100
  multi_az               = true # Automatically deploys PostgreSQL Standby in AZ-2
  db_subnet_group_name   = aws_db_subnet_group.db_group.name
  vpc_security_group_ids = [aws_security_group.db_sg.id]
  kms_key_id             = aws_kms_key.primary.arn
  storage_encrypted      = true
  monitoring_interval    = 60
  monitoring_role_arn    = aws_iam_role.rds_monitoring_role.arn
  username               = "prism_admin"
  password               = "PrismSecurePassword2026!"
  skip_final_snapshot    = true

  tags = {
    Name = "Amazon RDS — PostgreSQL Primary (+ Standby Multi-AZ)"
  }
}

# PostgreSQL Read Replica (Cross-AZ Read Offload)
resource "aws_db_instance" "rdsr" {
  identifier             = "prism-postgres-read-replica"
  replicate_source_db    = aws_db_instance.rdsp.identifier
  instance_class         = "db.r6g.large"
  vpc_security_group_ids = [aws_security_group.db_sg.id]
  kms_key_id             = aws_kms_key.primary.arn
  storage_encrypted      = true
  monitoring_interval    = 60
  monitoring_role_arn    = aws_iam_role.rds_monitoring_role.arn
  skip_final_snapshot    = true

  tags = {
    Name = "Amazon RDS — Read Replica"
  }
}

# ==============================================================================
# AI, SECURITY, OBSERVABILITY & GOVERNANCE
# ==============================================================================

# AWS Secrets Manager
resource "aws_secretsmanager_secret" "credentials" {
  name        = "prism-db-api-credentials"
  kms_key_id  = aws_kms_key.primary.arn
  description = "Database and internal API credentials"

  tags = {
    Name = "AWS Secrets Manager"
  }
}

# AWS IAM EC2 Instance Role
resource "aws_iam_role" "ec2_role" {
  name = "prism-ec2-backend-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_policy" "backend_permissions" {
  name = "prism-backend-service-access"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AllowBedrockInference"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Effect   = "Allow"
        Resource = "*"
      },
      {
        Sid      = "AllowSecretsManagerRead"
        Action   = ["secretsmanager:GetSecretValue"]
        Effect   = "Allow"
        Resource = [aws_secretsmanager_secret.credentials.arn]
      },
      {
        Sid      = "AllowKMSDecrypt"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Effect   = "Allow"
        Resource = [aws_kms_key.primary.arn]
      },
      {
        Sid      = "AllowCloudWatchLogs"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Effect   = "Allow"
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ec2_policy_attach" {
  role       = aws_iam_role.ec2_role.name
  policy_arn = aws_iam_policy.backend_permissions.arn
}

resource "aws_iam_instance_profile" "ec2_profile" {
  name = "prism-ec2-instance-profile"
  role = aws_iam_role.ec2_role.name
}

# AWS IAM RDS Enhanced Monitoring Role
resource "aws_iam_role" "rds_monitoring_role" {
  name = "prism-rds-enhanced-monitoring-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "monitoring.rds.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring_policy" {
  role       = aws_iam_role.rds_monitoring_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# Amazon GuardDuty
resource "aws_guardduty_detector" "main" {
  enable = true

  tags = {
    Name = "Amazon GuardDuty"
  }
}

# AWS Security Hub
resource "aws_securityhub_account" "main" {
  enable_default_standards = true
}

# Amazon SNS Operations Notifications
resource "aws_sns_topic" "ops_alerts" {
  name = "prism-ops-notifications"

  tags = {
    Name = "Amazon SNS"
  }
}

# Amazon CloudWatch Alarms
resource "aws_cloudwatch_metric_alarm" "ec2_cpu_alarm" {
  alarm_name          = "prism-backend-high-cpu-alarm"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Triggered when EC2 CPU utilization exceeds 80%"
  alarm_actions       = [aws_sns_topic.ops_alerts.arn]

  dimensions = {
    InstanceId = aws_instance.ec2_az1.id
  }

  tags = {
    Name = "Amazon CloudWatch"
  }
}
