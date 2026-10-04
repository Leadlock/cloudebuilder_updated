/**
 * Creates the remote Terraform state storage (S3 bucket + optional DynamoDB lock table, or an Azure resource group + storage account +
 * container) in the user's own cloud account, so they do not have to build it by hand before the first plan.
 *
 * Runs only when the user clicks "Create state storage" (never as a side effect of a plan), with the same short-lived credentials
 * Terraform itself runs on. Every step is idempotent: something that already exists in the caller's own account is reused, never
 * modified or replaced. The state holds resource ids and sometimes secrets, so what is created is locked down: private, encrypted,
 * versioned (so a bad run can be rolled back), and reachable only over TLS.
 *
 * Nothing here ever deletes anything.
 */
import {
  S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketVersioningCommand, PutBucketEncryptionCommand,
  PutPublicAccessBlockCommand, PutBucketPolicyCommand, PutBucketTaggingCommand,
} from '@aws-sdk/client-s3';
import { DynamoDBClient, DescribeTableCommand, CreateTableCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { STATE_BUCKET_PREFIX, STATE_LOCK_TABLE_PREFIX } from '@/lib/cloud/stateStoragePolicy';

export interface StateBackendResult {
  /** The names to use (filled in when the caller left the bucket name empty). */
  bucket?: string;
  dynamodbTable?: string;
  storageAccountName?: string;
  /** One line per thing that was created or already there, shown to the user. */
  steps: { what: string; outcome: 'created' | 'already-exists' }[];
}

export class StateBackendError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'StateBackendError';
  }
}

interface Sender { send(command: unknown): Promise<unknown> }
export interface AwsClients { s3: Sender; ddb: Sender; sts: Sender; waitForTable?: (name: string) => Promise<void> }

/** S3 bucket names are global across all of AWS, so a generic name ("terraform-state") is almost always taken. */
export function defaultBucketName(awsAccountId: string, region: string): string {
  return `cloudcraft-tfstate-${awsAccountId}-${region}`.toLowerCase().slice(0, 63).replace(/-+$/, '');
}

