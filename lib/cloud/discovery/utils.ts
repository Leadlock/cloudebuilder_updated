/**
 * Utilities for cloud discovery: exponential backoff retry, throttling detection,
 * configuration hashing, and ID sanitization.
 */
import { createHash } from 'crypto';

/**
 * Computes a deterministic SHA-256 hash of a functional configuration object
 * for change detection and drift tracking.
 */
export function computeConfigHash(config: Record<string, unknown>): string {
  try {
    const keys = Object.keys(config).sort();
    const sortedObj: Record<string, unknown> = {};
    for (const k of keys) {
      // Exclude transient internal keys starting with underscore
      if (!k.startsWith('_')) {
        sortedObj[k] = config[k];
      }
    }
    const serialized = JSON.stringify(sortedObj);
    return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
  } catch {
    return 'unhashable';
  }
}

/**
 * Checks whether an error is a cloud rate limit / throttling error.
 */
export function isThrottlingError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  const code = (err as { code?: string })?.code ?? '';
  const status = (err as { statusCode?: number; status?: number })?.statusCode ?? (err as { status?: number })?.status;

  if (status === 429 || status === 503) return true;

  const matchPatterns = [
    'Throttling',
    'ThrottlingException',
    'RequestLimitExceeded',
    'TooManyRequests',
    'TooManyRequestsException',
    'Rate exceeded',
    'slow down',
    'quota exceeded',
    'ResourceRateLimitExceeded',
  ];

  return matchPatterns.some((p) => name.includes(p) || code.includes(p) || msg.includes(p));
}

/**
 * Retry an asynchronous operation with exponential backoff and jitter.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    factor?: number;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 300,
    maxDelayMs = 4000,
    factor = 2,
    signal,
  } = options;

  let delay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new Error('Discovery aborted by user');
    }

    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries || !isThrottlingError(err)) {
        throw err;
      }

      // Add full jitter to prevent thundering herds
      const jitter = Math.random() * delay;
      const sleepDuration = Math.min(maxDelayMs, delay + jitter);
      await new Promise((resolve) => setTimeout(resolve, sleepDuration));
      delay *= factor;
    }
  }

  throw new Error('Retry exhausted');
}

/**
 * Sanitizes cloud resource identifiers into valid canvas node IDs.
 */
export function sanitizeResourceId(rawId: string): string {
  if (!rawId) return 'unknown-res';
  return rawId
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'res';
}
