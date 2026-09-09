/**
 * Credential encryption — AES-256-GCM authenticated encryption for credentials at rest.
 *
 * Security contract:
 * - Uses AES-256-GCM (authenticated encryption with associated data).
 * - Each encrypt() call generates a fresh random 12-byte IV.
 * - The authentication tag (16 bytes) is appended; decryption fails loudly if tampered.
 * - ENCRYPTION_KEY must be a 64-character hex string (32 bytes / 256 bits).
 * - encrypt/decrypt are server-side only; this module must never be imported from client code.
 * - If ENCRYPTION_KEY is absent or invalid at call time, an error is thrown immediately —
 *   no silent fallback to plaintext.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;  // 96-bit IV — recommended for GCM
const TAG_BYTES = 16; // 128-bit auth tag

/**
 * Derive a 32-byte key buffer from the env variable.
 * Accepts either:
 *  - A 64-char hex string (preferred — explicit 256-bit key).
 *  - Any string ≥ 32 chars (hashed to 32 bytes via SHA-256 as fallback).
 * Throws if ENCRYPTION_KEY is absent or too short.
 */
function getKeyBuffer(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      'ENCRYPTION_KEY is missing or too short. ' +
      'Set a 64-character hex string in your environment variables.',
    );
  }
  // If exactly 64 hex chars, decode directly — otherwise SHA-256 hash it.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // Derive 32 bytes from arbitrary-length key using SHA-256
  return createHash('sha256').update(raw, 'utf8').digest();
}

/**
 * Encrypt a UTF-8 plaintext string.
 * Output format: base64( iv[12] || ciphertext || authTag[16] )
 */
export function encrypt(plaintext: string): string {
  const key = getKeyBuffer();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Concatenate: iv | ciphertext | tag
  const combined = Buffer.concat([iv, encrypted, tag]);
  return combined.toString('base64');
}

/**
 * Decrypt a base64-encoded ciphertext produced by encrypt().
 * Throws if the ciphertext is tampered, truncated, or the key is wrong.
 * Never returns null — callers must handle the thrown error.
 */
export function decrypt(ciphertextB64: string): string {
  const key = getKeyBuffer();
  const combined = Buffer.from(ciphertextB64, 'base64');

  if (combined.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('Ciphertext is too short — data may be corrupted or not encrypted.');
  }

  const iv = combined.subarray(0, IV_BYTES);
  const tag = combined.subarray(combined.length - TAG_BYTES);
  const ciphertext = combined.subarray(IV_BYTES, combined.length - TAG_BYTES);

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    // Do not expose key/IV/tag details in error
    throw new Error('Credential decryption failed — data may be corrupted or key mismatch.');
  }
}
