// CloudCraft: Cognito "Pre sign-up" trigger. Refuses to register anyone whose email address is not on an allowed domain, so the sign-in service
// itself (not only CloudCraft) will not create the account or send a verification code to anyone else.
//
// Setup: see README.md. Set the Lambda environment variable ALLOWED_EMAIL_DOMAINS to the same value as in CloudCraft's .env (for example neozaar.com;
// several domains are separated by commas). Runtime: Node.js 20 or newer. No packages are needed.
//
// The rule is the one CloudCraft uses (lib/auth/emailDomains.ts): the address must have exactly one "@" and what follows it must equal a listed
// domain. Look-alikes such as x@neozaar.com.evil.com, x@evil.com@neozaar.com, x@sub.neozaar.com and domains written with look-alike letters are refused.
// If the variable is missing or has no valid domain, EVERY sign-up is refused (a mistake must not open registration to everyone).

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const allowedDomains = () =>
  (process.env.ALLOWED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => DOMAIN.test(d));

function emailAllowed(email, domains) {
  if (typeof email !== 'string') return false;
  const value = email.trim().toLowerCase();
  const parts = value.split('@');
  // eslint-disable-next-line no-control-regex
  if (parts.length !== 2 || parts[0] === '' || /[\s\u0000-\u001f]/.test(value)) return false;
  return domains.includes(parts[1]);
}

export const handler = async (event) => {
  const domains = allowedDomains();
  if (domains.length === 0) {
    console.error('ALLOWED_EMAIL_DOMAINS is not set or has no valid domain: refusing every sign-up.');
    throw new Error('Sign-up is not available right now.');
  }

  const attributes = event?.request?.userAttributes ?? {};
  // The email attribute; when the user name is the address itself, that.
  const email = attributes.email ?? (typeof event?.userName === 'string' && event.userName.includes('@') ? event.userName : undefined);

  if (!emailAllowed(email, domains)) {
    // The address is not written to the log: it is someone's personal data.
    console.warn(`Refused a sign-up (${event?.triggerSource ?? 'unknown source'}): the address is not on an allowed domain.`);
    throw new Error(`Access is limited to ${domains.map((d) => `@${d}`).join(' and ')} email addresses.`);
  }

  // Allowed: the sign-up goes on exactly as before (nothing is auto-confirmed or auto-verified here).
  return event;
};
