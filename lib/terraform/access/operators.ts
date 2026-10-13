/**
 * Platform operators: the people who decide which organizations may run Terraform on this server. They are named in the server's environment
 * (CLOUDCRAFT_OPERATOR_EMAILS, comma-separated). No role inside an organization, however high, makes anyone an operator.
 */
const csv = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export const operatorEmails = (): Set<string> => new Set(csv(process.env['CLOUDCRAFT_OPERATOR_EMAILS']));
export const isOperatorEmail = (email: string | undefined | null): boolean => !!email && operatorEmails().has(email.trim().toLowerCase());
