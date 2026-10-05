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
import { Cloud, RefreshCw, Trash2, Loader2, CheckCircle2, ShieldCheck, Plus, Pencil, Clock, KeyRound } from 'lucide-react';
import clsx from 'clsx';
import ConnectAwsAccountForm from '@/components/accounts/ConnectAwsAccountForm';
import ConnectAzureAccountForm from '@/components/accounts/ConnectAzureAccountForm';
import DeleteAccountDialog from '@/components/accounts/DeleteAccountDialog';
import EditAccountDialog from '@/components/accounts/EditAccountDialog';
import DeploymentPasswords from '@/components/accounts/DeploymentPasswords';
import TotpCard from '@/components/accounts/TotpCard';
import EncryptionKeyCard from '@/components/accounts/EncryptionKeyCard';
import CredentialLifetimeControls from '@/components/accounts/CredentialLifetimeControls';
import { describeLifetime } from '@/lib/cloud/credentialLifetime';

import { useApp } from '@/context/AppContext';

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
  'access-key-deploy': 'access key (can deploy)',
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

function AccountRow({ account, checking, isLight, onRecheck, onEdit, onDelete, onChanged }: { account: Account; checking: boolean; isLight: boolean; onRecheck: () => void; onEdit: () => void; onDelete: () => void; onChanged?: () => void | Promise<void> }) {
  const [showKeepTime, setShowKeepTime] = useState(false);
  const [showPasswords, setShowPasswords] = useState(false);
  const id = account.identity ?? {};
  const method = typeof id.authMethod === 'string' ? id.authMethod : undefined;
  const who = typeof id.accountId === 'string' ? id.accountId : typeof id.subscriptionId === 'string' ? id.subscriptionId : '';
  const terraform = method !== 'access-key';
  const lifetime = (id.lifetime ?? {}) as { expiresAt?: string; forgetAfterDeploy?: boolean; temporary?: boolean };
  const expired = account.status === 'expired';
  const timeText = lifetime.expiresAt ? describeLifetime(lifetime.expiresAt) : null;
  return (
    <div className={clsx("rounded-xl border p-3.5 transition-all", isLight ? "border-slate-200 bg-white shadow-sm" : "border-gray-700 bg-gray-800/60")} data-testid="account-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className={clsx("text-sm font-semibold truncate", isLight ? "text-slate-900" : "text-white")}>{account.name}</p>
            <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded', 
              account.provider === 'aws' 
                ? (isLight ? 'bg-orange-100 text-orange-800 border border-orange-200' : 'bg-orange-900/50 text-orange-300')
                : (isLight ? 'bg-blue-100 text-blue-800 border border-blue-200' : 'bg-blue-900/50 text-blue-300')
            )}>{account.provider.toUpperCase()}</span>
          </div>
          <p className={clsx("text-xs", isLight ? "text-slate-500" : "text-gray-500")}>
            {who ? `${who} · ` : ''}{METHOD_LABEL[method ?? ''] ?? ''}{method ? ' · ' : ''}{ago(account.lastValidatedAt)}
          </p>
          <p className={clsx("flex items-center gap-1 text-[11px]", isLight ? "text-slate-600" : "text-gray-400")}>
            <ShieldCheck className={clsx("w-3 h-3", isLight ? "text-slate-500" : "text-gray-400")} />
            {expired ? 'Credentials were erased from CloudCraft' : terraform ? 'Discovery and Terraform' : 'Discovery only — reconnect with an access key and an IAM role to run Terraform'}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className={clsx(
            'text-xs px-2 py-0.5 rounded-full mr-1 font-medium', 
            account.status === 'active' 
              ? (isLight ? 'bg-emerald-100 text-emerald-800' : 'bg-emerald-900 text-emerald-400')
              : account.status === 'invalid' 
                ? (isLight ? 'bg-rose-100 text-rose-800' : 'bg-red-900 text-red-400')
                : (isLight ? 'bg-slate-100 text-slate-600' : 'bg-gray-700 text-gray-400')
          )}>
            {account.status === 'active' ? 'connected' : account.status}
          </span>
          <button type="button" onClick={onRecheck} disabled={checking} title="Check the connection again" aria-label={`Re-check account ${account.name}`}
            className={clsx(
              "flex items-center gap-1 px-2 py-1.5 rounded-md text-xs disabled:opacity-60 transition-colors",
              isLight ? "text-slate-600 hover:text-blue-600 hover:bg-slate-100" : "text-gray-400 hover:text-blue-300 hover:bg-blue-950/40"
            )}>
            <RefreshCw className={clsx('w-3.5 h-3.5', checking && 'animate-spin')} />{checking ? 'Checking…' : 'Re-check'}
          </button>
          {account.status !== 'expired' && (
            <button type="button" onClick={() => setShowKeepTime((v) => !v)} aria-expanded={showKeepTime} title="How long CloudCraft keeps the key" aria-label={`Key time for account ${account.name}`}
              className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-gray-400 hover:text-amber-300 hover:bg-amber-950/30 transition-colors">
              <Clock className="w-3.5 h-3.5" />Key time
            </button>
          )}
          {account.provider === 'aws' && (
            <button type="button" onClick={() => setShowPasswords((v) => !v)} aria-expanded={showPasswords} title="Passwords CloudCraft generated for deployments" aria-label={`Deployment passwords for account ${account.name}`}
              className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-gray-400 hover:text-amber-300 hover:bg-amber-950/30 transition-colors">
              <KeyRound className="w-3.5 h-3.5" />Passwords
            </button>
          )}
          <button type="button" onClick={onEdit} title="Edit this account" aria-label={`Edit account ${account.name}`}
            className={clsx(
              "flex items-center gap-1 px-2 py-1.5 rounded-md text-xs transition-colors",
              isLight ? "text-slate-600 hover:text-blue-600 hover:bg-slate-100" : "text-gray-400 hover:text-blue-300 hover:bg-blue-950/40"
            )}>
            <Pencil className="w-3.5 h-3.5" />Edit
          </button>
          <button type="button" onClick={onDelete} title="Delete this account" aria-label={`Delete account ${account.name}`}
            className={clsx(
              "p-2 rounded-md transition-colors",
              isLight ? "text-slate-400 hover:text-rose-600 hover:bg-rose-50" : "text-gray-500 hover:text-red-300 hover:bg-red-950/40"
            )}>
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
      {(timeText || lifetime.forgetAfterDeploy || lifetime.temporary) && !expired && (
        <p className="mt-2 text-[11px] text-amber-300/90" data-testid="account-lifetime">
          {lifetime.temporary ? 'Temporary credentials' : 'Key kept for a limited time'}{timeText ? ` · ${timeText}` : ''}{lifetime.forgetAfterDeploy ? ' · deleted after a successful deployment' : ''}
        </p>
      )}
      {expired && (
        <p className="mt-2.5 text-xs text-amber-300 leading-relaxed" data-testid="account-expired">
          {timeText === 'expired'
            ? 'The time limit passed, so CloudCraft deleted the key. Click Edit and enter a new key to use it again.'
            : 'CloudCraft deleted the key after your last successful deployment, as you asked. Click Edit and enter a key to deploy again.'}
        </p>
      )}
      {showKeepTime && account.status !== 'expired' && (
        <CredentialLifetimeControls accountId={account.id} forgetAfterDeploy={lifetime.forgetAfterDeploy === true} temporary={lifetime.temporary === true} onChanged={onChanged ?? (() => undefined)} />
      )}
      {showPasswords && <DeploymentPasswords accountId={account.id} />}
      {account.status === 'invalid' && (
        <div className={clsx("mt-2.5 text-xs leading-relaxed p-2.5 rounded-lg", isLight ? "bg-rose-50 text-rose-800" : "text-red-300")} data-testid="account-invalid-reason">
          <p className={isLight ? "text-rose-800 font-medium" : "text-red-300"}>{typeof id.validationReason === 'string' ? id.validationReason : 'The last connection check failed.'}</p>
          <p className={clsx("mt-0.5", isLight ? "text-rose-600" : "text-gray-400")}>{typeof id.validationFix === 'string' ? id.validationFix : 'Click Re-check to see why.'}</p>
        </div>
      )}
      {account.status === 'pending' && <p className={clsx("mt-2.5 text-xs", isLight ? "text-slate-500" : "text-gray-500")}>Not checked yet. Click Re-check.</p>}
      {account.status === 'active' && <p className={clsx("mt-2.5 flex items-center gap-1 text-xs font-medium", isLight ? "text-emerald-700" : "text-emerald-400")}><CheckCircle2 className="w-3.5 h-3.5" /> CloudCraft can read this account.</p>}
    </div>
  );
}

