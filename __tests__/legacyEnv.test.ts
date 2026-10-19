import { applyLegacyEnv } from '@/lib/config/legacyEnv';

describe('settings that still have the old CLOUDCRAFT_ name', () => {
  test('are copied to the new name, and the old names that were used are reported', () => {
    const env: Record<string, string | undefined> = { CLOUDCRAFT_PROJECT_RELEASES: '1', CLOUDCRAFT_TERRAFORM_ORG_IDS: 'a,b', OTHER: 'x' };
    expect(applyLegacyEnv(env).sort()).toEqual(['CLOUDCRAFT_PROJECT_RELEASES', 'CLOUDCRAFT_TERRAFORM_ORG_IDS']);
    expect(env['CLOUDBUILDER_PROJECT_RELEASES']).toBe('1');
    expect(env['CLOUDBUILDER_TERRAFORM_ORG_IDS']).toBe('a,b');
    expect(env['OTHER']).toBe('x');
  });
  test('never override a new name that is already set, even to an empty value', () => {
    const env: Record<string, string | undefined> = { CLOUDCRAFT_TERRAFORM_DISABLED: '1', CLOUDBUILDER_TERRAFORM_DISABLED: '0', CLOUDCRAFT_X: '1', CLOUDBUILDER_X: '' };
    expect(applyLegacyEnv(env)).toEqual([]);
    expect(env['CLOUDBUILDER_TERRAFORM_DISABLED']).toBe('0');
    expect(env['CLOUDBUILDER_X']).toBe('');
  });
  test('does nothing when there are no old names', () => {
    const env: Record<string, string | undefined> = { CLOUDBUILDER_A: '1' };
    expect(applyLegacyEnv(env)).toEqual([]);
    expect(env).toEqual({ CLOUDBUILDER_A: '1' });
  });
});
