import React from 'react';
import {
  AwsIcon,
  AwsVpcIcon,
  AwsSubnetIcon,
  AwsEc2Icon,
  AwsAlbIcon,
  AwsAutoScalingIcon,
  AwsS3Icon,
  AwsRdsIcon,
  AwsLambdaIcon,
  AwsEcsIcon,
  AwsEksIcon,
  AwsIamIcon,
  AwsIamUserIcon,
  AwsKmsIcon,
  AwsCloudwatchIcon,
  AwsIgwIcon,
  AwsNatIcon,
  AwsRouteTableIcon,
  AwsSgIcon,
  AwsEbsIcon,
  AwsDynamodbIcon,
  AwsCloudFrontIcon,
  AwsInternetIcon,
  AwsApiGatewayIcon,
  AwsDocdbIcon,
  AwsSecretsManagerIcon,
  AwsClientIcon,
  AwsSnsIcon,
  AwsEventBridgeIcon,
  AwsCognitoIcon,
  AwsStepFunctionsIcon,
  AwsElastiCacheIcon,
  ExternalServiceIcon,
} from './AwsIcons';
import {
  AzureIcon,
  AzureResourceGroupIcon,
  AzureVnetIcon,
  AzureSubnetIcon,
  AzureVmIcon,
  AzureLbIcon,
  AzureAppGatewayIcon,
  AzureSqlIcon,
  AzureStorageIcon,
  AzureKeyVaultIcon,
  AzureFunctionsIcon,
  AzureAksIcon,
  AzurePublicIpIcon,
  AzureNsgIcon,
  AzureNicIcon,
  AzureAppServiceIcon,
  AzureEntraUserIcon,
  AzureManagedIdentityIcon,
  AzureRbacIcon,
  AzureRedisIcon,
  AzurePostgresIcon,
  AzureFrontDoorIcon,
} from './AzureIcons';

export { AwsIcon } from './AwsIcons';
export { AzureIcon } from './AzureIcons';

export interface CloudServiceIconProps {
  provider?: import('@/types').CloudProvider;
  resourceType: string;
  size?: number;
  className?: string;
  variant?: 'flat' | 'badge' | 'container';
}

