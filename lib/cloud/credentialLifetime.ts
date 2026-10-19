/**
 * How long CloudBuilder may keep and use a cloud credential.
 *
 * A stored key is a standing risk: if it leaks, it works until someone notices and deletes it. So a key can be given a lifetime
 * ("keep it for 8 hours"), or be temporary by nature (AWS temporary credentials expire on their own), or be forgotten as soon as a
 * deployment has succeeded. When the time is up CloudBuilder refuses to use the credential and erases the secret from its database,
 * leaving the account listed as expired so the person can see what happened and reconnect.
 *
 * The deadline lives inside the encrypted credentials (that is what is enforced) and is mirrored, as plain non-secret facts, in the
 * account's identity so lists can show it without decrypting anything. Pure (no Node imports): the connect form uses it too.
 */

export const LIFETIME_CHOICES = [
  { id: '1h', label: '1 hour', hours: 1 },
  { id: '8h', label: '8 hours', hours: 8 },
  { id: '24h', label: '24 hours', hours: 24 },
  { id: '7d', label: '7 days', hours: 24 * 7 },
  { id: 'forever', label: 'Until I remove it', hours: null },
] as const;

export type LifetimeChoiceId = (typeof LIFETIME_CHOICES)[number]['id'];

/** AWS temporary credentials (a GetSessionToken or SSO session) last from 15 minutes to 36 hours. */
export const TEMPORARY_HOURS = [1, 3, 6, 12] as const;

export const MAX_LIFETIME_HOURS = 24 * 30;

/** What the person asked for; the server turns it into a deadline using ITS clock. */
export interface LifetimeRequest {
  /** Hours from now. Omitted or null: no limit. */
  hours?: number | null;
  /** Erase the credentials after a deployment or teardown succeeds. */
  forgetAfterDeploy?: boolean;
}

export interface Lifetime { expiresAt?: string; forgetAfterDeploy?: boolean; temporary?: boolean }

export function lifetimeFromRequest(req: LifetimeRequest | undefined, temporary: boolean, now = Date.now()): Lifetime {
  const out: Lifetime = {};
  const hours = req?.hours;
  if (typeof hours === 'number' && Number.isFinite(hours) && hours > 0) {
    out.expiresAt = new Date(now + Math.min(hours, MAX_LIFETIME_HOURS) * 3_600_000).toISOString();
  }
  if (req?.forgetAfterDeploy === true) out.forgetAfterDeploy = true;
  if (temporary) out.temporary = true;
  return out;
}

/** Deploying needs the credentials to outlive the work: refuse to start with less than this left. */
export const MIN_REMAINING_FOR_DEPLOY_MS = 45 * 60_000;

export function remainingMs(expiresAt: string | undefined | null, now = Date.now()): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) ? t - now : null;
}

/** "expires in 7 h 12 min", "expires in 40 min", "expired", or "no time limit". */
export function describeLifetime(expiresAt: string | undefined | null, now = Date.now()): string {
  const left = remainingMs(expiresAt, now);
  if (left === null) return 'no time limit';
  if (left <= 0) return 'expired';
  const min = Math.ceil(left / 60_000);
  if (min < 60) return `expires in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `expires in ${h} h ${min % 60} min`;
  return `expires in ${Math.round(h / 24)} days`;
}

/** The non-secret copy of a credential's lifetime that goes in the account's identity, so lists can show it without decrypting. */
export function lifetimeMirror(credentials: object): { lifetime?: Lifetime } {
  const c = credentials as { expiresAt?: string; forgetAfterDeploy?: true; sessionToken?: string };
  const l: Lifetime = {};
  if (c.expiresAt) l.expiresAt = c.expiresAt;
  if (c.forgetAfterDeploy) l.forgetAfterDeploy = true;
  if (c.sessionToken) l.temporary = true;
  return Object.keys(l).length > 0 ? { lifetime: l } : {};
}

/** What a person can change about how long a stored credential is kept. */
export type LifetimeChange =
  | { action: 'extend'; hours: number | null }      // hours from now; null: no time limit
  | { action: 'forgetAfterDeploy'; value: boolean };

/**
 * The credentials after a lifetime change, or the reason it cannot be made. Temporary credentials (with a session token) stop
 * working at AWS on their own deadline, so their time cannot be extended here: get new ones instead.
 */
export function applyLifetimeChange(credentials: Record<string, unknown>, change: LifetimeChange, now = Date.now()): { ok: true; credentials: Record<string, unknown> } | { ok: false; message: string } {
  const next: Record<string, unknown> = { ...credentials };
  if (change.action === 'forgetAfterDeploy') {
    if (change.value) next['forgetAfterDeploy'] = true; else delete next['forgetAfterDeploy'];
    return { ok: true, credentials: next };
  }
  if (typeof credentials['sessionToken'] === 'string') {
    return { ok: false, message: 'These are temporary AWS credentials: AWS stops accepting them at its own deadline, so CloudBuilder cannot extend them. Connect again with new temporary credentials.' };
  }
  const hours = change.hours;
  if (hours === null) { delete next['expiresAt']; return { ok: true, credentials: next }; }
  if (!Number.isFinite(hours) || hours <= 0) return { ok: false, message: 'Choose how many hours to keep the key.' };
  next['expiresAt'] = new Date(now + Math.min(hours, MAX_LIFETIME_HOURS) * 3_600_000).toISOString();
  return { ok: true, credentials: next };
}

export type WipeReason = 'expired' | 'forgotten' | 'removed';

/** Thrown when a credential's time is up (or it was erased): HTTP 400 so callers show a plain message. */
export class CredentialsExpiredError extends Error {
  readonly statusCode = 400;
  readonly code = 'CREDENTIALS_EXPIRED';
  constructor(readonly reason: WipeReason, at?: string) {
    super(
      reason === 'forgotten'
        ? 'CloudBuilder deleted these credentials after your last successful deployment, as you asked. Connect the account again to deploy.'
        : reason === 'removed'
        ? 'These credentials were deleted from CloudBuilder on request. Connect the account again with a key to use it.'
        : `These credentials expired${at ? ` on ${at.replace('T', ' ').slice(0, 16)} UTC` : ''}, so CloudBuilder deleted them. Connect the account again with a new key.`,
    );
    this.name = 'CredentialsExpiredError';
  }
}

/** Throws (HTTP 400) when a deployment could outlive the credentials, so it never stops halfway through. */
export function assertEnoughTimeLeft(expiresAt: string | undefined | null, now = Date.now()): void {
  const left = remainingMs(expiresAt, now);
  if (left === null) return;
  if (left < MIN_REMAINING_FOR_DEPLOY_MS) {
    const min = Math.max(0, Math.floor(left / 60_000));
    throw Object.assign(
      new Error(`These credentials expire in ${min} minute${min === 1 ? '' : 's'}, which is not long enough to finish a deployment safely (a run stopped halfway can leave resources half-built). Connect the account again with credentials that last longer.`),
      { statusCode: 400 },
    );
  }
}
