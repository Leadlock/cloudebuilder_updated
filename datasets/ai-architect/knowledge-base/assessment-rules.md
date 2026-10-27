# Assessment rules (ruleset 2026.10.3)

A design is only "deploy-ready" if none of these rules fails or warns at MEDIUM severity or above. Read the recommendation to see how to satisfy each rule.

## AWS-S3-001 — S3 bucket Block Public Access is not fully enforced
Provider: aws; service: Amazon S3; severity: CRITICAL; pillar: security (SEC 8 — Protect data at rest (access controls)).
The bucket is configured to allow public access, so the generated Terraform does not enforce all four S3 Block Public Access settings.
Why it matters: Security Hub rates public read/write exposure of S3 buckets as critical (S3.2/S3.3) and requires bucket-level Block Public Access (S3.8). Severity is reduced to HIGH when public ACLs and public policies are both still blocked.
Recommendation: Keep S3 Block Public Access enabled at the bucket level. Serve public content through CloudFront with origin access control instead of a public bucket.
Applies to: aws_s3.

## AWS-S3-002 — S3 bucket has no explicit default encryption configuration
Provider: aws; service: Amazon S3; severity: LOW; pillar: security (SEC 8 — Protect data at rest).
The bucket design does not declare a default server-side encryption configuration.
Why it matters: Since January 2023 Amazon S3 applies SSE-S3 to all new objects by default, so objects are still encrypted at rest. Declaring the configuration explicitly (or using SSE-KMS) documents intent and enables key-level access control. Security Hub retired its generic S3 SSE control for this reason; this is a LOW, evidence-of-intent finding, not a statement that data is unencrypted.
Recommendation: Declare default encryption (SSE-S3, or SSE-KMS with a customer managed key for sensitive data).
Applies to: aws_s3.

## AWS-S3-003 — S3 server access logging is disabled
Provider: aws; service: Amazon S3; severity: LOW; pillar: security (SEC 4 — Detect and investigate security events).
Server access logging is not enabled for the bucket.
Why it matters: Security Hub S3.9 (medium). Rated LOW here because CloudTrail data events can provide equivalent object-level audit evidence; CloudBuilder cannot see whether they are enabled.
Recommendation: Enable server access logging to a dedicated, access-restricted log bucket, or enable CloudTrail S3 data events.
Applies to: aws_s3.

## AWS-S3-004 — S3 bucket permits access control lists (ACLs)
Provider: aws; service: Amazon S3; severity: MEDIUM; pillar: security (SEC 3 — Manage permissions).
Object Ownership is not set to "Bucket owner enforced", so ACLs remain active for this bucket.
Why it matters: Security Hub S3.12 (medium): ACLs should not be used to manage user access; IAM and bucket policies give auditable, centralized access control.
Recommendation: Set Object Ownership to "Bucket owner enforced" to disable ACLs.
Applies to: aws_s3.

## AWS-S3-005 — S3 bucket versioning is disabled
Provider: aws; service: Amazon S3; severity: LOW; pillar: reliability (REL 9 — Back up data).
Versioning is suspended, so overwritten or deleted objects cannot be recovered.
Why it matters: Security Hub S3.14 (low). Versioning protects against accidental deletion and overwrite.
Recommendation: Enable versioning; pair it with a lifecycle rule that expires noncurrent versions to control cost.
Applies to: aws_s3.

## AWS-S3-006 — S3 bucket has no lifecycle policy
Provider: aws; service: Amazon S3; severity: LOW; pillar: cost_optimization (Manage demand and supply resources — data lifecycle).
Neither a storage-class transition nor an expiration is configured.
Why it matters: Security Hub S3.13 (low). Lifecycle rules move infrequently accessed data to cheaper storage classes and expire data past retention.
Recommendation: Define transition and expiration days based on the data retention policy.
Applies to: aws_s3.

## AWS-RDS-001 — RDS database instance is publicly accessible
Provider: aws; service: Amazon RDS; severity: CRITICAL; pillar: security (SEC 5 — Protect network resources).
The instance is configured with Publicly Accessible = true, so it receives a public DNS endpoint reachable from outside the VPC (subject to security groups).
Why it matters: Security Hub RDS.2 (critical). Databases should only be reachable from application tiers inside private networks.
Recommendation: Disable public accessibility and place the instance in private subnets; administer it through a bastion, SSM port forwarding, or VPN.
Applies to: aws_rds.

## AWS-RDS-002 — RDS storage encryption is disabled
Provider: aws; service: Amazon RDS; severity: HIGH; pillar: security (SEC 8 — Protect data at rest).
Storage encryption is off, so the DB instance storage, automated backups, read replicas and snapshots are not encrypted.
Why it matters: Security Hub RDS.3 is rated medium; CloudBuilder rates it HIGH because a relational database is the primary store of application data and encryption cannot be enabled in place later.
Recommendation: Enable storage encryption (optionally with a customer managed KMS key).
Applies to: aws_rds.

## AWS-RDS-003 — RDS IAM database authentication is disabled
Provider: aws; service: Amazon RDS; severity: LOW; pillar: security (SEC 2 — Manage authentication).
The instance accepts only native database credentials.
Why it matters: Security Hub RDS.10 (medium). Rated LOW because native credentials stored in Secrets Manager with rotation are an accepted alternative CloudBuilder cannot observe.
Recommendation: Enable IAM database authentication for application roles, or store native credentials in Secrets Manager with rotation.
Applies to: aws_rds.

## AWS-RDS-004 — RDS database logs are not exported to CloudWatch Logs
Provider: aws; service: Amazon RDS; severity: LOW; pillar: security (SEC 4 — Detect and investigate security events).
No database log types are published to CloudWatch Logs.
Why it matters: Security Hub RDS.9 (medium). Rated LOW at design time because the relevant log types depend on the engine and audit requirements.
Recommendation: Export the engine's relevant logs (e.g. postgresql, or audit/error/general/slowquery for MySQL) to CloudWatch Logs with a retention policy.
Applies to: aws_rds.

## AWS-RDS-005 — RDS automatic minor version upgrade is disabled
Provider: aws; service: Amazon RDS; severity: MEDIUM; pillar: security (SEC 6 — Protect compute resources (patching)).
Minor engine versions (which include security patches) will not be applied automatically.
Why it matters: Security Hub RDS.13 (rated high by the standard). Rated MEDIUM because patching may be handled by a documented manual process CloudBuilder cannot observe.
Recommendation: Enable automatic minor version upgrades during the maintenance window.
Applies to: aws_rds.

## AWS-RDS-006 — RDS instance is not deployed across multiple Availability Zones
Provider: aws; service: Amazon RDS; severity: MEDIUM; pillar: reliability (REL 10 — Use fault isolation to protect your workload).
Multi-AZ is disabled, so there is no synchronous standby and no automatic failover.
Why it matters: Security Hub RDS.5 (medium); Reliability pillar fault-isolation guidance. Aurora engines replicate storage across AZs but still need a replica for compute failover.
Recommendation: Enable Multi-AZ for production databases.
Applies to: aws_rds.

## AWS-RDS-007 — RDS automated backups are disabled or retained for less than 7 days
Provider: aws; service: Amazon RDS; severity: HIGH; pillar: reliability (REL 9 — Back up data).
The backup retention period is below the 7-day minimum used by Security Hub RDS.11.
Why it matters: Security Hub RDS.11 (medium, default minimum 7 days). A retention of 0 disables automated backups and point-in-time recovery entirely and is rated HIGH; 1–6 days is rated LOW.
Recommendation: Retain automated backups for at least 7 days (longer if required by your recovery objectives).
Applies to: aws_rds.

## AWS-RDS-008 — RDS deletion protection is disabled
Provider: aws; service: Amazon RDS; severity: LOW; pillar: reliability (REL 9 — Back up data).
The instance can be deleted without first disabling deletion protection.
Why it matters: Security Hub RDS.8 (low).
Recommendation: Enable deletion protection.
Applies to: aws_rds.

## AWS-RDS-009 — RDS Enhanced Monitoring is disabled
Provider: aws; service: Amazon RDS; severity: LOW; pillar: operational_excellence (Implement observability).
OS-level metrics are not collected for the DB instance.
Why it matters: Security Hub RDS.6 (low).
Recommendation: Enable Enhanced Monitoring (e.g. 60-second granularity).
Applies to: aws_rds.

## AWS-EC2-001 — EC2 instance is assigned a public IP address
Provider: aws; service: Amazon EC2; severity: MEDIUM; pillar: security (SEC 5 — Protect network resources).
The instance receives a public IPv4 address at launch.
Why it matters: Security Hub EC2.9 is rated high; CloudBuilder rates it MEDIUM because inbound reachability also depends on security group rules evaluated separately (AWS-SG-001/002). Raised to HIGH if the diagram links the instance directly to an internet entry point.
Recommendation: Place instances in private subnets behind a load balancer; use NAT for egress and SSM Session Manager for administration.
Applies to: aws_ec2.

## AWS-EC2-002 — EC2 root volume is not encrypted
Provider: aws; service: Amazon EC2; severity: MEDIUM; pillar: security (SEC 8 — Protect data at rest).
The root EBS volume is created without encryption.
Why it matters: Security Hub EC2.3 (medium).
Recommendation: Encrypt the root volume (and enable EBS encryption by default in the account).
Applies to: aws_ec2.

## AWS-EC2-003 — EC2 instance does not require IMDSv2
Provider: aws; service: Amazon EC2; severity: HIGH; pillar: security (SEC 6 — Protect compute resources).
The instance metadata service accepts IMDSv1 requests (metadata HttpTokens is "optional").
Why it matters: Security Hub EC2.8 (high) requires IMDSv2 (HttpTokens = required). An instance whose metadata option is not specified or not discovered is INSUFFICIENT DATA — CloudBuilder never assumes IMDSv2 is enforced.
Recommendation: Require IMDSv2 on all instances and launch templates.
Applies to: aws_ec2.

## AWS-EBS-001 — EBS volume is not encrypted
Provider: aws; service: Amazon EBS; severity: MEDIUM; pillar: security (SEC 8 — Protect data at rest).
The volume is created without encryption.
Why it matters: Security Hub EC2.3 (medium).
Recommendation: Encrypt the volume.
Applies to: aws_ebs.

## AWS-EBS-002 — EBS volume has no snapshot schedule
Provider: aws; service: Amazon EBS; severity: LOW; pillar: reliability (REL 9 — Back up data).
No automated snapshot schedule is configured for the volume.
Why it matters: Reliability pillar backup guidance (REL 9).
Recommendation: Protect the volume with AWS Backup or Data Lifecycle Manager.
Applies to: aws_ebs.

