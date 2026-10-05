/**
 * Re-encrypts every stored cloud credential with the ACTIVE key, in the current format and bound to its own account.
 *
 * Used after changing ENCRYPTION_KEY (the old key goes into ENCRYPTION_KEYS_PREVIOUS so existing data can still be read), and to
 * upgrade data written by older versions. Safe to run again and again: values already on the active key are left alone. A value that
 * cannot be opened (its key is gone, or it was tampered with) is reported and left exactly as it is: nothing is ever deleted.
 */
import { decrypt, encrypt, inspectCiphertext } from './credentials';

export interface RotationRepo {
  listForRotation(): Promise<{ id: string; orgId: string; credentialsJson: string }[]>;
  replaceEncrypted(id: string, orgId: string, credentialsJson: string): Promise<void>;
}

export interface RotationReport {
  total: number;
  /** Already on the active key in the current format. */
  alreadyCurrent: number;
  /** Re-encrypted (or, in a dry run, would be). */
  rotated: number;
  /** Of those: older format (no key id / not bound to the account). */
  fromLegacyFormat: number;
  /** Could not be opened: id and a short reason, never any secret. */
  failed: { id: string; reason: string }[];
  dryRun: boolean;
}

export async function rotateCredentials(repo: RotationRepo, options: { dryRun?: boolean; contextOf: (orgId: string, accountId: string) => string }): Promise<RotationReport> {
  const rows = await repo.listForRotation();
  const report: RotationReport = { total: rows.length, alreadyCurrent: 0, rotated: 0, fromLegacyFormat: 0, failed: [], dryRun: options.dryRun === true };

  for (const row of rows) {
    const info = inspectCiphertext(row.credentialsJson);
    if (info.current) { report.alreadyCurrent++; continue; }
    const context = options.contextOf(row.orgId, row.id);
    let plain: string;
    try {
      plain = decrypt(row.credentialsJson, context);
    } catch {
      report.failed.push({ id: row.id, reason: info.keyMissing ? `encrypted with key ${info.keyId}, which is not configured (put it in ENCRYPTION_KEYS_PREVIOUS)` : 'could not be decrypted (corrupted, or it belongs to a different account)' });
      continue;
    }
    if (!report.dryRun) await repo.replaceEncrypted(row.id, row.orgId, encrypt(plain, context));
    report.rotated++;
    if (info.format === 'legacy') report.fromLegacyFormat++;
  }
  return report;
}
