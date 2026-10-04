'use client';
/** Confirmation before deleting a connected cloud account (its stored credentials and discovery history go with it). */
import { useState } from 'react';
import { Trash2, Loader2 } from 'lucide-react';

export default function DeleteAccountDialog({ account, onClose, onDeleted }: {
  account: { id: string; name: string; provider: string };
  onClose: () => void;
  onDeleted: (accountId: string) => void | Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/cloud-accounts/${account.id}`, { method: 'DELETE', credentials: 'include' });
      const data = await res.json().catch(() => ({})) as { error?: { message?: string } };
      if (!res.ok) throw new Error(data?.error?.message ?? `Could not delete the account (${res.status})`);
      await onDeleted(account.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the account');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="delete-account-title">
      <div className="w-full max-w-md bg-gray-900 border border-red-900/60 rounded-xl p-5 space-y-3 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-red-950/60 text-red-400 shrink-0"><Trash2 className="w-5 h-5" /></div>
          <div className="space-y-1">
            <h3 id="delete-account-title" className="text-white font-semibold text-sm">Delete “{account.name}”?</h3>
            <p className="text-gray-400 text-xs leading-relaxed">
              CloudCraft will forget this {account.provider.toUpperCase()} account: its stored connection details are deleted and so is its discovery history.
              Terraform plans and applies that use it will stop working until you connect it again.
            </p>
            <p className="text-gray-500 text-xs leading-relaxed">Nothing in your cloud account is touched, and designs you already imported stay as they are.</p>
          </div>
        </div>
        {error && <p className="text-red-400 text-xs bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" autoFocus onClick={onClose} disabled={deleting} className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-300 bg-gray-800 hover:bg-gray-700 disabled:opacity-60">Cancel</button>
          <button type="button" onClick={confirm} disabled={deleting} className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white">
            {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Delete account
          </button>
        </div>
      </div>
    </div>
  );
}
