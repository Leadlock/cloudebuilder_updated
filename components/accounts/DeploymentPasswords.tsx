'use client';
/**
 * The passwords CloudCraft generated for what it deployed with this account (database, SQL Server, Windows admin). Fetched only when
 * asked, shown until hidden, never kept in the browser. Empty until the account has been planned or deployed once.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';

const LABELS: Record<string, string> = { db_password: 'Database password', sql_admin_password: 'SQL admin password', windows_admin_password: 'Windows admin password' };

export default function DeploymentPasswords({ accountId }: { accountId: string }) {
  const [secrets, setSecrets] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cloud-accounts/${accountId}/deployment-secrets`, { credentials: 'include', cache: 'no-store' });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { secrets: Record<string, string> }; error?: { message?: string } };
      if (!res.ok || !data.ok || !data.data) { setError(data.error?.message ?? 'Could not read the passwords.'); return; }
      setSecrets(data.data.secrets);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2.5 rounded-lg border border-gray-700 bg-gray-900/40 px-3 py-2 space-y-2 text-xs" data-testid="deployment-passwords">
      <p className="text-gray-400 font-medium">Passwords CloudCraft generated for this account&apos;s deployments</p>
      {secrets === null ? (
        <button type="button" disabled={busy} onClick={() => void reveal()} className="px-2 py-1 rounded text-xs border border-gray-600 text-gray-200 hover:bg-gray-700 disabled:opacity-50">
          {busy ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Show passwords'}
        </button>
      ) : Object.keys(secrets).length === 0 ? (
        <p className="text-gray-500">None yet. They are created the first time you plan a deployment with this account (or you set them in the server environment).</p>
      ) : (
        <>
          <dl className="space-y-1">
            {Object.entries(secrets).map(([name, value]) => (
              <div key={name} className="flex items-center justify-between gap-3">
                <dt className="text-gray-400">{LABELS[name] ?? name}</dt>
                <dd><code className="font-mono text-gray-100 select-all break-all">{value}</code></dd>
              </div>
            ))}
          </dl>
          <button type="button" className="text-gray-500 hover:text-gray-300" onClick={() => setSecrets(null)}>Hide</button>
        </>
      )}
      {error && <p className="text-red-400" role="alert">{error}</p>}
    </div>
  );
}
