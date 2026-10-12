/**
 * Saving a container configuration and reading it back. A saved configuration never holds a secret value (a variable marked secret has
 * its value cleared, as the form already does), and what is read from storage is treated as untrusted: it is merged over the defaults for
 * its stack, so a template saved before an option existed still loads, and it must pass the same validation as the form.
 */
import { z } from 'zod';
import { defaultConfig, validate, STACK_LABEL, type ContainerConfig, type ContainerStack } from './dockerTemplates';

export const MAX_TEMPLATE_NAME = 80;
export const MAX_TEMPLATES_PER_ORG = 100;

export function stripSecrets(c: ContainerConfig): ContainerConfig {
  return { ...c, env: c.env.map((v) => (v.secret ? { key: v.key, value: '', secret: true } : v)) };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Merge a stored object over the defaults of its stack. Returns null when it is not a usable configuration. */
export function parseStoredConfig(json: string): ContainerConfig | null {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!isObject(raw) || typeof raw['stack'] !== 'string' || !(raw['stack'] in STACK_LABEL)) return null;
  const base = defaultConfig(raw['stack'] as ContainerStack);
  const merged = { ...base, ...raw, ec2: { ...base.ec2, ...(isObject(raw['ec2']) ? raw['ec2'] : {}) } } as ContainerConfig;
  if (!Array.isArray(merged.env)) merged.env = [];
  return validate(merged).length === 0 ? stripSecrets(merged) : null;
}

/** Errors that stop a configuration being saved (empty when it can be saved). */
export function checkSavable(name: unknown, config: ContainerConfig): string[] {
  const errors: string[] = [];
  if (typeof name !== 'string' || name.trim() === '' || name.trim().length > MAX_TEMPLATE_NAME) errors.push(`Give the template a name of 1 to ${MAX_TEMPLATE_NAME} characters.`);
  return [...errors, ...validate(config)];
}

/** The request body for saving or replacing a template. */
export const SaveBody = z.object({ name: z.string(), config: z.unknown() });
/** Roles that may save, change and delete templates (viewers can only read). */
export const WRITE_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member']);
