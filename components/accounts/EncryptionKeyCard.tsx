'use client';
/**
 * How the stored credentials are protected, and the two things an admin can do about it from here: re-encrypt them with the current
 * key, and generate a new random key. The active key itself is set in the server environment (ENCRYPTION_KEY) and is changed there.
 * Hidden for people who are not owners or admins. Shows no secret except a freshly generated key, once, when asked for.
 */
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, Copy } from 'lucide-react';

interface Status {
  activeKeyId: string | null;
  previousKeys: number;
  problem: string | null;
  warning: string | null;
  total: number;
  onActiveKey: number;
  needsReencrypt: number;
  cannotOpen: number;
  cannotOpenReasons: string[];
}

export default function EncryptionKeyCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<'reencrypt' | 'generate' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/cloud-accounts/encryption', { credentials: 'include' });
      if (res.status === 403 || res.status === 401) { setHidden(true); return; }
      const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: Status };
      if (res.ok && data.ok && data.data) setStatus(data.data);
    } catch { /* the card simply stays empty */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(action: 'reencrypt' | 'generate') {
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/cloud-accounts/encryption', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { key?: string; rotated?: number; cannotOpen?: number }; error?: { message?: string } };
      if (!res.ok || !data.ok || !data.data) { setError(data.error?.message ?? 'That did not work.'); return; }
      if (action === 'generate') setNewKey(data.data.key ?? null);
      else {
        setMessage(`Re-encrypted ${data.data.rotated ?? 0} credential${data.data.rotated === 1 ? '' : 's'} with the current key.${data.data.cannotOpen ? ` ${data.data.cannotOpen} could not be opened.` : ''}`);
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setBusy(null);
    }
  }

  if (hidden || !status) return null;
  const button = 'px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-600 text-gray-200 hover:bg-gray-700 disabled:opacity-50';

  return (
    <section className="rounded-xl border border-gray-700 bg-gray-800/40 p-4 space-y-3" aria-label="Credential encryption" data-testid="encryption-card">
      <div className="flex items-center gap-2 text-gray-200 text-sm font-semibold"><KeyRound className="w-4 h-4 text-amber-400" /> How your keys are protected</div>
      {status.problem && <p className="text-red-300 text-xs bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2" role="alert">{status.problem}</p>}
      {status.warning && <p className="text-amber-300 text-xs bg-amber-950/30 border border-amber-800/40 rounded-lg px-3 py-2">{status.warning}</p>}
      {status.activeKeyId && (
        <p className="text-gray-400 text-xs leading-relaxed">
          Stored credentials are encrypted (AES-256-GCM) with key <span className="font-mono text-gray-200">{status.activeKeyId}</span>
          {status.previousKeys > 0 ? ` (${status.previousKeys} older key${status.previousKeys === 1 ? '' : 's'} still readable)` : ''}.
          {' '}{status.total === 0 ? 'No credentials are stored yet.' : `${status.onActiveKey} of ${status.total} are on the current key${status.needsReencrypt > 0 ? `; ${status.needsReencrypt} can be upgraded` : ''}.`}
        </p>
      )}
      {status.cannotOpen > 0 && (
        <p className="text-red-300 text-xs">{status.cannotOpen} stored credential{status.cannotOpen === 1 ? '' : 's'} cannot be opened: {status.cannotOpenReasons.join(' ')}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy !== null || status.needsReencrypt === 0} onClick={() => void run('reencrypt')}>
          {busy === 'reencrypt' ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Re-encrypt with the current key'}
        </button>
        <button type="button" className={button} disabled={busy !== null} onClick={() => void run('generate')}>
          {busy === 'generate' ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Generate a new key'}
        </button>
      </div>
      {newKey && (
        <div className="text-xs space-y-1.5 rounded-lg border border-amber-800/40 bg-amber-950/20 p-3" data-testid="new-key">
          <p className="text-amber-200">New key (shown once, not stored by CloudCraft):</p>
          <div className="flex items-center gap-2">
            <code className="font-mono text-gray-100 break-all select-all">{newKey}</code>
            <button type="button" aria-label="Copy the key" className="p-1 text-gray-400 hover:text-white" onClick={() => void navigator.clipboard?.writeText(newKey)}><Copy className="w-3.5 h-3.5" /></button>
          </div>
          <ol className="text-gray-300 list-decimal pl-5 space-y-0.5 leading-relaxed">
            <li>In the server&apos;s <code>.env</code>, move the current <code>ENCRYPTION_KEY</code> value to <code>ENCRYPTION_KEYS_PREVIOUS</code> (comma separated if there are several).</li>
            <li>Put the new key in <code>ENCRYPTION_KEY</code> and restart CloudCraft.</li>
            <li>Come back here and press <strong>Re-encrypt with the current key</strong>. Then the old key can be removed.</li>
          </ol>
          <button type="button" className="text-gray-500 hover:text-gray-300" onClick={() => setNewKey(null)}>Hide the key</button>
        </div>
      )}
      {message && <p className="text-emerald-400 text-xs">{message}</p>}
      {error && <p className="text-red-400 text-xs" role="alert">{error}</p>}
    </section>
  );
}
