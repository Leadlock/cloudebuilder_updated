/**
 * The Deploy tab (running Terraform plan, apply and destroy), the AI Generator and Cloud Accounts can be closed to everyone except a short list of people.
 * Set RESTRICTED_FEATURES_ALLOWED_EMAILS to a comma separated list of email addresses (ajinkya@neozaar.com). Empty or missing means open to
 * everyone who can sign in, as before. A list with no valid address closes the features for everyone.
 *
 * Nothing in this file touches the server or the browser, so the interface and the API use the same rule.
 */

/** The screens that are closed. */
export const RESTRICTED_VIEWS: ReadonlySet<string> = new Set(['deploy', 'ai-generator', 'accounts']);

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The listed addresses, lower case. Entries that are not an email address are ignored. */
export function restrictedFeatureEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env['RESTRICTED_FEATURES_ALLOWED_EMAILS'] ?? '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => ADDRESS.test(e));
}

/** Whether the closing is switched on at all. */
export const restrictedFeaturesClosed = (env: NodeJS.ProcessEnv = process.env): boolean => (env['RESTRICTED_FEATURES_ALLOWED_EMAILS'] ?? '').trim() !== '';

/** Whether this person may use the Deploy tab and the AI Generator. */
export function canUseRestrictedFeatures(email: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!restrictedFeaturesClosed(env)) return true;
  if (typeof email !== 'string') return false;
  return restrictedFeatureEmails(env).includes(email.trim().toLowerCase());
}

/** The short word shown on a closed tab. */
export const RESTRICTED_FEATURE_LABEL = 'Not accessible';
export const RESTRICTED_FEATURE_MESSAGE = 'This feature is not accessible for your account.';
