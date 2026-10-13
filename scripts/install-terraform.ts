/**
 * Gets the Terraform CloudCraft runs, ready before the first deploy: `npm run terraform:install`. It does nothing when a Terraform is already
 * found (see lib/terraform/execution/binary.ts for the order). The server does the same on its own the first time Terraform is needed, so this
 * is only for people who prefer to do it up front, or want to check that this machine can reach HashiCorp.
 *
 *   --managed   ignore any Terraform already installed and fetch the copy CloudCraft manages (used by CI to test the real download)
 *
 * Prints the path and version of the Terraform that will be used. Exits 1, with the reason, when it cannot get one.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

if (process.argv.includes('--managed')) {
  // Look only at the managed folder: no file you named, no ~/bin, an empty PATH.
  delete process.env['TERRAFORM_BINARY_PATH'];
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-terraform-'));
  process.env['HOME'] = empty; process.env['USERPROFILE'] = empty; process.env['PATH'] = path.join(empty, 'bin');
}

async function main(): Promise<void> {
  // Imported after the environment above is set: nothing reads it earlier, but this keeps the order obvious.
  const { ensureTerraform, locateTerraform, TERRAFORM_VERSION } = await import('../lib/terraform/execution/binary');
  const before = locateTerraform();
  const bin = await ensureTerraform({ log: (l) => console.log(l) });
  const v = spawnSync(bin, ['version'], { encoding: 'utf8', timeout: 30_000 });
  if (v.status !== 0) throw new Error(`${bin} did not run: ${(v.stderr || v.stdout).trim().slice(0, 300)}`);
  console.log(`${before ? 'Found' : 'Installed'} ${bin}\n${v.stdout.split('\n')[0]}  (CloudCraft pins ${TERRAFORM_VERSION})`);
  if (process.argv.includes('--managed') && !bin.includes(`${path.sep}${TERRAFORM_VERSION}${path.sep}`)) throw new Error(`expected the managed copy, got ${bin}`);
}

main().catch((e: unknown) => { console.error(`Could not get Terraform: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
