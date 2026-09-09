import { awsResources } from './aws';
import { azureResources } from './azure';
import { ResourceDefinition, CloudProvider } from '@/types';

export const allResources: ResourceDefinition[] = [...awsResources, ...azureResources];

export function getResourcesByProvider(provider: CloudProvider): ResourceDefinition[] {
  return allResources.filter((r) => r.provider === provider);
}

export function getResourceDefinition(type: string): ResourceDefinition | undefined {
  return allResources.find((r) => r.type === type);
}

export { awsResources, azureResources };