## AWS-VPC-001 — Subnet automatically assigns public IP addresses
Provider: aws; service: Amazon VPC; severity: MEDIUM; pillar: security (SEC 5 — Protect network resources).
Instances launched in this subnet receive a public IPv4 address by default.
Why it matters: Security Hub EC2.15 (medium).
Recommendation: Disable auto-assign public IP; request public IPs explicitly only where required (e.g. NAT gateways, bastions).
Applies to: aws_subnet.

## AWS-VPC-002 — VPC Flow Logs are not enabled
Provider: aws; service: Amazon VPC; severity: LOW; pillar: security (SEC 4 — Detect and investigate security events).
Network traffic in the VPC is not being recorded.
Why it matters: Security Hub EC2.6 rates this medium. It is LOW here because flow logs need an existing S3 bucket as their destination, which a design-time canvas does not create. An imported VPC whose flow-log setting is not known stays NOT EVALUATED: nothing is assumed.
Recommendation: Enable VPC Flow Logs (all traffic, or at least rejected traffic) to a dedicated S3 bucket with a retention policy.
Applies to: aws_vpc.

## AWS-VPC-003 — VPC DNS resolution is disabled
Provider: aws; service: Amazon VPC; severity: MEDIUM; pillar: reliability (REL 2 — Plan your network topology).
enableDnsSupport is false, so the Amazon-provided DNS resolver is unavailable in the VPC.
Why it matters: Interface VPC endpoints with private DNS, EKS and many managed services require DNS support. Whether services can find each other is a property of the network foundation, so it counts toward Reliability (plan the network topology); it is neither an operations practice nor a security control.
Recommendation: Enable DNS support on the VPC.
Applies to: aws_vpc.

## AWS-SG-001 — Security group allows SSH (22) from the entire internet
Provider: aws; service: Amazon EC2 security groups; severity: HIGH; pillar: security (SEC 5 — Protect network resources).
An inbound rule allows TCP 22 from 0.0.0.0/0 or ::/0.
Why it matters: Security Hub EC2.13 (high).
Recommendation: Remove internet-wide SSH. Use SSM Session Manager, or restrict the source to known administrator CIDRs.
Applies to: aws_sg.

## AWS-SG-002 — Security group allows RDP (3389) from the entire internet
Provider: aws; service: Amazon EC2 security groups; severity: HIGH; pillar: security (SEC 5 — Protect network resources).
An inbound rule allows TCP 3389 from 0.0.0.0/0 or ::/0.
Why it matters: Security Hub EC2.14 (high).
Recommendation: Remove internet-wide RDP. Use Fleet Manager / Session Manager port forwarding, or restrict to known CIDRs.
Applies to: aws_sg.

## AWS-SG-003 — Network access rules for compute and databases are not modelled
Provider: aws; service: Amazon EC2 security groups; severity: MEDIUM; pillar: security (SEC 5 — Protect network resources).
The architecture contains compute or database resources but no security groups.
Why it matters: AWS always associates a security group (the VPC default group if none is specified), so the absence of security groups in the diagram does NOT mean traffic is unrestricted — it means the rules cannot be assessed.
Recommendation: Model a least-privilege security group per tier (load balancer, application, database).
Applies to the whole architecture.

## AWS-NACL-001 — Network ACL allows internet ingress to administrative ports
Provider: aws; service: Amazon VPC network ACLs; severity: MEDIUM; pillar: security (SEC 5 — Protect network resources).
An inbound NACL entry from 0.0.0.0/0 covers port 22 or 3389 (including allow-all entries).
Why it matters: Security Hub EC2.21 (medium).
Recommendation: Restrict NACL inbound entries to required ports and sources.
Applies to: aws_nacl.

## AWS-ELB-001 — HTTPS listener has no certificate
Provider: aws; service: Elastic Load Balancing; severity: MEDIUM; pillar: security (SEC 9 — Protect data in transit).
The listener protocol is HTTPS but no ACM certificate ARN is configured.
Why it matters: An HTTPS/TLS listener cannot be created without a certificate; the generated Terraform will fail to apply.
Recommendation: Provision an ACM certificate for the domain and attach it to the listener.
Applies to: aws_alb.

## AWS-ELB-002 — Internet-facing load balancer serves plaintext HTTP
Provider: aws; service: Elastic Load Balancing; severity: MEDIUM; pillar: security (SEC 9 — Protect data in transit).
The internet-facing listener uses HTTP without HTTPS termination.
Why it matters: Security Hub ELB.1 (medium) requires HTTP listeners to redirect to HTTPS.
Recommendation: Terminate TLS on an HTTPS listener with an ACM certificate and redirect HTTP to HTTPS.
Applies to: aws_alb.

## AWS-ELB-003 — Internet-facing Application Load Balancer has no AWS WAF web ACL
Provider: aws; service: Elastic Load Balancing; severity: MEDIUM; pillar: security (SEC 5 — Protect network resources).
No AWS WAF web ACL is connected to the internet-facing ALB in the architecture.
Why it matters: Security Hub ELB.16 (medium). Evidence is the absence of a relationship to an aws_waf resource in the diagram.
Recommendation: Associate a regional AWS WAF web ACL with AWS managed rule groups.
Applies to: aws_alb.

## AWS-ELB-004 — Load balancer deletion protection is disabled
Provider: aws; service: Elastic Load Balancing; severity: LOW; pillar: reliability (REL 11 — Design your workload to withstand component failures).
The load balancer can be deleted without first disabling protection.
Why it matters: Security Hub ELB.6 (medium). Rated LOW: an accidental deletion is recoverable by re-applying Terraform, with an outage.
Recommendation: Enable deletion protection for production load balancers.
Applies to: aws_alb.

## AWS-CF-001 — CloudFront allows unencrypted HTTP to viewers
Provider: aws; service: Amazon CloudFront; severity: MEDIUM; pillar: security (SEC 9 — Protect data in transit).
The viewer protocol policy is "allow-all".
Why it matters: Security Hub CloudFront.3 (medium).
Recommendation: Use "redirect-to-https" (or "https-only").
Applies to: aws_cloudfront.

## AWS-CF-002 — CloudFront distribution has no AWS WAF web ACL
Provider: aws; service: Amazon CloudFront; severity: MEDIUM; pillar: security (SEC 5 — Protect network resources).
Neither a web ACL ID nor a connected AWS WAF (CLOUDFRONT scope) resource is present.
Why it matters: Security Hub CloudFront.6 (medium).
Recommendation: Associate a global (CLOUDFRONT scope) AWS WAF web ACL.
Applies to: aws_cloudfront.

## AWS-WAF-001 — AWS WAF web ACL has no rules
Provider: aws; service: AWS WAF; severity: MEDIUM; pillar: security (SEC 5 — Protect network resources).
The web ACL has no managed rule groups and no rate-based rule.
Why it matters: Security Hub WAF.10 (medium). A default action of ALLOW is normal when block rules exist, so it is not flagged on its own.
Recommendation: Add AWS managed rule groups (e.g. Core rule set, Known bad inputs) and a rate-based rule.
Applies to: aws_waf.

## AWS-EKS-001 — EKS API endpoint is publicly accessible
Provider: aws; service: Amazon EKS; severity: HIGH; pillar: security (SEC 5 — Protect network resources).
The Kubernetes API server endpoint accepts connections from the internet.
Why it matters: Security Hub EKS.1 (high). HIGH when open to 0.0.0.0/0; LOW when public access is restricted to specific CIDRs.
Recommendation: Enable private endpoint access and disable public access, or restrict public access CIDRs to administrator networks.
Applies to: aws_eks.

## AWS-EKS-002 — EKS Kubernetes secrets are not envelope-encrypted with KMS
Provider: aws; service: Amazon EKS; severity: MEDIUM; pillar: security (SEC 8 — Protect data at rest).
Secrets encryption with a KMS key is disabled.
Why it matters: Security Hub EKS.3 (medium).
Recommendation: Enable envelope encryption of Kubernetes secrets with a KMS key.
Applies to: aws_eks.

## AWS-EKS-003 — EKS control plane audit logging is disabled
Provider: aws; service: Amazon EKS; severity: MEDIUM; pillar: security (SEC 4 — Detect and investigate security events).
The "audit" log type is not enabled for the cluster control plane.
Why it matters: Security Hub EKS.8 (medium).
Recommendation: Enable the audit control plane log type (and api/authenticator as needed).
Applies to: aws_eks.

## AWS-ECS-001 — ECS service automatically assigns public IP addresses
Provider: aws; service: Amazon ECS; severity: HIGH; pillar: security (SEC 5 — Protect network resources).
Tasks receive public IP addresses (AssignPublicIp = ENABLED).
Why it matters: Security Hub ECS.2 (high).
Recommendation: Run tasks in private subnets; use a NAT gateway or VPC endpoints for image pulls and a load balancer for inbound traffic.
Applies to: aws_ecs.

## AWS-IAM-001 — IAM role has full administrative privileges
Provider: aws; service: AWS IAM; severity: HIGH; pillar: security (SEC 3 — Manage permissions).
The AWS managed AdministratorAccess policy (Action "*" on Resource "*") is attached to the role.
Why it matters: Related to Security Hub IAM.1 (high), which targets customer managed policies granting "*:*"; the same privilege level attached to a workload role violates least privilege.
Recommendation: Replace AdministratorAccess with a least-privilege policy scoped to the actions and resources the workload uses.
Applies to: aws_iam.

## AWS-KMS-001 — KMS key automatic rotation is disabled
Provider: aws; service: AWS KMS; severity: MEDIUM; pillar: security (SEC 8 — Protect data at rest (key management)).
Automatic key material rotation is off for a symmetric encryption key.
Why it matters: Security Hub KMS.4 (medium). Not applicable to asymmetric or signing keys, which do not support automatic rotation.
Recommendation: Enable automatic key rotation.
Applies to: aws_kms.

## AWS-ELC-001 — ElastiCache in-transit encryption is disabled
Provider: aws; service: Amazon ElastiCache; severity: MEDIUM; pillar: security (SEC 9 — Protect data in transit).
Clients connect to the cache without TLS.
Why it matters: Security Hub ElastiCache.5 (medium).
Recommendation: Enable in-transit encryption and update clients to use TLS.
Applies to: aws_elasticache.

