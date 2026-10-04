'use client';
/**
 * Cloud Accounts — the one place to connect, check and remove the AWS and Azure accounts CloudCraft works with.
 *
 *   AWS:   an IAM role (recommended; discovery and Terraform) or a read-only access key (discovery only)
 *   Azure: a service principal
 *
 * Each account shows whether it is connected and, if not, why in plain words and what to do; "Re-check" runs the connection test
 * again. Credentials are never shown here — they are write-only.
 */
import { useCallback, useEffect, useState } from 'react';
import { Cloud, RefreshCw, Trash2, Loader2, CheckCircle2, ShieldCheck, Plus } from 'lucide-react';
import clsx from 'clsx';
import ConnectAwsAccountForm from '@/components/accounts/ConnectAwsAccountForm';
import ConnectAzureAccountForm from '@/components/accounts/ConnectAzureAccountForm';
import DeleteAccountDialog from '@/components/accounts/DeleteAccountDialog';

interface Account {
  id: string;
  provider: string;
  name: string;
  status: string;
  identity: Record<string, unknown>;
  lastValidatedAt?: string | null;
}

const METHOD_LABEL: Record<string, string> = {
  'key-and-role': 'access key + IAM role',
  'access-key': 'access key only',
  role: 'IAM role (server identity)',
  'service-principal': 'service principal',
};

