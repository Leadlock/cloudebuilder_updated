# Resource catalog

Every resource type the CloudCraft canvas, validator and Terraform generator understand. Use only these types and only the settings listed. Settings not listed do not exist and are rejected.

## aws_vpc — VPC
Provider: aws; category: networking.
Container. May contain: aws_subnet, aws_igw, aws_nat, aws_sg, aws_route_table, aws_nacl.
Allowed parent(s): aws_cloud_boundary.
Assessment rules that check this type: AWS-VPC-002 (low), AWS-VPC-003 (medium). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-vpc"
- cidrBlock (cidr); default "10.0.0.0/16"
- enableDnsSupport (boolean); default true
- enableDnsHostnames (boolean); default true
- flowLogsEnabled (boolean); default false
- flowLogsBucket (text); default ""
- flowLogsTrafficType (select one of [ALL, REJECT, ACCEPT]); default "ALL"

## aws_subnet — Subnet
Provider: aws; category: networking.
Container. May contain: aws_ec2, aws_rds, aws_alb, aws_nat, aws_lambda, aws_ecs, aws_auto_scaling, aws_elasticache, aws_nacl.
Allowed parent(s): aws_vpc.
Assessment rules that check this type: AWS-VPC-001 (medium). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-subnet"
- cidrBlock (cidr); default "10.0.1.0/24"
- availabilityZone (select one of [us-east-1a, us-east-1b, us-east-1c, us-east-2a, us-east-2b, us-west-1a, us-west-1b, us-west-2a, us-west-2b, ca-central-1a, ca-central-1b, ca-west-1a, ca-west-1b, mx-central-1a, mx-central-1b, eu-west-1a, eu-west-1b, eu-west-2a, eu-west-2b, eu-west-3a, eu-west-3b, eu-central-1a, eu-central-1b, eu-central-2a, eu-central-2b, eu-north-1a, eu-north-1b, eu-south-1a, eu-south-1b, eu-south-2a, eu-south-2b, ap-south-1a, ap-south-1b, ap-south-2a, ap-south-2b, ap-southeast-1a, ap-southeast-1b, ap-southeast-2a, ap-southeast-2b, ap-southeast-3a, ap-southeast-3b, ap-southeast-4a, ap-southeast-4b, ap-northeast-1a, ap-northeast-1b, ap-northeast-2a, ap-northeast-2b, ap-northeast-3a, ap-northeast-3b, ap-east-1a, ap-east-1b, sa-east-1a, sa-east-1b, me-south-1a, me-south-1b, me-central-1a, me-central-1b, il-central-1a, il-central-1b, af-south-1a, af-south-1b]); default "us-east-1a"
- mapPublicIpOnLaunch (boolean); default false

## aws_ec2 — EC2 Instance
Provider: aws; category: compute.
Allowed parent(s): aws_subnet.
Assessment rules that check this type: AWS-EC2-001 (medium), AWS-EC2-002 (medium), AWS-EC2-003 (high), AWS-EC2-010 (low), AWS-COST-001 (low), AWS-SUS-002 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-ec2"
- os (select one of [Ubuntu 24.04 LTS, Amazon Linux 2023, Debian 12 Bookworm, Red Hat Enterprise Linux 9, Windows Server 2022 Base]); default "Ubuntu 24.04 LTS"
- ami (text); default "ami-0c55b159cbfafe1f0"
- instanceType (select one of [t3.micro, t3.small, t3.medium, t3.large, t4g.small, t4g.medium, m5.large, c5.large, r5.large, c6g.xlarge, c6g.2xlarge, c6g.4xlarge]); default "t3.medium"
- tenancy (select one of [default, dedicated, host]); default "default"
- storageGb (number range 8–65536); default 30
- storageType (select one of [gp3, gp2, io1, io2]); default "gp3"
- storageIops (number range 100–256000); default 3000
- encrypted (boolean); default true
- deleteOnTermination (boolean); default true
- associatePublicIpAddress (boolean); default false
- ebsOptimized (boolean); default true
- keyName (text); default ""
- iamInstanceProfile (text); default ""
- metadataHttpTokens (select one of [required, optional]); default "required"
- detailedMonitoring (boolean); default false
- terminationProtection (boolean); default false
- instanceInitiatedShutdownBehavior (select one of [stop, terminate]); default "stop"
- userData (text); default ""
- tags (keyvalue); default {}

## aws_s3 — S3 Bucket
Provider: aws; category: storage.
Allowed parent(s): aws_cloud_boundary.
Assessment rules that check this type: AWS-S3-001 (critical), AWS-S3-002 (low), AWS-S3-003 (low), AWS-S3-004 (medium), AWS-S3-005 (low), AWS-S3-006 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-s3"
- bucketName (text); default "my-bucket"
- versioning (boolean); default true
- defaultStorageClass (select one of [STANDARD, INTELLIGENT_TIERING, STANDARD_IA, ONEZONE_IA, GLACIER_IR]); default "STANDARD"
- lifecycleTransitionDays (number range 0–3650); default 0
- lifecycleTransitionStorageClass (select one of [STANDARD_IA, ONEZONE_IA, GLACIER, DEEP_ARCHIVE]); default "STANDARD_IA"
- lifecycleExpirationDays (number range 0–3650); default 0
- encryption (boolean); default true
- encryptionType (select one of [AES256, aws:kms]); default "AES256"
- kmsKeyId (text); default ""
- publicAccess (boolean); default false
- blockPublicAcls (boolean); default true
- blockPublicPolicy (boolean); default true
- objectOwnership (select one of [BucketOwnerEnforced, BucketOwnerPreferred, ObjectWriter]); default "BucketOwnerEnforced"
- loggingEnabled (boolean); default false
- transferAcceleration (boolean); default false
- requesterPays (boolean); default false
- estimatedStorageGb (number range 0–…); default 50
- estimatedRequestsPerMonth (number range 0–…); default 100000
- tags (keyvalue); default {}

