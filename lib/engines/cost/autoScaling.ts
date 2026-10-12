/**
 * An Auto Scaling group has no price of its own: what it costs is the EC2 instances it keeps running.
 *
 * The estimator used to treat `aws_auto_scaling` as free, on the grounds that its instances are separate `aws_ec2` resources. A group drawn
 * on its own (every AI-generated design, and any canvas with just an ASG) has no such resources, so the whole application tier was missing
 * from the total and the AWS side looked far cheaper than the equivalent Azure scale set. This turns the group into the instances it runs,
 * so the same EC2 price (live price list or built-in table) is used for it as for a standalone instance.
 */
export interface AutoScalingInstances {
  /** Configuration to price one instance with, as an `aws_ec2` resource. */
  instanceConfig: Record<string, unknown>;
  /** How many instances the group is priced at. */
  quantity: number;
  instanceType: string;
  assumptions: string[];
}

const DEFAULT_INSTANCE_TYPE = 't3.medium';
const DEFAULT_CAPACITY = 2;

function nonNegative(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

export function autoScalingAsInstances(config: Record<string, unknown>): AutoScalingInstances {
  const instanceType = typeof config['instanceType'] === 'string' && config['instanceType'].trim() ? config['instanceType'].trim() : DEFAULT_INSTANCE_TYPE;
  const desired = nonNegative(config['desiredCapacity']);
  const min = nonNegative(config['minSize']);
  const max = nonNegative(config['maxSize']);
  // The group runs its desired capacity; with none set it never runs fewer than its minimum.
  const quantity = desired ?? min ?? DEFAULT_CAPACITY;

  const assumptions = [
    `Priced as ${quantity} × ${instanceType} on-demand instance${quantity === 1 ? '' : 's'} (the group's desired capacity)`,
  ];
  if (max !== undefined && max > quantity) {
    assumptions.push(`The group can scale out to ${max} instances under load; each extra instance adds the same hourly cost`);
  }
  if (quantity === 0) assumptions.push('Desired capacity is 0, so no instances run and no compute cost is charged');

  return { instanceConfig: { ...config, instanceType }, quantity, instanceType, assumptions };
}
