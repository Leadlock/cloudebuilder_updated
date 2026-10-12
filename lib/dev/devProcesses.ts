/**
 * Pure helpers for `npm run dev` (scripts/dev-all.ts), which starts the web server and every background worker together:
 * which processes to run, how their output is labelled, and when a crashing worker should stop being restarted.
 */
export interface DevProcessSpec {
  /** Label shown in front of every output line. */
  name: string;
  /** Path of the script run through tsx (relative to the app folder), or null for the Next.js dev server. */
  script: string | null;
  /** A crash of this process stops everything (the web server) or is retried and then left alone (a worker). */
  essential: boolean;
}

export const DEV_PROCESSES: readonly DevProcessSpec[] = [
  { name: 'web', script: null, essential: true },
  { name: 'worker:discovery', script: 'workers/discoveryWorker.ts', essential: false },
  { name: 'worker:terraform-apply', script: 'workers/terraformApplyWorker.ts', essential: false },
];

/** `CLOUDCRAFT_DEV_WORKERS=off` starts only the web server (the old behaviour). */
export function selectDevProcesses(env: Record<string, string | undefined> = process.env): DevProcessSpec[] {
  return env['CLOUDCRAFT_DEV_WORKERS'] === 'off' ? DEV_PROCESSES.filter((p) => p.essential) : [...DEV_PROCESSES];
}

/**
 * Where the dev web server listens. By default only this machine (127.0.0.1): `next dev` otherwise listens on every network interface and
 * prints a "Network" address, so anyone on the same Wi-Fi could reach a server that runs with development shortcuts. Set
 * CLOUDCRAFT_DEV_HOST=0.0.0.0 (or an address) on purpose to open it, for example to test from a phone.
 */
export function devHostArgs(env: Record<string, string | undefined> = process.env): string[] {
  const host = (env['CLOUDCRAFT_DEV_HOST'] ?? '').trim();
  return ['-H', /^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(host) ? host : '127.0.0.1'];
}

/** Splits a stream of text into whole lines, each labelled, keeping a partial last line for the next chunk. */
export class LinePrefixer {
  private partial = '';
  constructor(private readonly label: string) {}

  push(chunk: string): string[] {
    const text = (this.partial + chunk).replace(/\r\n/g, '\n');
    const parts = text.split('\n');
    this.partial = parts.pop() ?? '';
    return parts.map((l) => `[${this.label}] ${l}`);
  }

  end(): string[] {
    const rest = this.partial;
    this.partial = '';
    return rest ? [`[${this.label}] ${rest}`] : [];
  }
}

export interface RestartDecision { restart: boolean; delayMs: number; giveUp?: string }

/**
 * A worker that crashes is started again after a short, growing wait, but a worker that keeps crashing (a missing setting, no database)
 * is left alone with a clear message instead of spinning forever. The web server is never affected by it.
 */
export class RestartPolicy {
  private crashes: number[] = [];
  constructor(private readonly maxCrashes = 5, private readonly windowMs = 60_000) {}

  onExit(code: number | null, now: number = Date.now()): RestartDecision {
    if (code === 0) return { restart: false, delayMs: 0 };               // a clean exit is not restarted
    this.crashes = this.crashes.filter((t) => now - t < this.windowMs);
    this.crashes.push(now);
    if (this.crashes.length >= this.maxCrashes) {
      return { restart: false, delayMs: 0, giveUp: `crashed ${this.crashes.length} times in ${Math.round(this.windowMs / 1000)} seconds, so it is not being restarted. Fix the error above, then run the worker again with its npm script.` };
    }
    return { restart: true, delayMs: Math.min(1000 * 2 ** (this.crashes.length - 1), 15_000) };
  }
}

/** The arguments to run one spec's script through tsx, loading .env when there is one (workers need DATABASE_URL and the encryption key). */
export function tsxArgs(script: string, hasEnvFile: boolean): string[] {
  return [...(hasEnvFile ? ['--env-file=.env'] : []), '--tsconfig', 'tsconfig.json', script];
}
