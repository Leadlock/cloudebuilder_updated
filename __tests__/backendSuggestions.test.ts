import { suggestAzureBackend } from '@/lib/terraform/execution/backendSuggestions';
import { AzureBackendSchema } from '@/lib/terraform/execution/backendSchema';

const SUB = '40ba1da4-7522-41de-b5e5-cfa1098bb7b1';

describe('suggestAzureBackend', () => {
  it('gives names that Azure and CloudBuilder accept, so "Create state storage for me" is usable at once', () => {
    const s = suggestAzureBackend(SUB);
    expect(AzureBackendSchema.safeParse({ provider: 'azure', ...s }).success).toBe(true);
    expect(s.storageAccountName).toMatch(/^[a-z0-9]{3,24}$/);
  });

  it('derives the storage account name from the subscription, so two subscriptions never collide and one is stable', () => {
    expect(suggestAzureBackend(SUB).storageAccountName).toBe(suggestAzureBackend(SUB).storageAccountName);
    expect(suggestAzureBackend(SUB).storageAccountName).not.toBe(suggestAzureBackend('11111111-2222-4333-8444-555555555555').storageAccountName);
    expect(suggestAzureBackend(SUB).storageAccountName).toBe('cctfstate40ba1da47522');
  });

  it('still gives valid names when the subscription is unknown, in any case, or has odd characters', () => {
    for (const sub of [undefined, null, '', '??', SUB.toUpperCase(), 'x'.repeat(200)]) {
      const s = suggestAzureBackend(sub as never);
      expect(AzureBackendSchema.safeParse({ provider: 'azure', ...s }).success).toBe(true);
      expect(s.storageAccountName.length).toBeLessThanOrEqual(24);
    }
  });
});
