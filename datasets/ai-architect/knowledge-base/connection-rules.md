# Connection rules

Direction matters: connect from the caller to the callee. The lists below are the connections used by gate-verified designs, with the protocol and port CloudBuilder infers (do not supply them). The engine accepts some other pairs (it is permissive), but they are not meaningful architectures; prefer these.

## aws_alb connects to
- aws_auto_scaling (LOAD_BALANCES, HTTP:80; seen in 12 verified designs)
- aws_ecs (LOAD_BALANCES, HTTP:80; seen in 12 verified designs)
- aws_eks (LOAD_BALANCES, HTTP:80; seen in 4 verified designs)
- aws_lambda (NETWORK_FLOW; seen in 4 verified designs)

## aws_auto_scaling connects to
- aws_s3 (STORES_IN, HTTPS / IAM:443; seen in 12 verified designs)
- aws_nat (ROUTES_TO, TCP / UDP Egress; seen in 12 verified designs)
- aws_elasticache (CONNECTS_TO, Redis TCP:6379; seen in 9 verified designs)
- aws_rds (CONNECTS_TO, PostgreSQL:5432; seen in 6 verified designs)
- aws_dynamodb (CONNECTS_TO, HTTPS / IAM:443; seen in 3 verified designs)

## aws_cloudfront connects to
- aws_igw (NETWORK_FLOW; seen in 15 verified designs)
- aws_s3 (SERVES, S3 REST API (OAC):443; seen in 8 verified designs)
- aws_lambda (NETWORK_FLOW; seen in 4 verified designs)

## aws_cloudwatch connects to
- aws_alb (ASSOCIATED_WITH; seen in 32 verified designs)
- aws_rds (ASSOCIATED_WITH; seen in 20 verified designs)
- aws_auto_scaling (ASSOCIATED_WITH; seen in 12 verified designs)
- aws_ecs (ASSOCIATED_WITH; seen in 12 verified designs)
- aws_lambda (ASSOCIATED_WITH; seen in 12 verified designs)
- aws_eks (ASSOCIATED_WITH; seen in 4 verified designs)

## aws_ecs connects to
- aws_nat (ROUTES_TO, TCP / UDP Egress; seen in 12 verified designs)
- aws_elasticache (CONNECTS_TO, Redis TCP:6379; seen in 9 verified designs)
- aws_rds (CONNECTS_TO, PostgreSQL:5432; seen in 8 verified designs)
- aws_s3 (STORES_IN, HTTPS / IAM:443; seen in 8 verified designs)
- aws_sqs (CONNECTS_TO, SQS API:443; seen in 8 verified designs)
- aws_dynamodb (CONNECTS_TO, HTTPS / IAM:443; seen in 6 verified designs)

## aws_eks connects to
- aws_s3 (NETWORK_FLOW; seen in 4 verified designs)
- aws_nat (NETWORK_FLOW; seen in 4 verified designs)
- aws_elasticache (NETWORK_FLOW; seen in 3 verified designs)
- aws_rds (CONNECTS_TO, PostgreSQL:5432; seen in 2 verified designs)
- aws_dynamodb (CONNECTS_TO, HTTPS / IAM:443; seen in 1 verified designs)

## aws_iam connects to
- aws_ecs (AUTHENTICATES_WITH; seen in 12 verified designs)
- aws_lambda (AUTHENTICATES_WITH; seen in 12 verified designs)
- aws_eks (AUTHENTICATES_WITH; seen in 4 verified designs)

## aws_igw connects to
- aws_alb (NETWORK_FLOW; seen in 32 verified designs)

## aws_lambda connects to
- aws_s3 (STORES_IN, HTTPS / IAM:443; seen in 12 verified designs)
- aws_dynamodb (CONNECTS_TO, HTTPS / IAM:443; seen in 8 verified designs)
- aws_sqs (CONNECTS_TO, SQS API:443; seen in 4 verified designs)
- aws_rds (CONNECTS_TO, PostgreSQL:5432; seen in 4 verified designs)
- aws_nat (NETWORK_FLOW; seen in 4 verified designs)

## aws_nat connects to
- aws_igw (ROUTES_TO, Egress Translation; seen in 32 verified designs)

## aws_route53 connects to
- aws_cloudfront (RESOLVES_TO, DNS:53; seen in 23 verified designs)
- aws_alb (RESOLVES_TO, DNS:53; seen in 17 verified designs)
- azure_app_gateway (CONNECTS_TO, HTTPS / VPN:443; seen in 8 verified designs)

## aws_sg connects to
- aws_alb (ASSOCIATED_WITH; seen in 16 verified designs)
- aws_auto_scaling (ASSOCIATED_WITH; seen in 12 verified designs)
- aws_rds (ASSOCIATED_WITH; seen in 10 verified designs)
- aws_elasticache (ASSOCIATED_WITH; seen in 9 verified designs)

