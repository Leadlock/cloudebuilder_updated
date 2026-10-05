/**
 * Re-encrypts every stored cloud credential with the active ENCRYPTION_KEY (see .env.example for the rotation steps).
 *
 *   npm run credentials:rotate               do it
 *   npm run credentials:rotate -- --dry-run  only report what would change
 *
 * Prints counts and account ids, never a credential. Exits with an error status if any value could not be opened.
 */
import { cloudAccountRepository, credentialContext } from '../lib/repositories/cloudAccountRepository';
import { rotateCredentials } from '../lib/crypto/rotateCredentials';
import { loadKeyring } from '../lib/crypto/credentials';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const { active, all } = loadKeyring();   // throws, plainly, if ENCRYPTION_KEY is unusable
  console.log(`Active key id: ${active.id}. Keys that can still be read: ${all.map((k) => k.id).join(', ')}.`);

  const report = await rotateCredentials(cloudAccountRepository, { dryRun, contextOf: credentialContext });
  console.log(`${dryRun ? '[dry run] ' : ''}${report.total} stored credential(s): ${report.alreadyCurrent} already on the active key, ${report.rotated} ${dryRun ? 'would be' : ''} re-encrypted${report.fromLegacyFormat > 0 ? ` (${report.fromLegacyFormat} of them from the older format)` : ''}, ${report.failed.length} could not be opened.`);
  for (const f of report.failed) console.error(`  account ${f.id}: ${f.reason}`);
  if (report.failed.length > 0) process.exitCode = 1;
  else if (!dryRun && report.rotated + report.alreadyCurrent === report.total) console.log('Everything is on the active key. Old keys can be removed from ENCRYPTION_KEYS_PREVIOUS.');
}

main().then(() => process.exit(), (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
