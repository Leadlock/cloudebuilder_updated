'use client';
/**
 * Connect an Azure account with a service principal (a Reader role on the subscription is enough for discovery).
 * Used by the Cloud Accounts tab and by the Import screen. The client secret goes straight to the server and is cleared from the
 * form as soon as it has been sent.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';

const INPUT = 'w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500';
const EMPTY = { tenantId: '', clientId: '', clientSecret: '', subscriptionId: '' };

export default function ConnectAzureAccountForm({ onConnected }: { onConnected: (accountId: string) => void | Promise<void> }) {
  const [form, setForm] = useState(EMPTY);
  const [name, setName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    const f = { tenantId: form.tenantId.trim(), clientId: form.clientId.trim(), clientSecret: form.clientSecret.trim(), subscriptionId: form.subscriptionId.trim() };
    if (!f.tenantId || !f.clientId || !f.clientSecret || !f.subscriptionId) {
      setError('All Azure fields are required');
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch('/api/cloud-accounts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'azure', name: name.trim() || `Azure (${f.subscriptionId.slice(0, 8)}…)`, credentials: f }),
      });
      setForm(EMPTY);     // the secret is cleared as soon as it has been sent
      const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { id: string }; error?: { message?: string } };
      if (!res.ok || !data.ok || !data.data) {
        setError(data.error?.message ?? 'Failed to connect the account');
        return;
      }
      await fetch(`/api/cloud-accounts/${data.data.id}/validate`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
      setName('');
      await onConnected(data.data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="connect-azure-form">
      <div className="bg-blue-900/20 border border-blue-800 rounded-lg p-3 text-xs text-blue-300">
        <p className="font-medium mb-1">Azure service principal</p>
        <p className="text-blue-400">Create an app registration in Microsoft Entra ID, add a client secret, and give it the <strong>Reader</strong> role on your subscription. Credentials are stored server-side only.</p>
      </div>
      <input type="text" placeholder="Account name (optional)" value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
      <input type="text" placeholder="Tenant ID" value={form.tenantId} onChange={(e) => setForm((v) => ({ ...v, tenantId: e.target.value }))} autoComplete="off" spellCheck={false} className={INPUT} />
      <input type="text" placeholder="Client ID (Application ID)" value={form.clientId} onChange={(e) => setForm((v) => ({ ...v, clientId: e.target.value }))} autoComplete="off" spellCheck={false} className={INPUT} />
      <input type="password" placeholder="Client Secret (the secret's Value, not its ID)" value={form.clientSecret} onChange={(e) => setForm((v) => ({ ...v, clientSecret: e.target.value }))} autoComplete="new-password" spellCheck={false} className={INPUT} />
      <input type="text" placeholder="Subscription ID" value={form.subscriptionId} onChange={(e) => setForm((v) => ({ ...v, subscriptionId: e.target.value }))} autoComplete="off" spellCheck={false} className={INPUT} />

      {error && <p className="text-red-400 text-xs bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2" role="alert">{error}</p>}

      <button type="button" onClick={connect} disabled={connecting} className="w-full py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2">
        {connecting ? <><Loader2 className="w-4 h-4 animate-spin" /> Connecting…</> : 'Connect Azure Account'}
      </button>
    </div>
  );
}