## AWS-ELC-002 — ElastiCache at-rest encryption is disabled
Provider: aws; service: Amazon ElastiCache; severity: MEDIUM; pillar: security (SEC 8 — Protect data at rest).
Cache data, backups and swap are not encrypted at rest.
Why it matters: Security Hub ElastiCache.4 (medium).
Recommendation: Enable at-rest encryption (set at creation).
Applies to: aws_elasticache.

## AWS-ELC-003 — ElastiCache has no automatic failover
Provider: aws; service: Amazon ElastiCache; severity: MEDIUM; pillar: reliability (REL 11 — Withstand component failures).
The cache has no replica with automatic failover.
Why it matters: Security Hub ElastiCache.3 (medium). A single-node cache is reported LOW because failover requires at least one replica.
Recommendation: Use at least one replica with automatic failover and Multi-AZ.
Applies to: aws_elasticache.

## AWS-ELC-004 — ElastiCache automatic backups are disabled
Provider: aws; service: Amazon ElastiCache; severity: MEDIUM; pillar: reliability (REL 9 — Back up data).
Snapshot retention is 0 days.
Why it matters: Security Hub ElastiCache.1 (high). Rated MEDIUM because cache contents are often reconstructable from the system of record.
Recommendation: Retain automatic snapshots for at least 1 day.
Applies to: aws_elasticache.

## AWS-DDB-001 — DynamoDB encryption at rest
Provider: aws; service: Amazon DynamoDB; severity: INFORMATIONAL; pillar: security (SEC 8 — Protect data at rest).
DynamoDB encrypts all tables at rest; the configuration selects the key type.
Why it matters: DynamoDB encryption at rest cannot be disabled. "Server-side encryption = off" in CloudBuilder means the AWS owned key is used; "on" means an AWS managed KMS key. The previous rule that reported "encryption disabled" was incorrect and has been replaced by this evidence check.
Recommendation: Use a customer managed KMS key when you need key-level access control and CloudTrail evidence of key use.
Applies to: aws_dynamodb.

## AWS-DDB-002 — DynamoDB point-in-time recovery is disabled
Provider: aws; service: Amazon DynamoDB; severity: MEDIUM; pillar: reliability (REL 9 — Back up data).
Continuous backups are not enabled for the table.
Why it matters: Security Hub DynamoDB.2 (medium).
Recommendation: Enable point-in-time recovery.
Applies to: aws_dynamodb.

## AWS-DDB-003 — DynamoDB deletion protection is disabled
Provider: aws; service: Amazon DynamoDB; severity: LOW; pillar: reliability (REL 9 — Back up data).
The table can be deleted without first disabling deletion protection.
Why it matters: Security Hub DynamoDB.6 (medium). Rated LOW when point-in-time recovery is enabled, because deleting a PITR-enabled table leaves a restorable system backup; MEDIUM otherwise.
Recommendation: Enable deletion protection.
Applies to: aws_dynamodb.

## AWS-SQS-001 — SQS queue server-side encryption is disabled
Provider: aws; service: Amazon SQS; severity: MEDIUM; pillar: security (SEC 8 — Protect data at rest).
The queue is explicitly configured without SSE (the generated Terraform sets sqs_managed_sse_enabled = false).
Why it matters: Security Hub SQS.1 (medium).
Recommendation: Enable SSE-SQS or SSE-KMS.
Applies to: aws_sqs.

## AWS-SQS-002 — SQS queue has no dead-letter queue
Provider: aws; service: Amazon SQS; severity: LOW; pillar: reliability (REL 5 — Design interactions to mitigate or withstand failures).
No redrive policy sends repeatedly failing messages to a dead-letter queue.
Why it matters: Reliability pillar guidance on handling poison messages.
Recommendation: Create a dead-letter queue and set a redrive policy with a sensible max receive count; alarm on DLQ depth.
Applies to: aws_sqs.

## AWS-ARCH-001 — EC2 compute has no load balancer or Auto Scaling group
Provider: aws; service: Amazon EC2; severity: MEDIUM; pillar: reliability (REL 10/11 — Fault isolation and withstanding component failures).
EC2 instances are present without an Application/Network Load Balancer or Auto Scaling group in the architecture.
Why it matters: Reliability pillar: distribute load across redundant instances and replace unhealthy ones automatically.
Recommendation: Run the tier in an Auto Scaling group across at least two AZs behind a load balancer.
Applies to the whole architecture.

## AWS-ARCH-002 — All subnets are in a single Availability Zone
Provider: aws; service: Amazon VPC; severity: MEDIUM; pillar: reliability (REL 10 — Use fault isolation to protect your workload).
Every subnet in the architecture is placed in the same Availability Zone.
Why it matters: Reliability pillar fault isolation: deploy across multiple AZs. Evaluated from the subnets' Availability Zone settings.
Recommendation: Create subnets for each tier in at least two Availability Zones.
Applies to the whole architecture.

## AWS-ASG-001 — Auto Scaling group behind a load balancer uses EC2 health checks
Provider: aws; service: Amazon EC2 Auto Scaling; severity: LOW; pillar: reliability (REL 11 — Withstand component failures).
The group is connected to a load balancer but replaces instances only on EC2 status checks.
Why it matters: Security Hub AutoScaling.1 (low). Evaluated from the diagram relationship to a load balancer.
Recommendation: Use ELB health checks with an appropriate grace period.
Applies to: aws_auto_scaling.

## AWS-EC2-010 — EC2 detailed monitoring is disabled
Provider: aws; service: Amazon EC2; severity: LOW; pillar: operational_excellence (Implement observability).
Only 5-minute basic CloudWatch metrics are collected.
Why it matters: Operational Excellence observability guidance; 1-minute metrics shorten detection time for scaling and alarms.
Recommendation: Enable detailed monitoring for production instances.
Applies to: aws_ec2.

## AWS-ARCH-003 — No CloudWatch alarms are modelled
Provider: aws; service: Amazon CloudWatch; severity: LOW; pillar: operational_excellence (Implement observability).
The AWS architecture has workload resources but no CloudWatch alarm resources.
Why it matters: Operational Excellence: define alarms on the metrics that indicate workload health.
Recommendation: Add CloudWatch alarms for the key health metrics of each tier and route them to an on-call channel.
Applies to the whole architecture.

## AWS-LAMBDA-001 — Lambda active tracing (X-Ray) is disabled
Provider: aws; service: AWS Lambda; severity: LOW; pillar: operational_excellence (Implement observability).
Tracing mode is PassThrough.
Why it matters: Operational Excellence observability guidance for distributed tracing.
Recommendation: Enable active tracing where end-to-end latency matters.
Applies to: aws_lambda.

## AWS-ARCH-004 — Database-backed compute has no caching layer
Provider: aws; service: Amazon ElastiCache; severity: INFORMATIONAL; pillar: performance_efficiency (Data management — use caching where appropriate).
RDS and compute resources are present but no ElastiCache cluster is modelled.
Why it matters: Performance Efficiency: caching reduces repeated reads. Whether it helps depends on the read pattern, so this is informational.
Recommendation: If the workload is read-heavy, add ElastiCache (Redis/Valkey) for hot data and sessions.
Applies to the whole architecture.

## AWS-COST-001 — Previous-generation gp2 storage is used
Provider: aws; service: Amazon EBS; severity: LOW; pillar: cost_optimization (Select the correct resource type).
The volume/storage type is gp2; gp3 provides a baseline of 3,000 IOPS and 125 MiB/s independent of size at a lower price per GB.
Why it matters: Cost Optimization: select the most cost-effective resource type.
Recommendation: Migrate gp2 volumes to gp3 (online modification).
Applies to: aws_ebs, aws_ec2, aws_rds.

## AWS-SUS-001 — Lambda function runs on x86_64 instead of Graviton (arm64)
Provider: aws; service: AWS Lambda; severity: INFORMATIONAL; pillar: sustainability (Hardware and services — use efficient hardware).
The function architecture is x86_64.
Why it matters: Sustainability and Cost pillars recommend energy-efficient instance types such as AWS Graviton where the code supports it.
Recommendation: Switch to arm64 after confirming native dependencies are available for arm64.
Applies to: aws_lambda.

## AWS-ELB-005 — Load balancer access logging is disabled
Provider: aws; service: Elastic Load Balancing; severity: LOW; pillar: security (SEC 4 — Detect and investigate security events).
Access logs record each request the load balancer handles (client address, path, latency, response code, TLS details).
Why it matters: Security Hub ELB.5 rates this medium. It is LOW here because logging needs an S3 bucket whose policy lets the regional Elastic Load Balancing account write to it, which a design-time canvas does not create.
Recommendation: Turn on access logs and deliver them to a dedicated, access-restricted S3 bucket with a retention policy.
Applies to: aws_alb.

## AWS-CF-003 — CloudFront standard logging is disabled
Provider: aws; service: Amazon CloudFront; severity: LOW; pillar: security (SEC 4 — Detect and investigate security events).
Viewer requests to the distribution are not logged.
Why it matters: Security Hub CloudFront.5 rates this medium. It is LOW here because standard logging needs an existing S3 bucket with ACLs enabled for log delivery, which a design-time canvas does not create.
Recommendation: Enable standard logging to a dedicated S3 bucket (ACLs enabled for log delivery) with a retention policy.
Applies to: aws_cloudfront.

## AWS-WAF-002 — AWS WAF web ACL has CloudWatch metrics or request sampling disabled
Provider: aws; service: AWS WAF; severity: LOW; pillar: security (SEC 4 — Detect and investigate security events).
Without CloudWatch metrics and sampled requests there is no view of what the web ACL allows, blocks or counts.
Why it matters: A web ACL that cannot be observed cannot be tuned, and a rule that is blocking real customers goes unnoticed. Full request logging (a logging configuration to Kinesis, S3 or CloudWatch Logs) is not modelled by CloudBuilder, so this checks the visibility settings it does model.
Recommendation: Enable CloudWatch metrics and sampled requests on the web ACL and every rule, and add a WAF logging configuration.
Applies to: aws_waf.

## AWS-PERF-001 — CloudFront does not compress objects automatically
Provider: aws; service: Amazon CloudFront; severity: LOW; pillar: performance_efficiency (Networking and content delivery).
Automatic compression is off, so text content (HTML, CSS, JavaScript, JSON) is sent uncompressed.
Why it matters: Performance Efficiency: reduce the bytes sent over the network. Compression typically cuts text payloads substantially at no extra charge.
Recommendation: Turn on automatic object compression.
Applies to: aws_cloudfront.

