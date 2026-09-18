/**
 * Password hashing — scrypt-based, no external dependency.
 *
 * Security contract:
 * - Each hash gets a fresh random 16-byte salt (scrypt, not a fast general-purpose hash).
 * - Stored format: "<saltHex>:<hashHex>" so verification never needs a second input.
 * - Comparison is timing-safe (`timingSafeEqual`) to avoid leaking hash bytes via timing.
 * - Server-side only; never import from client code.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

const SALT_BYTES = 16;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = (await scryptAsync(password, salt, expected.length)) as Buffer;

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

const PASSWORD_MIN_LENGTH = 8;

/** Minimal strength check — enforced at signup time. */
export function isPasswordStrongEnough(password: string): boolean {
  return typeof password === 'string' && password.length >= PASSWORD_MIN_LENGTH;
}
