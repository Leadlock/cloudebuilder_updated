/**
 * The project's settings as the browser sends them, made safe before anything is generated from them.
 *
 * The result is built from the project's own defaults: only keys that exist there are read, each must have the type the default has, strings
 * are bounded, and nothing else is copied. So an unexpected key (including `__proto__`), a wrong type, a huge value or a secret smuggled into the
 * settings never reaches the generator or the release record. Whether a value is a good one (a port, a name, a size) is the generator's job.
 */
import { defaultProject, type StackProject } from '@/lib/engines/containers/stackProject';

export class ProjectInputError extends Error {
  constructor(public readonly path: string, message: string) { super(`${path}: ${message}`); this.name = 'ProjectInputError'; }
}

const MAX_STRING = 2000;
const MAX_ITEMS = 100;
const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function str(v: unknown, path: string): string {
  if (typeof v !== 'string') throw new ProjectInputError(path, 'must be text');
  if (v.length > MAX_STRING) throw new ProjectInputError(path, `is longer than ${MAX_STRING} characters`);
  if (v.includes('\0')) throw new ProjectInputError(path, 'has a character that is not allowed');
  return v;
}

function envList(v: unknown, path: string): Array<{ key: string; value: string; secret?: boolean }> {
  if (!Array.isArray(v) || v.length > MAX_ITEMS) throw new ProjectInputError(path, `must be a list of at most ${MAX_ITEMS} variables`);
  return v.map((e, i) => {
    const p = `${path}[${i}]`;
    if (!plain(e)) throw new ProjectInputError(p, 'must be a variable');
    const key = str(e['key'], `${p}.key`);
    const value = str(e['value'], `${p}.value`);
    const secret = e['secret'];
    if (secret !== undefined && typeof secret !== 'boolean') throw new ProjectInputError(`${p}.secret`, 'must be true or false');
    // A secret's value is never part of the settings: it is typed into the write-only form when the release asks for it.
    if (secret === true && value !== '') throw new ProjectInputError(`${p}.value`, 'a secret has no value here: you are asked for it during the release');
    return { key, value, ...(secret === true ? { secret: true } : {}) };
  });
}

function merge(def: unknown, input: unknown, path: string): unknown {
  if (input === undefined) return structuredClone(def);
  if (Array.isArray(def)) {
    if (path.endsWith('.env')) return envList(input, path);
    if (!Array.isArray(input) || input.length > MAX_ITEMS) throw new ProjectInputError(path, `must be a list of at most ${MAX_ITEMS} items`);
    return input.map((x, i) => str(x, `${path}[${i}]`));
  }
  if (plain(def)) {
    if (!plain(input)) throw new ProjectInputError(path, 'must be an object');
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(def)) out[key] = merge(def[key], Object.prototype.hasOwnProperty.call(input, key) ? input[key] : undefined, `${path}.${key}`);
    return out;
  }
  if (typeof def === 'string') return str(input, path);
  if (typeof def === 'number') {
    if (typeof input !== 'number' || !Number.isFinite(input)) throw new ProjectInputError(path, 'must be a number');
    return input;
  }
  if (typeof def === 'boolean') {
    if (typeof input !== 'boolean') throw new ProjectInputError(path, 'must be true or false');
    return input;
  }
  throw new ProjectInputError(path, 'is not a setting');
}

/** The project the browser described, or a ProjectInputError saying which setting is wrong. */
export function coerceProject(input: unknown): StackProject {
  if (!plain(input)) throw new ProjectInputError('project', 'must be an object');
  return merge(defaultProject(), input, 'project') as StackProject;
}