## AWS-PERF-002 — CloudFront serves viewers over HTTP/1.1 only
Provider: aws; service: Amazon CloudFront; severity: LOW; pillar: performance_efficiency (Networking and content delivery).
The distribution does not offer HTTP/2 or HTTP/3 to viewers.
Why it matters: Performance Efficiency: HTTP/2 multiplexes requests over one connection and HTTP/3 reduces connection setup time, both of which help page load times.
Recommendation: Use HTTP/2 (or HTTP/2 and HTTP/3) for viewer connections.
Applies to: aws_cloudfront.

## AWS-PERF-003 — Auto Scaling group has no scaling policy
Provider: aws; service: Amazon EC2 Auto Scaling; severity: LOW; pillar: performance_efficiency (Compute — adapt capacity to demand).
No target-tracking scaling policy is configured, so the group stays at its desired capacity whatever the load.
Why it matters: Performance Efficiency: adapt capacity to demand. A group without a scaling policy is a fixed-size fleet that either runs out of headroom or pays for idle instances.
Recommendation: Add a target-tracking policy (for example average CPU around 60%).
Applies to: aws_auto_scaling.

## AWS-PERF-004 — RDS Performance Insights is disabled
Provider: aws; service: Amazon RDS; severity: LOW; pillar: performance_efficiency (Data management — monitor performance).
Database load and top queries are not being collected.
Why it matters: Performance Efficiency: monitor performance to find and fix bottlenecks. Performance Insights keeps 7 days of history at no charge.
Recommendation: Enable Performance Insights (the 7-day retention is free).
Applies to: aws_rds.

## AWS-SUS-002 — Instances use x86 where an AWS Graviton equivalent exists
Provider: aws; service: Amazon EC2, Auto Scaling and RDS; severity: LOW; pillar: sustainability (Hardware and services — use efficient hardware).
The instance family is an x86 one (T3, M5, C5, R5 and similar); Graviton-based families (T4g, M6g, C6g, R6g and similar) do the same work using less energy.
Why it matters: Sustainability pillar: use the most efficient hardware for the workload. Graviton instances deliver better performance per watt, and usually a lower price, if the software supports arm64.
Recommendation: Move to the matching Graviton family where the workload runs on arm64 (test first).
Applies to: aws_ec2, aws_auto_scaling, aws_rds.

## AWS-COST-002 — SQS queue uses short polling
Provider: aws; service: Amazon SQS; severity: LOW; pillar: cost_optimization (Select the correct resource type).
The receive wait time is 0 seconds, so every receive call returns immediately, often with nothing, and is still billed as a request.
Why it matters: Cost Optimization: SQS bills per request. Long polling (a receive wait time of up to 20 seconds) returns as soon as a message arrives and removes most empty receives.
Recommendation: Set the receive wait time to 20 seconds (long polling).
Applies to: aws_sqs.

## AWS-COST-003 — CloudWatch log group never expires
Provider: aws; service: Amazon CloudWatch Logs; severity: LOW; pillar: cost_optimization (Optimize over time).
The log retention is 0 days, which means logs are kept forever and storage cost grows without limit.
Why it matters: Cost Optimization: do not keep data longer than it is needed. Set the retention to the period the organization actually requires.
Recommendation: Set a retention period that matches your policy (for example 30, 90 or 365 days).
Applies to: aws_cloudwatch, aws_ecs.

## AWS-ACCT-001 — CloudTrail multi-Region trail — account-level control
Provider: aws; service: AWS CloudTrail; severity: HIGH; pillar: security (SEC 4 — Detect and investigate security events).
CloudTrail multi-Region trail is an AWS account/Region setting that is not part of an architecture diagram.
Why it matters: Account-level controls are not part of an architecture diagram and CloudBuilder never assumes them: a control is NOT EVALUATED until the account has been checked (read-only API calls through a connected AWS account). A reading is dated, only used for seven days, and a control the account would not let CloudBuilder read stays NOT EVALUATED with the reason.
Recommendation: Enable an organization or multi-Region CloudTrail trail with log file validation, delivered to a protected S3 bucket.
Applies to the whole architecture.

## AWS-ACCT-002 — GuardDuty threat detection — account-level control
Provider: aws; service: Amazon GuardDuty; severity: HIGH; pillar: security (SEC 4 — Detect and investigate security events).
GuardDuty threat detection is an AWS account/Region setting that is not part of an architecture diagram.
Why it matters: Account-level controls are not part of an architecture diagram and CloudBuilder never assumes them: a control is NOT EVALUATED until the account has been checked (read-only API calls through a connected AWS account). A reading is dated, only used for seven days, and a control the account would not let CloudBuilder read stays NOT EVALUATED with the reason.
Recommendation: Enable GuardDuty in all Regions used by the workload (delegated administrator in AWS Organizations).
Applies to the whole architecture.

## AWS-ACCT-003 — Root user MFA — account-level control
Provider: aws; service: AWS IAM; severity: CRITICAL; pillar: security (SEC 2 — Manage authentication).
Root user MFA is an AWS account/Region setting that is not part of an architecture diagram.
Why it matters: Account-level controls are not part of an architecture diagram and CloudBuilder never assumes them: a control is NOT EVALUATED until the account has been checked (read-only API calls through a connected AWS account). A reading is dated, only used for seven days, and a control the account would not let CloudBuilder read stays NOT EVALUATED with the reason.
Recommendation: Enable (hardware) MFA on the root user and avoid root usage.
Applies to the whole architecture.

## AWS-ACCT-004 — AWS Config recording — account-level control
Provider: aws; service: AWS Config; severity: MEDIUM; pillar: security (SEC 4 — Detect and investigate security events).
AWS Config recording is an AWS account/Region setting that is not part of an architecture diagram.
Why it matters: Account-level controls are not part of an architecture diagram and CloudBuilder never assumes them: a control is NOT EVALUATED until the account has been checked (read-only API calls through a connected AWS account). A reading is dated, only used for seven days, and a control the account would not let CloudBuilder read stays NOT EVALUATED with the reason.
Recommendation: Enable AWS Config recording for all resources in each Region used.
Applies to the whole architecture.

## AZ-STG-001 — Storage account does not require secure transfer
Provider: azure; service: Azure Storage; severity: HIGH; pillar: security (SE:07 — Encrypt data).
"Secure transfer required" is disabled, so the account accepts HTTP and unencrypted SMB requests.
Why it matters: MCSB DP-3; Azure Policy "secure transfer to storage accounts" (404c3081…).
Recommendation: Enable "Secure transfer required".
Applies to: azure_storage.

## AZ-STG-002 — Storage account allows anonymous blob access
Provider: azure; service: Azure Storage; severity: HIGH; pillar: security (SE:06 — Network controls / SE:05 — Access).
"Allow Blob anonymous access" is enabled, so any container can be configured for anonymous public read access.
Why it matters: MCSB NS-2; Azure Policy "Storage account public access should be disallowed" (4fa4b6c0…). The setting permits — but does not by itself create — public containers, so it is HIGH rather than CRITICAL.
Recommendation: Disallow anonymous blob access; serve public content through Azure Front Door/CDN with a private origin or SAS.
Applies to: azure_storage.

## AZ-STG-003 — Storage account permits TLS versions older than 1.2
Provider: azure; service: Azure Storage; severity: MEDIUM; pillar: security (SE:07 — Encrypt data).
The minimum TLS version is 1.0 or 1.1.
Why it matters: MCSB DP-3 (encrypt data in transit with current protocols).
Recommendation: Set the minimum TLS version to TLS 1.2.
Applies to: azure_storage.

## AZ-STG-004 — Storage account network access is unrestricted
Provider: azure; service: Azure Storage; severity: MEDIUM; pillar: security (SE:06 — Network controls).
The storage firewall default action is "Allow", so the account endpoint accepts connections from all networks.
Why it matters: MCSB NS-2; Azure Policy "Storage accounts should restrict network access" (34c877ad…).
Recommendation: Set the default action to Deny and allow access through private endpoints, virtual network rules or trusted IP ranges.
Applies to: azure_storage.

## AZ-STG-005 — Blob soft delete is disabled
Provider: azure; service: Azure Storage; severity: LOW; pillar: reliability (RE:09 — Business continuity and disaster recovery).
Deleted blobs are not retained for recovery.
Why it matters: Azure Well-Architected Reliability data-protection guidance for Blob Storage.
Recommendation: Enable blob soft delete (e.g. 7 days) and consider blob versioning.
Applies to: azure_storage.

## AZ-STG-006 — Storage account uses locally-redundant storage (LRS)
Provider: azure; service: Azure Storage; severity: LOW; pillar: reliability (RE:05 — Redundancy).
LRS keeps three copies within a single datacenter.
Why it matters: Azure Well-Architected Reliability guidance recommends zone-redundant (ZRS) or geo-redundant replication for production data.
Recommendation: Use ZRS (or GZRS/RA-GZRS for regional DR) for production data.
Applies to: azure_storage.

## AZ-SQL-001 — Azure SQL logical server allows public network access
Provider: azure; service: Azure SQL Database; severity: HIGH; pillar: security (SE:06 — Network controls).
Public network access is enabled on the logical server.
Why it matters: MCSB NS-2; Azure Policy "Public network access on Azure SQL Database should be disabled" (1b8ca024…). Rated HIGH (not CRITICAL) because the server firewall still applies; it becomes CRITICAL in practice when broad firewall rules exist, which CloudBuilder does not model.
Recommendation: Disable public network access and connect through a private endpoint.
Applies to: azure_sql.

## AZ-SQL-002 — Transparent Data Encryption is disabled
Provider: azure; service: Azure SQL Database; severity: HIGH; pillar: security (SE:07 — Encrypt data).
TDE is disabled, so the database, backups and transaction logs are not encrypted at rest.
Why it matters: MCSB DP-4; Azure Policy "Transparent Data Encryption on SQL databases should be enabled" (17k78e20…).
Recommendation: Enable TDE (service-managed or customer-managed key).
Applies to: azure_sql.

## AZ-SQL-003 — Azure SQL auditing is disabled
Provider: azure; service: Azure SQL Database; severity: MEDIUM; pillar: security (SE:10 — Monitoring and threat detection).
Server auditing is not enabled.
Why it matters: MCSB LT-3; Azure Policy "Auditing on SQL server should be enabled" (a6fb4358…).
Recommendation: Enable server auditing to a Log Analytics workspace or storage account with appropriate retention.
Applies to: azure_sql.

