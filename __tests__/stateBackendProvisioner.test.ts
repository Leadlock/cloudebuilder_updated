import {
  ensureAwsStateBackend, ensureAzureStateBackend, defaultBucketName, StateBackendError,
  type AwsClients, type AzureStateClients,
} from '@/lib/terraform/execution/stateBackendProvisioner';

const awsErr = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

/** A fake AWS: records every command by name; per-command behaviour can be overridden. */
function fakeAws(handlers: Record<string, () => unknown> = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const send = jest.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    calls.push({ name, input: command.input });
    const h = handlers[name];
    if (h) return h();
    return name === 'GetCallerIdentityCommand' ? { Account: '123456789012' } : {};
  });
  const clients: AwsClients = { s3: { send }, ddb: { send }, sts: { send }, waitForTable: jest.fn(async () => {}) };
  return { clients, calls, names: () => calls.map((c) => c.name) };
}

describe('default bucket name', () => {
  test('is unique per account and region, lower-case and within the 63-character limit', () => {
    const n = defaultBucketName('123456789012', 'eu-north-1');
    expect(n).toBe('cloudcraft-tfstate-123456789012-eu-north-1');
    expect(defaultBucketName('123456789012', 'ap-southeast-4-very-long-region-name-xxxxxxxxxxxxxxxxxxxxxx').length).toBeLessThanOrEqual(63);
  });
});

describe('AWS state storage', () => {
  test('creates a missing bucket, secures it, and creates the lock table', async () => {
    const f = fakeAws({
      HeadBucketCommand: () => { throw awsErr('NotFound', 404); },
      DescribeTableCommand: () => { throw awsErr('ResourceNotFoundException', 400); },
    });
    const r = await ensureAwsStateBackend({ bucket: 'my-state', region: 'eu-north-1', dynamodbTable: 'tf-lock' }, f.clients);

    expect(r.steps.map((s) => s.outcome)).toEqual(['created', 'created', 'created']);
    expect(f.names()).toEqual(expect.arrayContaining([
      'CreateBucketCommand', 'PutPublicAccessBlockCommand', 'PutBucketVersioningCommand', 'PutBucketEncryptionCommand', 'PutBucketPolicyCommand', 'CreateTableCommand',
    ]));
    const create = f.calls.find((c) => c.name === 'CreateBucketCommand')!.input;
    expect(create['CreateBucketConfiguration']).toEqual({ LocationConstraint: 'eu-north-1' });
    expect(f.calls.find((c) => c.name === 'CreateTableCommand')!.input['KeySchema']).toEqual([{ AttributeName: 'LockID', KeyType: 'HASH' }]);
    const policy = JSON.parse(String(f.calls.find((c) => c.name === 'PutBucketPolicyCommand')!.input['Policy']));
    expect(policy.Statement[0].Condition.Bool['aws:SecureTransport']).toBe('false');
    expect(f.calls.find((c) => c.name === 'PutPublicAccessBlockCommand')!.input['PublicAccessBlockConfiguration']).toEqual({ BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true });
  });

  test('us-east-1 must not send a LocationConstraint', async () => {
    const f = fakeAws({ HeadBucketCommand: () => { throw awsErr('NotFound', 404); } });
    await ensureAwsStateBackend({ bucket: 'my-state', region: 'us-east-1' }, f.clients);
    expect(f.calls.find((c) => c.name === 'CreateBucketCommand')!.input['CreateBucketConfiguration']).toBeUndefined();
  });

  test('an existing bucket and table are reused, not recreated', async () => {
    const f = fakeAws();
    const r = await ensureAwsStateBackend({ bucket: 'my-state', region: 'eu-north-1', dynamodbTable: 'tf-lock' }, f.clients);
    expect(r.steps.every((s) => s.outcome === 'already-exists')).toBe(true);
    expect(f.names()).not.toContain('CreateBucketCommand');
    expect(f.names()).not.toContain('CreateTableCommand');
  });

  test('no bucket name: a unique one is chosen from the AWS account id and returned', async () => {
    const f = fakeAws({ HeadBucketCommand: () => { throw awsErr('NotFound', 404); } });
    const r = await ensureAwsStateBackend({ region: 'eu-north-1' }, f.clients);
    expect(r.bucket).toBe('cloudcraft-tfstate-123456789012-eu-north-1');
    expect(f.calls.find((c) => c.name === 'CreateBucketCommand')!.input['Bucket']).toBe(r.bucket);
  });

  test('a name owned by another account is refused with an explanation, and nothing is created or changed', async () => {
    const f = fakeAws({ HeadBucketCommand: () => { throw awsErr('Forbidden', 403); } });
    await expect(ensureAwsStateBackend({ bucket: 'cloudcraft-test', region: 'eu-north-1' }, f.clients)).rejects.toThrow(/different AWS account/);
    expect(f.names()).toEqual(['HeadBucketCommand']);
  });

  test('a read-only role gets a plain explanation of the permissions to add', async () => {
    const f = fakeAws({
      HeadBucketCommand: () => { throw awsErr('NotFound', 404); },
      CreateBucketCommand: () => { throw awsErr('AccessDenied', 403); },
    });
    const err = (await ensureAwsStateBackend({ bucket: 'my-state', region: 'eu-north-1' }, f.clients).catch((e: unknown) => e)) as StateBackendError;
    expect(err).toBeInstanceOf(StateBackendError);
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/read-only/);
    expect(err.message).toMatch(/s3:CreateBucket/);
  });

  test('the code never issues a delete', async () => {
    const f = fakeAws({ HeadBucketCommand: () => { throw awsErr('NotFound', 404); }, DescribeTableCommand: () => { throw awsErr('ResourceNotFoundException', 400); } });
    await ensureAwsStateBackend({ bucket: 'my-state', region: 'eu-north-1', dynamodbTable: 'tf-lock' }, f.clients);
    expect(f.names().filter((n) => /Delete/.test(n))).toEqual([]);
  });
});

