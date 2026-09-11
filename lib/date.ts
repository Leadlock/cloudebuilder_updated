/**
 * Deterministic date and time formatters to prevent SSR/CSR hydration mismatches.
 */

export function formatDate(input: string | number | Date | null | undefined): string {
  if (!input) return '';
  const d = typeof input === 'string' || typeof input === 'number' ? new Date(input) : input;
  if (isNaN(d.getTime())) return '';
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatDateTime(input: string | number | Date | null | undefined): string {
  if (!input) return '';
  const d = typeof input === 'string' || typeof input === 'number' ? new Date(input) : input;
  if (isNaN(d.getTime())) return '';
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

export function formatTime(input: string | number | Date | null | undefined): string {
  if (!input) return '';
  const d = typeof input === 'string' || typeof input === 'number' ? new Date(input) : input;
  if (isNaN(d.getTime())) return '';
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes} UTC`;
}
