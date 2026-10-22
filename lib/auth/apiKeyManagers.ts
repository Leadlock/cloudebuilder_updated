/**
 * Who may make, see and revoke API keys for the templates, and who may read and write a template's marketplace listing (the real price and text for the
 * Neozaar export). Set CLOUDBUILDER_API_KEY_MANAGERS to a comma separated list of email addresses
 * (ajinkya@neozaar.com). When it is not set, the list of RESTRICTED_FEATURES_ALLOWED_EMAILS is used (the people who may already use Deploy), so a server
 * that has that lock needs no new setting. Unlike that lock, an empty list means NOBODY: managing keys is never open to everyone, and being a super
 * administrator does not add anyone. The interface and the API use this one rule.
 */

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const parse = (v: string | undefined): string[] => (v ?? '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => ADDRESS.test(e));

/** The listed addresses, lower case. A setting that is present replaces the fallback, even when it lists nobody. */
export function apiKeyManagerEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  const own = env['CLOUDBUILDER_API_KEY_MANAGERS'];
  return own !== undefined && own.trim() !== '' ? parse(own) : parse(env['RESTRICTED_FEATURES_ALLOWED_EMAILS']);
}

export function canManageApiKeys(email: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof email === 'string' && apiKeyManagerEmails(env).includes(email.trim().toLowerCase());
}

export const API_KEY_MANAGER_MESSAGE = 'Managing API keys is not accessible for your account.';
export const LISTING_MANAGER_MESSAGE = 'Marketplace listings are not accessible for your account.';