function fakeAzure(over: Partial<Record<keyof AzureStateClients, unknown>> = {}) {
  const log: string[] = [];
  const c: AzureStateClients = {
    resourceGroupExists: async () => false,
    createResourceGroup: async () => { log.push('createRG'); },
    storageNameAvailable: async () => true,
    storageAccountExists: async () => false,
    createStorageAccount: async () => { log.push('createAccount'); },
    containerExists: async () => false,
    createContainer: async () => { log.push('createContainer'); },
    enableVersioning: async () => { log.push('versioning'); },
    ...(over as Partial<AzureStateClients>),
  };
  return { c, log };
}
const az = { resourceGroupName: 'rg-tf', storageAccountName: 'cctfstate001', containerName: 'tfstate' };

describe('Azure state storage', () => {
  test('creates the resource group, a hardened storage account and the container', async () => {
    const f = fakeAzure();
    const r = await ensureAzureStateBackend(az, 'eastus', f.c);
    expect(f.log).toEqual(['createRG', 'createAccount', 'versioning', 'createContainer']);
    expect(r.steps.every((s) => s.outcome === 'created')).toBe(true);
  });

  test('existing pieces are reused', async () => {
    const f = fakeAzure({ resourceGroupExists: async () => true, storageAccountExists: async () => true, containerExists: async () => true });
    const r = await ensureAzureStateBackend(az, 'eastus', f.c);
    expect(f.log).toEqual([]);
    expect(r.steps.every((s) => s.outcome === 'already-exists')).toBe(true);
  });

  test('a storage account name used by someone else is refused', async () => {
    const f = fakeAzure({ storageNameAvailable: async () => false });
    await expect(ensureAzureStateBackend(az, 'eastus', f.c)).rejects.toThrow(/already used by someone else/);
    expect(f.log).not.toContain('createAccount');
  });

  test('a Reader-only service principal gets a plain explanation', async () => {
    const f = fakeAzure({ createResourceGroup: async () => { throw Object.assign(new Error('x'), { code: 'AuthorizationFailed', statusCode: 403 }); } });
    await expect(ensureAzureStateBackend(az, 'eastus', f.c)).rejects.toThrow(/Reader role/);
  });
});

describe('state bucket tags', () => {
  test('the bucket is tagged so it can be found later', async () => {
    const f = fakeAws({ HeadBucketCommand: () => { throw awsErr('NotFound', 404); } });
    await ensureAwsStateBackend({ bucket: 'my-state', region: 'eu-north-1' }, f.clients);
    const tag = f.calls.find((c) => c.name === 'PutBucketTaggingCommand')!;
    expect(JSON.stringify(tag.input)).toContain('"ManagedBy"');
    expect(JSON.stringify(tag.input)).toContain('"CloudCraft"');
  });
  test('a role without the tagging permission still gets its bucket', async () => {
    const f = fakeAws({ HeadBucketCommand: () => { throw awsErr('NotFound', 404); }, PutBucketTaggingCommand: () => { throw awsErr('AccessDenied', 403); } });
    const r = await ensureAwsStateBackend({ bucket: 'my-state', region: 'eu-north-1' }, f.clients);
    expect(r.steps[0]!.outcome).toBe('created');
  });
});
