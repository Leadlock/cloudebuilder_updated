/**
 * Editing a connected account: change the name and/or how it is connected, without deleting it. Credentials are write-only (never
 * returned, a blank secret keeps the stored one), only owners and admins may do it, and the account is checked again afterwards.
 */
const mockIdentity = jest.fn();
const mockOrgRole = jest.fn();
jest.mock('@/lib/api/auth', () => ({ extractIdentity: (...a: unknown[]) => mockIdentity(...a), getOrgRole: (...a: unknown[]) => mockOrgRole(...a) }));
const mockResolveOrg = jest.fn();
jest.mock('@/lib/api/phase2d', () => ({ resolveOrgId: (...a: unknown[]) => mockResolveOrg(...a) }));
const mockFind = jest.fn();
const mockCreds = jest.fn();
const mockUpdate = jest.fn();
jest.mock('@/lib/repositories/cloudAccountRepository', () => ({
  cloudAccountRepository: { findById: (...a: unknown[]) => mockFind(...a), getCredentials: (...a: unknown[]) => mockCreds(...a), update: (...a: unknown[]) => mockUpdate(...a), delete: jest.fn() },
}));

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { PATCH } from '@/app/api/cloud-accounts/[id]/route';
import { mergeCredentialEdit } from '@/lib/cloud/credentialSchemas';
import { connectionHintOf, maskAccessKeyId } from '@/lib/cloud/connectionHint';
import EditAccountDialog from '@/components/accounts/EditAccountDialog';
import CloudAccountsPanel from '@/components/panels/CloudAccountsPanel';

const KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const NEW_SECRET = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
const ROLE = 'arn:aws:iam::123456789012:role/CloudCraftRole';
const keyRole = { accessKeyId: KEY_ID, secretAccessKey: SECRET, roleArn: ROLE, externalId: 'ext-123', region: 'us-east-1' };
const keyOnly = { accessKeyId: KEY_ID, secretAccessKey: SECRET, region: 'us-east-1' };
const azure = { tenantId: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), clientId: 'b'.repeat(8) + '-bbbb-bbbb-bbbb-' + 'b'.repeat(12), clientSecret: 'old-azure-secret', subscriptionId: 'c'.repeat(8) + '-cccc-cccc-cccc-' + 'c'.repeat(12) };

describe('mergeCredentialEdit', () => {
  it('changes only what was sent; a blank keeps the current value', () => {
    expect(mergeCredentialEdit(keyRole, { secretAccessKey: NEW_SECRET })).toEqual({ ...keyRole, secretAccessKey: NEW_SECRET });
    expect(mergeCredentialEdit(keyRole, { accessKeyId: '', secretAccessKey: '   ', roleArn: '' })).toEqual(keyRole);
    expect(mergeCredentialEdit(keyRole, { region: 'eu-west-1' })).toEqual({ ...keyRole, region: 'eu-west-1' });
  });
  it('a blank External ID removes it (the one field where blank means "remove")', () => {
    const merged = mergeCredentialEdit(keyRole, { externalId: '' });
    expect(merged).not.toHaveProperty('externalId');
    expect(merged).toMatchObject({ accessKeyId: KEY_ID, roleArn: ROLE });
  });
  it('does not change the object it was given, and trims typed values', () => {
    const before = JSON.stringify(keyRole);
    expect(mergeCredentialEdit(keyRole, { roleArn: `  ${ROLE}  ` }).roleArn).toBe(ROLE);
    expect(JSON.stringify(keyRole)).toBe(before);
  });
});

describe('connectionHintOf (what the Edit screen may show)', () => {
  it('shows the role, region and the start and end of the key — never the secret, the full key id or the External ID', () => {
    const hint = connectionHintOf(keyRole);
    expect(hint).toEqual({ region: 'us-east-1', roleArn: ROLE, accessKeyHint: 'AKIA…MPLE', hasExternalId: true });
    expect(JSON.stringify(hint)).not.toContain(SECRET);
    expect(JSON.stringify(hint)).not.toContain(KEY_ID);
    expect(JSON.stringify(hint)).not.toContain('ext-123');
    expect(maskAccessKeyId(KEY_ID)).toBe('AKIA…MPLE');
  });
  it('for a key alone there is no role; for Azure the ids are shown and the secret is only marked as set', () => {
    expect(connectionHintOf(keyOnly)).toEqual({ region: 'us-east-1', accessKeyHint: 'AKIA…MPLE' });
    const az = connectionHintOf(azure);
    expect(az).toEqual({ tenantId: azure.tenantId, clientId: azure.clientId, subscriptionId: azure.subscriptionId, clientSecretSet: true });
    expect(JSON.stringify(az)).not.toContain('old-azure-secret');
  });
});