export default function CloudAccountsPanel() {
  const { state } = useApp();
  const isLight = state.theme === 'light';

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState<'aws' | 'azure'>('aws');
  const [showConnect, setShowConnect] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Account | null>(null);
  const [toEdit, setToEdit] = useState<Account | null>(null);
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
    <div className={clsx("flex-1 overflow-y-auto px-4 sm:px-6 py-6 pb-36 custom-scrollbar", isLight ? "bg-slate-50 text-slate-900" : "bg-gray-950 text-slate-100")}>
      <div className="max-w-3xl mx-auto space-y-5">
        <div className={clsx("flex items-center justify-between gap-3 pb-4 border-b", isLight ? "border-slate-200" : "border-gray-800")}>
          <div className="flex items-center gap-3">
            <div className={clsx(
              "p-2.5 rounded-xl border",
              isLight ? "bg-blue-50 border-blue-200 text-blue-600" : "bg-blue-950/60 border-blue-500/30 text-blue-400"
            )}>
              <Cloud className="w-5 h-5" />
            </div>
            <div>
              <h2 className={clsx("font-bold text-lg", isLight ? "text-slate-900" : "text-white")}>Cloud Accounts</h2>
              <p className={clsx("text-xs mt-0.5", isLight ? "text-slate-500" : "text-gray-400")}>Connect the AWS and Azure accounts CloudCraft reads from and deploys to.</p>
            </div>
          </div>
          {!showForm && (
            <button type="button" onClick={() => setShowConnect(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-sm">
              <Plus className="w-3.5 h-3.5" /> Connect account
            </button>
          )}
        </div>

        {loadError && <p className={clsx("text-xs border rounded-lg px-3 py-2", isLight ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-red-950/40 border-red-900/50 text-red-400")}>{loadError}</p>}
        {actionError && <p className={clsx("text-xs border rounded-lg px-3 py-2", isLight ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-red-950/40 border-red-900/50 text-red-400")}>{actionError}</p>}

        {accounts === null && !loadError && <p className={clsx("flex items-center gap-2 text-xs", isLight ? "text-slate-500" : "text-gray-400")}><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading your accounts…</p>}

        {list.length > 0 && (
          <section className="space-y-2.5" aria-label="Connected accounts">
            <p className={clsx("text-xs font-semibold uppercase tracking-wider", isLight ? "text-slate-500" : "text-gray-400")}>Connected accounts ({list.length})</p>
            {list.map((a) => (
              <AccountRow key={a.id} account={a} checking={checkingId === a.id} isLight={isLight} onRecheck={() => recheck(a)} onEdit={() => setToEdit(a)} onDelete={() => setToDelete(a)} onChanged={async () => { await load(); }} />
            ))}
          </section>
        )}

        {accounts !== null && accounts.length === 0 && !showConnect && (
          <p className={clsx("text-sm", isLight ? "text-slate-600" : "text-gray-400")}>No accounts yet. Connect an AWS or Azure account below to import real infrastructure and, with an IAM role or service principal, run Terraform.</p>
        )}

        {showForm && (
          <section className={clsx("rounded-xl border p-4 space-y-4", isLight ? "border-slate-200 bg-white shadow-sm" : "border-gray-700 bg-gray-800/40")} aria-label="Connect an account">
            <div className="flex items-center justify-between gap-3">
              <p className={clsx("text-sm font-semibold", isLight ? "text-slate-900" : "text-gray-300")}>Connect an account</p>
              {list.length > 0 && <button type="button" onClick={() => setShowConnect(false)} className={clsx("text-xs", isLight ? "text-slate-500 hover:text-slate-800" : "text-gray-500 hover:text-gray-300")}>Cancel</button>}
            </div>
            <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Cloud provider">
              {(['aws', 'azure'] as const).map((p) => (
                <button key={p} type="button" role="tab" aria-selected={provider === p} onClick={() => setProvider(p)}
                  className={clsx('rounded-lg border px-3 py-2 text-sm font-semibold transition-colors',
                    provider === p 
                      ? (p === 'aws' 
                          ? (isLight ? 'border-orange-500 bg-orange-50 text-orange-800' : 'border-orange-500 bg-orange-950/40 text-orange-200')
                          : (isLight ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-blue-500 bg-blue-950/40 text-blue-200')
                        ) 
                      : (isLight ? 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100' : 'border-gray-700 text-gray-400 hover:bg-gray-700/40')
                  )}>
                  {p === 'aws' ? 'Amazon Web Services' : 'Microsoft Azure'}
                </button>
              ))}
            </div>
            {provider === 'aws'
              ? <ConnectAwsAccountForm key="aws" onConnected={async () => { await load(); setShowConnect(false); }} />
              : <ConnectAzureAccountForm key="azure" onConnected={async () => { await load(); setShowConnect(false); }} />}
          </section>
        )}

        <TotpCard />
        <EncryptionKeyCard />
      </div>

      {toEdit && (
        <EditAccountDialog
          key={toEdit.id}
          account={toEdit}
          onClose={() => setToEdit(null)}
          onSaved={async () => { setToEdit(null); await load(); }}
        />
      )}

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