const errName = (e: unknown): string => (e as { name?: string })?.name ?? '';
const errStatus = (e: unknown): number => (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 0;

/** The provider's raw error mentions ARNs and request ids; the user needs the cause and the fix. */
function explainAwsAccessDenied(action: string): StateBackendError {
  return new StateBackendError(
    `AWS refused "${action}". The role CloudCraft uses is read-only by default, so it cannot create storage. Add the "Extra policy for state storage" shown in Cloud Accounts → Connect an AWS account (step 2) to that role — it covers buckets named ${STATE_BUCKET_PREFIX}* and lock tables named ${STATE_LOCK_TABLE_PREFIX}*, so leave the bucket name empty or use those prefixes — or create the bucket yourself in the AWS console and enter its name here.`,
    403,
  );
}

export async function ensureAwsStateBackend(
  backend: { bucket?: string; region: string; dynamodbTable?: string },
  clients: AwsClients,
): Promise<StateBackendResult> {
  const steps: StateBackendResult['steps'] = [];
  let bucket = backend.bucket?.trim();
  if (!bucket) {
    const who = (await clients.sts.send(new GetCallerIdentityCommand({}))) as { Account?: string };
    if (!who.Account) throw new StateBackendError('Could not work out your AWS account id to name the bucket. Enter a bucket name instead.');
    bucket = defaultBucketName(who.Account, backend.region);
  }

  // 1. The bucket.
  let exists = false;
  try {
    await clients.s3.send(new HeadBucketCommand({ Bucket: bucket }));
    exists = true;
  } catch (e) {
    const status = errStatus(e);
    if (status === 403) {
      throw new StateBackendError(`The bucket name "${bucket}" is already used by a different AWS account (bucket names are shared by everyone on AWS), or this role may not list it. Pick another name — for example ${bucket}-2 — or leave the name empty and CloudCraft will choose a unique one.`, 409);
    }
    if (status !== 404 && errName(e) !== 'NotFound') throw e;
  }

  if (exists) {
    steps.push({ what: `S3 bucket ${bucket}`, outcome: 'already-exists' });
  } else {
    try {
      await clients.s3.send(new CreateBucketCommand({
        Bucket: bucket,
        ...(backend.region === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: backend.region as never } }),
      }));
      steps.push({ what: `S3 bucket ${bucket}`, outcome: 'created' });
    } catch (e) {
      if (errName(e) === 'BucketAlreadyOwnedByYou') steps.push({ what: `S3 bucket ${bucket}`, outcome: 'already-exists' });
      else if (errName(e) === 'BucketAlreadyExists') throw new StateBackendError(`The bucket name "${bucket}" is taken by another AWS account. Pick a different name, or leave it empty so CloudCraft picks a unique one.`, 409);
      else if (errName(e) === 'AccessDenied' || errStatus(e) === 403) throw explainAwsAccessDenied('s3:CreateBucket');
      else throw e;
    }
  }

  // 2. Lock it down. Safe to repeat on an existing bucket of ours: these only tighten settings the state needs.
  try {
    await clients.s3.send(new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
    }));
    await clients.s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }));
    await clients.s3.send(new PutBucketEncryptionCommand({
      Bucket: bucket,
      ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: true }] },
    }));
    await clients.s3.send(new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Sid: 'DenyInsecureTransport', Effect: 'Deny', Principal: '*', Action: 's3:*',
          Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        }],
      }),
    }));
    steps.push({ what: 'Bucket is private, versioned, encrypted and TLS-only', outcome: exists ? 'already-exists' : 'created' });
    // Tags make it findable later (AWS Tag Editor: ManagedBy = CloudCraft). Best effort: an older role policy without this action is fine.
    try {
      await clients.s3.send(new PutBucketTaggingCommand({ Bucket: bucket, Tagging: { TagSet: [{ Key: 'ManagedBy', Value: 'CloudCraft' }, { Key: 'Purpose', Value: 'terraform-state' }] } }));
    } catch { /* tagging is optional */ }
  } catch (e) {
    if (errName(e) === 'AccessDenied' || errStatus(e) === 403) throw explainAwsAccessDenied('s3:PutBucket* (securing the bucket)');
    throw e;
  }

  // 3. The lock table (optional): stops two runs from writing the state at once.
  const table = backend.dynamodbTable?.trim();
  if (table) {
    let tableExists = true;
    try {
      await clients.ddb.send(new DescribeTableCommand({ TableName: table }));
    } catch (e) {
      if (errName(e) === 'ResourceNotFoundException') tableExists = false;
      else if (errName(e) === 'AccessDeniedException' || errStatus(e) === 403) throw explainAwsAccessDenied('dynamodb:DescribeTable');
      else throw e;
    }
    if (tableExists) {
      steps.push({ what: `DynamoDB lock table ${table}`, outcome: 'already-exists' });
    } else {
      try {
        await clients.ddb.send(new CreateTableCommand({
          TableName: table,
          AttributeDefinitions: [{ AttributeName: 'LockID', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'LockID', KeyType: 'HASH' }],
          BillingMode: 'PAY_PER_REQUEST',
        }));
        await clients.waitForTable?.(table);
        steps.push({ what: `DynamoDB lock table ${table}`, outcome: 'created' });
      } catch (e) {
        if (errName(e) === 'ResourceInUseException') steps.push({ what: `DynamoDB lock table ${table}`, outcome: 'already-exists' });
        else if (errName(e) === 'AccessDeniedException' || errStatus(e) === 403) throw explainAwsAccessDenied('dynamodb:CreateTable');
        else throw e;
      }
    }
  }

  return { bucket, ...(table ? { dynamodbTable: table } : {}), steps };
}

/** Real AWS clients signed with the short-lived credentials Terraform itself would run on (see resolveExecutionCredentials). */
export function awsClientsFromEnv(env: Record<string, string>, region: string): AwsClients {
  const credentials = { accessKeyId: env['AWS_ACCESS_KEY_ID']!, secretAccessKey: env['AWS_SECRET_ACCESS_KEY']!, sessionToken: env['AWS_SESSION_TOKEN'] };
  const ddb = new DynamoDBClient({ region, credentials });
  return {
    s3: new S3Client({ region, credentials }),
    ddb,
    sts: new STSClient({ region, credentials }),
    waitForTable: async (name) => { await waitUntilTableExists({ client: ddb, maxWaitTime: 60 }, { TableName: name }); },
  };
}

// ─── Azure ────────────────────────────────────────────────────────────────────

export interface AzureStateClients {
  resourceGroupExists(name: string): Promise<boolean>;
  createResourceGroup(name: string, location: string): Promise<void>;
  storageNameAvailable(name: string): Promise<boolean>;
  storageAccountExists(rg: string, name: string): Promise<boolean>;
  createStorageAccount(rg: string, name: string, location: string): Promise<void>;
  containerExists(rg: string, account: string, container: string): Promise<boolean>;
  createContainer(rg: string, account: string, container: string): Promise<void>;
  enableVersioning(rg: string, account: string): Promise<void>;
}

