import { CanvasNode } from '@/types';

type Provider = 'aws' | 'azure';

interface TranslationMap {
  [key: string]: string;
}

const awsToAzure: TranslationMap = {
  'aws_ec2': 'azure_vm',
  'aws_vpc': 'azure_vnet',
  'aws_subnet': 'azure_subnet',
  'aws_rds': 'azure_sql',
  'aws_s3': 'azure_storage',
  'aws_alb': 'azure_app_gw',
  'aws_nat': 'azure_nat',
  'aws_igw': 'azure_public_ip',
  'aws_cloud_boundary': 'azure_cloud_boundary',
};

const azureToAws: TranslationMap = {
  'azure_vm': 'aws_ec2',
  'azure_vnet': 'aws_vpc',
  'azure_subnet': 'aws_subnet',
  'azure_sql': 'aws_rds',
  'azure_storage': 'aws_s3',
  'azure_app_gw': 'aws_alb',
  'azure_nat': 'aws_nat',
  'azure_public_ip': 'aws_igw',
  'azure_cloud_boundary': 'aws_cloud_boundary',
};

export class CloudCostComparisonService {
  /**
   * Translate a set of CanvasNodes from one provider to another.
   * This handles basic mapping of resource types and strips out provider-specific config 
   * that wouldn't translate cleanly, keeping the basic sizes/names.
   */
  static translateNodes(nodes: CanvasNode[], targetProvider: Provider): CanvasNode[] {
    const map = targetProvider === 'azure' ? awsToAzure : azureToAws;

    return nodes.map(node => {
      const translatedType = map[node.resourceType] || node.resourceType;
      
      // Attempt rudimentary translation of config if needed, otherwise rely on default mapping
      const config = { ...node.config };
      
      if (node.resourceType === 'aws_ec2' && targetProvider === 'azure') {
        const type = String(config.instanceType || '').toLowerCase();
        if (type.includes('micro')) config.instanceType = 'Standard_B1s';
        else config.instanceType = 'Standard_D2s_v3';
      } else if (node.resourceType === 'azure_vm' && targetProvider === 'aws') {
        const type = String(config.instanceSize || '').toLowerCase();
        if (type.includes('b1')) config.instanceType = 't3.micro';
        else config.instanceType = 'm5.large';
      }

      return {
        ...node,
        provider: targetProvider,
        resourceType: translatedType,
        config
      };
    });
  }

  /**
   * For the backend: Translate raw resource objects
   */
  static translateResources(resources: any[], targetProvider: Provider): any[] {
    const map = targetProvider === 'azure' ? awsToAzure : azureToAws;
    return resources.map(res => {
      const translatedType = map[res.resourceType] || res.resourceType;
      return {
        ...res,
        provider: targetProvider,
        resourceType: translatedType,
      };
    });
  }
}
