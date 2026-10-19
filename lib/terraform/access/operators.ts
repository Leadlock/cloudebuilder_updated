/**
 * Platform operators: the people who decide which organizations may run Terraform on this server. No role inside an organization, however
 * high, makes anyone an operator (signup makes every new person the owner of their own organization).
 *
 * Nothing has to be configured:
 *  - By default the operator is the person who first signed up on this server (the one who set it up). The earliest account counts, apart
 *    from the built-in development account (an address ending in @cloudbuilder.local). That is the same rule many self-hosted tools use for
 *    their first admin, and it cannot be claimed later: only the earliest account ever qualifies.
 *  - To name operators explicitly instead (several people, or someone other than the first signup), list their emails in
 *    CLOUDBUILDER_OPERATOR_EMAILS. When that list is set, only those people are operators and the first-signup rule is not used.
 */
const csv = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export const operatorEmails = (): Set<string> => new Set(csv(process.env['CLOUDBUILDER_OPERATOR_EMAILS']));

/** The built-in development accounts are never the operator. */
const SEEDED = /@cloudbuilder\.local$/i;

let firstSignup: string | undefined;
export function _resetOperatorCacheForTests(): void { firstSignup = undefined; }

/** The earliest real account on this server. Remembered once found: it can never change to someone else. */
async function firstSignupEmail(): Promise<string | null> {
  if (firstSignup) return firstSignup;
  try {
    const { db } = await import('@/src/prisma/db'); // on demand: importing this file never opens the database
    const users = (await db.orm.public.User.select('email', 'createdAt').all()) as Array<{ email: string; createdAt: string }>;
    const real = users.filter((u) => !SEEDED.test(u.email)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (real[0]) firstSignup = real[0].email.toLowerCase();
    return firstSignup ?? null;
  } catch { return null; }
}

export async function isOperatorEmail(email: string | undefined | null): Promise<boolean> {
  if (!email) return false;
  const who = email.trim().toLowerCase();
  const listed = operatorEmails();
  if (listed.size > 0) return listed.has(who);
  return (await firstSignupEmail()) === who;
}
