'use client';
/**
 * Edit a connected account: its name and how it is connected. Secrets are write-only — the current key and secret are never shown;
 * leave a secret field empty to keep the current one, type a new one to replace it. Only what was changed is sent. After saving,
 * the connection is checked again straight away.
 */
import { useState } from 'react';
import { Pencil, Loader2 } from 'lucide-react';
import { checkAwsConnectInput } from '@/lib/cloud/awsConnectInput';
import type { ConnectionHint } from '@/lib/cloud/connectionHint';

const REGIONS = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-northeast-1'];
const INPUT = 'w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500';
// Valid-looking stand-ins for fields left blank, so only what was typed is checked.
const ID_STANDIN = 'AKIAXXXXXXXXXXXXXXXX';
const SECRET_STANDIN = 'x'.repeat(40);
const ROLE_STANDIN = 'arn:aws:iam::123456789012:role/standin';

interface EditableAccount { id: string; name: string; provider: string; identity?: Record<string, unknown> }

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs text-gray-300 font-medium">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-gray-500 leading-snug">{hint}</span>}
    </label>
  );
}

export default function EditAccountDialog({ account, onClose, onSaved }: { account: EditableAccount; onClose: () => void; onSaved: (accountId: string) => void | Promise<void> }) {
  const hint = ((account.identity?.connection ?? {}) as ConnectionHint);
  const isAws = account.provider === 'aws';
  const [name, setName] = useState(account.name);
  const [aws, setAws] = useState({ accessKeyId: '', secretAccessKey: '', roleArn: hint.roleArn ?? '', externalId: '', region: hint.region ?? 'us-east-1' });
  const [removeExternalId, setRemoveExternalId] = useState(false);
  const [azure, setAzure] = useState({ tenantId: hint.tenantId ?? '', clientId: hint.clientId ?? '', clientSecret: '', subscriptionId: hint.subscriptionId ?? '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Only what changed: a typed value, a changed field. Empty secrets are left out, which keeps the current ones. */
  function changes(): Record<string, string> {
    const out: Record<string, string> = {};
    if (isAws) {
      if (aws.accessKeyId.trim()) out['accessKeyId'] = aws.accessKeyId.trim();
      if (aws.secretAccessKey.trim()) out['secretAccessKey'] = aws.secretAccessKey.trim();
      if (aws.roleArn.trim() && aws.roleArn.trim() !== (hint.roleArn ?? '')) out['roleArn'] = aws.roleArn.trim();
      if (aws.externalId.trim()) out['externalId'] = aws.externalId.trim();
      else if (removeExternalId) out['externalId'] = '';
      if (aws.region !== (hint.region ?? 'us-east-1')) out['region'] = aws.region;
    } else {
      if (azure.tenantId.trim() && azure.tenantId.trim() !== (hint.tenantId ?? '')) out['tenantId'] = azure.tenantId.trim();
      if (azure.clientId.trim() && azure.clientId.trim() !== (hint.clientId ?? '')) out['clientId'] = azure.clientId.trim();
      if (azure.clientSecret.trim()) out['clientSecret'] = azure.clientSecret.trim();
      if (azure.subscriptionId.trim() && azure.subscriptionId.trim() !== (hint.subscriptionId ?? '')) out['subscriptionId'] = azure.subscriptionId.trim();
    }
    return out;
  }

  async function save() {
    const credentials = changes();
    const nameChanged = name.trim() !== account.name && name.trim() !== '';
    if (!nameChanged && Object.keys(credentials).length === 0) { setError('Nothing has changed yet.'); return; }

    if (isAws && Object.keys(credentials).length) {
      const problem = checkAwsConnectInput({
        accessKeyId: credentials['accessKeyId'] ?? ID_STANDIN,
        secretAccessKey: credentials['secretAccessKey'] ?? SECRET_STANDIN,
        roleArn: credentials['roleArn'] ?? (hint.roleArn || ROLE_STANDIN),
        externalId: credentials['externalId'] ?? '',
      });
      if (problem) { setError(problem); return; }
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/cloud-accounts/${account.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(nameChanged ? { name: name.trim() } : {}), ...(Object.keys(credentials).length ? { credentials } : {}) }),
      });
      const data = await res.json().catch(() => ({})) as { error?: { message?: string } };
      if (!res.ok) { setError(data.error?.message ?? `Could not save the changes (${res.status})`); return; }
      // New credentials: check them straight away, so the list shows the result.
      if (Object.keys(credentials).length) await fetch(`/api/cloud-accounts/${account.id}/validate`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
      await onSaved(account.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="edit-account-title">
      <div className="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-xl p-5 space-y-4 shadow-2xl my-8">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-blue-950/60 text-blue-400 shrink-0"><Pencil className="w-5 h-5" /></div>
          <div className="space-y-1">
            <h3 id="edit-account-title" className="text-white font-semibold text-sm">Edit “{account.name}”</h3>
            <p className="text-gray-400 text-xs leading-relaxed">Change only what you need. Secrets are never shown — leave a secret empty to keep the current one, or type a new one to replace it. The connection is checked again after you save.</p>
          </div>
        </div>

        <div className="space-y-3">
          <Field label="Account name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} className={INPUT} /></Field>

          {isAws ? (
            <>
              <Field label="Access key ID" hint={hint.accessKeyHint ? `Current key: ${hint.accessKeyHint}. Leave empty to keep it.` : 'Leave empty to keep the current key.'}>
                <input type="text" value={aws.accessKeyId} onChange={(e) => setAws((v) => ({ ...v, accessKeyId: e.target.value }))} placeholder="AKIA…" autoComplete="off" spellCheck={false} className={`${INPUT} font-mono`} />
              </Field>
              <Field label="Secret access key" hint="Never shown. Leave empty to keep the current secret; type the new one if you changed the key.">
                <input type="password" value={aws.secretAccessKey} onChange={(e) => setAws((v) => ({ ...v, secretAccessKey: e.target.value }))} placeholder="••••••••" autoComplete="new-password" spellCheck={false} className={`${INPUT} font-mono`} />
              </Field>
              <Field label="Role ARN" hint={hint.roleArn ? undefined : account.identity?.authMethod === 'access-key'
                ? 'No role yet: add one to let CloudCraft run Terraform and read on temporary credentials.'
                : Object.keys(hint).length === 0
                  ? 'The current role is not shown yet — click Re-check once and it appears here. Leave empty to keep it.'
                  : undefined}>
                <input type="text" value={aws.roleArn} onChange={(e) => setAws((v) => ({ ...v, roleArn: e.target.value }))} placeholder="arn:aws:iam::123456789012:role/CloudCraftRole" autoComplete="off" spellCheck={false} className={INPUT} />
              </Field>
              <Field label="External ID (optional)" hint={hint.hasExternalId ? 'One is set. Leave empty to keep it, type a new one to replace it, or tick the box to remove it.' : undefined}>
                <input type="text" value={aws.externalId} onChange={(e) => setAws((v) => ({ ...v, externalId: e.target.value }))} autoComplete="off" spellCheck={false} className={INPUT} />
                {hint.hasExternalId && (
                  <span className="flex items-center gap-2 mt-1 text-[11px] text-gray-400">
                    <input id="remove-external-id" type="checkbox" checked={removeExternalId} onChange={(e) => setRemoveExternalId(e.target.checked)} /> Remove the External ID
                  </span>
                )}
              </Field>
              <Field label="Region">
                <select value={aws.region} onChange={(e) => setAws((v) => ({ ...v, region: e.target.value }))} className={INPUT}>
                  {[...new Set([aws.region, ...REGIONS])].map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </Field>
            </>
          ) : (
            <>
              <Field label="Tenant ID"><input type="text" value={azure.tenantId} onChange={(e) => setAzure((v) => ({ ...v, tenantId: e.target.value }))} autoComplete="off" spellCheck={false} className={INPUT} /></Field>
              <Field label="Client ID (Application ID)"><input type="text" value={azure.clientId} onChange={(e) => setAzure((v) => ({ ...v, clientId: e.target.value }))} autoComplete="off" spellCheck={false} className={INPUT} /></Field>
              <Field label="Client secret" hint="Never shown. Leave empty to keep the current secret; type a new one if it expired or changed.">
                <input type="password" value={azure.clientSecret} onChange={(e) => setAzure((v) => ({ ...v, clientSecret: e.target.value }))} placeholder="••••••••" autoComplete="new-password" spellCheck={false} className={INPUT} />
              </Field>
              <Field label="Subscription ID"><input type="text" value={azure.subscriptionId} onChange={(e) => setAzure((v) => ({ ...v, subscriptionId: e.target.value }))} autoComplete="off" spellCheck={false} className={INPUT} /></Field>
            </>
          )}
        </div>

        {error && <p className="text-red-400 text-xs bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2" role="alert">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={saving} className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-300 bg-gray-800 hover:bg-gray-700 disabled:opacity-60">Cancel</button>
          <button type="button" onClick={save} disabled={saving} className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pencil className="w-3.5 h-3.5" />}
            Save and check again
          </button>
        </div>
      </div>
    </div>
  );
}
