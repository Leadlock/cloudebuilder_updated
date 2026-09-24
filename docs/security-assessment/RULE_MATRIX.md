# CloudCraft Assessment Rule Matrix

Generated from the rule registry (`lib/engines/assessment/rules`) for ruleset **2026.09.2**. Each row is taken from the rule's
own metadata and from running the engine on the resource definition's default configuration.

**Columns**
- **FRAMEWORK**: control references attached to the rule. FSBP = AWS Security Hub Foundational Security Best Practices;
  MCSB = Microsoft cloud security benchmark; Azure Policy = built-in policy definition (first 8 characters of the GUID);
  WA = Well-Architected pillar mapping.
- **EVIDENCE**: what the rule reads. Config = configuration fields on the canvas resource; Topology = nodes, edges and
  containment; Not modelled = data the diagram cannot hold, so the rule always returns NOT_EVALUATED.
- **AUTOFIX**: SAFE = SAFE_AUTOFIX; REVIEW = REVIEW_REQUIRED; MANUAL = MANUAL_ONLY; SAFE / REVIEW (deployed) = SAFE on
  design-only resources, REVIEW_REQUIRED on imported or deployed resources; — = no configuration change can fix it.
- **SOURCE VERIFIED**: official = identifier and title checked against an official machine-readable publication (Azure
  Policy MCSB initiative v57.58.0). secondary cross-check = FSBP identifier, title and severity checked against a maintained
  machine-readable mapping, because docs.aws.amazon.com could not be reached from the build environment. not verified =
  WA guidance URL only.
- **TESTED**: Yes = rule-specific automated test (FAIL/PASS, Auto-Fix round trip, or both). Registry probe only = covered
  only by the generic registry tests (valid keys, references, SOC 1 areas).

**Status**
- PRODUCTION IMPLEMENTED: the design-time evaluation is complete, has rule-specific tests, and its control reference is
  verified against an official source.
- IMPLEMENTED — LIVE VERIFICATION REQUIRED: implemented and tested, but the control reference could only be cross-checked
  against a secondary source, or has no rule-specific test yet.
- PARTIAL: topology heuristic. It can only see what is drawn, e.g. it cannot tell whether monitoring exists outside the
  diagram.
- NOT EVALUATED: always returns NOT_EVALUATED because the data is not in the diagram. It is shown in reports as a
  coverage gap and never counted as passing.

No rule has been verified against a live AWS or Azure account, and no evaluation carries LIVE_VERIFIED provenance.

