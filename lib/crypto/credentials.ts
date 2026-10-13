/**
 * Credential encryption — AES-256-GCM authenticated encryption for credentials at rest.
 *
 * Security contract:
 * - AES-256-GCM with a fresh random 12-byte IV for every encryption and a 16-byte authentication tag: tampering fails loudly.
 * - Keys are IDENTIFIED. Stored data looks like `v2:<keyId>:<base64(iv | ciphertext | tag)>`, where keyId is a short fingerprint of
 *   the key that encrypted it. So keys can be rotated: put the new key in ENCRYPTION_KEY, move the old one to
 *   ENCRYPTION_KEYS_PREVIOUS (comma separated), and everything encrypted with an old key still opens until it is re-encrypted
 *   (`npm run credentials:rotate`).
 * - Ciphertext is BOUND to what it belongs to. The caller passes a context (for example "cloud-account:<org>:<id>") that is
 *   authenticated with the data (GCM additional data). Copying one account's encrypted credentials into another row, or another
 *   organisation, makes decryption fail instead of quietly handing over someone else's credentials.
 * - Older data (no prefix, no context, one key) is still readable and is upgraded to the format above the next time it is read.
 * - The key must be a 64-character hex string (256 random bits). In production anything else is refused; outside production a long
 *   passphrase is accepted (hashed with SHA-256) so existing development setups keep working, with a warning.
 * - encrypt/decrypt are server-side only; this module must never be imported from client code. There is no fallback to plaintext.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;  // 96-bit IV — recommended for GCM
const TAG_BYTES = 16; // 128-bit auth tag
const VERSION = 'v2';
const AAD_PREFIX = 'cloudcraft-credential|';

export interface KeyEntry { id: string; key: Buffer }

/** A short, non-reversible fingerprint that names a key inside stored data without revealing it. */
export function keyIdOf(key: Buffer): string {
  return createHash('sha256').update('cloudcraft:key-id:').update(key).digest('hex').slice(0, 8);
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * Keys that were once published as examples (in .env.example) and so are known to everyone. Compared by hash, so this file does not
 * repeat them. Production refuses them; anywhere else they get a warning.
 */
const PUBLISHED_EXAMPLE_KEY_HASHES = new Set(['c1fa177136c43d44575f41558a23a67f670f233daa3d97dd8e4305715dc65c0f']);
const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export interface KeyAssessment { ok: boolean; problem?: string; warning?: string }

/** Whether a configured key is acceptable here. Production demands 64 hex characters of real randomness. */
export function assessEncryptionKey(raw: string | undefined, production: boolean): KeyAssessment {
  if (!raw) return { ok: false, problem: 'is not set' };
  if (PUBLISHED_EXAMPLE_KEY_HASHES.has(sha256hex(raw))) {
    const text = 'is a key that was published as an example, so anyone can use it to decrypt your stored credentials. Generate your own with: npm run credentials:new-key (then rotate: see .env.example)';
    return production ? { ok: false, problem: text } : { ok: true, warning: text };
  }
  if (HEX64.test(raw)) {
    // A key like 000…0 or abab…ab is valid hex but is not random. (Only production insists: development and tests use throwaway keys.)
    if (production && new Set(raw.toLowerCase()).size < 8) return { ok: false, problem: 'does not look random (too few different characters). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"' };
    return { ok: true };
  }
  if (production) return { ok: false, problem: 'must be exactly 64 hexadecimal characters (256 random bits) in production. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"' };
  if (raw.length < 32) return { ok: false, problem: 'is too short (at least 32 characters; 64 hexadecimal characters recommended)' };
  return { ok: true, warning: 'is a passphrase, not 64 random hex characters. It works here, but production will refuse it. Generate a proper key with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"' };
}

/** Whether the configured encryption key is one this server should be trusted with credentials under (not an example, not a weak passphrase). */
export function encryptionKeyIsTrustworthy(env: NodeJS.ProcessEnv = process.env): { ok: boolean; reason?: string } {
  const v = assessEncryptionKey(env['ENCRYPTION_KEY'], env['NODE_ENV'] === 'production');
  return v.ok && !v.warning ? { ok: true } : { ok: false, reason: v.problem ?? v.warning };
}

function toKeyBuffer(raw: string): Buffer {
  return HEX64.test(raw) ? Buffer.from(raw, 'hex') : createHash('sha256').update(raw, 'utf8').digest();
}

let warned = false;
let cache: { signature: string; active: KeyEntry; all: KeyEntry[] } | null = null;

/** The active key (encrypts everything new) and every key that may still open older data. Throws, plainly, if the active key is unusable. */
export function loadKeyring(env: NodeJS.ProcessEnv = process.env): { active: KeyEntry; all: KeyEntry[] } {
  const raw = env['ENCRYPTION_KEY'];
  const previousRaw = env['ENCRYPTION_KEYS_PREVIOUS'] ?? '';
  const signature = `${raw ?? ''}|${previousRaw}|${env['NODE_ENV'] ?? ''}`;
  if (cache && cache.signature === signature) return cache;

  const production = env['NODE_ENV'] === 'production';
  const verdict = assessEncryptionKey(raw, production);
  if (!verdict.ok) throw new Error(`ENCRYPTION_KEY ${verdict.problem}.`);
  if (verdict.warning && !warned) { warned = true; console.warn(`[crypto] ENCRYPTION_KEY ${verdict.warning}`); }

  const toEntry = (k: string): KeyEntry => { const key = toKeyBuffer(k); return { id: keyIdOf(key), key }; };
  const active = toEntry(raw!);
  const previous = previousRaw.split(',').map((k) => k.trim()).filter(Boolean).map((k) => {
    const v = assessEncryptionKey(k, production);
    if (!v.ok) throw new Error(`An entry in ENCRYPTION_KEYS_PREVIOUS ${v.problem}.`);
    return toEntry(k);
  });
  const seen = new Set<string>();
  const all = [active, ...previous].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  cache = { signature, active, all };
  return cache;
}

/** For tests. */
export function _resetKeyringCacheForTests(): void { cache = null; warned = false; }

const aad = (context: string) => Buffer.from(`${AAD_PREFIX}${context}`, 'utf8');

/**
 * Encrypt a UTF-8 plaintext string with the active key.
 * Output: `v2:<keyId>:<base64( iv[12] | ciphertext | authTag[16] )>`.
 * `context` names what the data belongs to; the same context must be given to decrypt().
 */
export function encrypt(plaintext: string, context = ''): string {
  const { active } = loadKeyring();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, active.key, iv);
  cipher.setAAD(aad(context));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${active.id}:${Buffer.concat([iv, encrypted, tag]).toString('base64')}`;
}

function open(key: Buffer, combined: Buffer, additional: Buffer | null): string {
  if (combined.length < IV_BYTES + TAG_BYTES + 1) throw new Error('short');
  const iv = combined.subarray(0, IV_BYTES);
  const tag = combined.subarray(combined.length - TAG_BYTES);
  const ciphertext = combined.subarray(IV_BYTES, combined.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  if (additional) decipher.setAAD(additional);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export interface CiphertextInfo {
  format: 'v2' | 'legacy';
  keyId: string | null;
  /** True when it was encrypted with the active key in the current format (nothing to upgrade). */
  current: boolean;
  /** v2 data names a key this server does not have. */
  keyMissing: boolean;
}

/** What a stored value is, without decrypting it. */
export function inspectCiphertext(ciphertext: string): CiphertextInfo {
  const { active, all } = loadKeyring();
  if (ciphertext.startsWith(`${VERSION}:`)) {
    const keyId = ciphertext.split(':')[1] ?? '';
    return { format: 'v2', keyId, current: keyId === active.id, keyMissing: !all.some((k) => k.id === keyId) };
  }
  return { format: 'legacy', keyId: null, current: false, keyMissing: false };
}

/**
 * Decrypt a value produced by encrypt() (or the older format). Throws if it was tampered with, truncated, belongs to a different
 * context, or was encrypted with a key that is not configured. Never returns null; the error never says which part failed.
 */
export function decrypt(ciphertext: string, context = ''): string {
  const { all } = loadKeyring();
  try {
    if (ciphertext.startsWith(`${VERSION}:`)) {
      const [, keyId = '', body = ''] = ciphertext.split(':');
      const entry = all.find((k) => k.id === keyId);
      if (!entry) throw new Error('unknown key');
      return open(entry.key, Buffer.from(body, 'base64'), aad(context));
    }
    // Older data: no key id and no context. Try each key we hold.
    const combined = Buffer.from(ciphertext, 'base64');
    for (const k of all) {
      try { return open(k.key, combined, null); } catch { /* try the next key */ }
    }
    throw new Error('no key opened it');
  } catch {
    throw new Error('Credential decryption failed — the data may be corrupted, may belong to something else, or was encrypted with a key that is not configured.');
  }
}
