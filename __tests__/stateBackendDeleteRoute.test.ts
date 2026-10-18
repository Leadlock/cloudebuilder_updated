/**
 * @jest-environment node
 */
/** DELETE /api/projects/[id]/terraform/state-backend: who may, what must be typed, and that the provisioner is only called after every gate. */
import { NextRequest } from 'next/server';

const mockIdentity = jest.fn();
const mockAccess = jest.fn();
const mockDenied = jest.fn();
const mockRate = jest.fn();
const mockAudit = jest.fn();
const mockCreds = jest.fn();
const mockDelete = jest.fn();
class FakeStateError extends Error { constructor(m: string, public statusCode = 400) { super(m); } }

jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a) }));
jest.mock('@/lib/api/projectAccess', () => ({ requireProjectAccess: (...a: unknown[]) => mockAccess(...a) }));
jest.mock('@/lib/api/terraformAccess', () => ({ terraformExecutionDenied: (...a: unknown[]) => mockDenied(...a) }));
jest.mock('@/lib/api/rateLimit', () => ({ checkRateLimit: (...a: unknown[]) => mockRate(...a) }));
jest.mock('@/lib/terraform/execution/audit', () => ({ recordTerraformAudit: (...a: unknown[]) => mockAudit(...a) }));
jest.mock('@/lib/repositories/cloudAccountRepository', () => ({ cloudAccountRepository: { getCredentials: (...a: unknown[]) => mockCreds(...a) } }));
jest.mock('@/lib/cloud/credentials/resolveExecutionCredentials', () => ({ resolveExecutionCredentials: async () => ({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }) }));
jest.mock('@/lib/cloud/terraformCapability', () => ({ assertTerraformCapable: () => undefined }));
jest.mock('@/lib/terraform/execution/stateBackendProvisioner', () => ({
  ensureAwsStateBackend: jest.fn(), ensureAzureStateBackend: jest.fn(), awsClientsFromEnv: () => ({ s3: {} }), azureClientsFromEnv: jest.fn(),
  deleteAwsStateBackend: (...a: unknown[]) => mockDelete(...a), StateBackendError: FakeStateError,
}));

import { DELETE } from '@/app/api/projects/[id]/terraform/state-backend/route';

const B = 'cloudcraft-tfstate-123456789012-eu-north-1';
const call = (body: unknown) => DELETE(new NextRequest('http://x/api/projects/p1/terraform/state-backend', { method: 'DELETE', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id: 'p1' }) });
const ok = { cloudAccountId: 'a1', stateBackend: { provider: 'aws', bucket: B, region: 'eu-north-1' }, confirmName: B };

beforeEach(() => {
  jest.clearAllMocks();
  mockIdentity.mockReturnValue({ userId: 'u1', role: 'admin', email: 'a@x.com' });
  mockAccess.mockResolvedValue({ orgId: 'o1' });
  mockDenied.mockResolvedValue(null);
  mockRate.mockResolvedValue({ allowed: true });
  mockCreds.mockResolvedValue(JSON.stringify({ accessKeyId: 'AKIAXXXXXXXXXXXXXXXX', secretAccessKey: 's', region: 'eu-north-1', allowDeploy: true }));
  mockDelete.mockResolvedValue({ bucket: B, deletedObjects: 2, steps: [{ what: 'S3 bucket', outcome: 'deleted' }] });
});

describe('DELETE state-backend', () => {
  test('deletes after every gate, and audits the request and the result', async () => {
    const res = await call(ok);
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith({ bucket: B }, expect.anything());
    expect(mockAudit.mock.calls.map((c) => c[0].outcome)).toEqual(['requested', 'succeeded']);
  });
  test('needs a signed-in administrator', async () => {
    mockIdentity.mockReturnValue(null);
    expect((await call(ok)).status).toBe(401);
    mockIdentity.mockReturnValue({ userId: 'u1', role: 'member', email: 'a@x.com' });
    expect((await call(ok)).status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });
  test('the bucket name must be typed exactly', async () => {
    expect((await call({ ...ok, confirmName: 'other' })).status).toBe(400);
    expect((await call({ ...ok, confirmName: ` ${B} ` })).status).toBe(200);
  });
  test('Terraform access and the rate limit apply', async () => {
    mockDenied.mockResolvedValue('Terraform execution is not enabled for your organization.');
    expect((await call(ok)).status).toBe(403);
    mockDenied.mockResolvedValue(null);
    mockRate.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    expect((await call(ok)).status).toBe(429);
    expect(mockDelete).not.toHaveBeenCalled();
  });
  test('a bad bucket name or an Azure request is refused before anything is read', async () => {
    expect((await call({ ...ok, stateBackend: { ...ok.stateBackend, bucket: 'Bad_Bucket' }, confirmName: 'Bad_Bucket' })).status).toBe(400);
    expect((await call({ ...ok, stateBackend: { provider: 'azure' } })).status).toBe(400);
    expect(mockCreds).not.toHaveBeenCalled();
  });
  test('a refusal from the provisioner comes back with its reason (409 for state that still lists resources, 403 for a role that may not)', async () => {
    mockDelete.mockRejectedValueOnce(new FakeStateError('Not deleted: Terraform\'s record still lists what it created', 409));
    const r1 = await call(ok);
    expect(r1.status).toBe(409);
    expect((await r1.json()).error.message).toContain('still lists');
    mockDelete.mockRejectedValueOnce(new FakeStateError('AWS refused it', 403));
    expect((await call(ok)).status).toBe(403);
    expect(mockAudit.mock.calls.filter((c) => c[0].outcome === 'failed')).toHaveLength(2);
  });
});