## aws_rds — RDS Instance
Provider: aws; category: database.
Allowed parent(s): aws_subnet.
Assessment rules that check this type: AWS-RDS-001 (critical), AWS-RDS-002 (high), AWS-RDS-003 (low), AWS-RDS-004 (low), AWS-RDS-005 (medium), AWS-RDS-006 (medium), AWS-RDS-007 (high), AWS-RDS-008 (low), AWS-RDS-009 (low), AWS-COST-001 (low), AWS-PERF-004 (low), AWS-SUS-002 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-rds"
- engine (select one of [postgres, mysql, aurora-postgresql, aurora-mysql, mariadb]); default "postgres"
- engineVersion (text); default "16.4"
- instanceClass (select one of [db.t3.micro, db.t3.small, db.t3.medium, db.m5.large, db.r5.large, db.t4g.micro, db.t4g.medium, db.r6g.xlarge, db.r6g.2xlarge, db.r6g.4xlarge]); default "db.t3.medium"
- allocatedStorage (number range 20–65536); default 50
- storageType (select one of [gp3, gp2, io1, io2, standard]); default "gp3"
- iops (number range 1000–256000); default 3000
- storageThroughput (number range 125–4000); default 125
- maxAllocatedStorage (number range 0–…); default 0
- multiAz (boolean); default true
- readReplicas (number range 0–15); default 0
- encrypted (boolean); default true
- kmsKeyId (text); default ""
- publiclyAccessible (boolean); default false
- iamDatabaseAuthenticationEnabled (boolean); default false
- masterUsername (text); default "admin"
- port (number range 1150–65535); default 5432
- backupRetentionPeriod (number range 0–35); default 7
- preferredBackupWindow (text); default "03:00-04:00"
- copyTagsToSnapshot (boolean); default true
- deletionProtection (boolean); default true
- enablePerformanceInsights (boolean); default false
- performanceInsightsRetentionPeriod (select one of [7, 31, 93, 731]); default "7"
- monitoringInterval (select one of [0, 1, 5, 10, 15, 30, 60]); default 0
- enableCloudwatchLogsExports (multiselect one of [general, error, slowquery, audit, postgresql, upgrade]); default []
- autoMinorVersionUpgrade (boolean); default true
- preferredMaintenanceWindow (text); default "sun:05:00-sun:06:00"
- parameterGroupName (text); default ""
- tags (keyvalue); default {}

## aws_internet — Internet
Provider: aws; category: networking.
Allowed parent(s): aws_cloud_boundary.
Settings:
- name (text); default "Internet"

## aws_cloudfront — CloudFront
Provider: aws; category: networking.
Allowed parent(s): aws_cloud_boundary.
Assessment rules that check this type: AWS-CF-001 (medium), AWS-CF-002 (medium), AWS-CF-003 (low), AWS-PERF-001 (low), AWS-PERF-002 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-cdn"
- priceClass (select one of [PriceClass_100, PriceClass_200, PriceClass_All]); default "PriceClass_100"
- estimatedDataTransferGb (number range 0–…); default 1000
- estimatedRequests (number range 0–…); default 10000000
- defaultRootObject (text); default "index.html"
- enabled (boolean); default true
- viewerProtocolPolicy (select one of [redirect-to-https, https-only, allow-all]); default "redirect-to-https"
- useCustomCertificate (boolean); default false
- customCertificateArn (text); default ""
- minimumProtocolVersion (select one of [TLSv1.2_2021, TLSv1.2_2019, TLSv1_2016]); default "TLSv1.2_2021"
- webAclId (text); default ""
- loggingEnabled (boolean); default false
- loggingBucket (text); default ""
- minTtl (number range 0–…); default 0
- defaultTtl (number range 0–…); default 3600
- maxTtl (number range 0–…); default 86400
- compressionEnabled (boolean); default true
- httpVersion (select one of [http1.1, http2, http2and3]); default "http2"
- ipv6Enabled (boolean); default true
- geoRestrictionType (select one of [none, whitelist, blacklist]); default "none"
- geoRestrictionCountries (tags); default []
- tags (keyvalue); default {}

## aws_alb — Load Balancer
Provider: aws; category: loadbalancing.
Allowed parent(s): aws_subnet.
Assessment rules that check this type: AWS-ELB-001 (medium), AWS-ELB-002 (medium), AWS-ELB-003 (medium), AWS-ELB-004 (low), AWS-ELB-005 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-alb"
- lbType (select one of [application, network, gateway]); default "application"
- scheme (select one of [internet-facing, internal]); default "internet-facing"
- listenerPort (number range 1–65535); default 443
- listenerProtocol (select one of [HTTP, HTTPS, TCP, TLS]); default "HTTPS"
- certificateArn (text); default ""
- sslPolicy (select one of [ELBSecurityPolicy-TLS13-1-2-2021-06, ELBSecurityPolicy-TLS-1-2-2017-01, ELBSecurityPolicy-FS-1-2-Res-2019-08]); default "ELBSecurityPolicy-TLS13-1-2-2021-06"
- targetPort (number range 1–65535); default 80
- targetProtocol (select one of [HTTP, HTTPS]); default "HTTP"
- healthCheckPath (text); default "/"
- healthCheckIntervalSeconds (number range 5–300); default 30
- idleTimeoutSeconds (number range 1–4000); default 60
- deletionProtection (boolean); default false
- accessLogsEnabled (boolean); default false
- accessLogsBucket (text); default ""
- tags (keyvalue); default {}

## aws_auto_scaling — Auto Scaling
Provider: aws; category: compute.
Allowed parent(s): aws_subnet.
Assessment rules that check this type: AWS-ASG-001 (low), AWS-PERF-003 (low), AWS-SUS-002 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-asg"
- instanceType (text); default "t3.medium"
- amiId (text); default "ami-0c55b159cbfafe1f0"
- minSize (number range 0–1000); default 2
- maxSize (number range 1–1000); default 10
- desiredCapacity (number range 0–1000); default 2
- scalingPolicyEnabled (boolean); default true
- targetCpuUtilization (number range 1–100); default 60
- healthCheckType (select one of [EC2, ELB]); default "EC2"
- healthCheckGracePeriodSeconds (number range 0–7200); default 300
- defaultCooldownSeconds (number range 0–86400); default 300
- tags (keyvalue); default {}