describe('PATCH /api/cloud-accounts/[id]', () => {
  const call = (body: unknown, id = 'acct-1') => PATCH(new NextRequest(`http://localhost/api/cloud-accounts/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  const message = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;
  let provider = 'aws';
  let stored: Record<string, unknown> = keyRole;
  const savedUpdate = () => mockUpdate.mock.calls[0]![2] as { name?: string; credentialsJson?: string; identityJson?: string };

  beforeEach(() => {
    [mockIdentity, mockOrgRole, mockResolveOrg, mockFind, mockCreds, mockUpdate].forEach((m) => m.mockReset());
    provider = 'aws'; stored = keyRole;
    mockIdentity.mockReturnValue({ userId: 'u1', role: 'admin', orgIds: ['org-1'] });
    mockResolveOrg.mockResolvedValue('org-1'); mockOrgRole.mockResolvedValue('owner');
    mockFind.mockImplementation(async () => ({ id: 'acct-1', provider, name: 'Mine', status: 'invalid', identity: {} }));
    mockCreds.mockImplementation(async () => JSON.stringify(stored));
    mockUpdate.mockImplementation(async (_id: string, _org: string, input: { name?: string }) => ({ id: 'acct-1', provider, name: input.name ?? 'Mine', status: 'pending', identity: {} }));
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('replaces just the secret: the key, role, External ID and region stay, and the account is saved ready to be checked again', async () => {
    const res = await call({ credentials: { secretAccessKey: NEW_SECRET } });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith('acct-1', 'org-1', expect.any(Object));
    expect(JSON.parse(savedUpdate().credentialsJson!)).toEqual({ ...keyRole, secretAccessKey: NEW_SECRET });
    expect(JSON.parse(savedUpdate().identityJson!)).toEqual({ authMethod: 'key-and-role', connection: { region: 'us-east-1', roleArn: ROLE, hasExternalId: true, accessKeyHint: 'AKIA…MPLE' } });
  });

  it('a blank secret and blank key keep the current ones — an edit that changes nothing leaves the stored credentials and last check alone', async () => {
    await call({ name: 'Renamed', credentials: { accessKeyId: '', secretAccessKey: '' } });
    expect(savedUpdate()).toEqual({ name: 'Renamed', credentialsJson: undefined, identityJson: undefined });
  });

  it('a name change alone does not touch the credentials', async () => {
    expect((await call({ name: '  Production AWS  ' })).status).toBe(200);
    expect(savedUpdate()).toEqual({ name: 'Production AWS', credentialsJson: undefined, identityJson: undefined });
    expect(mockCreds).not.toHaveBeenCalled();
  });

  it('can change the key and the role together, drop the External ID, or move the region', async () => {
    const newKeyId = 'AKIAABCDEFGHIJKLMNOP';
    await call({ credentials: { accessKeyId: newKeyId, secretAccessKey: NEW_SECRET, roleArn: 'arn:aws:iam::123456789012:role/Other', externalId: '', region: 'eu-west-1' } });
    const next = JSON.parse(savedUpdate().credentialsJson!);
    expect(next).toEqual({ accessKeyId: newKeyId, secretAccessKey: NEW_SECRET, roleArn: 'arn:aws:iam::123456789012:role/Other', region: 'eu-west-1' });
    expect(next).not.toHaveProperty('externalId');
  });

  it('adding a role to an account connected with a key alone turns it into key + role (so Terraform becomes possible)', async () => {
    stored = keyOnly;
    await call({ credentials: { roleArn: ROLE } });
    expect(JSON.parse(savedUpdate().credentialsJson!)).toEqual({ ...keyOnly, roleArn: ROLE });
    expect(JSON.parse(savedUpdate().identityJson!)).toMatchObject({ authMethod: 'key-and-role' });
  });

  it('edits an Azure account the same way: only the secret replaced', async () => {
    provider = 'azure'; stored = azure;
    await call({ credentials: { clientSecret: 'new-azure-secret' } });
    expect(JSON.parse(savedUpdate().credentialsJson!)).toEqual({ ...azure, clientSecret: 'new-azure-secret' });
    expect(JSON.parse(savedUpdate().identityJson!)).toMatchObject({ authMethod: 'service-principal', connection: { clientSecretSet: true } });
  });

  it.each([
    ['a user ARN where a role ARN is needed', { credentials: { roleArn: 'arn:aws:iam::123456789012:user/bob' } }, /ARN of an IAM user, not of a role/],
    ['a malformed key id', { credentials: { accessKeyId: 'AKIA1' } }, /accessKeyId: accessKeyId must be a long-term IAM access key ID/],
    ['a secret of the wrong length', { credentials: { secretAccessKey: 'short' } }, /secretAccessKey: secretAccessKey must be the 40-character secret access key/],
    ['a region that is not one', { credentials: { region: 'nowhere' } }, /region: region must be a valid AWS region/],
    ['a field nobody can set (a session token)', { credentials: { sessionToken: 'x' } }, /Unrecognized key/],
    ['nothing to change', {}, /Send a name or credentials to change/],
    ['an unknown top-level field', { name: 'x', orgId: 'org-2' }, /Unrecognized key/],
    ['a blank name', { name: '   ' }, /./],
  ])('refuses %s, saying why, and saves nothing', async (_n, body, expected) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(await message(res)).toMatch(expected);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses credentials that do not belong to the account\'s cloud (Azure fields sent to an AWS account)', async () => {
    const res = await call({ credentials: { tenantId: azure.tenantId } });
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses bad JSON', async () => {
    const res = await call('{not json');
    expect(res.status).toBe(400);
    expect(await message(res)).toBe('Invalid JSON body');
  });

  it('only an owner or admin of the organisation may edit; everyone else is refused before anything is read or saved', async () => {
    for (const role of ['member', 'viewer', null]) {
      mockOrgRole.mockResolvedValue(role);
      expect((await call({ name: 'x' })).status).toBe(403);
    }
    mockOrgRole.mockResolvedValue('admin');
    expect((await call({ name: 'x' })).status).toBe(200);
    mockIdentity.mockReturnValue(null);
    expect((await call({ name: 'x' })).status).toBe(401);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('cannot edit another organisation\'s account: it is "not found"', async () => {
    mockFind.mockResolvedValue(null);
    expect((await call({ name: 'x' }, 'acct-of-another-org')).status).toBe(404);
    expect(mockFind).toHaveBeenCalledWith('acct-of-another-org', 'org-1');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('never returns or logs a credential — only ids', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const res = await call({ credentials: { secretAccessKey: NEW_SECRET } });
    const text = JSON.stringify(await res.json());
    for (const secret of [NEW_SECRET, SECRET, KEY_ID, 'ext-123']) expect(text).not.toContain(secret);
    const logged = info.mock.calls.map((c) => String(c[0])).join(' ');
    expect(logged).toMatch(/edited acct-1 in org org-1 by user u1 \(credentials changed\)/);
    for (const secret of [NEW_SECRET, SECRET, KEY_ID]) expect(logged).not.toContain(secret);
  });

  it('a database failure is a generic error', async () => {
    mockUpdate.mockRejectedValue(new Error('connection to db.internal:5432 refused'));
    const res = await call({ name: 'x' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/db\.internal|5432/);
  });
});

describe('Edit dialog', () => {
  const dialog = (account: object) => renderToStaticMarkup(createElement(EditAccountDialog, { account: account as never, onClose: () => undefined, onSaved: async () => undefined }));
  const awsAccount = { id: 'a1', name: 'Production AWS', provider: 'aws', identity: { authMethod: 'key-and-role', connection: { region: 'eu-west-1', roleArn: ROLE, accessKeyHint: 'AKIA…MPLE', hasExternalId: true } } };

  it('is a modal that names the account and explains that secrets are never shown', () => {
    const html = dialog(awsAccount);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Edit “Production AWS”');
    expect(html).toContain('Secrets are never shown');
    expect(html).toContain('Save and check again');
  });

  it('prefills what is not secret (name, role, region), recognises the key without showing it, and leaves secret fields empty', () => {
    const html = dialog(awsAccount);
    expect(html).toContain('value="Production AWS"');
    expect(html).toContain(`value="${ROLE}"`);
    expect(html).toContain('Current key: AKIA…MPLE. Leave empty to keep it.');
    expect(html).toMatch(/type="password"[^>]*value=""|value=""[^>]*type="password"/);
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain(KEY_ID);
    expect(html).toContain('<option value="eu-west-1" selected');
  });

  it('offers to remove an External ID only when one is set', () => {
    expect(dialog(awsAccount)).toContain('Remove the External ID');
    expect(dialog({ ...awsAccount, identity: { connection: { roleArn: ROLE } } })).not.toContain('Remove the External ID');
  });

  it('for an account with no role it invites adding one', () => {
    expect(dialog({ id: 'a2', name: 'Key only', provider: 'aws', identity: { authMethod: 'access-key', connection: { accessKeyHint: 'AKIA…MPLE', region: 'us-east-1' } } })).toContain('No role yet: add one');
  });

  it('an account saved before connection details were kept does not wrongly claim "no role": it says the details appear after one Re-check', () => {
    const html = dialog({ id: 'a3', name: 'Older', provider: 'aws', identity: { authMethod: 'key-and-role' } });
    expect(html).not.toContain('No role yet');
    expect(html).toContain('click Re-check once and it appears here');
  });

  it('for Azure shows tenant, client and subscription, and a secret field that stays empty', () => {
    const html = dialog({ id: 'z1', name: 'Azure prod', provider: 'azure', identity: { connection: { tenantId: azure.tenantId, clientId: azure.clientId, subscriptionId: azure.subscriptionId, clientSecretSet: true } } });
    expect(html).toContain(`value="${azure.tenantId}"`);
    expect(html).toContain(`value="${azure.subscriptionId}"`);
    expect(html).toContain('Client secret');
    expect(html).not.toContain('old-azure-secret');
  });
});

describe('Cloud Accounts tab', () => {
  it('has the code to open the Edit dialog from each account row', async () => {
    const fs = await import('node:fs');
    const panel = fs.readFileSync('components/panels/CloudAccountsPanel.tsx', 'utf8');
    expect(panel).toMatch(/aria-label=\{`Edit account \$\{account\.name\}`\}/);
    expect(panel).toMatch(/EditAccountDialog/);
    expect(renderToStaticMarkup(createElement(CloudAccountsPanel))).toContain('Cloud Accounts');
  });
});
