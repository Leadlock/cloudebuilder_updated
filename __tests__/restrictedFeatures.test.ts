/**
 * RESTRICTED_FEATURES_ALLOWED_EMAILS: the Deploy tab and the AI Generator are closed to everyone except the listed people.
 */
import { canUseRestrictedFeatures, restrictedFeatureEmails } from '@/lib/auth/restrictedFeatures';

const env = (v?: string): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', ...(v === undefined ? {} : { RESTRICTED_FEATURES_ALLOWED_EMAILS: v }) });

describe('canUseRestrictedFeatures', () => {
  test('not set: open to everyone, as before', () => {
    expect(canUseRestrictedFeatures('anyone@neozaar.com', env())).toBe(true);
    expect(canUseRestrictedFeatures('anyone@neozaar.com', env('  '))).toBe(true);
    expect(canUseRestrictedFeatures(undefined, env())).toBe(true);
  });

  test('set: only the listed address, in any letter case and with spaces', () => {
    const e = env('ajinkya@neozaar.com');
    expect(canUseRestrictedFeatures('ajinkya@neozaar.com', e)).toBe(true);
    expect(canUseRestrictedFeatures('  Ajinkya@NeoZaar.com ', e)).toBe(true);
    expect(canUseRestrictedFeatures('someone@neozaar.com', e)).toBe(false);
  });

  test.each([
    'ajinkya@neozaar.com.evil.com',
    'ajinkya@neozaar.com@evil.com',
    'xajinkya@neozaar.com',
    'ajinkya+x@neozaar.com',
    '',
  ])('look-alike addresses are refused: %j', (a) => {
    expect(canUseRestrictedFeatures(a, env('ajinkya@neozaar.com'))).toBe(false);
  });

  test('a missing or non-text email is refused once it is closed', () => {
    const e = env('ajinkya@neozaar.com');
    expect(canUseRestrictedFeatures(undefined, e)).toBe(false);
    expect(canUseRestrictedFeatures(null, e)).toBe(false);
    expect(canUseRestrictedFeatures(['ajinkya@neozaar.com'], e)).toBe(false);
  });

  test('several people can be listed', () => {
    const e = env('ajinkya@neozaar.com, ops@neozaar.com');
    expect(restrictedFeatureEmails(e)).toEqual(['ajinkya@neozaar.com', 'ops@neozaar.com']);
    expect(canUseRestrictedFeatures('ops@neozaar.com', e)).toBe(true);
  });

  test('a list with nothing valid closes the features for everyone instead of opening them', () => {
    expect(canUseRestrictedFeatures('ajinkya@neozaar.com', env('ajinkya'))).toBe(false);
    expect(canUseRestrictedFeatures('ajinkya@neozaar.com', env('*'))).toBe(false);
  });
});