export async function ensureAzureStateBackend(
  backend: { resourceGroupName: string; storageAccountName: string; containerName: string },
  location: string,
  c: AzureStateClients,
): Promise<StateBackendResult> {
  const steps: StateBackendResult['steps'] = [];
  const { resourceGroupName: rg, storageAccountName: account, containerName: container } = backend;
  try {
    if (await c.resourceGroupExists(rg)) steps.push({ what: `Resource group ${rg}`, outcome: 'already-exists' });
    else { await c.createResourceGroup(rg, location); steps.push({ what: `Resource group ${rg}`, outcome: 'created' }); }

    if (await c.storageAccountExists(rg, account)) {
      steps.push({ what: `Storage account ${account}`, outcome: 'already-exists' });
    } else {
      if (!(await c.storageNameAvailable(account))) {
        throw new StateBackendError(`The storage account name "${account}" is already used by someone else (storage account names are shared by everyone on Azure). Pick another name: 3-24 lowercase letters and digits.`, 409);
      }
      await c.createStorageAccount(rg, account, location);
      await c.enableVersioning(rg, account);
      steps.push({ what: `Storage account ${account} (private, TLS 1.2, no public blobs, versioned)`, outcome: 'created' });
    }

    if (await c.containerExists(rg, account, container)) steps.push({ what: `Container ${container}`, outcome: 'already-exists' });
    else { await c.createContainer(rg, account, container); steps.push({ what: `Container ${container}`, outcome: 'created' }); }
  } catch (e) {
    if (e instanceof StateBackendError) throw e;
    const code = (e as { code?: string; statusCode?: number })?.code ?? '';
    if (code === 'AuthorizationFailed' || (e as { statusCode?: number })?.statusCode === 403) {
      throw new StateBackendError('Azure refused to create the storage. The service principal only has the Reader role. Give it Contributor on the subscription (or on the resource group) so it can create the state storage, or create the storage account yourself and enter its names here.', 403);
    }
    throw e;
  }
  return { storageAccountName: account, steps };
}

/** Real Azure clients for a service principal (loaded lazily so the AWS path never pays for the Azure SDKs). */
export async function azureClientsFromEnv(env: Record<string, string>): Promise<AzureStateClients> {
  const [{ ClientSecretCredential }, { ResourceManagementClient }, { StorageManagementClient }] = await Promise.all([
    import('@azure/identity'), import('@azure/arm-resources'), import('@azure/arm-storage'),
  ]);
  const cred = new ClientSecretCredential(env['ARM_TENANT_ID']!, env['ARM_CLIENT_ID']!, env['ARM_CLIENT_SECRET']!);
  const sub = env['ARM_SUBSCRIPTION_ID']!;
  const rm = new ResourceManagementClient(cred, sub);
  const st = new StorageManagementClient(cred, sub);
  const notFound = (e: unknown) => (e as { statusCode?: number })?.statusCode === 404;
  return {
    resourceGroupExists: async (n) => (await rm.resourceGroups.checkExistence(n)).body,
    createResourceGroup: async (n, location) => { await rm.resourceGroups.createOrUpdate(n, { location }); },
    storageNameAvailable: async (n) => Boolean((await st.storageAccounts.checkNameAvailability({ name: n, type: 'Microsoft.Storage/storageAccounts' })).nameAvailable),
    storageAccountExists: async (rg, n) => { try { await st.storageAccounts.getProperties(rg, n); return true; } catch (e) { if (notFound(e) || (e as { code?: string })?.code === 'ResourceNotFound' || (e as { code?: string })?.code === 'ResourceGroupNotFound') return false; throw e; } },
    createStorageAccount: async (rg, n, location) => {
      await st.storageAccounts.beginCreateAndWait(rg, n, {
        location, kind: 'StorageV2', sku: { name: 'Standard_LRS' },
        minimumTlsVersion: 'TLS1_2', allowBlobPublicAccess: false, enableHttpsTrafficOnly: true,
      });
    },
    containerExists: async (rg, a, c) => { try { await st.blobContainers.get(rg, a, c); return true; } catch (e) { if (notFound(e)) return false; throw e; } },
    createContainer: async (rg, a, c) => { await st.blobContainers.create(rg, a, c, {}); },
    enableVersioning: async (rg, a) => { await st.blobServices.setServiceProperties(rg, a, { isVersioningEnabled: true }); },
  };
}