## aws_lambda — Lambda
Provider: aws; category: compute.
Allowed parent(s): aws_subnet.
Assessment rules that check this type: AWS-LAMBDA-001 (low), AWS-SUS-001 (informational). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-lambda"
- runtime (select one of [nodejs20.x, nodejs22.x, python3.13, python3.12, java21, provided.al2023, dotnet8]); default "nodejs20.x"
- handler (text); default "index.handler"
- memorySize (number range 128–10240); default 512
- architecture (select one of [x86_64, arm64]); default "x86_64"
- timeout (number range 1–900); default 15
- ephemeralStorageMb (number range 512–10240); default 512
- reservedConcurrency (number range -1–1000); default -1
- provisionedConcurrency (number range 0–1000); default 0
- tracingMode (select one of [PassThrough, Active]); default "PassThrough"
- environmentVariables (keyvalue); default {}
- estimatedInvocationsPerMonth (number range 0–…); default 1000000
- estimatedAvgDurationMs (number range 1–…); default 100
- tags (keyvalue); default {}

## aws_ecs — ECS Service
Provider: aws; category: compute.
Allowed parent(s): aws_subnet.
Assessment rules that check this type: AWS-ECS-001 (high), AWS-COST-003 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-ecs"
- containerImage (text); default "nginx:latest"
- containerPort (number range 1–65535); default 80
- launchType (select one of [FARGATE, EC2]); default "FARGATE"
- desiredCount (number range 0–1000); default 2
- cpu (number); default 256
- memory (number); default 512
- assignPublicIp (boolean); default false
- minCapacity (number range 0–1000); default 1
- maxCapacity (number range 1–1000); default 10
- healthCheckGracePeriodSeconds (number range 0–2147483647); default 0
- logRetentionDays (number range 1–3650); default 30
- environmentVariables (keyvalue); default {}
- tags (keyvalue); default {}

## aws_eks — EKS Cluster
Provider: aws; category: compute.
No container: omit "parent".
Assessment rules that check this type: AWS-EKS-001 (high), AWS-EKS-002 (medium), AWS-EKS-003 (medium). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-eks"
- version (text); default "1.30"
- nodeInstanceType (select one of [t3.medium, t3.large, m5.large, m5.xlarge, c6g.xlarge]); default "t3.medium"
- nodeCount (number range 1–100); default 3
- capacityType (select one of [ON_DEMAND, SPOT]); default "ON_DEMAND"
- nodeDiskSizeGb (number range 20–16384); default 20
- endpointPublicAccess (boolean); default true
- endpointPrivateAccess (boolean); default false
- publicAccessCidrs (cidr); default "0.0.0.0/0"
- clusterLogTypes (multiselect one of [api, audit, authenticator, controllerManager, scheduler]); default ["api","audit"]
- secretsEncryption (boolean); default true
- tags (keyvalue); default {}

## aws_igw — Internet Gateway
Provider: aws; category: networking.
Allowed parent(s): aws_vpc.
Settings:
- name (text); default "my-igw"

## aws_nat — NAT Gateway
Provider: aws; category: networking.
Allowed parent(s): aws_vpc, aws_subnet.
Settings:
- name (text); default "my-nat"
- connectivityType (select one of [public, private]); default "public"
- eipAllocationId (text); default ""
- privateIpAddress (text); default ""
- secondaryAllocationIds (tags); default []
- tags (keyvalue); default {}

## aws_route_table — Route Table
Provider: aws; category: networking.
Allowed parent(s): aws_vpc.
Settings:
- name (text); default "my-route-table"
- isMain (boolean); default false
- targetType (select one of [internet_gateway, nat_gateway, none]); default "internet_gateway"
- destinationCidr (cidr); default "0.0.0.0/0"
- tags (keyvalue); default {}

## aws_nacl — Network ACL
Provider: aws; category: security.
Allowed parent(s): aws_vpc, aws_subnet.
Assessment rules that check this type: AWS-NACL-001 (medium). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-nacl"
- allowAllInbound (boolean); default false
- inboundCidr (cidr); default "10.0.0.0/16"
- inboundProtocol (select one of [tcp, udp, icmp, all]); default "tcp"
- inboundPortFrom (number range 0–65535); default 443
- inboundPortTo (number range 0–65535); default 443
- allowAllOutbound (boolean); default true
- outboundCidr (cidr); default "0.0.0.0/0"
- outboundProtocol (select one of [tcp, udp, icmp, all]); default "all"
- tags (keyvalue); default {}

## aws_sg — Security Group
Provider: aws; category: security.
Allowed parent(s): aws_vpc.
Assessment rules that check this type: AWS-SG-001 (high), AWS-SG-002 (high). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-sg"
- description (text); default ""
- allowHttp (boolean); default true
- allowHttps (boolean); default true
- allowSsh (boolean); default false
- allowRdp (boolean); default false
- sourceCidr (cidr); default "0.0.0.0/0"
- allowAllOutbound (boolean); default true
- egressCidr (cidr); default "0.0.0.0/0"
- tags (keyvalue); default {}

## aws_iam — IAM Role
Provider: aws; category: security.
Allowed parent(s): aws_cloud_boundary.
Assessment rules that check this type: AWS-IAM-001 (high). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-ec2-role"
- trustedService (select one of [ec2.amazonaws.com, lambda.amazonaws.com, ecs-tasks.amazonaws.com, eks.amazonaws.com, rds.amazonaws.com, events.amazonaws.com]); default "ec2.amazonaws.com"
- managedPolicyArns (multiselect one of [arn:aws:iam::aws:policy/ReadOnlyAccess, arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess, arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess, arn:aws:iam::aws:policy/SecretsManagerReadWrite, arn:aws:iam::aws:policy/CloudWatchLogsFullAccess, arn:aws:iam::aws:policy/AdministratorAccess]); default []
- maxSessionDurationSeconds (number range 3600–43200); default 3600
- tags (keyvalue); default {}