function ago(iso: string | null | undefined): string {
  if (!iso) return 'not checked yet';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'checked just now';
  if (s < 3600) return `checked ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `checked ${Math.round(s / 3600)} h ago`;
  return `checked ${Math.round(s / 86400)} d ago`;
}

function AccountRow({ account, checking, onRecheck, onDelete }: { account: Account; checking: boolean; onRecheck: () => void; onDelete: () => void }) {
  const id = account.identity ?? {};
  const method = typeof id.authMethod === 'string' ? id.authMethod : undefined;
  const who = typeof id.accountId === 'string' ? id.accountId : typeof id.subscriptionId === 'string' ? id.subscriptionId : '';
  const terraform = method !== 'access-key';
  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800/60 p-3.5" data-testid="account-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-white text-sm font-semibold truncate">{account.name}</p>
            <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded', account.provider === 'aws' ? 'bg-orange-900/50 text-orange-300' : 'bg-blue-900/50 text-blue-300')}>{account.provider.toUpperCase()}</span>
          </div>
          <p className="text-gray-500 text-xs">
            {who ? `${who} · ` : ''}{METHOD_LABEL[method ?? ''] ?? ''}{method ? ' · ' : ''}{ago(account.lastValidatedAt)}
          </p>
          <p className="flex items-center gap-1 text-[11px] text-gray-400">
            <ShieldCheck className="w-3 h-3" />
            {terraform ? 'Discovery and Terraform' : 'Discovery only — reconnect with an access key and an IAM role to run Terraform'}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className={clsx('text-xs px-2 py-0.5 rounded-full mr-1', account.status === 'active' ? 'bg-emerald-900 text-emerald-400' : account.status === 'invalid' ? 'bg-red-900 text-red-400' : 'bg-gray-700 text-gray-400')}>
            {account.status === 'active' ? 'connected' : account.status}
          </span>
          <button type="button" onClick={onRecheck} disabled={checking} title="Check the connection again" aria-label={`Re-check account ${account.name}`}
            className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-gray-400 hover:text-blue-300 hover:bg-blue-950/40 disabled:opacity-60 transition-colors">
            <RefreshCw className={clsx('w-3.5 h-3.5', checking && 'animate-spin')} />{checking ? 'Checking…' : 'Re-check'}
          </button>
          <button type="button" onClick={onDelete} title="Delete this account" aria-label={`Delete account ${account.name}`}
            className="p-2 rounded-md text-gray-500 hover:text-red-300 hover:bg-red-950/40 transition-colors">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
      {account.status === 'invalid' && (
        <div className="mt-2.5 text-xs leading-relaxed" data-testid="account-invalid-reason">
          <p className="text-red-300">{typeof id.validationReason === 'string' ? id.validationReason : 'The last connection check failed.'}</p>
          <p className="text-gray-400 mt-0.5">{typeof id.validationFix === 'string' ? id.validationFix : 'Click Re-check to see why.'}</p>
        </div>
      )}
      {account.status === 'pending' && <p className="mt-2.5 text-xs text-gray-500">Not checked yet. Click Re-check.</p>}
      {account.status === 'active' && <p className="mt-2.5 flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="w-3.5 h-3.5" /> CloudCraft can read this account.</p>}
    </div>
  );
}

export default function CloudAccountsPanel() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState<'aws' | 'azure'>('aws');
  const [showConnect, setShowConnect] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Account | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/cloud-accounts', { credentials: 'include' });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: Account[]; error?: { message?: string } };
      if (!res.ok || !data.ok || !data.data) throw new Error(data.error?.message ?? `Could not load accounts (${res.status})`);
      setAccounts(data.data);
      setLoadError(null);
      return data.data;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load accounts');
      return null;
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function recheck(account: Account) {
    setCheckingId(account.id);
    setActionError(null);
    try {
      const res = await fetch(`/api/cloud-accounts/${account.id}/validate`, { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(data.error?.message ?? `Could not check the account (${res.status})`);
      }
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not check the account');
    } finally {
      setCheckingId(null);
    }
  }

  const list = accounts ?? [];
  const showForm = showConnect || (accounts !== null && accounts.length === 0);

  return (
    <div className="flex-1 overflow-y-auto bg-gray-900 p-5">
      <div className="max-w-3xl mx-auto space-y-5">
        <div className="flex items-center justify-between gap-3 pb-4 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-950/60 border border-blue-500/30 text-blue-400"><Cloud className="w-5 h-5" /></div>
            <div>
              <h2 className="text-white font-bold text-lg">Cloud Accounts</h2>
              <p className="text-gray-400 text-xs mt-0.5">Connect the AWS and Azure accounts CloudCraft reads from and deploys to.</p>
            </div>
          </div>
          {!showForm && (
            <button type="button" onClick={() => setShowConnect(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white">
              <Plus className="w-3.5 h-3.5" /> Connect account
            </button>
          )}
        </div>

        {loadError && <p className="text-red-400 text-xs bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2">{loadError}</p>}
        {actionError && <p className="text-red-400 text-xs bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2">{actionError}</p>}

        {accounts === null && !loadError && <p className="flex items-center gap-2 text-gray-400 text-xs"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading your accounts…</p>}

        {list.length > 0 && (
          <section className="space-y-2.5" aria-label="Connected accounts">
            <p className="text-gray-400 text-xs font-medium uppercase tracking-wider">Connected accounts ({list.length})</p>
            {list.map((a) => (
              <AccountRow key={a.id} account={a} checking={checkingId === a.id} onRecheck={() => recheck(a)} onDelete={() => setToDelete(a)} />
            ))}
          </section>
        )}

        {accounts !== null && accounts.length === 0 && !showConnect && (
          <p className="text-gray-400 text-sm">No accounts yet. Connect an AWS or Azure account below to import real infrastructure and, with an IAM role or service principal, run Terraform.</p>
        )}

        {showForm && (
          <section className="rounded-xl border border-gray-700 bg-gray-800/40 p-4 space-y-4" aria-label="Connect an account">
            <div className="flex items-center justify-between gap-3">
              <p className="text-gray-300 text-sm font-semibold">Connect an account</p>
              {list.length > 0 && <button type="button" onClick={() => setShowConnect(false)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>}
            </div>
            <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Cloud provider">
              {(['aws', 'azure'] as const).map((p) => (
                <button key={p} type="button" role="tab" aria-selected={provider === p} onClick={() => setProvider(p)}
                  className={clsx('rounded-lg border px-3 py-2 text-sm font-semibold transition-colors',
                    provider === p ? (p === 'aws' ? 'border-orange-500 bg-orange-950/40 text-orange-200' : 'border-blue-500 bg-blue-950/40 text-blue-200') : 'border-gray-700 text-gray-400 hover:bg-gray-700/40')}>
                  {p === 'aws' ? 'Amazon Web Services' : 'Microsoft Azure'}
                </button>
              ))}
            </div>
            {provider === 'aws'
              ? <ConnectAwsAccountForm key="aws" onConnected={async () => { await load(); setShowConnect(false); }} />
              : <ConnectAzureAccountForm key="azure" onConnected={async () => { await load(); setShowConnect(false); }} />}
          </section>
        )}
      </div>

      {toDelete && (
        <DeleteAccountDialog
          account={toDelete}
          onClose={() => setToDelete(null)}
          onDeleted={async () => { setToDelete(null); await load(); }}
        />
      )}
    </div>
  );
}