## aws_sqs connects to
- aws_ecs (NETWORK_FLOW; seen in 8 verified designs)
- aws_lambda (TRIGGERS, EventSourceMapping; seen in 4 verified designs)

## aws_waf connects to
- aws_alb (ASSOCIATED_WITH; seen in 32 verified designs)
- aws_cloudfront (ASSOCIATED_WITH; seen in 23 verified designs)

## azure_aks connects to
- azure_storage (NETWORK_FLOW; seen in 4 verified designs)
- azure_key_vault (NETWORK_FLOW; seen in 4 verified designs)
- azure_redis (CONNECTS_TO, Redis TLS:6380; seen in 3 verified designs)
- azure_postgres (DATABASE_CONNECTION, PostgreSQL / TCP:5432; seen in 2 verified designs)
- azure_cosmos_db (CONNECTS_TO, HTTPS:443; seen in 1 verified designs)

## azure_app_gateway connects to
- azure_vmss (LOAD_BALANCES, HTTP:80; seen in 12 verified designs)
- azure_aks (LOAD_BALANCES, HTTP:80; seen in 4 verified designs)
- azure_functions (NETWORK_FLOW; seen in 4 verified designs)
- azure_app_service (NETWORK_FLOW; seen in 4 verified designs)

## azure_app_service connects to
- azure_storage (STORES_IN, Blob HTTPS:443; seen in 8 verified designs)
- azure_key_vault (AUTHENTICATES_WITH, Managed Identity:443; seen in 8 verified designs)
- azure_redis (CONNECTS_TO, Redis TLS:6380; seen in 6 verified designs)
- azure_postgres (DATABASE_CONNECTION, PostgreSQL / TCP:5432; seen in 4 verified designs)
- azure_cosmos_db (CONNECTS_TO, HTTPS:443; seen in 2 verified designs)

## azure_bastion connects to
- azure_vmss (NETWORK_FLOW; seen in 3 verified designs)

## azure_front_door connects to
- azure_app_gateway (ROUTES_TO, HTTPS Origin:443; seen in 6 verified designs)
- azure_storage (SERVES, Blob HTTPS:443; seen in 4 verified designs)
- azure_app_service (NETWORK_FLOW; seen in 3 verified designs)
- azure_functions (NETWORK_FLOW; seen in 3 verified designs)

## azure_functions connects to
- azure_storage (STORES_IN, Blob HTTPS:443; seen in 8 verified designs)
- azure_key_vault (AUTHENTICATES_WITH, Managed Identity:443; seen in 8 verified designs)
- azure_cosmos_db (CONNECTS_TO, HTTPS:443; seen in 5 verified designs)
- azure_sql (CONNECTS_TO, TDS / TCP:1433; seen in 2 verified designs)

## azure_nsg connects to
- azure_subnet (ASSOCIATED_WITH; seen in 32 verified designs)

## azure_private_endpoint connects to
- azure_storage (ASSOCIATED_WITH, Private Link:443; seen in 32 verified designs)
- azure_key_vault (ASSOCIATED_WITH, Private Link:443; seen in 32 verified designs)
- azure_redis (ASSOCIATED_WITH, Private Link:443; seen in 15 verified designs)
- azure_cosmos_db (ASSOCIATED_WITH, Private Link:443; seen in 11 verified designs)
- azure_sql (ASSOCIATED_WITH, Private Link:443; seen in 2 verified designs)

## azure_vmss connects to
- azure_vmss (NETWORK_FLOW; seen in 12 verified designs)
- azure_storage (STORES_IN, Blob HTTPS:443; seen in 12 verified designs)
- azure_key_vault (AUTHENTICATES_WITH, Managed Identity:443; seen in 12 verified designs)
- aws_s3 (CONNECTS_TO, HTTPS / VPN:443; seen in 8 verified designs)
- azure_postgres (DATABASE_CONNECTION, PostgreSQL / TCP:5432; seen in 6 verified designs)
- azure_redis (CONNECTS_TO, Redis TLS:6380; seen in 6 verified designs)
- azure_cosmos_db (CONNECTS_TO, HTTPS:443; seen in 3 verified designs)

## azure_waf connects to
- azure_front_door (ASSOCIATED_WITH; seen in 16 verified designs)

## Cross-cloud
Cross-cloud connections: the engine accepts them only from compute (EC2, VM/VMSS, Lambda, Functions) to compute, storage or SQL, or when either end is a gateway/CDN/edge service (Application Gateway, CloudFront, Front Door). Route 53 → Application Gateway is used for failover and weighted routing; an Azure VM Scale Set → S3 is used for asset replication.
