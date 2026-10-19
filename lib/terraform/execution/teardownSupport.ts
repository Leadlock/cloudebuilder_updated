/**
 * Helpers that make a teardown work even when the deployment did not finish cleanly.
 *
 *  - Deletion protection. The generated Terraform turns it on for load balancers, databases and DynamoDB tables, and AWS refuses to
 *    delete a protected resource, so a teardown (which only deletes) could never remove them. Just before the confirmed teardown
 *    runs, protection is switched off on exactly the resources the reviewed destroy plan will delete, and nothing else.
 *  - A minimal configuration. A destroy plan removes everything in Terraform's recorded state whatever the configuration says, but
 *    Terraform still needs a configuration that loads. If the saved design cannot be turned into a valid one (it was changed since,
 *    or it has a problem that stopped the deployment in the first place), teardown falls back to a configuration with only the
 *    cloud provider, and works from the state alone.
 *
 * Nothing here ever deletes a resource: it only switches protection off and builds a provider-only configuration.
 */
import { ElasticLoadBalancingV2Client, ModifyLoadBalancerAttributesCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { RDSClient, ModifyDBInstanceCommand } from '@aws-sdk/client-rds';
import { DynamoDBClient, UpdateTableCommand } from '@aws-sdk/client-dynamodb';

export interface ProtectedResource { type: 'aws_lb' | 'aws_db_instance' | 'aws_dynamodb_table'; id: string; /** Its Terraform address, shown to the user before they confirm. */ address: string }

interface LoosePlanJson { resource_changes?: { address: string; type: string; mode?: string; change: { actions: string[]; before?: Record<string, unknown> | null } }[] }

/** Resources the destroy plan will delete that currently have deletion protection on, with the id AWS knows them by. */
export function findProtectedResources(planJson: LoosePlanJson): ProtectedResource[] {
  const found: ProtectedResource[] = [];
  for (const rc of planJson.resource_changes ?? []) {
    if ((rc.mode ?? 'managed') !== 'managed' || !rc.change.actions.includes('delete')) continue;
    const b = rc.change.before ?? {};
    if (rc.type === 'aws_lb' && b['enable_deletion_protection'] === true && typeof b['arn'] === 'string') found.push({ type: 'aws_lb', id: b['arn'], address: rc.address });
    else if (rc.type === 'aws_db_instance' && b['deletion_protection'] === true && typeof b['identifier'] === 'string') found.push({ type: 'aws_db_instance', id: b['identifier'], address: rc.address });
    else if (rc.type === 'aws_dynamodb_table' && b['deletion_protection_enabled'] === true && typeof b['name'] === 'string') found.push({ type: 'aws_dynamodb_table', id: b['name'], address: rc.address });
  }
  return found;
}

export interface ProtectionClients {
  elb: { send(command: unknown): Promise<unknown> };
  rds: { send(command: unknown): Promise<unknown> };
  ddb: { send(command: unknown): Promise<unknown> };
}

export function protectionClients(env: Record<string, string>, region: string): ProtectionClients {
  const credentials = { accessKeyId: env['AWS_ACCESS_KEY_ID']!, secretAccessKey: env['AWS_SECRET_ACCESS_KEY']!, sessionToken: env['AWS_SESSION_TOKEN'] };
  return { elb: new ElasticLoadBalancingV2Client({ region, credentials }), rds: new RDSClient({ region, credentials }), ddb: new DynamoDBClient({ region, credentials }) };
}

/**
 * Switches deletion protection off for each resource. A failure on one is logged and does not stop the others: the teardown then
 * reports exactly what AWS still refuses.
 */
export async function disableDeletionProtection(items: ProtectedResource[], clients: ProtectionClients, log: (line: string) => void): Promise<void> {
  for (const item of items) {
    try {
      if (item.type === 'aws_lb') {
        await clients.elb.send(new ModifyLoadBalancerAttributesCommand({ LoadBalancerArn: item.id, Attributes: [{ Key: 'deletion_protection.enabled', Value: 'false' }] }));
      } else if (item.type === 'aws_db_instance') {
        await clients.rds.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: item.id, DeletionProtection: false, ApplyImmediately: true }));
      } else {
        await clients.ddb.send(new UpdateTableCommand({ TableName: item.id, DeletionProtectionEnabled: false }));
      }
      log(`[CloudBuilder] Deletion protection switched off for ${item.type} ${item.id.split('/').slice(-2, -1)[0] ?? item.id}.\n`);
    } catch (err) {
      log(`[CloudBuilder] Could not switch deletion protection off for ${item.type} ${item.id} (${(err as { name?: string })?.name ?? 'error'}); the teardown will report it if AWS refuses the delete.\n`);
    }
  }
}

/** A configuration with only the AWS provider (and its region), enough for Terraform to destroy whatever the state records. */
export function minimalAwsDestroyConfig(region: string): { filename: string; content: string }[] {
  return [
    {
      filename: 'providers.tf',
      content: `terraform {\n  required_version = ">= 1.5"\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "~> 5.0"\n    }\n  }\n}\n\nprovider "aws" {\n  region = var.aws_region\n}\n`,
    },
    {
      filename: 'variables.tf',
      content: `variable "aws_region" {\n  type    = string\n  default = "${region.replace(/[^a-z0-9-]/g, '')}"\n}\n`,
    },
  ];
}
