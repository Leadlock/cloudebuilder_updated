/**
 * The Terraform resource types CloudCraft's generator can emit. A plan that would create or change anything else is
 * refused (see planGuardrails.ts): even if a crafted value somehow slipped extra HCL past the escaping in hclSafety.ts,
 * the resulting resource would not be on this list.
 *
 * Kept in step with TerraformGenerator.ts by __tests__/planGuardrails.test.ts, which fails if the generator starts
 * emitting a type that is missing here (or this list keeps one the generator no longer emits).
 */
export const ALLOWED_TERRAFORM_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'aws_appautoscaling_target', 'aws_autoscaling_group', 'aws_autoscaling_policy', 'aws_cloudfront_distribution',
  'aws_cloudwatch_log_group', 'aws_cloudwatch_metric_alarm', 'aws_db_instance', 'aws_db_subnet_group',
  'aws_dynamodb_table', 'aws_ebs_volume', 'aws_ecr_repository', 'aws_ecs_cluster', 'aws_ecs_service', 'aws_ecs_task_definition', 'aws_eip',
  'aws_eks_cluster', 'aws_eks_node_group', 'aws_elasticache_replication_group', 'aws_elasticache_subnet_group', 'aws_flow_log',
  'aws_iam_instance_profile', 'aws_iam_role', 'aws_iam_role_policy', 'aws_iam_role_policy_attachment', 'aws_instance', 'aws_internet_gateway', 'aws_kms_alias',
  'aws_kms_key', 'aws_lambda_function', 'aws_lambda_provisioned_concurrency_config', 'aws_launch_template', 'aws_lb',
  'aws_lb_listener', 'aws_lb_listener_rule', 'aws_lb_target_group', 'aws_nat_gateway', 'aws_network_acl', 'aws_route53_record',
  'aws_route53_zone', 'aws_route_table', 'aws_route_table_association', 'aws_s3_bucket',
  'aws_s3_bucket_accelerate_configuration', 'aws_s3_bucket_lifecycle_configuration',
  'aws_s3_bucket_ownership_controls', 'aws_s3_bucket_public_access_block',
  'aws_s3_bucket_request_payment_configuration', 'aws_s3_bucket_server_side_encryption_configuration',
  'aws_s3_bucket_versioning', 'aws_security_group', 'aws_security_group_rule', 'aws_sqs_queue', 'aws_subnet', 'aws_vpc', 'aws_wafv2_web_acl',
  'azurerm_application_gateway', 'azurerm_bastion_host', 'azurerm_cdn_frontdoor_endpoint',
  'azurerm_cdn_frontdoor_origin', 'azurerm_cdn_frontdoor_origin_group', 'azurerm_cdn_frontdoor_profile',
  'azurerm_cdn_frontdoor_route', 'azurerm_cosmosdb_account', 'azurerm_key_vault', 'azurerm_kubernetes_cluster',
  'azurerm_lb', 'azurerm_lb_backend_address_pool', 'azurerm_lb_probe', 'azurerm_lb_rule',
  'azurerm_linux_function_app', 'azurerm_linux_virtual_machine', 'azurerm_linux_virtual_machine_scale_set',
  'azurerm_linux_web_app', 'azurerm_monitor_autoscale_setting', 'azurerm_mssql_database',
  'azurerm_mssql_firewall_rule', 'azurerm_mssql_server', 'azurerm_mssql_server_security_alert_policy',
  'azurerm_nat_gateway', 'azurerm_nat_gateway_public_ip_association', 'azurerm_network_interface',
  'azurerm_network_security_group', 'azurerm_public_ip', 'azurerm_redis_cache', 'azurerm_resource_group',
  'azurerm_route_table', 'azurerm_service_plan', 'azurerm_storage_account', 'azurerm_subnet',
  'azurerm_subnet_nat_gateway_association', 'azurerm_virtual_network', 'azurerm_web_application_firewall_policy',
  'azurerm_windows_function_app', 'azurerm_windows_virtual_machine', 'azurerm_windows_virtual_machine_scale_set',
  'azurerm_windows_web_app',
  'azurerm_api_management', 'azurerm_application_insights', 'azurerm_container_app', 'azurerm_container_app_environment', 'azurerm_eventgrid_topic', 'azurerm_eventhub', 'azurerm_eventhub_namespace', 'azurerm_firewall', 'azurerm_firewall_policy', 'azurerm_firewall_policy_rule_collection_group', 'azurerm_network_security_rule', 'azurerm_subnet_network_security_group_association', 'azurerm_subnet_route_table_association', 'azurerm_cdn_frontdoor_firewall_policy', 'azurerm_cdn_frontdoor_security_policy', 'azurerm_container_registry', 'azurerm_log_analytics_workspace', 'azurerm_mysql_flexible_database',
  'azurerm_mysql_flexible_server', 'azurerm_mysql_flexible_server_configuration', 'azurerm_mysql_flexible_server_firewall_rule',
  'azurerm_postgresql_flexible_server', 'azurerm_postgresql_flexible_server_configuration', 'azurerm_postgresql_flexible_server_database',
  'azurerm_postgresql_flexible_server_firewall_rule', 'azurerm_private_dns_zone', 'azurerm_private_dns_zone_virtual_network_link',
  'azurerm_network_interface_security_group_association', 'azurerm_private_endpoint', 'azurerm_role_assignment', 'azurerm_user_assigned_identity', 'azurerm_servicebus_namespace', 'azurerm_servicebus_queue',]);
