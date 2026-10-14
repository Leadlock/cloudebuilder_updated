/**
 * The second step of a sign-in (a code from an app, a text message or an email, or first-time authenticator setup) has a name inside the
 * sign-in service. The browser is given neutral names instead, so nothing sent to it names the service behind the sign-in.
 */
export type VerificationMethod = 'app' | 'sms' | 'email' | 'setup';

const TO_PUBLIC: Record<string, VerificationMethod> = {
  SOFTWARE_TOKEN_MFA: 'app',
  SMS_MFA: 'sms',
  EMAIL_OTP: 'email',
  MFA_SETUP: 'setup',
};
const FROM_PUBLIC: Record<VerificationMethod, string> = { app: 'SOFTWARE_TOKEN_MFA', sms: 'SMS_MFA', email: 'EMAIL_OTP', setup: 'MFA_SETUP' };

export const VERIFICATION_METHODS = Object.keys(FROM_PUBLIC) as VerificationMethod[];

/** The neutral name for a service challenge. Unknown challenges are treated as an authenticator-app code. */
export const toPublicMethod = (serviceName: string): VerificationMethod => TO_PUBLIC[serviceName] ?? 'app';
/** The service's name for a neutral one. */
export const fromPublicMethod = (m: VerificationMethod): string => FROM_PUBLIC[m];
