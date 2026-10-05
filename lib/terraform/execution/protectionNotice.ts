/**
 * The message shown BEFORE a teardown is confirmed, naming the resources whose deletion protection CloudCraft will switch off.
 *
 * Load balancers, databases and DynamoDB tables are generated with deletion protection on, and AWS refuses to delete a protected
 * resource. So the confirmed teardown first turns protection off for exactly the protected resources in the reviewed plan. The person
 * must know that before they confirm: it is a change to their account, made on their behalf, ahead of the delete itself.
 * Pure (no Node imports) so the panel can use it in the browser.
 */
export interface ProtectionItem { address: string; type: string }

export interface ProtectionNotice {
  title: string;
  /** What will happen and why. */
  body: string;
  /** One line per resource: what it is, and its name in Terraform. */
  lines: { kind: string; address: string }[];
  footer: string;
}

const KIND: Record<string, string> = {
  aws_lb: 'Load balancer',
  aws_db_instance: 'Database',
  aws_dynamodb_table: 'DynamoDB table',
};

export function protectionNotice(items: ProtectionItem[] | null | undefined): ProtectionNotice | null {
  const list = (items ?? []).filter((i) => KIND[i.type]);
  if (list.length === 0) return null;
  const n = list.length;
  return {
    title: `Deletion protection will be switched off on ${n} resource${n === 1 ? '' : 's'}`,
    body: `${n === 1 ? 'This resource has' : 'These resources have'} deletion protection turned on, and AWS refuses to delete a protected resource. When you confirm, CloudCraft first turns the protection off ${n === 1 ? 'on it' : 'on each of them'}, then deletes ${n === 1 ? 'it' : 'them'} with the rest. It happens only after you confirm, and only for the ${n === 1 ? 'resource' : 'resources'} listed here.`,
    lines: list.map((i) => ({ kind: KIND[i.type]!, address: i.address })),
    footer: 'If you do not want these deleted, press Cancel: nothing has been changed yet.',
  };
}