## AZ-SQL-004 — Microsoft Defender for SQL threat detection is disabled
Provider: azure; service: Azure SQL Database; severity: MEDIUM; pillar: security (SE:10 — Monitoring and threat detection).
Threat detection (security alert policy) is not enabled on the logical server.
Why it matters: MCSB LT-1; Azure Policy for Defender for SQL on servers (abfb4388…).
Recommendation: Enable Microsoft Defender for SQL (security alert policy) on the logical server.
Applies to: azure_sql.

## AZ-SQL-005 — Azure SQL permits TLS versions older than 1.2
Provider: azure; service: Azure SQL Database; severity: MEDIUM; pillar: security (SE:07 — Encrypt data).
The minimum TLS version of the logical server is 1.0 or 1.1.
Why it matters: MCSB DP-3; Azure Policy "Azure SQL Database should be running TLS version 1.2 or newer" (32e6bbec…).
Recommendation: Set minimum TLS to 1.2.
Applies to: azure_sql.

## AZ-SQL-006 — "Allow Azure services" firewall exception is enabled on a public SQL server
Provider: azure; service: Azure SQL Database; severity: MEDIUM; pillar: security (SE:06 — Network controls).
The AllowAllWindowsAzureIps firewall rule (0.0.0.0) admits connections from any Azure-hosted address, including other customers' resources.
Why it matters: MCSB NS-2 (restrict access to trusted networks). Only evaluated when public network access is enabled.
Recommendation: Remove the Azure-services exception; use private endpoints or specific firewall/VNet rules.
Applies to: azure_sql.

## AZ-SQL-010 — Azure SQL database is not zone-redundant
Provider: azure; service: Azure SQL Database; severity: MEDIUM; pillar: reliability (RE:05 — Redundancy).
Zone redundancy is disabled on a service tier that supports it.
Why it matters: Azure Well-Architected Reliability (redundancy). Not applicable to Basic/Standard (DTU) tiers, which do not offer zone redundancy.
Recommendation: Enable zone redundancy for production databases on Premium, Business Critical or General Purpose tiers.
Applies to: azure_sql.

## AZ-SQL-011 — Azure SQL backups use locally-redundant storage
Provider: azure; service: Azure SQL Database; severity: LOW; pillar: reliability (RE:09 — Business continuity and disaster recovery).
Backup storage redundancy is Local.
Why it matters: Azure Well-Architected Reliability (BCDR): geo- or zone-redundant backup storage protects restores from regional/zonal loss.
Recommendation: Use Geo or GeoZone backup storage redundancy unless data residency forbids it.
Applies to: azure_sql.

## AZ-COS-001 — Cosmos DB account allows public network access
Provider: azure; service: Azure Cosmos DB; severity: HIGH; pillar: security (SE:06 — Network controls).
Public network access is enabled on the account.
Why it matters: MCSB NS-2; Azure Policy "Azure Cosmos DB should disable public network access" (797b37f7…).
Recommendation: Disable public network access and use private endpoints.
Applies to: azure_cosmos_db.

## AZ-COS-010 — Cosmos DB service-managed failover is disabled
Provider: azure; service: Azure Cosmos DB; severity: LOW; pillar: reliability (RE:05 — Redundancy).
Automatic (service-managed) failover is disabled.
Why it matters: Azure Well-Architected Reliability guidance for Cosmos DB. Only effective when the account has more than one region, which CloudBuilder does not model — hence LOW.
Recommendation: Add a secondary region and enable service-managed failover.
Applies to: azure_cosmos_db.

## AZ-RED-001 — Azure Cache for Redis non-TLS port is enabled
Provider: azure; service: Azure Cache for Redis; severity: MEDIUM; pillar: security (SE:07 — Encrypt data).
The non-TLS port (6379) accepts unencrypted connections.
Why it matters: MCSB DP-3; Azure Policy "Only secure connections to your Azure Cache for Redis should be enabled" (22bee202…).
Recommendation: Disable the non-TLS port and connect on 6380 with TLS.
Applies to: azure_redis.

## AZ-RED-002 — Azure Cache for Redis allows public network access
Provider: azure; service: Azure Cache for Redis; severity: MEDIUM; pillar: security (SE:06 — Network controls).
The cache endpoint accepts connections from public networks.
Why it matters: MCSB NS-2; Azure Policy "Azure Cache for Redis should use private link" (7803067c…).
Recommendation: Use a private endpoint and disable public network access.
Applies to: azure_redis.

## AZ-RED-003 — Azure Cache for Redis permits TLS versions older than 1.2
Provider: azure; service: Azure Cache for Redis; severity: MEDIUM; pillar: security (SE:07 — Encrypt data).
The minimum TLS version is 1.0 or 1.1.
Why it matters: MCSB DP-3.
Recommendation: Set minimum TLS to 1.2.
Applies to: azure_redis.

## AZ-KV-001 — Key Vault is reachable from all networks
Provider: azure; service: Azure Key Vault; severity: MEDIUM; pillar: security (SE:09 — Protect application secrets).
Public network access is enabled and the vault firewall default action is Allow.
Why it matters: MCSB NS-2 / DP-8; Azure Policy "Azure Key Vault should have firewall enabled" (55615ac9…). A public vault whose firewall denies by default passes.
Recommendation: Set the firewall default action to Deny with private endpoints or trusted networks, or disable public network access.
Applies to: azure_key_vault.

## AZ-KV-002 — Key Vault purge protection is disabled
Provider: azure; service: Azure Key Vault; severity: MEDIUM; pillar: security (SE:09 — Protect application secrets).
Soft-deleted vaults and objects can be permanently purged before the retention period ends.
Why it matters: MCSB DP-8; Azure Policy "Key vaults should have deletion protection enabled" (0b60c0b2…).
Recommendation: Enable purge protection.
Applies to: azure_key_vault.

## AZ-KV-003 — Key Vault uses access policies instead of Azure RBAC
Provider: azure; service: Azure Key Vault; severity: MEDIUM; pillar: security (SE:05 — Identity and access management).
Azure RBAC authorization is disabled for the vault data plane.
Why it matters: MCSB PA-7; Azure Policy "Azure Key Vault should use RBAC permission model" (12d4fa5e…).
Recommendation: Migrate to the Azure RBAC permission model.
Applies to: azure_key_vault.

## AZ-NSG-001 — NSG allows SSH (22) from any source
Provider: azure; service: Azure network security groups; severity: HIGH; pillar: security (SE:06 — Network controls).
An inbound rule allows TCP 22 from "*" / Internet / 0.0.0.0/0.
Why it matters: MCSB NS-3; Azure Policy "Management ports should be closed on your virtual machines" (22730e10…).
Recommendation: Remove internet-wide SSH; use Azure Bastion or just-in-time VM access, or restrict the source to known administrator ranges.
Applies to: azure_nsg.

## AZ-NSG-002 — NSG allows RDP (3389) from any source
Provider: azure; service: Azure network security groups; severity: HIGH; pillar: security (SE:06 — Network controls).
An inbound rule allows TCP 3389 from "*" / Internet / 0.0.0.0/0.
Why it matters: MCSB NS-3; Azure Policy "Management ports should be closed on your virtual machines" (22730e10…).
Recommendation: Remove internet-wide RDP; use Azure Bastion or just-in-time VM access, or restrict the source to known administrator ranges.
Applies to: azure_nsg.

## AZ-NIC-001 — IP forwarding is enabled on a network interface
Provider: azure; service: Azure network interfaces; severity: MEDIUM; pillar: security (SE:04 — Segmentation).
The NIC can forward traffic not addressed to it.
Why it matters: MCSB NS-3; Azure Policy "IP Forwarding on your virtual machine should be disabled" (bd352bd5…). Legitimate for network virtual appliances.
Recommendation: Disable IP forwarding unless the VM is an intentional network virtual appliance.
Applies to: azure_nic.

## AZ-ARCH-001 — Subnets are not protected by a network security group
Provider: azure; service: Azure Virtual Network; severity: MEDIUM; pillar: security (SE:04 — Segmentation / SE:06 — Network controls).
Subnets in the architecture have no associated NSG.
Why it matters: MCSB NS-1; Azure Policy "Subnets should be associated with a Network Security Group" (e71308d3…). Unlike AWS, Azure attaches no NSG by default, so a subnet with no NSG in the design will have none when deployed. Association is inferred from containment or a diagram connection.
Recommendation: Associate a least-privilege NSG with every workload subnet.
Applies to the whole architecture.

## AZ-VM-001 — Virtual machine has a public IP address
Provider: azure; service: Azure Virtual Machines; severity: MEDIUM; pillar: security (SE:06 — Network controls).
A public IP is attached to the VM network interface.
Why it matters: MCSB NS-1/NS-2: expose workloads through controlled entry points (load balancer, Application Gateway, Bastion) rather than per-VM public IPs.
Recommendation: Remove the public IP; use Azure Bastion for administration and a load balancer/Application Gateway for inbound traffic.
Applies to: azure_vm.

## AZ-VM-002 — Encryption at host is disabled
Provider: azure; service: Azure Virtual Machines; severity: LOW; pillar: security (SE:07 — Encrypt data).
Temporary disks and disk caches are not encrypted at the host.
Why it matters: MCSB DP-4; Azure Policy "VMs and VMSS should have encryption at host enabled" (fc4d8e41…). Rated LOW because managed OS/data disks are always encrypted at rest with platform-managed keys (server-side encryption); encryption at host extends this to temp disks and caches.
Recommendation: Enable encryption at host (register the EncryptionAtHost feature on the subscription first).
Applies to: azure_vm.

## AZ-VMSS-001 — Scale set encryption at host is disabled
Provider: azure; service: Azure Virtual Machine Scale Sets; severity: LOW; pillar: security (SE:07 — Encrypt data).
Temporary disks and caches of scale set instances are not encrypted at the host.
Why it matters: MCSB DP-4; Azure Policy fc4d8e41…. Managed disks are always encrypted with platform-managed keys.
Recommendation: Enable encryption at host on the scale set.
Applies to: azure_vmss.

## AZ-VM-010 — Azure Backup protection is not modelled for the VM
Provider: azure; service: Azure Virtual Machines; severity: MEDIUM; pillar: reliability (RE:09 — Business continuity and disaster recovery).
CloudBuilder does not model Recovery Services vaults or backup policies.
Why it matters: MCSB BR-1; Azure Policy "Azure Backup should be enabled for Virtual Machines" (013e242c…). Reported NOT EVALUATED — backup is never assumed.
Recommendation: Protect the VM with Azure Backup (Recovery Services vault + policy).
Applies to: azure_vm.

