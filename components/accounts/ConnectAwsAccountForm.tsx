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
import { LIFETIME_CHOICES, TEMPORARY_HOURS } from '@/lib/cloud/credentialLifetime';
import { useApp } from '@/context/AppContext';

const REGIONS = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-northeast-1'];

export default function ConnectAwsAccountForm({ onConnected, initialMode = 'direct' }: { onConnected: (accountId: string) => void | Promise<void>; initialMode?: 'direct' | 'role' }) {
  const { state } = useApp();
  const isLight = state.theme === 'light';

  const inputClass = `w-full rounded-lg px-3 py-2 text-sm focus:outline-none transition-colors ${
    isLight
      ? 'bg-slate-50 border border-slate-300 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:bg-white'
      : 'bg-gray-700 border border-gray-600 text-white placeholder-gray-500 focus:border-blue-500'
  }`;

  const [form, setForm] = useState({ accessKeyId: '', secretAccessKey: '', roleArn: '', externalId: '', sessionToken: '', region: 'us-east-1' });
  // How long CloudCraft may keep the key (a stored key is a standing risk, so the default is short), and whether to erase it after a deployment.
  const [keepFor, setKeepFor] = useState<string>('8h');
  const [forgetAfterDeploy, setForgetAfterDeploy] = useState(false);
  const [validHours, setValidHours] = useState<number>(12);   // temporary (ASIA) credentials: how long they are still valid
  const [name, setName] = useState('');
  // 'direct': the IAM user's own key does everything (simple; for test accounts). 'role': the key only assumes a role (safer).
  const [mode, setMode] = useState<'direct' | 'role'>(initialMode);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    const f = { ...form, accessKeyId: form.accessKeyId.trim(), secretAccessKey: form.secretAccessKey.trim(), roleArn: form.roleArn.trim(), externalId: form.externalId.trim(), sessionToken: form.sessionToken.trim() };
    const temporary = f.accessKeyId.startsWith('ASIA');
    const problem = checkAwsConnectInput(f, { needsRole: mode === 'role', allowTemporary: mode === 'direct' });
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
          lifetime: {
            hours: temporary ? validHours : (LIFETIME_CHOICES.find((c) => c.id === keepFor)?.hours ?? null),
            ...(forgetAfterDeploy ? { forgetAfterDeploy: true } : {}),
          },
          provider: 'aws',
          name: name.trim() || `AWS (${f.region})`,
          credentials: mode === 'direct'
            ? { accessKeyId: f.accessKeyId, secretAccessKey: f.secretAccessKey, region: f.region, allowDeploy: true, ...(temporary ? { sessionToken: f.sessionToken } : {}) }
            : {
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
      setForm((v) => ({ ...v, accessKeyId: '', secretAccessKey: '', sessionToken: '' }));
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
      <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="How to connect">
        {([['direct', 'Simple', 'Use my IAM user\'s access key directly'], ['role', 'Safer', 'Access key + IAM role (temporary access)']] as const).map(([m, title, sub]) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setError(null); }}
            className={`text-left rounded-lg border px-3 py-2 text-xs transition-colors ${
              mode === m
                ? isLight
                  ? 'border-amber-500 bg-amber-50 text-amber-950 font-semibold shadow-sm'
                  : 'border-orange-500 bg-orange-950/30 text-white'
                : isLight
                  ? 'border-slate-200 bg-slate-100/80 text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
                  : 'border-gray-700 bg-gray-800/60 text-gray-400 hover:text-gray-200'
            }`}>
            <span className="block font-semibold">{title}</span><span className="block text-[11px] opacity-80">{sub}</span>
          </button>
        ))}
      </div>

      {mode === 'direct' ? (
        <div className={`p-3 rounded-lg border text-xs space-y-2 ${isLight ? 'bg-amber-50/70 border-amber-200 text-amber-900' : 'bg-amber-950/20 border-amber-700/40'}`} data-testid="direct-key-guide">
          <p className={`${isLight ? 'text-amber-900' : 'text-amber-200'} font-medium`}>Three steps in the AWS console, nothing to write:</p>
          <ol className={`${isLight ? 'text-slate-700' : 'text-gray-300'} leading-relaxed list-decimal pl-5 space-y-0.5`}>
            <li><strong>IAM → Users → your user</strong> (or create one) → <strong>Add permissions → Attach policies directly</strong> → tick <strong>AdministratorAccess</strong>.</li>
            <li>On that user: <strong>Security credentials → Create access key</strong> → &ldquo;Application running outside AWS&rdquo;.</li>
            <li>Paste the Access key ID and the Secret access key below.</li>
          </ol>
          <p className={`${isLight ? 'text-amber-800' : 'text-amber-200/90'} leading-relaxed`}>
            CloudCraft will then be able to create and delete anything in this AWS account, using that key. It is stored encrypted and never shown again.
            Use this for a <strong>test or sandbox account</strong>, never with the account&apos;s root key, and delete the key in AWS when you are finished.
            For a real account use <strong>Safer</strong>.
          </p>
        </div>
      ) : (
        <AwsKeyRoleGuide roleArn={form.roleArn} externalId={form.externalId} onExternalId={(value) => setForm((v) => ({ ...v, externalId: value }))} />
      )}

      <input type="text" placeholder="Account name (optional)" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      <input type="text" placeholder="Access key ID (AKIA…)" value={form.accessKeyId} onChange={(e) => setForm((v) => ({ ...v, accessKeyId: e.target.value }))} autoComplete="off" spellCheck={false} className={`${inputClass} font-mono`} />
      <input type="password" placeholder="Secret access key (shown once by AWS; never shown again here)" value={form.secretAccessKey} onChange={(e) => setForm((v) => ({ ...v, secretAccessKey: e.target.value }))} autoComplete="new-password" spellCheck={false} className={`${inputClass} font-mono`} />
      {mode === 'direct' && form.accessKeyId.trim().startsWith('ASIA') && (
        <input type="password" placeholder="Session token (AWS_SESSION_TOKEN — for temporary credentials)" value={form.sessionToken} onChange={(e) => setForm((v) => ({ ...v, sessionToken: e.target.value }))} autoComplete="new-password" spellCheck={false} className={`${inputClass} font-mono`} data-testid="session-token" />
      )}
      {mode === 'role' && (
        <>
          <input type="text" placeholder="Role ARN (arn:aws:iam::123456789012:role/CloudCraftRole)" value={form.roleArn} onChange={(e) => setForm((v) => ({ ...v, roleArn: e.target.value }))} autoComplete="off" spellCheck={false} className={inputClass} />
          <input type="text" placeholder="External ID (optional — only if the role requires one)" value={form.externalId} onChange={(e) => setForm((v) => ({ ...v, externalId: e.target.value }))} autoComplete="off" spellCheck={false} className={inputClass} />
        </>
      )}
      <select value={form.region} onChange={(e) => setForm((v) => ({ ...v, region: e.target.value }))} aria-label="Region" className={inputClass}>
        {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>

      <div className={`rounded-lg border px-3 py-2 space-y-2 text-xs ${isLight ? 'bg-slate-50 border-slate-200 text-slate-700' : 'border-gray-700 bg-gray-800/50 text-gray-300'}`} data-testid="credential-lifetime">
        {mode === 'direct' && form.accessKeyId.trim().startsWith('ASIA') ? (
          <label className="flex items-center justify-between gap-3">
            <span>These temporary credentials are valid for another</span>
            <select value={validHours} onChange={(e) => setValidHours(Number(e.target.value))} aria-label="Temporary credentials valid for" className={isLight ? 'bg-white border border-slate-300 rounded px-2 py-1 text-slate-900' : 'bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white'}>
              {TEMPORARY_HOURS.map((h) => <option key={h} value={h}>{h} hour{h === 1 ? '' : 's'}</option>)}
            </select>
          </label>
        ) : (
          <label className="flex items-center justify-between gap-3">
            <span>Keep this key in CloudCraft for</span>
            <select value={keepFor} onChange={(e) => setKeepFor(e.target.value)} aria-label="Keep the key for" className={isLight ? 'bg-white border border-slate-300 rounded px-2 py-1 text-slate-900' : 'bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white'}>
              {LIFETIME_CHOICES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
        )}
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={forgetAfterDeploy} onChange={(e) => setForgetAfterDeploy(e.target.checked)} className="mt-0.5" />
          <span>Delete the key from CloudCraft after a deployment succeeds</span>
        </label>
        <p className={`leading-relaxed ${isLight ? 'text-slate-500' : 'text-gray-500'}`}>When the time is up CloudCraft erases the secret and you connect again. Also delete the key in AWS when you no longer need it.</p>
      </div>

      {error && <p className={`text-xs border rounded-lg px-3 py-2 ${isLight ? 'text-rose-700 bg-rose-50 border-rose-200' : 'text-red-400 bg-red-950/40 border-red-900/50'}`} role="alert">{error}</p>}

      <button type="button" onClick={connect} disabled={connecting} className="w-full py-2.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2 shadow-md">
        {connecting ? <><Loader2 className="w-4 h-4 animate-spin" /> Connecting…</> : 'Connect AWS Account'}
      </button>
    </div>
  );
}
