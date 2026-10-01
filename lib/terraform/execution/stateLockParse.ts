/**
 * Reading Terraform's state-lock error text. Pure (no Node imports) so the browser can use it too.
 */
export interface LockInfo { id: string; who?: string; operation?: string; created?: Date; path?: string }

export function isStateLockError(message: string): boolean {
  return message.includes('Error acquiring the state lock') || message.includes('state blob is already locked') || message.includes('Lock Info:');
}

/** Reads the lock details out of Terraform's error text ("ID: ... Path: ... Operation: ... Who: ... Created: ..."). */
export function parseLockInfo(message: string): LockInfo | null {
  const id = (/\bID:\s*([A-Za-z0-9-]+)/.exec(message) ?? [])[1];
  if (!id) return null;
  const field = (name: string, next: string) => (new RegExp(`${name}:\\s*([\\s\\S]*?)\\s*(?:${next}):`).exec(message) ?? [])[1]?.trim();
  const createdRaw = (/Created:\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*([+-]\d{4}|Z)?/.exec(message) ?? []);
  const created = createdRaw[1] ? new Date(`${createdRaw[1]}T${createdRaw[2]}${createdRaw[3] && createdRaw[3] !== 'Z' ? `${createdRaw[3].slice(0, 3)}:${createdRaw[3].slice(3)}` : 'Z'}`) : undefined;
  return {
    id,
    who: field('Who', 'Version|Created|Info'),
    operation: field('Operation', 'Who|Version|Created|Info'),
    path: field('Path', 'Operation|Who|Version|Created|Info'),
    created: created && !Number.isNaN(created.getTime()) ? created : undefined,
  };
}
