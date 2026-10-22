import { apiKeyManagerEmails, canManageApiKeys } from '@/lib/auth/apiKeyManagers';

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe('who may manage API keys', () => {
  test('only the listed address, in any letter case, and nobody else', () => {
    const e = env({ CLOUDBUILDER_API_KEY_MANAGERS: 'ajinkya@neozaar.com' });
    expect(canManageApiKeys('ajinkya@neozaar.com', e)).toBe(true);
    expect(canManageApiKeys('  Ajinkya@Neozaar.com ', e)).toBe(true);
    expect(canManageApiKeys('vaibhav@neozaar.com', e)).toBe(false);
    expect(canManageApiKeys('ajinkya@neozaar.com.evil.io', e)).toBe(false);
    expect(canManageApiKeys('ajinkya@neozaar.co', e)).toBe(false);
    for (const x of [undefined, null, 5, {}, '']) expect(canManageApiKeys(x, e)).toBe(false);
  });
  test('more than one address can be listed, and entries that are not addresses are ignored', () => {
    const e = env({ CLOUDBUILDER_API_KEY_MANAGERS: 'a@x.com, b@x.com,not-an-address,,c@' });
    expect(apiKeyManagerEmails(e)).toEqual(['a@x.com', 'b@x.com']);
  });
  test('without its own setting the list of the people who may use Deploy applies', () => {
    const e = env({ RESTRICTED_FEATURES_ALLOWED_EMAILS: 'ajinkya@neozaar.com' });
    expect(canManageApiKeys('ajinkya@neozaar.com', e)).toBe(true);
    expect(canManageApiKeys('someone@neozaar.com', e)).toBe(false);
  });
  test('its own setting replaces that list instead of adding to it', () => {
    const e = env({ CLOUDBUILDER_API_KEY_MANAGERS: 'only@x.com', RESTRICTED_FEATURES_ALLOWED_EMAILS: 'ajinkya@neozaar.com' });
    expect(canManageApiKeys('ajinkya@neozaar.com', e)).toBe(false);
    expect(canManageApiKeys('only@x.com', e)).toBe(true);
  });
  test('nothing set at all, or a list with no valid address, means nobody (never everybody)', () => {
    expect(canManageApiKeys('ajinkya@neozaar.com', env({}))).toBe(false);
    expect(canManageApiKeys('ajinkya@neozaar.com', env({ CLOUDBUILDER_API_KEY_MANAGERS: 'garbage' }))).toBe(false);
    expect(canManageApiKeys('ajinkya@neozaar.com', env({ CLOUDBUILDER_API_KEY_MANAGERS: '   ', RESTRICTED_FEATURES_ALLOWED_EMAILS: '' }))).toBe(false);
  });
  test('a super administrator is not a key manager unless listed', () => {
    const e = env({ CLOUDBUILDER_API_KEY_MANAGERS: 'a@x.com', SUPER_ADMIN_EMAILS: 'root@x.com' });
    expect(canManageApiKeys('root@x.com', e)).toBe(false);
  });
});