## aws_kms — KMS Key
Provider: aws; category: security.
No container: omit "parent".
Assessment rules that check this type: AWS-KMS-001 (medium). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-kms-key"
- enableKeyRotation (boolean); default true
- keyUsage (select one of [ENCRYPT_DECRYPT, SIGN_VERIFY]); default "ENCRYPT_DECRYPT"
- keySpec (select one of [SYMMETRIC_DEFAULT, RSA_2048, RSA_4096, ECC_NIST_P256]); default "SYMMETRIC_DEFAULT"
- multiRegion (boolean); default false
- deletionWindowDays (number range 7–30); default 30
- tags (keyvalue); default {}

## aws_cloudwatch — CloudWatch
Provider: aws; category: monitoring.
No container: omit "parent".
Assessment rules that check this type: AWS-COST-003 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-alarm"
- metricName (text); default "CPUUtilization"
- namespace (text); default "AWS/EC2"
- threshold (number); default 80
- comparisonOperator (select one of [GreaterThanThreshold, GreaterThanOrEqualToThreshold, LessThanThreshold, LessThanOrEqualToThreshold]); default "GreaterThanThreshold"
- evaluationPeriods (number range 1–288); default 2
- periodSeconds (select one of [10, 30, 60, 300, 900]); default 300
- statistic (select one of [Average, Sum, Minimum, Maximum, SampleCount]); default "Average"
- treatMissingData (select one of [missing, notBreaching, breaching, ignore]); default "missing"
- logRetentionDays (number range 1–3650); default 30
- tags (keyvalue); default {}

## aws_ebs — EBS Volume
Provider: aws; category: storage.
No container: omit "parent".
Assessment rules that check this type: AWS-EBS-001 (medium), AWS-EBS-002 (low), AWS-COST-001 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-ebs"
- availabilityZone (text); default "us-east-1a"
- sizeGb (number range 1–65536); default 100
- volumeType (select one of [gp3, gp2, io1, io2, st1, sc1]); default "gp3"
- iops (number range 100–256000); default 3000
- throughputMbps (number range 125–4000); default 125
- encrypted (boolean); default true
- kmsKeyId (text); default ""
- multiAttachEnabled (boolean); default false
- snapshotSchedule (select one of [none, daily, weekly]); default "daily"
- tags (keyvalue); default {}

## aws_dynamodb — DynamoDB
Provider: aws; category: database.
No container: omit "parent".
Assessment rules that check this type: AWS-DDB-001 (informational), AWS-DDB-002 (medium), AWS-DDB-003 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-table"
- partitionKeyName (text); default "id"
- partitionKeyType (select one of [S, N, B]); default "S"
- sortKeyName (text); default ""
- sortKeyType (select one of [S, N, B]); default "S"
- billingMode (select one of [PAY_PER_REQUEST, PROVISIONED]); default "PAY_PER_REQUEST"
- readCapacity (number range 1–40000); default 5
- writeCapacity (number range 1–40000); default 5
- tableClass (select one of [STANDARD, STANDARD_INFREQUENT_ACCESS]); default "STANDARD"
- serverSideEncryption (boolean); default true
- pointInTimeRecovery (boolean); default true
- deletionProtection (boolean); default false
- streamEnabled (boolean); default false
- streamViewType (select one of [KEYS_ONLY, NEW_IMAGE, OLD_IMAGE, NEW_AND_OLD_IMAGES]); default "NEW_AND_OLD_IMAGES"
- ttlAttribute (text); default ""
- estimatedStorageGb (number range 0–…); default 5
- estimatedReadRequestUnitsPerMonth (number range 0–…); default 1000000
- estimatedWriteRequestUnitsPerMonth (number range 0–…); default 500000
- tags (keyvalue); default {}

## aws_route53 — Route 53
Provider: aws; category: networking.
Allowed parent(s): aws_cloud_boundary.
Settings:
- name (text); default "my-hosted-zone"
- domainName (text); default "example.com"
- hostedZoneType (select one of [Public, Private]); default "Public"
- comment (text); default ""
- recordType (select one of [A, AAAA, CNAME, MX, TXT, NS]); default "A"
- recordValue (text); default ""
- ttl (number range 1–172800); default 300
- routingPolicy (select one of [Simple, Weighted]); default "Simple"
- weight (number range 0–255); default 100
- tags (keyvalue); default {}

## aws_waf — AWS WAF
Provider: aws; category: security.
Allowed parent(s): aws_cloud_boundary.
Assessment rules that check this type: AWS-WAF-001 (medium), AWS-WAF-002 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-waf-acl"
- scope (select one of [REGIONAL, CLOUDFRONT]); default "REGIONAL"
- defaultAction (select one of [ALLOW, BLOCK]); default "ALLOW"
- managedRuleGroups (multiselect one of [AWSManagedRulesCommonRuleSet, AWSManagedRulesKnownBadInputsRuleSet, AWSManagedRulesSQLiRuleSet, AWSManagedRulesLinuxRuleSet, AWSManagedRulesAmazonIpReputationList, AWSManagedRulesAnonymousIpList]); default ["AWSManagedRulesCommonRuleSet","AWSManagedRulesKnownBadInputsRuleSet"]
- rateLimitEnabled (boolean); default false
- rateLimitThreshold (number range 100–20000000); default 2000
- cloudWatchMetricsEnabled (boolean); default true
- sampledRequestsEnabled (boolean); default true
- tags (keyvalue); default {}

