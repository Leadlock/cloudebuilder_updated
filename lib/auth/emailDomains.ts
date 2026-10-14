/**
 * Limits who can use this CloudCraft to people with an email address on certain domains, for example while it is being tested inside a
 * company. Set ALLOWED_EMAIL_DOMAINS to a comma separated list (neozaar.com). Empty or missing means anyone can, as before.
 *
 * The check is deliberately strict: the part after the single "@" must equal a listed domain exactly. Look-alikes such as
 * "x@neozaar.com.evil.com", "x@evil.com@neozaar.com", sub-domains that were not listed, and non-ASCII look-alike domains are all refused.
 */
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api/response';

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** The listed domains, lower case. Empty when there is no restriction. Entries that are not a plain domain are ignored. */
export function allowedEmailDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env['ALLOWED_EMAIL_DOMAINS'] ?? '').split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter((d) => DOMAIN.test(d));
}

/** Whether this address may use the app. Always true when no restriction is set. */
export function emailAllowed(email: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const domains = allowedEmailDomains(env);
  // A restriction that was set but contains nothing usable (a typo) must not silently open the app to everyone.
  const configured = (env['ALLOWED_EMAIL_DOMAINS'] ?? '').trim() !== '';
  if (domains.length === 0) return !configured;
  if (typeof email !== 'string') return false;
  const value = email.trim().toLowerCase();
  const parts = value.split('@');
  if (parts.length !== 2 || parts[0] === '' || /[\s\u0000-\u001f]/.test(value)) return false;
  return domains.includes(parts[1]!);
}

/** The message shown to someone who is not allowed in. */
export function domainRestrictionMessage(env: NodeJS.ProcessEnv = process.env): string {
  const domains = allowedEmailDomains(env);
  return domains.length > 0 ? `Access is limited to ${domains.map((d) => `@${d}`).join(' and ')} email addresses.` : 'Access is limited to approved email addresses.';
}

/** A 403 response when the address is not allowed, otherwise null. */
export function refuseDisallowedEmail(email: unknown): NextResponse | null {
  return emailAllowed(email) ? null : apiError('FORBIDDEN', domainRestrictionMessage(), 403);
}
