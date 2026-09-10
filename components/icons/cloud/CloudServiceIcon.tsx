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
} from './AzureIcons';

export interface CloudServiceIconProps {
  provider?: 'aws' | 'azure' | 'multi';
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