## aws_elasticache — ElastiCache Redis
Provider: aws; category: database.
Allowed parent(s): aws_subnet.
Assessment rules that check this type: AWS-ELC-001 (medium), AWS-ELC-002 (medium), AWS-ELC-003 (medium), AWS-ELC-004 (medium). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-redis-cache"
- engine (select one of [redis, valkey]); default "redis"
- engineVersion (text); default "7.1"
- nodeType (select one of [cache.t3.micro, cache.t3.small, cache.t3.medium, cache.r6g.large, cache.r6g.xlarge]); default "cache.t3.medium"
- numNodes (number range 1–6); default 2
- automaticFailoverEnabled (boolean); default true
- multiAzEnabled (boolean); default true
- transitEncryption (boolean); default true
- atRestEncryption (boolean); default true
- port (number range 1–65535); default 6379
- snapshotRetentionLimit (number range 0–35); default 5
- tags (keyvalue); default {}

## aws_sqs — SQS Queue
Provider: aws; category: messaging.
Allowed parent(s): aws_cloud_boundary.
Assessment rules that check this type: AWS-SQS-001 (medium), AWS-SQS-002 (low), AWS-COST-002 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-app-queue"
- fifoQueue (boolean); default false
- contentBasedDeduplication (boolean); default false
- encryption (boolean); default true
- kmsMasterKeyId (text); default ""
- visibilityTimeoutSeconds (number range 0–43200); default 30
- messageRetentionSeconds (number range 60–1209600); default 345600
- delaySeconds (number range 0–900); default 0
- receiveWaitTimeSeconds (number range 0–20); default 0
- deadLetterTargetArn (text); default ""
- maxReceiveCount (number range 1–1000); default 5
- estimatedRequestsPerMonth (number range 0–…); default 1000000
- tags (keyvalue); default {}

## aws_cloud_boundary — AWS Cloud Boundary
Provider: aws; category: networking.
Container. May contain: aws_vpc, aws_s3, aws_cloudfront, aws_internet, aws_iam, aws_waf, aws_route53, aws_sqs.
Top-level container.
Settings:
- name (text); default "Amazon Web Services"
- region (text); default "us-east-1"

## azure_resource_group — Resource Group
Provider: azure; category: networking.
Container. May contain: azure_vnet, azure_storage, azure_sql, azure_key_vault, azure_postgres, azure_mysql, azure_service_bus, azure_acr, azure_monitor.
Allowed parent(s): azure_cloud_boundary.
Settings:
- name (text); default "my-rg"
- location (select one of [eastus, eastus2, westus, westus2, northeurope, westeurope, southeastasia]); default "eastus"

## azure_vnet — Virtual Network
Provider: azure; category: networking.
Container. May contain: azure_subnet, azure_nsg, azure_nat, azure_route_table, azure_bastion.
Allowed parent(s): azure_resource_group, azure_cloud_boundary.
Settings:
- name (text); default "my-vnet"
- addressSpace (cidr); default "10.0.0.0/16"

## azure_subnet — Subnet
Provider: azure; category: networking.
Container. May contain: azure_vm, azure_vmss, azure_lb, azure_app_gateway, azure_sql, azure_redis, azure_functions, azure_aks, azure_nic, azure_postgres, azure_mysql, azure_private_endpoint.
Allowed parent(s): azure_vnet.
Settings:
- name (text); default "my-subnet"
- addressPrefix (cidr); default "10.0.1.0/24"

## azure_vm — Virtual Machine
Provider: azure; category: compute.
Allowed parent(s): azure_subnet.
Assessment rules that check this type: AZ-VM-001 (medium), AZ-VM-002 (low), AZ-VM-010 (medium), AZ-VM-011 (low), AZ-VM-020 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-vm"
- osType (select one of [Linux, Windows]); default "Linux"
- size (select one of [Standard_B1s, Standard_B2s, Standard_B4ms, Standard_D2s_v3, Standard_D4s_v3, Standard_E2s_v3, Standard_D4s_v5, Standard_D8s_v5, Standard_E8s_v5]); default "Standard_B2s"
- availabilityZone (select one of [, 1, 2, 3]); default ""
- useManagedDisk (boolean); default true
- osDiskType (select one of [Premium_LRS, StandardSSD_LRS, Standard_LRS, PremiumV2_LRS]); default "Premium_LRS"
- osDiskCaching (select one of [None, ReadOnly, ReadWrite]); default "ReadWrite"
- osDiskSizeGb (number range 0–4095); default 0
- publicIpEnabled (boolean); default false
- adminUsername (text); default "azureuser"
- bootDiagnosticsEnabled (boolean); default true
- encryptionAtHostEnabled (boolean); default false
- customData (text); default ""
- tags (keyvalue); default {}

## azure_storage — Storage Account
Provider: azure; category: storage.
Allowed parent(s): azure_resource_group, azure_cloud_boundary.
Assessment rules that check this type: AZ-STG-001 (high), AZ-STG-002 (high), AZ-STG-003 (medium), AZ-STG-004 (medium), AZ-STG-005 (low), AZ-STG-006 (low), AZ-PE-001 (high). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "mystorageacct"
- sku (select one of [Standard_LRS, Standard_ZRS, Standard_GRS, Premium_LRS]); default "Standard_LRS"
- kind (select one of [StorageV2, BlobStorage, FileStorage]); default "StorageV2"
- httpsOnly (boolean); default true
- allowBlobPublicAccess (boolean); default false
- minimumTlsVersion (select one of [TLS1_0, TLS1_1, TLS1_2]); default "TLS1_2"
- networkDefaultAction (select one of [Allow, Deny]); default "Allow"
- blobVersioningEnabled (boolean); default false
- blobSoftDeleteRetentionDays (number range 0–365); default 0
- tags (keyvalue); default {}

