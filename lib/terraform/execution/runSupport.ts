/**
 * Safe building blocks shared by plan and destroy:
 *
 *  - `initWithRetry`   `terraform init` that survives a brief network drop (DNS blip) and a damaged provider cache;
 *  - `validateConfiguration`  `terraform validate`, so a configuration Terraform will reject fails in seconds with a clear
 *                      message instead of after a long run.
 *
 * Only READ-ONLY steps are retried. A step that changes infrastructure (apply, destroy) is never retried automatically
 * on a network error, because the first attempt may already have changed something.
 */
import { runTerraform, type TerraformRunOptions, type TerraformRunResult } from './cli';

export type RunTerraform = (args: string[], options: TerraformRunOptions) => Promise<TerraformRunResult>;

const TRANSIENT_NETWORK = /getaddrinfow|no such host|dial tcp|i\/o timeout|connection reset|TLS handshake timeout|temporary failure in name resolution|network is unreachable|ECONNRESET|ENOTFOUND|EAI_AGAIN/i;
const CACHE_PROBLEM = /plugin cache|checksum|does not match any of the checksums|cache directory|failed to install provider|text file busy/i;

export function isTransientNetworkError(message: string): boolean {
  return TRANSIENT_NETWORK.test(message);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface InitOptions {
  run?: RunTerraform;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  onOutput?: (chunk: string) => void;
  timeoutMs?: number;
}

/** `terraform init`: retries a network drop with a short wait, and falls back to a fresh download if the shared cache misbehaves. */
export async function initWithRetry(cwd: string, env: Record<string, string>, options: InitOptions = {}): Promise<void> {
  const { run = runTerraform, sleep = defaultSleep, attempts = 3, onOutput, timeoutMs = 5 * 60 * 1000 } = options;
  const args = ['init', '-input=false', '-no-color'];
  let pluginCache = true;
  for (let attempt = 1; ; attempt++) {
    try {
      await run(args, { cwd, env, timeoutMs, onOutput, pluginCache });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (pluginCache && CACHE_PROBLEM.test(message)) { pluginCache = false; continue; }   // one retry without the shared cache
      if (attempt < attempts && isTransientNetworkError(message)) {
        onOutput?.(`\n[CloudCraft] Network problem during init (attempt ${attempt} of ${attempts}); retrying…\n`);
        await sleep(attempt * 4000);
        continue;
      }
      throw err;
    }
  }
}

/** `terraform validate`. Throws a clear error, before anything else runs, if Terraform rejects the generated files. */
export async function validateConfiguration(cwd: string, env: Record<string, string>, options: { run?: RunTerraform } = {}): Promise<void> {
  const run = options.run ?? runTerraform;
  try {
    await run(['validate', '-no-color'], { cwd, env, timeoutMs: 2 * 60 * 1000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = message.replace(/^terraform validate failed \(exit \d+\):\s*/i, '').trim();
    throw new Error(`Terraform rejected the generated configuration (nothing was changed): ${detail.slice(0, 2500)}`);
  }
}
