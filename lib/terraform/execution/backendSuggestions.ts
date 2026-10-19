/**
 * Names for the Azure remote state storage, so "Create state storage for me" works without the person inventing four names.
 *
 * Pure (no Node imports): the Terraform panel uses it in the browser. AWS already does this on the server (the bucket is named after the
 * AWS account id); on Azure the storage account name must be unique across ALL of Azure and may only be 3-24 lowercase letters and
 * digits, so it is derived from the subscription id, which is the one thing that is both stable and yours alone.
 */
export interface AzureBackendSuggestion {
  resourceGroupName: string;
  storageAccountName: string;
  containerName: string;
  key: string;
}

export function suggestAzureBackend(subscriptionId: string | undefined | null): AzureBackendSuggestion {
  const digits = (subscriptionId ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  // "cctfstate" + up to 12 characters = at most 21: inside the 24-character limit, and still valid when the id is unknown.
  const storageAccountName = digits.length >= 4 ? `cctfstate${digits}` : 'cctfstatestorage';
  return {
    resourceGroupName: 'cloudbuilder-tfstate-rg',
    storageAccountName,
    containerName: 'tfstate',
    key: 'cloudbuilder/terraform.tfstate',
  };
}