| RULE ID | PROVIDER | SERVICE | FRAMEWORK | SEVERITY | EVIDENCE | AUTOFIX | SOURCE VERIFIED | TESTED | STATUS |
|---|---|---|---|---|---|---|---|---|---|
| AWS-S3-001 | AWS | Amazon S3 | FSBP S3.8; FSBP S3.2; FSBP S3.3; WA security | CRITICAL | Config: publicAccess, blockPublicAcls, blockPublicPolicy | REVIEW | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-S3-002 | AWS | Amazon S3 | WA security | LOW | Config: encryption, encryptionType | SAFE | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-S3-003 | AWS | Amazon S3 | FSBP S3.9; WA security | LOW | Config: loggingEnabled | MANUAL | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-S3-004 | AWS | Amazon S3 | FSBP S3.12; WA security | MEDIUM | Config: objectOwnership | REVIEW | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-S3-005 | AWS | Amazon S3 | FSBP S3.14; WA reliability | LOW | Config: versioning | SAFE | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-S3-006 | AWS | Amazon S3 | FSBP S3.13; WA cost_optimization | LOW | Config: lifecycleTransitionDays, lifecycleExpirationDays | MANUAL | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-RDS-001 | AWS | Amazon RDS | FSBP RDS.2; WA security | CRITICAL | Config: publiclyAccessible | REVIEW | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-RDS-002 | AWS | Amazon RDS | FSBP RDS.3; WA security | HIGH | Config: encrypted, kmsKeyId | SAFE / REVIEW (deployed) | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-RDS-003 | AWS | Amazon RDS | FSBP RDS.10; WA security | LOW | Config: iamDatabaseAuthenticationEnabled | REVIEW | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-RDS-004 | AWS | Amazon RDS | FSBP RDS.9; WA security | LOW | Config: enableCloudwatchLogsExports | MANUAL | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-RDS-005 | AWS | Amazon RDS | FSBP RDS.13; WA security | MEDIUM | Config: autoMinorVersionUpgrade | SAFE | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-RDS-006 | AWS | Amazon RDS | FSBP RDS.5; WA reliability | MEDIUM | Config: multiAz | REVIEW | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-RDS-007 | AWS | Amazon RDS | FSBP RDS.11; WA reliability | HIGH | Config: backupRetentionPeriod | SAFE | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-RDS-008 | AWS | Amazon RDS | FSBP RDS.8; WA reliability | LOW | Config: deletionProtection | SAFE | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-RDS-009 | AWS | Amazon RDS | FSBP RDS.6; WA operational_excellence | LOW | Config: monitoringInterval | REVIEW | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-EC2-001 | AWS | Amazon EC2 | FSBP EC2.9; WA security | MEDIUM | Config: associatePublicIpAddress | REVIEW | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-EC2-002 | AWS | Amazon EC2 | FSBP EC2.3; WA security | MEDIUM | Config: encrypted | SAFE / REVIEW (deployed) | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-EC2-003 | AWS | Amazon EC2 | FSBP EC2.8; WA security | HIGH | Not modelled in the diagram | — | secondary cross-check | Registry probe only | NOT EVALUATED |
| AWS-EBS-001 | AWS | Amazon EBS | FSBP EC2.3; WA security | MEDIUM | Config: encrypted | SAFE / REVIEW (deployed) | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-EBS-002 | AWS | Amazon EBS | WA reliability | LOW | Config: snapshotSchedule | MANUAL | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-VPC-001 | AWS | Amazon VPC | FSBP EC2.15; WA security | MEDIUM | Config: mapPublicIpOnLaunch | REVIEW | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-VPC-002 | AWS | Amazon VPC | FSBP EC2.6; WA security | MEDIUM | Not modelled in the diagram | — | secondary cross-check | Registry probe only | NOT EVALUATED |
| AWS-VPC-003 | AWS | Amazon VPC | WA operational_excellence | MEDIUM | Config: enableDnsSupport | SAFE | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-SG-001 | AWS | Amazon EC2 security groups | FSBP EC2.13; WA security | HIGH | Config: allowSsh | REVIEW | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-SG-002 | AWS | Amazon EC2 security groups | FSBP EC2.14; WA security | HIGH | Config: allowRdp | REVIEW | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-SG-003 | AWS | Amazon EC2 security groups | WA security | MEDIUM | Not modelled in the diagram | — | n/a (WA guidance only, not verified) | Yes | NOT EVALUATED |
| AWS-NACL-001 | AWS | Amazon VPC network ACLs | FSBP EC2.21; WA security | MEDIUM | Config: allowAllInbound, inboundCidr, inboundProtocol, inboundPortFrom | REVIEW | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-ELB-001 | AWS | Elastic Load Balancing | WA security | MEDIUM | Config: listenerProtocol, certificateArn | MANUAL | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-ELB-002 | AWS | Elastic Load Balancing | FSBP ELB.1; WA security | MEDIUM | Config: scheme, listenerProtocol, lbType | MANUAL | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-ELB-003 | AWS | Elastic Load Balancing | FSBP ELB.16; WA security | MEDIUM | Config: scheme, lbType, Diagram relationship | MANUAL | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-ELB-004 | AWS | Elastic Load Balancing | FSBP ELB.6; WA reliability | LOW | Config: deletionProtection | SAFE | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-CF-001 | AWS | Amazon CloudFront | FSBP CloudFront.3; WA security | MEDIUM | Config: viewerProtocolPolicy | SAFE | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-CF-002 | AWS | Amazon CloudFront | FSBP CloudFront.6; WA security | MEDIUM | Config: webAclId, Diagram relationship | MANUAL | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-WAF-001 | AWS | AWS WAF | FSBP WAF.10; WA security | MEDIUM | Config: managedRuleGroups, rateLimitEnabled | REVIEW | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-EKS-001 | AWS | Amazon EKS | FSBP EKS.1; WA security | HIGH | Config: endpointPublicAccess, publicAccessCidrs | MANUAL | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-EKS-002 | AWS | Amazon EKS | FSBP EKS.3; WA security | MEDIUM | Config: secretsEncryption | SAFE / REVIEW (deployed) | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-EKS-003 | AWS | Amazon EKS | FSBP EKS.8; WA security | MEDIUM | Config: clusterLogTypes | SAFE | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-ECS-001 | AWS | Amazon ECS | FSBP ECS.2; WA security | HIGH | Config: assignPublicIp | REVIEW | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-IAM-001 | AWS | AWS IAM | FSBP IAM.1; WA security | HIGH | Config: managedPolicyArns | MANUAL | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-KMS-001 | AWS | AWS KMS | FSBP KMS.4; WA security | MEDIUM | Config: enableKeyRotation, keyUsage, keySpec | SAFE | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-ELC-001 | AWS | Amazon ElastiCache | FSBP ElastiCache.5; WA security | MEDIUM | Config: transitEncryption | REVIEW | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-ELC-002 | AWS | Amazon ElastiCache | FSBP ElastiCache.4; WA security | MEDIUM | Config: atRestEncryption | SAFE / REVIEW (deployed) | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-ELC-003 | AWS | Amazon ElastiCache | FSBP ElastiCache.3; WA reliability | MEDIUM | Config: numNodes, automaticFailoverEnabled | REVIEW | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-ELC-004 | AWS | Amazon ElastiCache | FSBP ElastiCache.1; WA reliability | MEDIUM | Config: snapshotRetentionLimit | SAFE | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-DDB-001 | AWS | Amazon DynamoDB | WA security | INFORMATIONAL | Config: serverSideEncryption | — | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-DDB-002 | AWS | Amazon DynamoDB | FSBP DynamoDB.2; WA reliability | MEDIUM | Config: pointInTimeRecovery | SAFE | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-DDB-003 | AWS | Amazon DynamoDB | FSBP DynamoDB.6; WA reliability | LOW | Config: deletionProtection, pointInTimeRecovery | SAFE | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-SQS-001 | AWS | Amazon SQS | FSBP SQS.1; WA security | MEDIUM | Config: encryption, kmsMasterKeyId | SAFE | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-SQS-002 | AWS | Amazon SQS | WA reliability | LOW | Config: deadLetterTargetArn | MANUAL | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-ARCH-001 | AWS | Amazon EC2 | WA reliability | MEDIUM | Topology (nodes, edges, containment) | — | n/a (WA guidance only, not verified) | Yes | PARTIAL |
| AWS-ARCH-002 | AWS | Amazon VPC | WA reliability | MEDIUM | Topology (nodes, edges, containment) | — | n/a (WA guidance only, not verified) | Yes | PARTIAL |
| AWS-ASG-001 | AWS | Amazon EC2 Auto Scaling | FSBP AutoScaling.1; WA reliability | LOW | Config: healthCheckType | SAFE | secondary cross-check | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-EC2-010 | AWS | Amazon EC2 | WA operational_excellence | LOW | Config: detailedMonitoring | SAFE | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-ARCH-003 | AWS | Amazon CloudWatch | WA operational_excellence | LOW | Topology (nodes, edges, containment) | — | n/a (WA guidance only, not verified) | Yes | PARTIAL |
| AWS-LAMBDA-001 | AWS | AWS Lambda | WA operational_excellence | LOW | Config: tracingMode | SAFE | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-ARCH-004 | AWS | Amazon ElastiCache | WA performance_efficiency | INFORMATIONAL | Topology (nodes, edges, containment) | — | n/a (WA guidance only, not verified) | Yes | PARTIAL |
| AWS-COST-001 | AWS | Amazon EBS | WA cost_optimization | LOW | Config: volumeType, storageType | REVIEW | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-SUS-001 | AWS | AWS Lambda | WA sustainability | INFORMATIONAL | Config: architecture | REVIEW | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AWS-ACCT-001 | AWS | AWS CloudTrail | FSBP CloudTrail.1; WA security | HIGH | Account/organization data (not available in the diagram) | — | secondary cross-check | Yes | NOT EVALUATED |
| AWS-ACCT-002 | AWS | Amazon GuardDuty | FSBP GuardDuty.1; WA security | HIGH | Account/organization data (not available in the diagram) | — | secondary cross-check | Yes | NOT EVALUATED |
| AWS-ACCT-003 | AWS | AWS IAM | FSBP IAM.9; WA security | CRITICAL | Account/organization data (not available in the diagram) | — | secondary cross-check | Yes | NOT EVALUATED |
| AWS-ACCT-004 | AWS | AWS Config | FSBP Config.1; WA security | MEDIUM | Account/organization data (not available in the diagram) | — | secondary cross-check | Yes | NOT EVALUATED |
| AZ-STG-001 | AZURE | Azure Storage | MCSB DP-3; Azure Policy 404c3081; WA security | HIGH | Config: httpsOnly | SAFE | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-STG-002 | AZURE | Azure Storage | MCSB NS-2; Azure Policy 4fa4b6c0; WA security | HIGH | Config: allowBlobPublicAccess | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-STG-003 | AZURE | Azure Storage | MCSB DP-3; WA security | MEDIUM | Config: minimumTlsVersion | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-STG-004 | AZURE | Azure Storage | MCSB NS-2; Azure Policy 34c877ad; WA security | MEDIUM | Config: networkDefaultAction | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-STG-005 | AZURE | Azure Storage | WA reliability | LOW | Config: blobSoftDeleteRetentionDays | SAFE | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AZ-STG-006 | AZURE | Azure Storage | WA reliability | LOW | Config: sku | SAFE / REVIEW (deployed) | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AZ-SQL-001 | AZURE | Azure SQL Database | MCSB NS-2; Azure Policy 1b8ca024; WA security | HIGH | Config: publicNetworkAccess | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-SQL-002 | AZURE | Azure SQL Database | MCSB DP-4; Azure Policy 17k78e20; WA security | HIGH | Config: transparentDataEncryptionEnabled | SAFE / REVIEW (deployed) | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-SQL-003 | AZURE | Azure SQL Database | MCSB LT-3; Azure Policy a6fb4358; WA security | MEDIUM | Config: auditingEnabled | MANUAL | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-SQL-004 | AZURE | Azure SQL Database | MCSB LT-1; Azure Policy abfb4388; WA security | MEDIUM | Config: threatDetectionEnabled | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-SQL-005 | AZURE | Azure SQL Database | MCSB DP-3; Azure Policy 32e6bbec; WA security | MEDIUM | Config: minimumTlsVersion | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-SQL-006 | AZURE | Azure SQL Database | MCSB NS-2; WA security | MEDIUM | Config: publicNetworkAccess, allowAzureServices | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-SQL-010 | AZURE | Azure SQL Database | WA reliability | MEDIUM | Config: tier, zoneRedundant | REVIEW | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AZ-SQL-011 | AZURE | Azure SQL Database | WA reliability | LOW | Config: requestedBackupStorageRedundancy | REVIEW | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AZ-COS-001 | AZURE | Azure Cosmos DB | MCSB NS-2; Azure Policy 797b37f7; WA security | HIGH | Config: publicNetworkAccess | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-COS-010 | AZURE | Azure Cosmos DB | WA reliability | LOW | Config: enableAutomaticFailover | SAFE | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AZ-RED-001 | AZURE | Azure Cache for Redis | MCSB DP-3; Azure Policy 22bee202; WA security | MEDIUM | Config: enableNonSslPort | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-RED-002 | AZURE | Azure Cache for Redis | MCSB NS-2; Azure Policy 7803067c; WA security | MEDIUM | Config: publicNetworkAccessEnabled | MANUAL | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-RED-003 | AZURE | Azure Cache for Redis | MCSB DP-3; WA security | MEDIUM | Config: minimumTlsVersion | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-KV-001 | AZURE | Azure Key Vault | MCSB NS-2; MCSB DP-8; Azure Policy 55615ac9; WA security | MEDIUM | Config: publicNetworkAccessEnabled, networkAclsDefaultAction | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-KV-002 | AZURE | Azure Key Vault | MCSB DP-8; Azure Policy 0b60c0b2; WA security | MEDIUM | Config: purgeProtectionEnabled | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-KV-003 | AZURE | Azure Key Vault | MCSB PA-7; Azure Policy 12d4fa5e; WA security | MEDIUM | Config: enableRbacAuthorization | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-NSG-001 | AZURE | Azure network security groups | MCSB NS-3; Azure Policy 22730e10; WA security | HIGH | Config: allowSsh | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-NSG-002 | AZURE | Azure network security groups | MCSB NS-3; Azure Policy 22730e10; WA security | HIGH | Config: allowRdp | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-NIC-001 | AZURE | Azure network interfaces | MCSB NS-3; Azure Policy bd352bd5; WA security | MEDIUM | Config: enableIpForwarding | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-ARCH-001 | AZURE | Azure Virtual Network | MCSB NS-1; Azure Policy e71308d3; WA security | MEDIUM | Topology (nodes, edges, containment) | — | official | Yes | PARTIAL |
| AZ-VM-001 | AZURE | Azure Virtual Machines | MCSB NS-2; WA security | MEDIUM | Config: publicIpEnabled | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-VM-002 | AZURE | Azure Virtual Machines | MCSB DP-4; Azure Policy fc4d8e41; WA security | LOW | Config: encryptionAtHostEnabled | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-VMSS-001 | AZURE | Azure Virtual Machine Scale Sets | MCSB DP-4; Azure Policy fc4d8e41; WA security | LOW | Config: osDiskEncryption | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-VM-010 | AZURE | Azure Virtual Machines | MCSB BR-1; Azure Policy 013e242c; WA reliability | MEDIUM | Not modelled in the diagram | — | official | Registry probe only | NOT EVALUATED |
| AZ-VM-011 | AZURE | Azure Virtual Machines | WA reliability | LOW | Config: availabilityZone | MANUAL | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AZ-VM-020 | AZURE | Azure Virtual Machines | WA operational_excellence | LOW | Config: bootDiagnosticsEnabled | SAFE | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AZ-ARCH-010 | AZURE | Azure Virtual Machines | WA reliability | MEDIUM | Topology (nodes, edges, containment) | — | n/a (WA guidance only, not verified) | Yes | PARTIAL |
| AZ-APP-001 | AZURE | Azure App Service | MCSB DP-3; Azure Policy a4af4a39; WA security | MEDIUM | Config: httpsOnly | SAFE | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-FUNC-001 | AZURE | Azure Function App | MCSB DP-3; Azure Policy 6d555dd1; WA security | MEDIUM | Config: httpsOnly | SAFE | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-APP-002 | AZURE | Azure App Service | MCSB DP-3; Azure Policy f0e6e85b; WA security | MEDIUM | Config: minimumTlsVersion | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-FUNC-002 | AZURE | Azure Function App | MCSB DP-3; Azure Policy f9d614c5; WA security | MEDIUM | Config: minimumTlsVersion | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-APP-003 | AZURE | Azure App Service | MCSB DP-3; Azure Policy 4d24b6d4; WA security | MEDIUM | Config: ftpsState | SAFE | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-APP-010 | AZURE | Azure App Service | WA reliability | LOW | Config: healthCheckPath | MANUAL | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AZ-AKS-001 | AZURE | Azure Kubernetes Service | MCSB PA-7; Azure Policy ac4a19c2; WA security | HIGH | Config: rbacEnabled | SAFE / REVIEW (deployed) | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-AKS-002 | AZURE | Azure Kubernetes Service | MCSB NS-2; Azure Policy 0e246bcf; WA security | MEDIUM | Config: privateClusterEnabled | MANUAL | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-AKS-010 | AZURE | Azure Kubernetes Service | WA reliability | LOW | Config: skuTier | REVIEW | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AZ-AKS-030 | AZURE | Azure Kubernetes Service | WA cost_optimization | LOW | Config: enableAutoScaling, nodeCount | REVIEW | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AZ-AGW-001 | AZURE | Azure Application Gateway | MCSB NS-6; Azure Policy 564feb30; WA security | MEDIUM | Config: sku, wafEnabled, wafMode | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-AFD-001 | AZURE | Azure Front Door | MCSB DP-3; WA security | MEDIUM | Config: httpsOnly | SAFE | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-AFD-002 | AZURE | Azure Front Door | MCSB NS-6; Azure Policy 055aa869; WA security | MEDIUM | Config: sku, Diagram relationship | MANUAL | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-WAF-001 | AZURE | Azure Web Application Firewall | MCSB NS-6; WA security | MEDIUM | Config: mode | REVIEW | official | Yes | PRODUCTION IMPLEMENTED |
| AZ-BAS-001 | AZURE | Azure Bastion | WA security | LOW | Config: shareableLinkEnabled | REVIEW | n/a (WA guidance only, not verified) | Yes | IMPLEMENTED — LIVE VERIFICATION REQUIRED |
| AZ-ARCH-020 | AZURE | Azure Monitor | MCSB LT-3; WA operational_excellence | MEDIUM | Not modelled in the diagram | — | official | Yes | NOT EVALUATED |
| AZ-ARCH-030 | AZURE | Azure Cache for Redis | WA performance_efficiency | INFORMATIONAL | Topology (nodes, edges, containment) | — | n/a (WA guidance only, not verified) | Yes | PARTIAL |
| AZ-ACCT-001 | AZURE | Microsoft Defender for Cloud | MCSB LT-1; WA security | HIGH | Account/organization data (not available in the diagram) | — | official | Registry probe only | NOT EVALUATED |
| AZ-ACCT-002 | AZURE | Azure Monitor | MCSB LT-3; WA security | MEDIUM | Account/organization data (not available in the diagram) | — | official | Registry probe only | NOT EVALUATED |
| AZ-ACCT-003 | AZURE | Microsoft Entra ID | MCSB IM-6; WA security | HIGH | Account/organization data (not available in the diagram) | — | official | Registry probe only | NOT EVALUATED |