## AZ-VM-011 — Virtual machine is not pinned to an availability zone
Provider: azure; service: Azure Virtual Machines; severity: LOW; pillar: reliability (RE:05 — Redundancy).
No availability zone is set, so the VM is placed regionally without zonal guarantees.
Why it matters: Azure Well-Architected Reliability (redundancy): spread instances across zones where the region supports them.
Recommendation: Deploy VMs across zones (or use a zone-redundant scale set).
Applies to: azure_vm.

## AZ-VM-020 — VM boot diagnostics are disabled
Provider: azure; service: Azure Virtual Machines; severity: LOW; pillar: operational_excellence (OE:07 — Monitoring system).
Serial console output and boot screenshots are not captured.
Why it matters: Azure Well-Architected Operational Excellence (monitoring).
Recommendation: Enable boot diagnostics (managed storage).
Applies to: azure_vm.

## AZ-ARCH-010 — Virtual machines are not behind a load balancer or scale set
Provider: azure; service: Azure Virtual Machines; severity: MEDIUM; pillar: reliability (RE:05 — Redundancy).
VMs exist without an Azure Load Balancer, Application Gateway, Front Door or VM Scale Set in the architecture.
Why it matters: Azure Well-Architected Reliability (redundancy). The previous rule looked for resource types that do not exist in CloudBuilder and fired even when a load balancer was present; it has been corrected.
Recommendation: Run the tier on a zone-redundant VM Scale Set behind a Standard Load Balancer or Application Gateway.
Applies to the whole architecture.

## AZ-APP-001 — App Service accepts plaintext HTTP
Provider: azure; service: Azure App Service; severity: MEDIUM; pillar: security (SE:07 — Encrypt data).
HTTPS Only is disabled.
Why it matters: MCSB DP-3; Azure Policy for App Service HTTPS-only.
Recommendation: Enable HTTPS Only.
Applies to: azure_app_service.

## AZ-FUNC-001 — Function App accepts plaintext HTTP
Provider: azure; service: Azure Function App; severity: MEDIUM; pillar: security (SE:07 — Encrypt data).
HTTPS Only is disabled.
Why it matters: MCSB DP-3; Azure Policy for Function App HTTPS-only.
Recommendation: Enable HTTPS Only.
Applies to: azure_functions.

## AZ-APP-002 — App Service permits TLS versions older than 1.2
Provider: azure; service: Azure App Service; severity: MEDIUM; pillar: security (SE:07 — Encrypt data).
The minimum inbound TLS version is 1.0 or 1.1.
Why it matters: MCSB DP-3; Azure Policy "Latest TLS version should be used" for App Service.
Recommendation: Set minimum TLS to 1.2.
Applies to: azure_app_service.

## AZ-FUNC-002 — Function App permits TLS versions older than 1.2
Provider: azure; service: Azure Function App; severity: MEDIUM; pillar: security (SE:07 — Encrypt data).
The minimum inbound TLS version is 1.0 or 1.1.
Why it matters: MCSB DP-3; Azure Policy "Latest TLS version should be used" for Function App.
Recommendation: Set minimum TLS to 1.2.
Applies to: azure_functions.

## AZ-APP-003 — App Service allows unencrypted FTP deployment
Provider: azure; service: Azure App Service; severity: MEDIUM; pillar: security (SE:07 — Encrypt data).
FTP state is "AllAllowed" (plain FTP and FTPS).
Why it matters: MCSB DP-3; Azure Policy "FTPS should be required in your web App" (4d24b6d4…).
Recommendation: Set FTP state to "FTPS only" or "Disabled".
Applies to: azure_app_service.

## AZ-APP-010 — App Service health check is not configured
Provider: azure; service: Azure App Service; severity: LOW; pillar: reliability (RE:05 — Redundancy / health modeling).
No health check path is set, so unhealthy instances are not removed from rotation.
Why it matters: Azure Well-Architected Reliability guidance for App Service.
Recommendation: Expose a health endpoint and set the health check path.
Applies to: azure_app_service.

## AZ-APP-020 — App Service does not use HTTP/2
Provider: azure; service: Azure App Service; severity: LOW; pillar: performance_efficiency (PE:07 — Optimize code and infrastructure).
HTTP/2 is disabled, so clients open several connections instead of multiplexing requests over one.
Why it matters: Azure Well-Architected Performance Efficiency: optimize code and infrastructure. HTTP/2 reduces connection overhead and improves page load time.
Recommendation: Enable HTTP/2 on the App Service.
Applies to: azure_app_service.

## AZ-APP-021 — App Service "Always on" is disabled
Provider: azure; service: Azure App Service; severity: LOW; pillar: performance_efficiency (PE:07 — Optimize code and infrastructure).
The app is unloaded after a period of inactivity, so the next request waits for a cold start.
Why it matters: Azure Well-Architected Performance Efficiency: optimize code and infrastructure. Cold starts add seconds to the first request after idle time. (Always on needs the Basic tier or higher.)
Recommendation: Enable Always on for production apps (Basic tier or higher).
Applies to: azure_app_service.

## AZ-AFD-010 — Front Door caching is disabled
Provider: azure; service: Azure Front Door; severity: LOW; pillar: performance_efficiency (PE:07 — Optimize code and infrastructure).
Every request is forwarded to the origin because edge caching is off.
Why it matters: Azure Well-Architected Performance Efficiency: optimize code and infrastructure. Caching static content at the edge cuts latency and origin load.
Recommendation: Enable caching for cacheable content and set the query-string behaviour.
Applies to: azure_front_door.

## AZ-VMSS-010 — Scale set autoscale is disabled
Provider: azure; service: Azure Virtual Machine Scale Sets; severity: LOW; pillar: performance_efficiency (PE:05 — Optimize scaling and partitioning).
The scale set stays at a fixed instance count whatever the load.
Why it matters: Azure Well-Architected Performance Efficiency: optimize scaling and partitioning. A fixed-size scale set either runs out of headroom or pays for idle instances.
Recommendation: Enable autoscale with minimum and maximum instance counts and a metric rule.
Applies to: azure_vmss.

## AZ-AGW-010 — Application Gateway autoscale is disabled
Provider: azure; service: Azure Application Gateway; severity: LOW; pillar: performance_efficiency (PE:05 — Optimize scaling and partitioning).
The gateway runs at a fixed capacity instead of scaling with traffic.
Why it matters: Azure Well-Architected Performance Efficiency: optimize scaling and partitioning. A fixed-capacity gateway can throttle traffic at peaks or be over-provisioned the rest of the time.
Recommendation: Enable autoscale with a sensible minimum and maximum capacity.
Applies to: azure_app_gateway.

## AZ-AKS-001 — AKS Kubernetes RBAC is disabled
Provider: azure; service: Azure Kubernetes Service; severity: HIGH; pillar: security (SE:05 — Identity and access management).
Role-based access control is disabled for the cluster.
Why it matters: MCSB PA-7; Azure Policy "Role-Based Access Control (RBAC) should be used on Kubernetes Services" (ac4a19c2…).
Recommendation: Enable Kubernetes RBAC with Microsoft Entra integration.
Applies to: azure_aks.

## AZ-AKS-002 — AKS API server is publicly reachable without authorized IP ranges
Provider: azure; service: Azure Kubernetes Service; severity: MEDIUM; pillar: security (SE:06 — Network controls).
The cluster is not private and CloudBuilder has no authorized IP range configuration for the API server.
Why it matters: MCSB NS-2; Azure Policy "Authorized IP ranges should be defined on Kubernetes Services" (0e246bcf…).
Recommendation: Use a private cluster, or restrict API server access with authorized IP ranges.
Applies to: azure_aks.

## AZ-AKS-010 — AKS cluster uses the Free tier (no financially-backed API server SLA)
Provider: azure; service: Azure Kubernetes Service; severity: LOW; pillar: reliability (RE:05 — Redundancy).
The control plane runs on the Free tier.
Why it matters: Azure Well-Architected Reliability guidance for AKS recommends the Standard tier for production clusters.
Recommendation: Use the Standard tier for production clusters.
Applies to: azure_aks.

## AZ-AKS-030 — AKS cluster autoscaler is disabled
Provider: azure; service: Azure Kubernetes Service; severity: LOW; pillar: cost_optimization (CO:12 — Scaling costs).
The node pool runs a fixed node count.
Why it matters: Azure Well-Architected Cost Optimization: scale capacity with demand.
Recommendation: Enable the cluster autoscaler with sensible min/max node counts.
Applies to: azure_aks.

## AZ-AGW-001 — Application Gateway web application firewall is not enforcing
Provider: azure; service: Azure Application Gateway; severity: MEDIUM; pillar: security (SE:06 — Network controls).
The gateway uses the Standard_v2 SKU, has WAF disabled, or runs WAF in Detection mode.
Why it matters: MCSB NS-6; Azure Policy "Web Application Firewall (WAF) should be enabled for Application Gateway" (564feb30…). Detection mode logs but does not block, so it is a WARNING.
Recommendation: Use the WAF_v2 SKU with WAF in Prevention mode after tuning in Detection mode.
Applies to: azure_app_gateway.

## AZ-AFD-001 — Front Door accepts plaintext HTTP
Provider: azure; service: Azure Front Door; severity: MEDIUM; pillar: security (SE:07 — Encrypt data).
HTTPS-only / HTTP-to-HTTPS redirect is disabled on the route.
Why it matters: MCSB DP-3.
Recommendation: Accept HTTPS only and redirect HTTP to HTTPS.
Applies to: azure_front_door.

## AZ-AFD-002 — Front Door has no WAF policy
Provider: azure; service: Azure Front Door; severity: MEDIUM; pillar: security (SE:06 — Network controls).
No Azure WAF policy is connected to the Front Door profile in the architecture.
Why it matters: MCSB NS-6; Azure Policy "Azure Web Application Firewall should be enabled for Azure Front Door entry-points" (055aa869…). Managed rule sets require the Premium tier.
Recommendation: Attach a WAF policy (Premium tier for managed rule sets) in Prevention mode.
Applies to: azure_front_door.

## AZ-WAF-001 — WAF policy is in Detection mode
Provider: azure; service: Azure Web Application Firewall; severity: MEDIUM; pillar: security (SE:06 — Network controls).
Matching requests are logged but not blocked.
Why it matters: MCSB NS-6. Detection mode is appropriate while tuning, not for steady state.
Recommendation: Switch to Prevention mode after reviewing detections and adding exclusions.
Applies to: azure_waf.

