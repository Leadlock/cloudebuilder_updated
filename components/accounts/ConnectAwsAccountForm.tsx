'use client';
/**
 * Connect an AWS account the way it is done in the user's own account: their access key signs in and assumes their role.
 * No AWS account or identity of CloudCraft's is involved. Used by the Cloud Accounts tab and by the Import screen.
 *
 * Secrets go straight to the server and are cleared from the form as soon as they have been sent — they are never kept in React
 * state beyond typing, never shown again, and never stored in the browser.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import AwsKeyRoleGuide from '@/components/panels/AwsKeyRoleGuide';
import { checkAwsConnectInput } from '@/lib/cloud/awsConnectInput';

const REGIONS = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-northeast-1'];
const INPUT = 'w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500';

export default function ConnectAwsAccountForm({ onConnected }: { onConnected: (accountId: string) => void | Promise<void> }) {
  const [form, setForm] = useState({ accessKeyId: '', secretAccessKey: '', roleArn: '', externalId: '', region: 'us-east-1' });
  const [name, setName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    const f = { ...form, accessKeyId: form.accessKeyId.trim(), secretAccessKey: form.secretAccessKey.trim(), roleArn: form.roleArn.trim(), externalId: form.externalId.trim() };
    const problem = checkAwsConnectInput(f);
    if (problem) {
      setError(problem);          // nothing is sent, and nothing the person typed is cleared
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
          name: name.trim() || `AWS (${f.region})`,
          credentials: {
            accessKeyId: f.accessKeyId, secretAccessKey: f.secretAccessKey, roleArn: f.roleArn, region: f.region,
            ...(f.externalId ? { externalId: f.externalId } : {}),
          },
        }),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; data?: { id: string }; error?: { message?: string } };
      if (!res.ok || !data.ok || !data.data) {
        // Not saved: keep what was typed (so a typo costs one correction, not retyping the secret) and say what the server said.
        setError(data.error?.message ?? 'Failed to connect the account');
        return;
      }
      // Saved: the secret is cleared now and never shown again.
      setForm((v) => ({ ...v, accessKeyId: '', secretAccessKey: '' }));
      // Check the connection right away, so the list shows the result (connected, or why not).
      await fetch(`/api/cloud-accounts/${data.data.id}/validate`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
      setForm((v) => ({ ...v, roleArn: '', externalId: '' }));
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
      <AwsKeyRoleGuide roleArn={form.roleArn} externalId={form.externalId} onExternalId={(value) => setForm((v) => ({ ...v, externalId: value }))} />

      <input type="text" placeholder="Account name (optional)" value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
      <input type="text" placeholder="Access key ID (AKIA…)" value={form.accessKeyId} onChange={(e) => setForm((v) => ({ ...v, accessKeyId: e.target.value }))} autoComplete="off" spellCheck={false} className={`${INPUT} font-mono`} />
      <input type="password" placeholder="Secret access key (shown once by AWS; never shown again here)" value={form.secretAccessKey} onChange={(e) => setForm((v) => ({ ...v, secretAccessKey: e.target.value }))} autoComplete="new-password" spellCheck={false} className={`${INPUT} font-mono`} />
      <input type="text" placeholder="Role ARN (arn:aws:iam::123456789012:role/CloudCraftRole)" value={form.roleArn} onChange={(e) => setForm((v) => ({ ...v, roleArn: e.target.value }))} autoComplete="off" spellCheck={false} className={INPUT} />
      <input type="text" placeholder="External ID (optional — only if the role requires one)" value={form.externalId} onChange={(e) => setForm((v) => ({ ...v, externalId: e.target.value }))} autoComplete="off" spellCheck={false} className={INPUT} />
      <select value={form.region} onChange={(e) => setForm((v) => ({ ...v, region: e.target.value }))} aria-label="Region" className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
        {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>

      {error && <p className="text-red-400 text-xs bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2" role="alert">{error}</p>}

      <button type="button" onClick={connect} disabled={connecting} className="w-full py-2.5 bg-orange-700 hover:bg-orange-600 disabled:opacity-40 text-white rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2">
        {connecting ? <><Loader2 className="w-4 h-4 animate-spin" /> Connecting…</> : 'Connect AWS Account'}
      </button>
    </div>
  );
}