## azure_sql — Azure SQL
Provider: azure; category: database.
Allowed parent(s): azure_resource_group, azure_subnet, azure_cloud_boundary.
Assessment rules that check this type: AZ-SQL-001 (high), AZ-SQL-002 (high), AZ-SQL-003 (medium), AZ-SQL-004 (medium), AZ-SQL-005 (medium), AZ-SQL-006 (medium), AZ-SQL-010 (medium), AZ-SQL-011 (low), AZ-PE-001 (high). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-sql"
- tier (select one of [Basic, Standard, Premium, GeneralPurpose, BusinessCritical, GP_Gen5_2, GP_Gen5_8, BC_Gen5_16]); default "Standard"
- maxSizeGb (number range 1–4096); default 250
- requestedBackupStorageRedundancy (select one of [Local, Zone, Geo, GeoZone]); default "Geo"
- zoneRedundant (boolean); default false
- readScale (boolean); default false
- publicNetworkAccess (boolean); default false
- allowAzureServices (boolean); default true
- minimumTlsVersion (select one of [1.0, 1.1, 1.2]); default "1.2"
- transparentDataEncryptionEnabled (boolean); default true
- threatDetectionEnabled (boolean); default true
- auditingEnabled (boolean); default false
- tags (keyvalue); default {}

## azure_cosmos_db — Cosmos DB
Provider: azure; category: database.
No container: omit "parent".
Assessment rules that check this type: AZ-COS-001 (high), AZ-COS-010 (low), AZ-PE-001 (high). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-cosmos"
- kind (select one of [GlobalDocumentDB, MongoDB]); default "GlobalDocumentDB"
- defaultConsistency (select one of [Strong, BoundedStaleness, Session, ConsistentPrefix, Eventual]); default "Session"
- throughputMode (select one of [Serverless, Provisioned]); default "Serverless"
- maxThroughputRu (number range 1000–1000000); default 4000
- enableAutomaticFailover (boolean); default true
- publicNetworkAccess (boolean); default false
- backupType (select one of [Periodic, Continuous]); default "Periodic"
- tags (keyvalue); default {}

## azure_lb — Load Balancer
Provider: azure; category: loadbalancing.
Allowed parent(s): azure_subnet.
Settings:
- name (text); default "my-lb"
- sku (select one of [Basic, Standard]); default "Standard"
- type (select one of [Public, Internal]); default "Public"
- backendPort (number range 1–65535); default 80
- healthProbeProtocol (select one of [Http, Https, Tcp]); default "Http"
- healthProbePath (text); default "/"
- tags (keyvalue); default {}

## azure_app_gateway — App Gateway
Provider: azure; category: loadbalancing.
Allowed parent(s): azure_subnet.
Assessment rules that check this type: AZ-AGW-010 (low), AZ-AGW-001 (medium), AZ-AGW-011 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-app-gateway"
- sku (select one of [Standard_v2, WAF_v2]); default "Standard_v2"
- backendPort (number range 1–65535); default 80
- zones (select one of [, 1,2, 1,2,3]); default ""
- autoscaleEnabled (boolean); default true
- minCapacity (number range 0–125); default 2
- maxCapacity (number range 2–125); default 10
- capacity (number range 1–125); default 2
- wafEnabled (boolean); default false
- wafMode (select one of [Prevention, Detection]); default "Prevention"
- tags (keyvalue); default {}

## azure_nat — NAT Gateway
Provider: azure; category: networking.
Allowed parent(s): azure_vnet.
Settings:
- name (text); default "my-nat"
- idleTimeoutMin (number range 4–120); default 4
- sku (select one of [Standard]); default "Standard"
- availabilityZone (select one of [, 1, 2, 3]); default ""
- tags (keyvalue); default {}

## azure_nsg — Network Security Group
Provider: azure; category: security.
Allowed parent(s): azure_vnet.
Assessment rules that check this type: AZ-NSG-001 (high), AZ-NSG-002 (high). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-nsg"
- description (text); default ""
- allowHttp (boolean); default true
- allowHttps (boolean); default true
- allowSsh (boolean); default false
- allowRdp (boolean); default false
- sourceCidr (text); default "*"
- allowAllOutbound (boolean); default true
- egressCidr (text); default "*"
- tags (keyvalue); default {}

## azure_route_table — Route Table
Provider: azure; category: networking.
Allowed parent(s): azure_vnet.
Settings:
- name (text); default "my-route-table"
- disableBgpRoutePropagation (boolean); default false
- destinationCidr (cidr); default "0.0.0.0/0"
- nextHopType (select one of [Internet, VirtualNetworkGateway, VirtualAppliance, None]); default "Internet"
- nextHopIpAddress (text); default ""
- tags (keyvalue); default {}

## azure_bastion — Azure Bastion
Provider: azure; category: security.
Allowed parent(s): azure_vnet.
Assessment rules that check this type: AZ-BAS-001 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-bastion"
- sku (select one of [Basic, Standard]); default "Standard"
- scaleUnits (number range 2–50); default 2
- copyPasteEnabled (boolean); default true
- fileCopyEnabled (boolean); default false
- ipConnectEnabled (boolean); default false
- shareableLinkEnabled (boolean); default false
- tunnelingEnabled (boolean); default false
- tags (keyvalue); default {}

## azure_key_vault — Key Vault
Provider: azure; category: security.
Allowed parent(s): azure_resource_group, azure_cloud_boundary.
Assessment rules that check this type: AZ-KV-001 (medium), AZ-KV-002 (medium), AZ-KV-003 (medium), AZ-PE-001 (high). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-vault"
- sku (select one of [standard, premium]); default "standard"
- enableRbacAuthorization (boolean); default true
- publicNetworkAccessEnabled (boolean); default false
- networkAclsDefaultAction (select one of [Allow, Deny]); default "Deny"
- purgeProtectionEnabled (boolean); default true
- softDeleteRetentionDays (number range 7–90); default 90
- enabledForDiskEncryption (boolean); default false
- tags (keyvalue); default {}

