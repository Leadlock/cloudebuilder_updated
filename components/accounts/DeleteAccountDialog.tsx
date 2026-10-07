'use client';
/** Confirmation before deleting a connected cloud account (its stored credentials and discovery history go with it). */
import { useState } from 'react';
import { useEscapeKey } from '@/lib/ui/useEscapeKey';
import { Trash2, Loader2 } from 'lucide-react';
import { useApp } from '@/context/AppContext';

export default function DeleteAccountDialog({ account, onClose, onDeleted }: {
  account: { id: string; name: string; provider: string };
  onClose: () => void;
  onDeleted: (accountId: string) => void | Promise<void>;
}) {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const [deleting, setDeleting] = useState(false);
  useEscapeKey(deleting ? undefined : onClose); // not while the deletion is running
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
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${isLight ? 'bg-slate-900/40' : 'bg-black/70'} backdrop-blur-sm p-4`} role="dialog" aria-modal="true" aria-labelledby="delete-account-title">
      <div className={`w-full max-w-md ${isLight ? 'bg-white border-rose-200 shadow-2xl shadow-rose-900/10' : 'bg-gray-900 border-red-900/60 shadow-2xl'} border rounded-2xl p-5 space-y-4 animate-in zoom-in-95 duration-150`}>
        <div className="flex items-start gap-3">
          <div className={`p-2.5 rounded-xl ${isLight ? 'bg-rose-50 text-rose-600 border border-rose-200' : 'bg-red-950/60 text-red-400'} shrink-0`}><Trash2 className="w-5 h-5" /></div>
          <div className="space-y-1">
            <h3 id="delete-account-title" className={`${isLight ? 'text-slate-900' : 'text-white'} font-semibold text-sm`}>Delete “{account.name}”?</h3>
            <p className={`${isLight ? 'text-slate-600' : 'text-gray-400'} text-xs leading-relaxed`}>
              CloudCraft will forget this {account.provider.toUpperCase()} account: its stored connection details are deleted and so is its discovery history.
              Terraform plans and applies that use it will stop working until you connect it again.
            </p>
            <p className={`${isLight ? 'text-slate-400' : 'text-gray-500'} text-xs leading-relaxed`}>Nothing in your cloud account is touched, and designs you already imported stay as they are.</p>
          </div>
        </div>
        {error && <p className={`text-xs border rounded-lg px-3 py-2 ${isLight ? 'text-rose-700 bg-rose-50 border-rose-200' : 'text-red-400 bg-red-950/40 border-red-900/50'}`}>{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" autoFocus onClick={onClose} disabled={deleting} className={`px-3 py-1.5 rounded-xl text-xs font-medium ${isLight ? 'text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200' : 'text-gray-300 bg-gray-800 hover:bg-gray-700'} disabled:opacity-60 transition-colors`}>Cancel</button>
          <button type="button" onClick={confirm} disabled={deleting} className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-semibold bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white shadow-md shadow-red-600/20 transition-all">
            {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Delete account
          </button>
        </div>
      </div>
    </div>
  );
}
