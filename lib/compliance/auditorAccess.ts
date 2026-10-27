/** Rules for the read-only auditor links. */
export const MAX_AUDITOR_DAYS = 90;

/** The token goes after a # so it is never sent to a server in the URL, never lands in access logs, and is not passed on in a Referer header. The page reads it and sends it as a header. */
export const auditorLink = (origin: string, token: string): string => `${origin}/auditor#${token}`;
