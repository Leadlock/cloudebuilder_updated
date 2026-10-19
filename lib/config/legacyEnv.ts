/**
 * The product was called CloudCraft: its settings were CLOUDCRAFT_*. A server or a worker started with an old .env keeps working: each
 * CLOUDCRAFT_X is copied to CLOUDBUILDER_X when that is not set, and a line says which names to change. Import this first in every entry point.
 */
import 'dotenv/config';

const OLD = 'CLOUDCRAFT_';
const NEW = 'CLOUDBUILDER_';

/** Copies the old names to the new ones in `env`; returns the old names that were used. */
export function applyLegacyEnv(env: Record<string, string | undefined> = process.env): string[] {
  const used: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith(OLD)) continue;
    const next = NEW + key.slice(OLD.length);
    if (env[next] === undefined && env[key] !== undefined) { env[next] = env[key]; used.push(key); }
  }
  return used;
}

const used = applyLegacyEnv();
if (used.length > 0) console.warn(`[config] ${used.length} setting${used.length === 1 ? ' uses' : 's use'} the old CLOUDCRAFT_ name (${used.join(', ')}). Rename ${used.length === 1 ? 'it' : 'them'} to CLOUDBUILDER_… in the environment.`);
