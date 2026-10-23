/**
 * When may CloudBuilder use its own local accounts / unverified token reading instead of AWS Cognito?
 *
 * Cognito is where email ownership is verified. Falling back to a local account whenever Cognito returned an error
 * meant anyone could register an email address they do not own (and be logged in at once). So:
 *
 *  - Local SIGN-UP is off. It exists only for development when explicitly requested: NODE_ENV=development AND
 *    CLOUDBUILDER_ALLOW_LOCAL_SIGNUP=1.
 *  - Local LOGIN is only tried when Cognito says it does not know this user or the password is wrong, i.e. for accounts
 *    created before Cognito. A Cognito outage or throttling error never triggers it.
 *  - Reading an ID token without verifying its signature (used when the key server is unreachable) is a development shortcut: it needs
 *    CLOUDBUILDER_DEV_SHORTCUTS=1 as well as NODE_ENV=development (see lib/dev/shortcuts.ts).
 */
import { devShortcutsEnabled } from '@/lib/dev/shortcuts';

export function localSignupAllowed(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.CLOUDBUILDER_ALLOW_LOCAL_SIGNUP === '1';
}

/** Cognito errors that mean "this is not a Cognito user / wrong password" — the only cases where a legacy local login is tried. */
const NOT_A_COGNITO_LOGIN = new Set(['UserNotFoundException', 'NotAuthorizedException']);
export function localLoginFallbackAllowed(cognitoErrorName: string | undefined): boolean {
  return cognitoErrorName !== undefined && NOT_A_COGNITO_LOGIN.has(cognitoErrorName);
}

export function unverifiedTokenFallbackAllowed(): boolean {
  return devShortcutsEnabled();
}

/**
 * When may CloudBuilder bypass the MFA challenge step on localhost?
 *
 * Never in production (NODE_ENV === 'production').
 * In tests (NODE_ENV === 'test'), only if explicitly configured via CLOUDBUILDER_DISABLE_MFA_LOCAL=1.
 * In development, enabled by default for localhost requests (or when CLOUDBUILDER_DISABLE_MFA_LOCAL=1 is set),
 * unless explicitly set to 0 or false.
 */
export function localMfaBypassAllowed(req?: { headers?: { get: (name: string) => string | null }; nextUrl?: { hostname?: string } }): boolean {
  if (process.env.NODE_ENV === 'production') return false;

  // In test environment, keep normal MFA behavior unless explicitly opted in
  if (process.env.NODE_ENV === 'test') {
    return (process.env.CLOUDBUILDER_DISABLE_MFA_LOCAL === '1' || process.env.CLOUDCRAFT_DISABLE_MFA_LOCAL === '1');
  }

  const explicit = process.env.CLOUDBUILDER_DISABLE_MFA_LOCAL ?? process.env.CLOUDCRAFT_DISABLE_MFA_LOCAL;
  if (explicit === '0' || explicit === 'false') return false;
  if (explicit === '1' || explicit === 'true') return true;

  if (req) {
    const host = req.headers?.get('host') || req.nextUrl?.hostname || '';
    const hostname = host.split(':')[0].toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
      return true;
    }
  }

  return process.env.NODE_ENV === 'development';
}