## azure_functions — Functions
Provider: azure; category: compute.
Allowed parent(s): azure_subnet.
Assessment rules that check this type: AZ-FUNC-001 (medium), AZ-FUNC-002 (medium). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-func"
- runtime (select one of [node, python, dotnet, java, powershell]); default "node"
- runtimeVersion (text); default "20"
- osType (select one of [Linux, Windows]); default "Linux"
- planType (select one of [Y1, EP1, EP2, B1, S1]); default "Y1"
- alwaysOn (boolean); default false
- httpsOnly (boolean); default true
- publicNetworkAccess (boolean); default true
- minimumTlsVersion (select one of [1.0, 1.1, 1.2]); default "1.2"
- appSettings (keyvalue); default {}
- memoryMb (number range 128–1536); default 512
- estimatedInvocationsPerMonth (number range 0–…); default 1000000
- estimatedAvgDurationMs (number range 1–…); default 100
- tags (keyvalue); default {}

## azure_app_service — App Service
Provider: azure; category: compute.
No container: omit "parent".
Assessment rules that check this type: AZ-APP-001 (medium), AZ-APP-002 (medium), AZ-APP-003 (medium), AZ-APP-010 (low), AZ-APP-020 (low), AZ-APP-021 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-webapp"
- osType (select one of [Linux, Windows]); default "Linux"
- runtime (select one of [node, python, dotnet, java, php, docker]); default "node"
- runtimeVersion (text); default "20-lts"
- skuName (select one of [F1, B1, B2, S1, P1v3, P2v3]); default "B1"
- alwaysOn (boolean); default true
- httpsOnly (boolean); default true
- publicNetworkAccess (boolean); default true
- minimumTlsVersion (select one of [1.0, 1.1, 1.2]); default "1.2"
- ftpsState (select one of [Disabled, FtpsOnly, AllAllowed]); default "Disabled"
- http2Enabled (boolean); default true
- clientAffinityEnabled (boolean); default false
- healthCheckPath (text); default ""
- appSettings (keyvalue); default {}
- tags (keyvalue); default {}

## azure_aks — AKS Cluster
Provider: azure; category: compute.
Allowed parent(s): azure_subnet.
Assessment rules that check this type: AZ-AKS-001 (high), AZ-AKS-002 (medium), AZ-AKS-010 (low), AZ-AKS-030 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-aks"
- dnsPrefix (text); default "my-aks"
- kubernetesVersion (text); default ""
- nodeVmSize (select one of [Standard_B2s, Standard_D2s_v3, Standard_D4s_v3, Standard_D4s_v5]); default "Standard_D2s_v3"
- nodeCount (number range 1–100); default 3
- enableAutoScaling (boolean); default false
- minNodeCount (number range 1–100); default 1
- maxNodeCount (number range 1–100); default 5
- skuTier (select one of [Free, Standard]); default "Free"
- privateClusterEnabled (boolean); default false
- networkPlugin (select one of [azure, kubenet]); default "azure"
- rbacEnabled (boolean); default true
- tags (keyvalue); default {}

## azure_public_ip — Public IP
Provider: azure; category: networking.
No container: omit "parent".
Settings:
- name (text); default "my-pip"
- sku (select one of [Basic, Standard]); default "Standard"
- allocationMethod (select one of [Static, Dynamic]); default "Static"
- availabilityZone (select one of [, 1, 2, 3]); default ""
- domainNameLabel (text); default ""
- tags (keyvalue); default {}

## azure_nic — Network Interface
Provider: azure; category: networking.
Allowed parent(s): azure_subnet.
Assessment rules that check this type: AZ-NIC-001 (medium). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-nic"
- privateIpAllocationMethod (select one of [Dynamic, Static]); default "Dynamic"
- enableAcceleratedNetworking (boolean); default false
- enableIpForwarding (boolean); default false
- tags (keyvalue); default {}

## azure_front_door — Front Door
Provider: azure; category: networking.
Allowed parent(s): azure_cloud_boundary.
Assessment rules that check this type: AZ-AFD-010 (low), AZ-AFD-001 (medium), AZ-AFD-002 (medium). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-frontdoor"
- sku (select one of [Standard_AzureFrontDoor, Premium_AzureFrontDoor]); default "Standard_AzureFrontDoor"
- originHostName (text); default "origin.example.com"
- httpsOnly (boolean); default true
- cachingEnabled (boolean); default true
- queryStringCachingBehavior (select one of [IgnoreQueryString, UseQueryString]); default "IgnoreQueryString"
- tags (keyvalue); default {}

## azure_waf — Azure WAF
Provider: azure; category: security.
Allowed parent(s): azure_cloud_boundary.
Assessment rules that check this type: AZ-WAF-001 (medium). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-azure-waf"
- mode (select one of [Prevention, Detection]); default "Prevention"
- managedRuleSetVersion (select one of [3.2, 3.1, 3.0]); default "3.2"
- requestBodyCheck (boolean); default true
- fileUploadLimitMb (number range 1–4000); default 100
- maxRequestBodySizeKb (number range 8–2000); default 128
- tags (keyvalue); default {}

## azure_redis — Azure Redis
Provider: azure; category: database.
Allowed parent(s): azure_subnet.
Assessment rules that check this type: AZ-RED-001 (medium), AZ-RED-002 (medium), AZ-RED-003 (medium), AZ-PE-001 (high). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-redis"
- sku (select one of [Basic, Standard, Premium]); default "Standard"
- family (select one of [C, P]); default "C"
- capacity (number range 0–6); default 1
- enableNonSslPort (boolean); default false
- publicNetworkAccessEnabled (boolean); default true
- minimumTlsVersion (select one of [1.0, 1.1, 1.2]); default "1.2"
- redisVersion (select one of [6]); default "6"
- tags (keyvalue); default {}

