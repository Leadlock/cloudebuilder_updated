import { awsResources } from './aws';
import { azureResources } from './azure';
import { terraformAwsCatalog, terraformAzureCatalog } from './catalog';
import { ResourceDefinition, CloudProvider } from '@/types';

/**
 * Deduplicate and merge resources by unique type.
 * Curated specialized definitions take precedence, while catalog fills the complete Terraform suite.
 */
function mergeResources(curated: ResourceDefinition[], catalog: ResourceDefinition[]): ResourceDefinition[] {
  const map = new Map<string, ResourceDefinition>();
  for (const r of catalog) {
    map.set(r.type, r);
  }
  for (const r of curated) {
    map.set(r.type, r);
  }
  return Array.from(map.values());
}

export const fullAwsResources: ResourceDefinition[] = mergeResources(awsResources, terraformAwsCatalog);
export const fullAzureResources: ResourceDefinition[] = mergeResources(azureResources, terraformAzureCatalog);

/** Core AI dataset and containment resources */
export const allResources: ResourceDefinition[] = [...awsResources, ...azureResources];

/** Complete multi-cloud Terraform catalog (curated + extended Terraform suite) */
export const allCatalogResources: ResourceDefinition[] = [...fullAwsResources, ...fullAzureResources];

export function getResourcesByProvider(provider: CloudProvider): ResourceDefinition[] {
  if (provider === 'aws') return fullAwsResources;
  if (provider === 'azure') return fullAzureResources;
  return allCatalogResources;
}

export function getResourceDefinition(type: string): ResourceDefinition | undefined {
  return allCatalogResources.find((r) => r.type === type);
}

export { awsResources, azureResources };
export * from './catalog';
