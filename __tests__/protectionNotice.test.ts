import { protectionNotice } from '@/lib/terraform/execution/protectionNotice';
import { findProtectedResources } from '@/lib/terraform/execution/teardownSupport';

describe('the message shown before a teardown is confirmed', () => {
  const items = [
    { address: 'aws_lb.web', type: 'aws_lb' },
    { address: 'aws_db_instance.orders', type: 'aws_db_instance' },
    { address: 'aws_dynamodb_table.inv', type: 'aws_dynamodb_table' },
  ];

  test('names each resource, what it is, and says it happens only after confirming', () => {
    const n = protectionNotice(items)!;
    expect(n.title).toBe('Deletion protection will be switched off on 3 resources');
    expect(n.lines).toEqual([
      { kind: 'Load balancer', address: 'aws_lb.web' },
      { kind: 'Database', address: 'aws_db_instance.orders' },
      { kind: 'DynamoDB table', address: 'aws_dynamodb_table.inv' },
    ]);
    expect(n.body).toMatch(/AWS refuses to delete a protected resource/);
    expect(n.body).toMatch(/only after you confirm/);
    expect(n.footer).toMatch(/press Cancel: nothing has been changed yet/);
  });

  test('singular wording for one resource', () => {
    const n = protectionNotice([items[0]!])!;
    expect(n.title).toBe('Deletion protection will be switched off on 1 resource');
    expect(n.body).toMatch(/^This resource has deletion protection/);
  });

  test('nothing to say when no resource is protected, or when the input is missing or of another kind', () => {
    expect(protectionNotice([])).toBeNull();
    expect(protectionNotice(undefined)).toBeNull();
    expect(protectionNotice(null)).toBeNull();
    expect(protectionNotice([{ address: 'aws_vpc.main', type: 'aws_vpc' }])).toBeNull();
  });
});

describe('the preview carries the address of each protected resource', () => {
  test('from the destroy plan, only protected resources that will be deleted', () => {
    const plan = { resource_changes: [
      { type: 'aws_lb', change: { actions: ['delete'], before: { arn: 'arn:x', enable_deletion_protection: true } }, address: 'aws_lb.web' },
      { type: 'aws_lb', change: { actions: ['delete'], before: { arn: 'arn:y', enable_deletion_protection: false } }, address: 'aws_lb.open' },
      { type: 'aws_db_instance', change: { actions: ['no-op'], before: { identifier: 'keep', deletion_protection: true } }, address: 'aws_db_instance.keep' },
    ] };
    expect(findProtectedResources(plan as never)).toEqual([{ type: 'aws_lb', id: 'arn:x', address: 'aws_lb.web' }]);
  });
});