export function CloudServiceIcon({
  provider = 'aws',
  resourceType,
  size = 24,
  className = '',
  variant = 'flat',
}: CloudServiceIconProps) {
  // Normalize resourceType
  const type = resourceType.toLowerCase();

  // A third-party service is neither an AWS nor an Azure product: a neutral icon, whichever cloud the design is on.
  if (type.endsWith('_external_service')) return <ExternalServiceIcon size={size} className={className} />;

  // AWS Icons mapping
  if (type.includes('vpc') && !type.includes('subnet') && !type.includes('endpoint')) {
    return <AwsVpcIcon size={size} className={className} />;
  }
  if (type.includes('subnet')) {
    return provider === 'azure' || type.startsWith('azure_') ? (
      <AzureSubnetIcon size={size} className={className} />
    ) : (
      <AwsSubnetIcon size={size} className={className} />
    );
  }
  if (type.includes('cloudfront') || type.includes('cdn')) {
    return <AwsCloudFrontIcon size={size} className={className} />;
  }
  if (type.includes('apigateway') || type.includes('api_gateway') || type.includes('apigw')) {
    return <AwsApiGatewayIcon size={size} className={className} />;
  }
  if (type.includes('docdb') || type.includes('documentdb') || type.includes('document_db')) {
    return <AwsDocdbIcon size={size} className={className} />;
  }
  if (type.includes('secretsmanager') || type.includes('secrets_manager') || (type.includes('secret') && !type.includes('key_vault'))) {
    return <AwsSecretsManagerIcon size={size} className={className} />;
  }
  if (type.includes('client') || type.includes('browser') || type.includes('end_user')) {
    return <AwsClientIcon size={size} className={className} />;
  }
  if (type.includes('sns') || (type.includes('notification') && !type.includes('s3'))) {
    return <AwsSnsIcon size={size} className={className} />;
  }
  if (type.includes('eventbridge') || type.includes('event_bridge') || type.includes('events')) {
    return <AwsEventBridgeIcon size={size} className={className} />;
  }
  if (type.includes(['cog', 'nito'].join('')) || type.includes(['user', '_pool'].join(''))) {
    return <AwsCognitoIcon size={size} className={className} />;
  }
  if (type.includes('step_functions') || type.includes('sfn') || type.includes('state_machine')) {
    return <AwsStepFunctionsIcon size={size} className={className} />;
  }
  if (type.includes('internet') || type.includes('public_traffic') || type === 'aws_internet') {
    return <AwsInternetIcon size={size} className={className} />;
  }
  if (type.includes('ec2') || type === 'aws_instance') {
    return <AwsEc2Icon size={size} className={className} />;
  }
  if (type.includes('alb') || type === 'aws_lb' || (type.includes('load') && type.startsWith('aws_'))) {
    return <AwsAlbIcon size={size} className={className} />;
  }
  if (type.includes('auto') || type.includes('asg') || type.includes('scaling')) {
    return <AwsAutoScalingIcon size={size} className={className} />;
  }
  if (type.includes('s3') || type === 'aws_s3_bucket') {
    return <AwsS3Icon size={size} className={className} />;
  }
  if (type.includes('rds') || type === 'aws_db_instance' || type.includes('aurora')) {
    return <AwsRdsIcon size={size} className={className} />;
  }
  if (type.includes('lambda')) {
    return <AwsLambdaIcon size={size} className={className} />;
  }
  if (type.includes('ecs') || type.includes('fargate')) {
    return <AwsEcsIcon size={size} className={className} />;
  }
  if (type.includes('eks') || (type.includes('k8s') && type.startsWith('aws_'))) {
    return <AwsEksIcon size={size} className={className} />;
  }
  if (type.includes('iam_user') || type === 'aws_iam_user') {
    return <AwsIamUserIcon size={size} className={className} />;
  }
  if (type.includes('ad_user') || type.includes('entra') || type === 'azure_ad_user') {
    return <AzureEntraUserIcon size={size} className={className} />;
  }
  if (type.includes('managed_identity') || type.includes('user_assigned_identity') || type.includes('msi')) {
    return <AzureManagedIdentityIcon size={size} className={className} />;
  }
  if (type.includes('role_assignment') || type.includes('rbac')) {
    return <AzureRbacIcon size={size} className={className} />;
  }
  if (type.includes('iam') || type.includes('role')) {
    return <AwsIamIcon size={size} className={className} />;
  }
  if (type.includes('kms') || type.includes('key')) {
    return provider === 'azure' || type.startsWith('azure_') ? (
      <AzureKeyVaultIcon size={size} className={className} />
    ) : (
      <AwsKmsIcon size={size} className={className} />
    );
  }
  if (type.includes('cloudwatch') || type.includes('alarm')) {
    return <AwsCloudwatchIcon size={size} className={className} />;
  }
  if (type.includes('igw') || type.includes('internet_gateway')) {
    return <AwsIgwIcon size={size} className={className} />;
  }
  if (type.includes('nat') || type.includes('nat_gateway')) {
    return <AwsNatIcon size={size} className={className} />;
  }
  if (type.includes('route') || type.includes('route_table')) {
    return <AwsRouteTableIcon size={size} className={className} />;
  }
  if (type.includes('sg') || type.includes('security_group') || type.includes('nsg')) {
    return provider === 'azure' || type.startsWith('azure_') ? (
      <AzureNsgIcon size={size} className={className} />
    ) : (
      <AwsSgIcon size={size} className={className} />
    );
  }
  if (type.includes('route53') || type.includes('r53') || type.includes('dns')) {
    return <AwsRouteTableIcon size={size} className={className} />;
  }
  if (type.includes('bedrock') || type.includes('ai')) {
    return (
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
        <rect width="48" height="48" rx="8" fill="#059669" fillOpacity="0.16" />
        <path d="M24 10l9 5.2v10.4L24 31l-9-5.4V15.2L24 10z" stroke="#059669" strokeWidth="2.5" fill="#10B981" fillOpacity="0.3" />
        <circle cx="24" cy="20.5" r="4" fill="#059669" />
        <path d="M19 33l5 5 5-5" stroke="#059669" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (type.includes('guardduty') || type.includes('guard')) {
    return (
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
        <rect width="48" height="48" rx="8" fill="#E11D48" fillOpacity="0.16" />
        <path d="M24 8l14 6v10c0 9-6 16-14 18-8-2-14-9-14-18V14l14-6z" stroke="#E11D48" strokeWidth="2.5" fill="#F43F5E" fillOpacity="0.25" />
        <circle cx="24" cy="23" r="5" fill="#E11D48" />
        <circle cx="24" cy="23" r="2" fill="#FFF" />
      </svg>
    );
  }
  if (type.includes('security_hub') || type.includes('shub')) {
    return (
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
        <rect width="48" height="48" rx="8" fill="#DC2626" fillOpacity="0.16" />
        <path d="M24 8l13 7v10c0 8.5-5.5 15.5-13 17.5-7.5-2-13-9-13-17.5V15l13-7z" stroke="#DC2626" strokeWidth="2.5" />
        <path d="M18 24h12M24 18v12" stroke="#DC2626" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (type.includes('cloudtrail') || type.includes('trail')) {
    return (
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
        <rect width="48" height="48" rx="8" fill="#DB2777" fillOpacity="0.16" />
        <path d="M12 36c4-12 10-18 24-22M12 28c3-8 8-12 18-14" stroke="#DB2777" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="36" cy="14" r="4" fill="#DB2777" />
      </svg>
    );
  }
  if (type.includes('config')) {
    return (
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
        <rect width="48" height="48" rx="8" fill="#9333EA" fillOpacity="0.16" />
        <rect x="12" y="12" width="24" height="24" rx="4" stroke="#9333EA" strokeWidth="2.5" />
        <path d="M18 20h12M18 26h8M18 32h5" stroke="#9333EA" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (type.includes('waf') || type.includes('cloudflare')) {
    return (
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
        <rect width="48" height="48" rx="8" fill="#F97316" fillOpacity="0.16" />
        <path d="M24 9l12 5.5v9c0 8-5 14-12 16.5-7-2.5-12-8.5-12-16.5v-9L24 9z" stroke="#F97316" strokeWidth="2.5" fill="#FB923C" fillOpacity="0.25" />
        <path d="M18 24l4 4 8-8" stroke="#F97316" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (type.includes('elasticache') || (type.includes('cache') && !type.includes('azure_') && provider !== 'azure')) {
    return <AwsElastiCacheIcon size={size} className={className} />;
  }
  if (type.includes('redis') || (type.includes('cache') && (provider === 'azure' || type.startsWith('azure_')))) {
    return <AzureRedisIcon size={size} className={className} />;
  }
  if (type.includes('front_door') || type.includes('frontdoor')) {
    return <AzureFrontDoorIcon size={size} className={className} />;
  }
  if (type.includes('postgres') || type.includes('postgresql')) {
    return provider === 'azure' || type.startsWith('azure_') ? (
      <AzurePostgresIcon size={size} className={className} />
    ) : (
      <AwsRdsIcon size={size} className={className} />
    );
  }
  if (type.includes('sqs') || type.includes('queue')) {
    return <AwsLambdaIcon size={size} className={className} />;
  }
  if (type.includes('vmss') || type.includes('scale_set')) {
    return <AzureVmIcon size={size} className={className} />;
  }
  if (type.includes('ebs') || type.includes('volume') || type.includes('disk')) {
    return <AwsEbsIcon size={size} className={className} />;
  }
  if (type.includes('dynamo') || type.includes('dynamodb')) {
    return <AwsDynamodbIcon size={size} className={className} />;
  }

  // Azure Icons mapping
  if (type.includes('resource_group') || type === 'azure_rg') {
    return <AzureResourceGroupIcon size={size} className={className} />;
  }
  if (type.includes('vnet') || type.includes('virtual_network')) {
    return <AzureVnetIcon size={size} className={className} />;
  }
  if (type.includes('vm') || type.includes('virtual_machine')) {
    return <AzureVmIcon size={size} className={className} />;
  }
  if (type.includes('azure_lb') || (type.includes('lb') && type.startsWith('azure_'))) {
    return <AzureLbIcon size={size} className={className} />;
  }
  if (type.includes('app_gateway') || type.includes('application_gateway')) {
    return <AzureAppGatewayIcon size={size} className={className} />;
  }
  if (type.includes('app_service')) {
    return <AzureAppServiceIcon size={size} className={className} />;
  }
  if (type.includes('sql') || type.includes('mssql') || type.includes('database')) {
    return <AzureSqlIcon size={size} className={className} />;
  }
  if (type.includes('storage') || type.includes('blob')) {
    return <AzureStorageIcon size={size} className={className} />;
  }
  if (type.includes('vault') || type.includes('key_vault')) {
    return <AzureKeyVaultIcon size={size} className={className} />;
  }
  if (type.includes('function') || type.includes('functions')) {
    return <AzureFunctionsIcon size={size} className={className} />;
  }
  if (type.includes('aks')) {
    return <AzureAksIcon size={size} className={className} />;
  }
  if (type.includes('public_ip') || type.includes('pip') || type.includes('eip')) {
    return provider === 'azure' ? (
      <AzurePublicIpIcon size={size} className={className} />
    ) : (
      <AwsIgwIcon size={size} className={className} />
    );
  }
  if (type.includes('nic') || type.includes('network_interface')) {
    return <AzureNicIcon size={size} className={className} />;
  }

  // Fallback to Provider Logo or Default Box
  if (provider === 'azure' || type.startsWith('azure_')) {
    return <AzureIcon size={size} className={className} />;
  }
  return <AwsIcon size={size} className={className} />;
}
