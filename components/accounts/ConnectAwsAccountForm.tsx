'use client';
/**
 * Connect an AWS account: with an IAM role (recommended; can also run Terraform) or a read-only access key (quick; discovery only).
 * Used by the Cloud Accounts tab and by the Import screen, so both behave identically.
 *
 * Secrets go straight to the server and are cleared from the form as soon as they have been sent — they are never kept in React
 * state beyond typing, never shown again, and never stored in the browser.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import clsx from 'clsx';
import AwsConnectGuide from '@/components/panels/AwsConnectGuide';
import AwsAccessKeyGuide from '@/components/panels/AwsAccessKeyGuide';

const REGIONS = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-northeast-1'];
const INPUT = 'w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500';

export default function ConnectAwsAccountForm({ onConnected }: { onConnected: (accountId: string) => void | Promise<void> }) {
  const [method, setMethod] = useState<'role' | 'access-key'>('role');
  const [role, setRole] = useState({ roleArn: '', externalId: '', region: 'us-east-1' });
  const [keys, setKeys] = useState({ accessKeyId: '', secretAccessKey: '' });
  const [name, setName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    const useKey = method === 'access-key';
    if (useKey ? (!keys.accessKeyId.trim() || !keys.secretAccessKey.trim()) : (!role.roleArn.trim() || !role.externalId.trim())) {
      setError(useKey ? 'Access key ID and Secret access key are required' : 'Role ARN and External ID are required');
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch('/api/cloud-accounts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'aws',
          name: name.trim() || `AWS (${role.region})`,
          credentials: useKey
            ? { accessKeyId: keys.accessKeyId.trim(), secretAccessKey: keys.secretAccessKey.trim(), region: role.region }
            : { roleArn: role.roleArn.trim(), externalId: role.externalId.trim(), region: role.region },
        }),
      });
      // The secret is cleared as soon as it has been sent.
      if (useKey) setKeys({ accessKeyId: '', secretAccessKey: '' });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { id: string }; error?: { message?: string } };
      if (!res.ok || !data.ok || !data.data) {
        setError(data.error?.message ?? 'Failed to connect the account');
        return;
      }
      // Check the connection right away, so the list shows the result (connected, or why not).
      await fetch(`/api/cloud-accounts/${data.data.id}/validate`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
      setRole({ roleArn: '', externalId: '', region: role.region });
      setName('');
      await onConnected(data.data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="connect-aws-form">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="How to connect">
        {([
          ['role', 'IAM role', 'Recommended. Also lets CloudCraft run Terraform.'],
          ['access-key', 'Access key', 'Quick, read-only. Discovery only.'],
        ] as const).map(([value, title, hint]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={method === value}
            onClick={() => setMethod(value)}
            className={clsx('text-left rounded-lg border px-3 py-2 transition-colors', method === value ? 'border-blue-500 bg-blue-900/20' : 'border-gray-700 hover:bg-gray-700/40')}
          >
            <p className="text-white text-xs font-semibold">{title}</p>
            <p className="text-gray-400 text-[11px] leading-snug">{hint}</p>
          </button>
        ))}
      </div>

      {method === 'role' ? (
        <>
          <div className="bg-blue-900/20 border border-blue-800 rounded-lg p-3 text-xs text-blue-300">
            <p className="font-medium mb-1">IAM cross-account role (recommended)</p>
            <p className="text-blue-400">Create an IAM role in your AWS account with <strong>ReadOnlyAccess</strong> and add CloudCraft as a trusted principal. Credentials are stored server-side only.</p>
          </div>
          <AwsConnectGuide externalId={role.externalId} roleArn={role.roleArn} onExternalId={(value) => setRole((f) => ({ ...f, externalId: value }))} />
        </>
      ) : (
        <AwsAccessKeyGuide />
      )}

      <input type="text" placeholder="Account name (optional)" value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />

      {method === 'role' ? (
        <>
          <input type="text" placeholder="Role ARN (arn:aws:iam::123456789012:role/CloudCraftReadOnly)" value={role.roleArn} onChange={(e) => setRole((f) => ({ ...f, roleArn: e.target.value }))} className={INPUT} />
          <input type="text" placeholder="External ID (shared secret)" value={role.externalId} onChange={(e) => setRole((f) => ({ ...f, externalId: e.target.value }))} className={INPUT} />
        </>
      ) : (
        <>
          <input type="text" placeholder="Access key ID (AKIA…)" value={keys.accessKeyId} onChange={(e) => setKeys((f) => ({ ...f, accessKeyId: e.target.value }))} autoComplete="off" spellCheck={false} className={`${INPUT} font-mono`} />
          <input type="password" placeholder="Secret access key (shown once by AWS; never shown again here)" value={keys.secretAccessKey} onChange={(e) => setKeys((f) => ({ ...f, secretAccessKey: e.target.value }))} autoComplete="new-password" spellCheck={false} className={`${INPUT} font-mono`} />
        </>
      )}

      <select value={role.region} onChange={(e) => setRole((f) => ({ ...f, region: e.target.value }))} aria-label="Region" className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
        {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>

      {error && <p className="text-red-400 text-xs bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2" role="alert">{error}</p>}

      <button type="button" onClick={connect} disabled={connecting} className="w-full py-2.5 bg-orange-700 hover:bg-orange-600 disabled:opacity-40 text-white rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2">
        {connecting ? <><Loader2 className="w-4 h-4 animate-spin" /> Connecting…</> : 'Connect AWS Account'}
      </button>
    </div>
  );
}
