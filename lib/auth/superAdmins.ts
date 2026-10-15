/**
 * The super administrator: the person with the final say. Set SUPER_ADMIN_EMAILS to a comma separated list (ajinkya@neozaar.com).
 *
 *  - Only a super administrator can approve, reject or send back an architecture review; no other admin can, so nothing reaches a Terraform plan or
 *    apply without their approval. A review is assigned to them when it is submitted.
 *  - They are an owner of every organization they belong to. This is limited to organizations they are a member of: it never gives access to
 *    another organization's data.
 *
 * Empty or missing means there is no super administrator and reviews work as before (any organization admin decides). A list with no valid
 * address means nobody can approve, and a production server refuses to start with it (lib/startup/productionChecks.ts).
 * Pure functions: the interface and the API use the same rule.
 */
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The listed addresses, lower case. Entries that are not an email address are ignored. */
export function superAdminEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env['SUPER_ADMIN_EMAILS'] ?? '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => ADDRESS.test(e));
}

/** Whether a super administrator is set up at all. */
export const superAdminsConfigured = (env: NodeJS.ProcessEnv = process.env): boolean => (env['SUPER_ADMIN_EMAILS'] ?? '').trim() !== '';

export function isSuperAdmin(email: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof email !== 'string') return false;
  return superAdminEmails(env).includes(email.trim().toLowerCase());
}

/** Whether this person may approve, reject or send back an architecture review. */
export function mayDecideReviews(email: unknown, role: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return superAdminsConfigured(env) ? isSuperAdmin(email, env) : role === 'admin';
}

/** The sentence shown to someone who may not. */
export function reviewDecisionMessage(env: NodeJS.ProcessEnv = process.env): string {
  const who = superAdminEmails(env);
  return who.length > 0 ? `Only ${who.join(' or ')} can approve, reject or send back an architecture review.` : 'Only Administrators can approve architecture reviews.';
}
