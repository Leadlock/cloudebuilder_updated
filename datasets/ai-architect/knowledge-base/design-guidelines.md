# Design guidelines

## Network layout
Create a cloud boundary, then a VPC or VNet inside it, then subnets inside the network. Name subnets by role (public/web, app, data): the layout engine classifies tiers from the name. Give every subnet a unique CIDR inside the network range; overlapping CIDRs fail the network-addressing gate. Use two subnets per tier in two availability zones for AWS.

## Placement
Entry points (load balancers, application gateways, NAT gateways) go in public/web subnets. Application compute goes in private app subnets. Databases and caches go in data subnets. Managed regional services (S3, storage accounts, Key Vault, SQS, Route 53, CloudFront, Front Door, WAF) sit in the cloud boundary or resource group.

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

## Known limits of the catalog
The catalog has no API Gateway, EventBridge, Kinesis, SNS, Service Bus, Event Hubs, Azure Monitor or Log Analytics resources. Azure relational databases are modelled as Azure SQL only. Cross-cloud connections are accepted only from compute to compute/storage/SQL, or through gateway/CDN/edge services. Do not invent resource types to fill those gaps; state the limitation in the summary instead.