## azure_vmss — VM Scale Set
Provider: azure; category: compute.
Allowed parent(s): azure_subnet.
Assessment rules that check this type: AZ-VMSS-001 (low), AZ-VMSS-010 (low), AZ-VMSS-011 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-vmss"
- osType (select one of [Linux, Windows]); default "Linux"
- sku (select one of [Standard_B2s, Standard_D2s_v3, Standard_D4s_v3, Standard_D4s_v5, Standard_D8s_v5, Standard_E8s_v5]); default "Standard_B2s"
- capacity (number range 0–1000); default 2
- adminUsername (text); default "azureuser"
- autoscaleEnabled (boolean); default true
- minCapacity (number range 0–1000); default 2
- maxCapacity (number range 1–1000); default 10
- upgradeMode (select one of [Manual, Automatic, Rolling]); default "Manual"
- overprovision (boolean); default true
- osDiskEncryption (boolean); default true
- zones (select one of [, 1,2, 1,2,3]); default ""
- tags (keyvalue); default {}

## azure_cloud_boundary — Azure Cloud Boundary
Provider: azure; category: networking.
Container. May contain: azure_resource_group, azure_vnet, azure_storage, azure_sql, azure_key_vault, azure_front_door, azure_waf, azure_postgres, azure_mysql, azure_service_bus, azure_acr, azure_monitor.
Top-level container.
Settings:
- name (text); default "Microsoft Azure"
- region (text); default "eastus"

## azure_postgres — Azure PostgreSQL
Provider: azure; category: database.
Allowed parent(s): azure_resource_group, azure_subnet, azure_cloud_boundary.
Assessment rules that check this type: AZ-PG-001 (high), AZ-PG-002 (high), AZ-PG-010 (medium), AZ-PG-011 (low), AZ-PG-012 (medium). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-postgres"
- databaseName (text); default "appdb"
- version (select one of [16, 15, 14, 13]); default "16"
- skuName (select one of [B_Standard_B1ms, B_Standard_B2s, GP_Standard_D2ds_v5, GP_Standard_D4ds_v5, MO_Standard_E2ds_v5, MO_Standard_E4ds_v5]); default "B_Standard_B1ms"
- storageGb (number range 32–16384); default 32
- highAvailability (select one of [Disabled, ZoneRedundant]); default "Disabled"
- backupRetentionDays (number range 7–35); default 7
- geoRedundantBackup (boolean); default false
- publicNetworkAccess (boolean); default false
- allowAzureServices (boolean); default false
- requireSecureTransport (boolean); default true
- minimumTlsVersion (select one of [TLSv1.2, TLSv1.3]); default "TLSv1.2"
- tags (keyvalue); default {}

## azure_mysql — Azure MySQL
Provider: azure; category: database.
Allowed parent(s): azure_resource_group, azure_subnet, azure_cloud_boundary.
Assessment rules that check this type: AZ-MY-001 (high), AZ-MY-002 (high), AZ-MY-010 (medium), AZ-MY-011 (low), AZ-MY-012 (medium). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-mysql"
- databaseName (text); default "appdb"
- version (select one of [8.0.21, 5.7]); default "8.0.21"
- skuName (select one of [B_Standard_B1ms, B_Standard_B2s, GP_Standard_D2ds_v4, GP_Standard_D4ds_v4, MO_Standard_E2ds_v4]); default "B_Standard_B1ms"
- storageGb (number range 20–16384); default 20
- highAvailability (select one of [Disabled, ZoneRedundant]); default "Disabled"
- backupRetentionDays (number range 1–35); default 7
- geoRedundantBackup (boolean); default false
- publicNetworkAccess (boolean); default false
- allowAzureServices (boolean); default false
- requireSecureTransport (boolean); default true
- minimumTlsVersion (select one of [TLSv1.2, TLSv1.3]); default "TLSv1.2"
- tags (keyvalue); default {}

## azure_service_bus — Service Bus
Provider: azure; category: messaging.
Allowed parent(s): azure_resource_group, azure_cloud_boundary.
Assessment rules that check this type: AZ-PE-001 (high), AZ-SB-001 (low), AZ-SB-002 (low), AZ-SB-003 (medium), AZ-SB-010 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-servicebus"
- sku (select one of [Basic, Standard, Premium]); default "Standard"
- capacity (select one of [1, 2, 4, 8, 16]); default 1
- queueNames (text); default "jobs"
- maxDeliveryCount (number range 1–100); default 10
- zoneRedundant (boolean); default false
- publicNetworkAccess (boolean); default true
- localAuthEnabled (boolean); default true
- minimumTlsVersion (select one of [1.0, 1.1, 1.2]); default "1.2"
- tags (keyvalue); default {}

## azure_acr — Container Registry
Provider: azure; category: storage.
Allowed parent(s): azure_resource_group, azure_cloud_boundary.
Assessment rules that check this type: AZ-PE-001 (high), AZ-ACR-001 (medium), AZ-ACR-002 (low), AZ-ACR-010 (low). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "myregistry"
- sku (select one of [Basic, Standard, Premium]); default "Standard"
- zoneRedundant (boolean); default false
- adminEnabled (boolean); default false
- publicNetworkAccess (boolean); default true
- estimatedStorageGb (number range 0–10000); default 20
- tags (keyvalue); default {}

## azure_monitor — Azure Monitor
Provider: azure; category: monitoring.
Allowed parent(s): azure_resource_group, azure_cloud_boundary.
Settings:
- name (text); default "my-monitor"
- applicationInsightsEnabled (boolean); default true
- retentionDays (number range 30–730); default 30
- dailyQuotaGb (number range -1–10000); default -1
- internetIngestionEnabled (boolean); default true
- internetQueryEnabled (boolean); default true
- estimatedIngestionGbPerMonth (number range 0–100000); default 10
- tags (keyvalue); default {}

## azure_private_endpoint — Private Endpoint
Provider: azure; category: networking.
Allowed parent(s): azure_subnet.
Assessment rules that check this type: AZ-PE-002 (medium). Satisfy them in the design instead of leaving them to fail.
Settings:
- name (text); default "my-private-endpoint"
- subresource (select one of [auto, blob, file, queue, table, dfs]); default "auto"
- privateDns (boolean); default true
- estimatedDataGbPerMonth (number range 0–1000000); default 100
- tags (keyvalue); default {}
