/**
 * Stateless, self-verifying session tokens (HMAC-signed, no server-side
 * store).
 *
 * Why this exists: the previous session implementation kept active sessions
 * in an in-memory `Map` (see git history of lib/api/authService.ts). That
 * works for a single long-running process, but this app now ships with a
 * production Docker/ECS deployment target (see Dockerfile,
 * ecs-task-definition.json) — the moment there's more than one task
 * instance, or a task restarts, a user's session lives on whichever
 * instance happened to create it and vanishes/404s everywhere else,
 * producing random, unreproducible logouts under real traffic. A stateless
 * signed token needs no shared state at all: any instance holding the same
 * `SESSION_SECRET` can verify a token nobody else issued.
 *
 * Format: `<base64url(payload JSON)>.<base64url(HMAC-SHA256 signature)>`.
 * Verification is synchronous (no DB/network round-trip), so this is a
 * drop-in replacement for the old Map-backed lookup — every call site that
 * used to call the old getSession()/createSession() keeps working
 * unchanged; see lib/api/authService.ts.
 *
 * This is deliberately hand-rolled rather than pulling in a JWT library:
 * the payload shape is entirely internal (never parsed by anything but
 * this file), so none of a JWT library's header/alg-negotiation surface
 * (a frequent source of real-world JWT vulnerabilities, e.g. "alg: none")
 * is exposed. HMAC-SHA256 over a fixed, known algorithm, checked with a
 * constant-time comparison, is the entire trust boundary.
 */
import { createHmac, timingSafeEqual } from 'crypto';

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error(
      'SESSION_SECRET is not set (or is too short). Generate one with: ' +
      `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" ` +
      'and set it in .env — see .env.example. The app refuses to mint or verify ' +
      'sessions without it, rather than silently falling back to something guessable.'
    );
  }
  return value;
}

function sign(data: string): string {
  return createHmac('sha256', secret()).update(data).digest('base64url');
}

/**
 * Encode an arbitrary JSON-serializable payload into a signed token.
 * The payload is visible to anyone holding the token (it's base64, not
 * encrypted) — never put anything in it that isn't already safe to expose
 * to the browser holding the cookie, same rule as a JWT.
 */
export function encodeSessionToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(body);
  return `${body}.${signature}`;
}

/**
 * Verify and decode a signed token. Returns null for anything invalid:
 * wrong signature (tampered or forged), malformed shape, or unparseable
 * payload. Never throws on untrusted input — a malformed cookie value must
 * behave exactly like "not logged in," not like a 500.
 */
export function decodeSessionToken<T = Record<string, unknown>>(token: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];

  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(sign(body), 'base64url');
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  try {
    const json = Buffer.from(body, 'base64url').toString('utf8');
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
