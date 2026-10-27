/** The auditor token: `ca_` and 43 random characters (256 bits). Only its SHA-256 is stored, so a lookup by hash needs no comparison that could leak timing. */
import { createHash } from 'crypto';

export const AUDITOR_TOKEN_PREFIX = 'ca_';
export const hashAuditorToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export const looksLikeAuditorToken = (s: string): boolean => /^ca_[A-Za-z0-9_-]{43}$/.test(s);
export const auditorAccessUsable = (a: { revokedAt: string | null; expiresAt: string }, now = Date.now()): boolean => !a.revokedAt && Date.parse(a.expiresAt) > now;