## AZ-BAS-001 — Bastion shareable links are enabled
Provider: azure; service: Azure Bastion; severity: LOW; pillar: security (SE:05 — Identity and access management).
Users can create links that allow VM access without Azure portal sign-in.
Why it matters: Azure Bastion shareable links bypass portal-based access paths; they should be enabled only with governance over link creation and expiry.
Recommendation: Disable shareable links unless there is a governed business need.
Applies to: azure_bastion.

## AZ-ARCH-020 — Azure Monitor diagnostic settings and alert rules not modelled
Provider: azure; service: Azure Monitor; severity: MEDIUM; pillar: operational_excellence (OE:07 — Monitoring system).
CloudBuilder models the Log Analytics workspace (the Azure Monitor resource) but not the diagnostic settings that send each resource's logs to it, nor alert rules.
Why it matters: Whether each resource really sends logs to the workspace, and whether alerts exist, cannot be seen in the design, so this control is NOT EVALUATED with a clear data requirement. Whether a workspace is in the design at all is checked by AZ-MON-001.
Recommendation: Send platform metrics and resource logs to a Log Analytics workspace via diagnostic settings and define alert rules.
Applies to the whole architecture.

## AZ-ARCH-030 — Database-backed compute has no caching layer
Provider: azure; service: Azure Cache for Redis; severity: INFORMATIONAL; pillar: performance_efficiency (PE:08 — Data performance).
Azure SQL/Cosmos DB and compute resources are present without Azure Cache for Redis.
Why it matters: Azure Well-Architected Performance Efficiency: caching reduces repeated reads. Informational — it depends on the read pattern. (The previous rule looked for non-existent resource types and fired even when Redis was present.)
Recommendation: If read-heavy, add Azure Cache for Redis for hot data and sessions.
Applies to the whole architecture.

## AZ-ACCT-001 — Microsoft Defender for Cloud plans — subscription/tenant-level control
Provider: azure; service: Microsoft Defender for Cloud; severity: HIGH; pillar: security (SE:10 — Monitoring and threat detection).
Microsoft Defender for Cloud plans is configured at the subscription or tenant level, outside an architecture diagram.
Why it matters: Reported NOT EVALUATED at design time. CloudBuilder never assumes subscription or tenant controls are enabled.
Recommendation: Enable the Defender for Cloud plans relevant to the workload (Servers, SQL, Storage, Containers, Key Vault).
Applies to the whole architecture.

## AZ-ACCT-002 — Activity log export and diagnostic settings — subscription/tenant-level control
Provider: azure; service: Azure Monitor; severity: MEDIUM; pillar: security (SE:10 — Monitoring and threat detection).
Activity log export and diagnostic settings is configured at the subscription or tenant level, outside an architecture diagram.
Why it matters: Reported NOT EVALUATED at design time. CloudBuilder never assumes subscription or tenant controls are enabled.
Recommendation: Export the subscription Activity Log and resource logs to a Log Analytics workspace with defined retention.
Applies to the whole architecture.

## AZ-ACCT-003 — Multifactor authentication / Conditional Access — subscription/tenant-level control
Provider: azure; service: Microsoft Entra ID; severity: HIGH; pillar: security (SE:05 — Identity and access management).
Multifactor authentication / Conditional Access is configured at the subscription or tenant level, outside an architecture diagram.
Why it matters: Reported NOT EVALUATED at design time. CloudBuilder never assumes subscription or tenant controls are enabled.
Recommendation: Require MFA through Conditional Access for all users, and phishing-resistant MFA for privileged roles.
Applies to the whole architecture.

## AZ-PG-001 — PostgreSQL flexible server allows public network access
Provider: azure; service: Azure Database for PostgreSQL; severity: HIGH; pillar: security (SE:06 — Network controls).
The server has a public endpoint, reachable from the internet subject to its firewall rules and authentication.
Why it matters: MCSB NS-2: keep data services off the public internet. A flexible server with private access is placed in a delegated subnet of the application network.
Recommendation: Turn public access off and place the server in a subnet reserved for flexible servers.
Applies to: azure_postgres.

## AZ-PG-002 — PostgreSQL flexible server does not require TLS
Provider: azure; service: Azure Database for PostgreSQL; severity: HIGH; pillar: security (SE:07 — Encrypt data).
Clients can connect without encryption.
Why it matters: MCSB DP-3: encrypt data in transit. The server parameter require_secure_transport rejects unencrypted connections.
Recommendation: Require TLS for all connections.
Applies to: azure_postgres.

## AZ-PG-010 — PostgreSQL flexible server is not zone-redundant
Provider: azure; service: Azure Database for PostgreSQL; severity: MEDIUM; pillar: reliability (RE:05 — Redundancy).
High availability is off on a size that supports it, so a zone failure takes the database down.
Why it matters: Azure Well-Architected Reliability (redundancy). Burstable sizes do not offer zone-redundant high availability, so they are not evaluated.
Recommendation: Enable zone-redundant high availability for production databases on General Purpose or Memory Optimized sizes.
Applies to: azure_postgres.

## AZ-PG-011 — PostgreSQL backups are not geo-redundant
Provider: azure; service: Azure Database for PostgreSQL; severity: LOW; pillar: reliability (RE:09 — Business continuity and disaster recovery).
Backups are kept in the server's own region only.
Why it matters: Azure Well-Architected Reliability (BCDR): geo-redundant backups allow a restore in the paired region after a regional loss. LOW because it adds cost and may conflict with data residency.
Recommendation: Enable geo-redundant backup unless data residency forbids it.
Applies to: azure_postgres.

## AZ-PG-012 — Private PostgreSQL flexible server is not placed in a subnet
Provider: azure; service: Azure Database for PostgreSQL; severity: MEDIUM; pillar: security (SE:06 — Network controls).
Public access is off, but the server is not inside a subnet, so it cannot be created as a private server.
Why it matters: A flexible server with private access is injected into a subnet delegated to its service. Without a subnet the generated Terraform creates it with a public endpoint, contrary to the design.
Recommendation: Place the server in a subnet that holds nothing but flexible servers.
Applies to: azure_postgres.

## AZ-MY-001 — MySQL flexible server allows public network access
Provider: azure; service: Azure Database for MySQL; severity: HIGH; pillar: security (SE:06 — Network controls).
The server has a public endpoint, reachable from the internet subject to its firewall rules and authentication.
Why it matters: MCSB NS-2: keep data services off the public internet. A flexible server with private access is placed in a delegated subnet of the application network.
Recommendation: Turn public access off and place the server in a subnet reserved for flexible servers.
Applies to: azure_mysql.

## AZ-MY-002 — MySQL flexible server does not require TLS
Provider: azure; service: Azure Database for MySQL; severity: HIGH; pillar: security (SE:07 — Encrypt data).
Clients can connect without encryption.
Why it matters: MCSB DP-3: encrypt data in transit. The server parameter require_secure_transport rejects unencrypted connections.
Recommendation: Require TLS for all connections.
Applies to: azure_mysql.

## AZ-MY-010 — MySQL flexible server is not zone-redundant
Provider: azure; service: Azure Database for MySQL; severity: MEDIUM; pillar: reliability (RE:05 — Redundancy).
High availability is off on a size that supports it, so a zone failure takes the database down.
Why it matters: Azure Well-Architected Reliability (redundancy). Burstable sizes do not offer zone-redundant high availability, so they are not evaluated.
Recommendation: Enable zone-redundant high availability for production databases on General Purpose or Memory Optimized sizes.
Applies to: azure_mysql.

## AZ-MY-011 — MySQL backups are not geo-redundant
Provider: azure; service: Azure Database for MySQL; severity: LOW; pillar: reliability (RE:09 — Business continuity and disaster recovery).
Backups are kept in the server's own region only.
Why it matters: Azure Well-Architected Reliability (BCDR): geo-redundant backups allow a restore in the paired region after a regional loss. LOW because it adds cost and may conflict with data residency.
Recommendation: Enable geo-redundant backup unless data residency forbids it.
Applies to: azure_mysql.

## AZ-MY-012 — Private MySQL flexible server is not placed in a subnet
Provider: azure; service: Azure Database for MySQL; severity: MEDIUM; pillar: security (SE:06 — Network controls).
Public access is off, but the server is not inside a subnet, so it cannot be created as a private server.
Why it matters: A flexible server with private access is injected into a subnet delegated to its service. Without a subnet the generated Terraform creates it with a public endpoint, contrary to the design.
Recommendation: Place the server in a subnet that holds nothing but flexible servers.
Applies to: azure_mysql.

## AZ-PE-001 — Service has no public endpoint and no Private Endpoint, so nothing can reach it
Provider: azure; service: Azure Private Link; severity: HIGH; pillar: security (SE:06 — Network controls).
Public network access is off, but the design has no Private Endpoint giving the application a private path to the service.
Why it matters: MCSB NS-2. Turning the public endpoint off is the right security default, but it only works together with a Private Endpoint in the application network and a private DNS zone. Without one the service is unreachable, so the application fails at runtime however secure the design looks.
Recommendation: Add a Private Endpoint in a subnet of the application network and connect it to the service (CloudBuilder creates the private DNS zone and link).
Applies to: azure_sql, azure_storage, azure_key_vault, azure_redis, azure_cosmos_db, azure_acr, azure_event_hubs, azure_event_grid, azure_service_bus.

## AZ-PE-002 — Private Endpoint is not connected to a service or not placed in a subnet
Provider: azure; service: Azure Private Link; severity: MEDIUM; pillar: security (SE:06 — Network controls).
A Private Endpoint must sit in a subnet and be connected to the service it exposes, or no Terraform is generated for it.
Why it matters: The endpoint is a network interface in a subnet that maps to one service. Without both, it does nothing.
Recommendation: Place the endpoint in a subnet and connect it to one service.
Applies to: azure_private_endpoint.

## AZ-SB-001 — Service Bus namespace is reachable from the internet
Provider: azure; service: Azure Service Bus; severity: LOW; pillar: security (SE:06 — Network controls).
Public network access is on. Access still needs credentials, but the endpoint is open to anyone who has them.
Why it matters: MCSB NS-2. Private access (Private Endpoint) needs the Premium tier, which costs about $677 a month per messaging unit, so this is a recommendation and not a defect: Standard with TLS and Entra ID or keys is a common choice for modest workloads.
Recommendation: For sensitive workloads use the Premium tier with a Private Endpoint and turn public access off.
Applies to: azure_service_bus.

