# Design guidelines

## Network layout
Create a cloud boundary, then a VPC or VNet inside it, then subnets inside the network. Name subnets by role (public/web, app, data): the layout engine classifies tiers from the name. Give every subnet a unique CIDR inside the network range; overlapping CIDRs fail the network-addressing gate. Use two subnets per tier in two availability zones for AWS.

## Placement
Entry points (load balancers, application gateways, NAT gateways) go in public/web subnets. Application compute goes in private app subnets. Databases and caches go in data subnets. Managed regional services (S3, storage accounts, Key Vault, SQS, Service Bus, Container Registry, Azure Monitor, Route 53, CloudFront, Front Door, WAF) sit in the cloud boundary or resource group. An Azure PostgreSQL or MySQL flexible server is placed in a subnet of its own (a delegated subnet that holds nothing else); Private Endpoints go in the data subnet.

## Connectivity
Every resource must be connected to the rest of the design or the connectivity gate fails. Draw edges from caller to callee: Route 53 → CloudFront/ALB, WAF → the resource it protects, ALB → compute, compute → database/cache/queue/storage. Security groups, NSGs and network ACLs attach to the subnet or workload they protect with one edge. IAM roles connect to the compute that assumes them. CloudWatch connects to the resources it alarms on.

## Edge protection
Every internet-facing ALB has a regional WAF connected to it and an HTTPS listener with a certificate; every CloudFront distribution and Front Door has a WAF. Application Gateway uses the WAF_v2 SKU with the WAF in Prevention mode.

## Data protection
Databases and caches are never publicly accessible, are encrypted, and are Multi-AZ / zone-redundant where the setting exists. Storage disables public access and defaults network access to Deny. Key Vault uses RBAC, purge protection and a Deny network default.

## Compute
Use Auto Scaling groups or VM Scale Sets rather than a fixed count of single instances. Enable health checks against the load balancer. Container and Kubernetes clusters use private endpoints.

## Settings
Only set configuration keys that exist for the resource type, with values from the listed options. Unknown keys and invalid values are rejected before any other check runs. Account-specific values (TLS certificate ARNs, container images) are written as REPLACE-WITH-YOUR-* placeholders and must be supplied before deployment.

## One boundary per cloud
A design has at most one AWS cloud boundary and one Azure cloud boundary. Two AWS regions, or two Azure regions, cannot be drawn in one design: the layout and the overlap gate reject it. For high availability inside one cloud use two availability zones (AWS) or zone-redundant services (Azure). Cross-region or cross-cloud resilience is modelled only with the multi-cloud patterns (AWS plus Azure). If the user asks for two regions of the same cloud, design the primary region and say in the summary that the second region and data replication must be added separately.

## Static sites and event-driven workloads
Static content needs no network: use S3 or Blob storage as a private origin behind CloudFront or Front Door with a WAF, and no compute. Background work uses a queue between a producer and workers so bursts are buffered and failures retried (SQS with Lambda or Auto Scaling workers on AWS). On Azure the queue is Service Bus (azure_service_bus): the producer connects to it and Functions can be triggered from it (service bus → function).

## Queue workers and microservices
Background work goes through an SQS queue: the web service connects to the queue (web → queue) and the worker service reads from it (queue → worker). Run web and worker services as separate ECS services in the private app subnets, one per availability zone. For several services behind one load balancer, connect the load balancer to each service, give each service the data store it needs (compute → database/table), and connect services to each other only through the queue (producer → queue → consumer), never directly.

## Use the service that was asked for
Never swap one service for another. PostgreSQL is aws_rds (engine postgres) on AWS and azure_postgres on Azure; MySQL is aws_rds (engine mysql) or azure_mysql; only a request for SQL Server or Azure SQL uses azure_sql. A request for a message queue uses aws_sqs or azure_service_bus; a container registry is azure_acr; monitoring and logging on Azure is azure_monitor (Log Analytics with Application Insights). If a requested service is not in the catalog, say so in the summary instead of substituting another.

## Private access on Azure
When a service has its public endpoint off (Storage with network default Deny, Key Vault, Azure SQL, Redis, Cosmos DB, and Container Registry or Service Bus on the Premium tier), the application can only reach it through a Private Endpoint: add an azure_private_endpoint in a subnet, connect it to the service (endpoint → service), and connect the application to the service as usual. One endpoint reaches one service. Service Bus and Container Registry only support private endpoints on the Premium tier; on Standard they keep public access with TLS 1.2. PostgreSQL and MySQL flexible servers do not use an endpoint: place the server in a subnet that holds nothing else.

## Tiers and availability zones
A request for a three-tier application means three tiers: a web tier, an API (application) tier and a data tier. Give each compute tier its own resource (for example two VM Scale Sets) and connect web → API → data. When high availability is asked for, spread the tiers across zones: set zones on VM Scale Sets and Application Gateway to "1,2,3", use zone-redundant databases (highAvailability ZoneRedundant for PostgreSQL and MySQL, zoneRedundant for Azure SQL) and ZRS storage.

## Common mistakes and how to avoid them
These mistakes were measured in real model output. (1) A WAF that is placed but not connected: always connect WAF → the load balancer or CDN it protects. (2) Subnets with no cidrBlock or availabilityZone: every subnet needs its own /24 inside the VPC range (10.x.1.0/24, 10.x.2.0/24, …) and the two subnets of a tier belong in two zones (us-east-1a and us-east-1b). (3) Using an internet gateway in a connection without declaring it: add an aws_igw resource inside the VPC and connect it to the load balancer; NAT gateways connect to it. (4) A load balancer that is not connected to the compute behind it: draw ALB → each service or Auto Scaling group. (5) A load balancer with no certificateArn: set the REPLACE-WITH-YOUR-CERTIFICATE-ID placeholder. (6) A data store, bucket or cache connected to nothing: connect the compute that uses it. (7) Inventing a setting name such as listener: use only the settings listed for the type.

## Known limits of the catalog
The catalog has no API Gateway, EventBridge, Kinesis, SNS, Event Hubs, Event Grid, API Management, Azure Firewall or Logic Apps resources. Azure relational databases are Azure SQL, PostgreSQL and MySQL flexible servers. Cross-cloud connections are accepted only from compute to compute/storage/SQL, or through gateway/CDN/edge services. Do not invent resource types to fill those gaps; state the limitation in the summary instead.
