import { StateBackendSchema, AwsBackendSchema } from '@/lib/terraform/execution/backendSchema';
import { ApiTerraformExecutionService } from '@/lib/services/ApiTerraformExecutionService';

const aws = { provider: 'aws' as const, bucket: 'cloudbuilder-tfstate-460195068628-eu-north-1', key: 'cloudbuilder/terraform.tfstate', region: 'eu-north-1' };

describe('state backend names are trimmed before they are checked', () => {
  test('a trailing or leading space (the usual result of pasting) is accepted and removed', () => {
    const r = StateBackendSchema.parse({ ...aws, bucket: ` ${aws.bucket} `, key: ` ${aws.key}\t`, region: 'eu-north-1 ', dynamodbTable: ' tf-lock ' });
    expect(r).toMatchObject({ bucket: aws.bucket, key: aws.key, region: 'eu-north-1', dynamodbTable: 'tf-lock' });
  });

  test('Azure names too', () => {
    const r = StateBackendSchema.parse({ provider: 'azure', resourceGroupName: ' rg-tf ', storageAccountName: 'cctfstate001 ', containerName: ' tfstate', key: ' a/b.tfstate ' });
    expect(r).toMatchObject({ resourceGroupName: 'rg-tf', storageAccountName: 'cctfstate001', containerName: 'tfstate', key: 'a/b.tfstate' });
  });

  test('a space INSIDE a name is still refused, with a message that says what is allowed', () => {
    const bad = AwsBackendSchema.safeParse({ ...aws, bucket: 'my state bucket' });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error!.issues)).toMatch(/lowercase letters, digits, dots or hyphens, no spaces/);
  });

  test('trimming does not weaken the checks: injection characters are still refused', () => {
    for (const bucket of ['x"; rm -rf', 'a${b}c', 'UPPER', "b'ucket"]) {
      expect(AwsBackendSchema.safeParse({ ...aws, bucket: ` ${bucket} ` }).success).toBe(false);
    }
    expect(AwsBackendSchema.safeParse({ ...aws, key: ' a" b ' }).success).toBe(false);
    expect(AwsBackendSchema.safeParse({ ...aws, region: ' not a region ' }).success).toBe(false);
  });

  test('an empty name (only spaces) is refused', () => {
    expect(AwsBackendSchema.safeParse({ ...aws, bucket: '   ' }).success).toBe(false);
    expect(AwsBackendSchema.safeParse({ ...aws, key: '   ' }).success).toBe(false);
  });
});

describe('a validation failure says which field was wrong', () => {
  const guarded = global.fetch;
  afterEach(() => { global.fetch = guarded; });

  test('the message includes the reasons, not just "Validation failed"', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      ok: false, error: { code: 'BAD_REQUEST', message: 'Validation failed', details: { formErrors: [], fieldErrors: { stateBackend: ['Invalid S3 bucket name: 3-63 lowercase letters, digits, dots or hyphens, no spaces'], environment: ['Invalid input'] } } },
    }), { status: 400 })) as unknown as typeof fetch;
    await expect(ApiTerraformExecutionService.generatePlan('p', 'production', 'a', { provider: 'aws', bucket: 'x', key: 'k', region: 'r' })).rejects.toThrow(/Validation failed: Invalid S3 bucket name.*; Invalid input/);
  });

  test('without details the message is unchanged', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: 'Access denied' } }), { status: 403 })) as unknown as typeof fetch;
    await expect(ApiTerraformExecutionService.generatePlan('p', 'production', 'a', { provider: 'aws', bucket: 'x', key: 'k', region: 'r' })).rejects.toThrow(/^Access denied$/);
  });
});