## AZ-SB-002 — Service Bus allows shared access keys
Provider: azure; service: Azure Service Bus; severity: LOW; pillar: security (SE:05 — Identity and access management).
Shared access signature keys can send and receive. They do not expire and are hard to scope.
Why it matters: MCSB IM-1 / IM-3: prefer Microsoft Entra ID (managed identities) over keys. LOW because turning keys off needs a role assignment for each application, which CloudBuilder does not generate.
Recommendation: Disable shared access keys and give each application a managed identity with the Azure Service Bus Data Sender / Receiver role.
Applies to: azure_service_bus.

## AZ-SB-003 — Service Bus permits TLS versions older than 1.2
Provider: azure; service: Azure Service Bus; severity: MEDIUM; pillar: security (SE:07 — Encrypt data).
The minimum TLS version is 1.0 or 1.1.
Why it matters: MCSB DP-3.
Recommendation: Set the minimum TLS version to 1.2.
Applies to: azure_service_bus.

## AZ-SB-010 — Premium Service Bus namespace is not zone-redundant
Provider: azure; service: Azure Service Bus; severity: LOW; pillar: reliability (RE:05 — Redundancy).
A Premium namespace can spread across availability zones; this one does not.
Why it matters: Azure Well-Architected Reliability (redundancy). Only the Premium tier offers zone redundancy, so other tiers are not evaluated.
Recommendation: Enable zone redundancy on the Premium namespace.
Applies to: azure_service_bus.

## AZ-ACR-001 — Container Registry admin user is enabled
Provider: azure; service: Azure Container Registry; severity: MEDIUM; pillar: security (SE:05 — Identity and access management).
The admin user is one shared username and password for the whole registry.
Why it matters: Microsoft recommends disabling the admin account: it cannot be scoped or audited per person and its password does not expire. Use managed identities or repository-scoped tokens.
Recommendation: Disable the admin user; let the platform pull images with its managed identity.
Applies to: azure_acr.

## AZ-ACR-002 — Container Registry is reachable from the internet
Provider: azure; service: Azure Container Registry; severity: LOW; pillar: security (SE:06 — Network controls).
Public network access is on. Pulling and pushing still needs credentials.
Why it matters: MCSB NS-2. Private access needs the Premium tier (about $50 a month) and a Private Endpoint, so this is a recommendation for sensitive images and not a defect.
Recommendation: For sensitive images use the Premium tier with a Private Endpoint and turn public access off.
Applies to: azure_acr.

## AZ-ACR-010 — Premium Container Registry is not zone-redundant
Provider: azure; service: Azure Container Registry; severity: LOW; pillar: reliability (RE:05 — Redundancy).
A Premium registry can be zone-redundant at no extra charge; this one is not.
Why it matters: Azure Well-Architected Reliability (redundancy). Zone redundancy is a Premium feature, so other tiers are not evaluated.
Recommendation: Enable zone redundancy on the Premium registry.
Applies to: azure_acr.

## AZ-FW-001 — Azure Firewall threat intelligence is off
Provider: azure; service: Azure Firewall; severity: MEDIUM; pillar: security (SE:06 — Network controls).
The firewall does not alert on or block traffic to and from known malicious addresses and domains.
Why it matters: MCSB NS-1 / LT-1: threat intelligence filtering is a built-in control of the firewall and costs nothing extra. "Alert" is the default; "Alert and deny" blocks as well.
Recommendation: Set threat intelligence to "Alert" (or "Alert and deny").
Applies to: azure_firewall.

## AZ-FW-010 — Azure Firewall is not spread across availability zones
Provider: azure; service: Azure Firewall; severity: LOW; pillar: reliability (RE:05 — Redundancy).
A firewall deployed without zones is lost with its single zone, and every route through it fails.
Why it matters: Azure Well-Architected Reliability (RE:05). Zones add no charge for the firewall itself. Zones are fixed when the firewall is created.
Recommendation: Deploy the firewall across zones 1, 2 and 3 in a region that offers them.
Applies to: azure_firewall.

## AZ-EH-001 — Event Hubs namespace is reachable from the internet
Provider: azure; service: Azure Event Hubs; severity: LOW; pillar: security (SE:06 — Network controls).
Public network access is on. Access still needs credentials.
Why it matters: MCSB NS-2. Private access needs a private endpoint, available on the Standard and Premium tiers, so this is a recommendation and not a defect.
Recommendation: Add a Private Endpoint and turn public access off.
Applies to: azure_event_hubs.

## AZ-EH-002 — Event Hubs allows shared access keys
Provider: azure; service: Azure Event Hubs; severity: LOW; pillar: security (SE:05 — Identity and access management).
Shared access signature keys can send and receive. They do not expire and are hard to scope.
Why it matters: MCSB IM-1 / IM-3: prefer Microsoft Entra ID (managed identities). LOW because turning keys off needs a role assignment for each application, which CloudBuilder does not generate.
Recommendation: Disable shared access keys and give each application a managed identity with the Azure Event Hubs Data Sender / Receiver role.
Applies to: azure_event_hubs.

## AZ-EH-003 — Event Hubs permits TLS versions older than 1.2
Provider: azure; service: Azure Event Hubs; severity: MEDIUM; pillar: security (SE:07 — Encrypt data).
The minimum TLS version is 1.0 or 1.1.
Why it matters: MCSB DP-3.
Recommendation: Set the minimum TLS version to 1.2.
Applies to: azure_event_hubs.

## AZ-EH-010 — Event Hubs namespace is not zone-redundant
Provider: azure; service: Azure Event Hubs; severity: LOW; pillar: reliability (RE:05 — Redundancy).
A zone failure interrupts event ingestion. The Basic tier does not offer zone redundancy, so it is not evaluated.
Why it matters: Azure Well-Architected Reliability (RE:05). Zone redundancy is chosen when the namespace is created, in regions that offer zones.
Recommendation: Enable zone redundancy on the namespace.
Applies to: azure_event_hubs.

## AZ-EG-001 — Event Grid topic is reachable from the internet
Provider: azure; service: Azure Event Grid; severity: LOW; pillar: security (SE:06 — Network controls).
Public network access is on. Publishing still needs a key or Entra ID token.
Why it matters: MCSB NS-2. A private endpoint costs about $7 a month, so this is a recommendation for sensitive topics.
Recommendation: Add a Private Endpoint and turn public access off.
Applies to: azure_event_grid.

## AZ-EG-002 — Event Grid topic allows access keys
Provider: azure; service: Azure Event Grid; severity: LOW; pillar: security (SE:05 — Identity and access management).
Access keys can publish to the topic. They do not expire and are hard to scope.
Why it matters: MCSB IM-1 / IM-3: prefer Microsoft Entra ID. LOW because turning keys off needs a role assignment for each publisher, which CloudBuilder does not generate.
Recommendation: Disable access keys and give publishers the Event Grid Data Sender role.
Applies to: azure_event_grid.

## AZ-APIM-001 — API Management is on the Developer tier, which has no SLA
Provider: azure; service: Azure API Management; severity: LOW; pillar: reliability (RE:05 — Redundancy).
The Developer tier is meant for development and testing: it has no service level agreement and no redundancy.
Why it matters: Azure Well-Architected Reliability. LOW because the tier is a deliberate choice for non-production designs. Basic and above carry an SLA.
Recommendation: Use the Basic, Standard or Premium tier (or Consumption) for production.
Applies to: azure_api_management.

## AZ-APIM-010 — Premium API Management is not spread across availability zones
Provider: azure; service: Azure API Management; severity: LOW; pillar: reliability (RE:05 — Redundancy).
Only the Premium tier can use zones; this one does not.
Why it matters: Azure Well-Architected Reliability (RE:05). Other tiers are not evaluated.
Recommendation: Set zones 1, 2 and 3 on the Premium instance.
Applies to: azure_api_management.

## AZ-CA-001 — Container App is in a subnet smaller than /23
Provider: azure; service: Azure Container Apps; severity: MEDIUM; pillar: reliability (RE:03 — Workload architecture).
A Container Apps environment placed in a subnet needs an address range of /23 or larger (512 addresses).
Why it matters: Azure requires a /23 or larger subnet for the Consumption-only environment type. A smaller subnet makes the deployment fail.
Recommendation: Give the app a subnet of its own with a /23 (or larger) address range.
Applies to: azure_container_apps.

## AZ-CA-002 — Container App ingress is open to the internet
Provider: azure; service: Azure Container Apps; severity: LOW; pillar: security (SE:06 — Network controls).
The app accepts traffic from the internet directly, without a gateway or firewall in front.
Why it matters: MCSB NS-1: put a WAF (Front Door or Application Gateway) in front of internet-facing apps and keep the app internal. LOW because a public API or site is often intended.
Recommendation: Put the app in a subnet with internal ingress and a Front Door or Application Gateway with a WAF in front.
Applies to: azure_container_apps.

## AZ-VMSS-011 — VM scale set is not spread across availability zones
Provider: azure; service: Azure Virtual Machine Scale Sets; severity: LOW; pillar: reliability (RE:05 — Redundancy).
The instances run in one place, so a single availability zone failing takes the tier down.
Why it matters: Azure Well-Architected Reliability (RE:05 redundancy): spread each tier across zones in regions that offer them. LOW because not every region has zones and a design may intentionally run in one.
Recommendation: Set Availability Zones to "Zones 1, 2 and 3" (or two zones) on the vm scale set, in a region that offers zones.
Applies to: azure_vmss.

## AZ-AGW-011 — Application Gateway is not spread across availability zones
Provider: azure; service: Azure Application Gateway; severity: LOW; pillar: reliability (RE:05 — Redundancy).
The gateway run in one place, so a single availability zone failing takes the tier down.
Why it matters: Azure Well-Architected Reliability (RE:05 redundancy): spread each tier across zones in regions that offer them. LOW because not every region has zones and a design may intentionally run in one.
Recommendation: Set Availability Zones to "Zones 1, 2 and 3" (or two zones) on the application gateway, in a region that offers zones.
Applies to: azure_app_gateway.

## AZ-MON-001 — Workload has no Azure Monitor workspace
Provider: azure; service: Azure Monitor; severity: LOW; pillar: operational_excellence (OE:07 — Monitoring system).
The design has compute or data services but no Log Analytics workspace to collect their telemetry.
Why it matters: Azure Well-Architected Operational Excellence (OE:07): without a workspace there is nowhere to keep logs and metrics. LOW because the platform keeps basic metrics anyway and a workspace adds cost.
Recommendation: Add an Azure Monitor resource (Log Analytics workspace, with Application Insights for application telemetry) and connect the workloads to it.
Applies to the whole architecture.
