'use client';
/**
 * Per-account controls for how long CloudCraft keeps the credentials: keep for longer (or without a limit), erase after the next
 * successful deployment, or erase now. Nothing secret is shown or sent: the server changes the stored credentials in place.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { LIFETIME_CHOICES } from '@/lib/cloud/credentialLifetime';

interface Props {
  accountId: string;
  forgetAfterDeploy: boolean;
  temporary: boolean;
  onChanged: () => void | Promise<void>;
}

export default function CredentialLifetimeControls({ accountId, forgetAfterDeploy, temporary, onChanged }: Props) {
  const [keepFor, setKeepFor] = useState<string>('8h');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmErase, setConfirmErase] = useState(false);

  async function send(label: string, body: Record<string, unknown>) {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(`/api/cloud-accounts/${accountId}/lifetime`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: { message?: string } };
      if (!res.ok || !data.ok) { setError(data.error?.message ?? 'Could not change that.'); return; }
      setConfirmErase(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setBusy(null);
    }
  }

  const small = 'bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-xs';
  const button = 'px-2 py-1 rounded text-xs border border-gray-600 text-gray-200 hover:bg-gray-700 disabled:opacity-50';

  return (
    <div className="mt-2.5 rounded-lg border border-gray-700 bg-gray-900/40 px-3 py-2 space-y-2 text-xs" data-testid="lifetime-controls">
      <p className="text-gray-400 font-medium">How long CloudCraft keeps this key</p>
      {!temporary && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-gray-400">Keep it for</span>
          <select value={keepFor} onChange={(e) => setKeepFor(e.target.value)} aria-label="Keep the key for" className={small}>
            {LIFETIME_CHOICES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <button type="button" className={button} disabled={busy !== null}
            onClick={() => void send('extend', { action: 'extend', hours: LIFETIME_CHOICES.find((c) => c.id === keepFor)?.hours ?? null })}>
            {busy === 'extend' ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Set from now'}
          </button>
        </div>
      )}
      <label className="flex items-center gap-2 text-gray-300">
        <input type="checkbox" checked={forgetAfterDeploy} disabled={busy !== null}
          onChange={(e) => void send('forget', { action: 'forgetAfterDeploy', value: e.target.checked })} />
        Delete the key after a deployment succeeds
      </label>
      {confirmErase ? (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-amber-300">Delete the key from CloudCraft now? You will have to connect again.</span>
          <button type="button" className={`${button} !border-red-700 text-red-200`} disabled={busy !== null} onClick={() => void send('erase', { action: 'erase' })}>
            {busy === 'erase' ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Yes, delete it'}
          </button>
          <button type="button" className={button} onClick={() => setConfirmErase(false)}>Cancel</button>
        </div>
      ) : (
        <button type="button" className={button} onClick={() => setConfirmErase(true)}>Delete the key now</button>
      )}
      {error && <p className="text-red-400" role="alert">{error}</p>}
    </div>
  );
}
