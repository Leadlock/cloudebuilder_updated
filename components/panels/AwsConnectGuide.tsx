'use client';
/**
 * Setup help shown on the "Connect AWS account" form, so the usual mistakes cannot happen:
 *  - says up front whether the CloudCraft server can sign in to AWS at all (without an identity of its own it cannot assume
 *    anyone's role, and every connection would end as "invalid");
 *  - shows the identity the role's trust policy has to name, and writes that trust policy (with the External ID) ready to paste;
 *  - generates a strong External ID;
 *  - writes the small policy the server's own identity needs to assume the role.
 */
import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck, Loader2, Copy, Check, RefreshCw, Wand2 } from 'lucide-react';
import { buildTrustPolicy, buildAssumeRolePolicy, trustPrincipalFromArn, generateExternalId } from '@/lib/cloud/trustPolicy';

type ServerIdentity =
  | { configured: true; accountId: string; arn: string }
  | { configured: false; reason: string; fix: string };

const ROLE_ARN_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,64}$/;

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable: the text is selectable */ }
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-gray-400">{label}</span>
        <button type="button" onClick={copy} className="flex items-center gap-1 text-[11px] text-blue-300 hover:text-blue-200">
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="text-[11px] leading-snug text-gray-300 bg-black/40 border border-gray-700 rounded-lg p-2.5 overflow-x-auto select-all">{text}</pre>
    </div>
  );
}

export default function AwsConnectGuide({ externalId, roleArn, onExternalId }: { externalId: string; roleArn: string; onExternalId: (value: string) => void }) {
  const [server, setServer] = useState<ServerIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (fresh: boolean) => {
    setLoading(true); setLoadError(null);
    try {
      const res = await fetch(`/api/cloud-accounts/server-identity${fresh ? '?fresh=1' : ''}`, { credentials: 'include' });
      const data = await res.json().catch(() => ({})) as { data?: ServerIdentity; error?: { message?: string } };
      if (!res.ok || !data.data) throw new Error(data.error?.message ?? `Could not check the server (${res.status})`);
      setServer(data.data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not check the server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);

  if (loading && !server) {
    return <p className="flex items-center gap-2 text-xs text-gray-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking how CloudCraft signs in to AWS…</p>;
  }
  if (loadError && !server) {
    return <p className="text-xs text-amber-400">Could not check the server&apos;s AWS sign-in: {loadError}</p>;
  }
  if (!server) return null;

  if (!server.configured) {
    return (
      <div className="p-3 rounded-lg bg-amber-950/40 border border-amber-500/40 text-xs space-y-2" data-testid="aws-server-not-configured">
        <p className="flex items-start gap-2 text-amber-300 font-medium"><ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" /> {server.reason}</p>
        <p className="text-gray-300 leading-relaxed">{server.fix}</p>
        <p className="text-gray-500 leading-relaxed">Until that is done, an account you connect here will show as invalid, whatever you enter below.</p>
        <button type="button" onClick={() => load(true)} disabled={loading} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 disabled:opacity-60">
          <RefreshCw className={loading ? 'w-3 h-3 animate-spin' : 'w-3 h-3'} /> Check again
        </button>
      </div>
    );
  }

  const principal = trustPrincipalFromArn(server.arn);
  const ext = externalId.trim() || '<your External ID>';
  return (
    <div className="p-3 rounded-lg bg-emerald-950/20 border border-emerald-700/40 text-xs space-y-3" data-testid="aws-server-configured">
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-emerald-300 font-medium"><ShieldCheck className="w-4 h-4 shrink-0 text-emerald-400" /> CloudCraft signs in to AWS as</p>
        <p className="font-mono text-[11px] text-gray-200 break-all">{server.arn}</p>
        <p className="text-gray-500">AWS account {server.accountId}. Your role has to trust this identity.</p>
      </div>

      <div className="space-y-1.5">
        <p className="text-gray-300 font-medium">1. External ID</p>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => onExternalId(generateExternalId())} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-blue-600/30 hover:bg-blue-600/50 border border-blue-500/50 text-blue-100">
            <Wand2 className="w-3 h-3" /> {externalId ? 'Generate a new one' : 'Generate a strong External ID'}
          </button>
          <span className="text-gray-500">{externalId ? 'Filled in below — use the same one in the role.' : 'Or type your own below.'}</span>
        </div>
      </div>

      <details className="group" open>
        <summary className="cursor-pointer text-gray-300 font-medium">2. Trust policy for your role</summary>
        <div className="mt-2 space-y-2">
          <p className="text-gray-500 leading-relaxed">In AWS: IAM → Roles → your role → Trust relationships → Edit trust policy → paste this.</p>
          <CopyBlock label="Trust policy" text={buildTrustPolicy(principal, ext)} />
        </div>
      </details>

      <details className="group">
        <summary className="cursor-pointer text-gray-300 font-medium">3. Permission for CloudCraft&apos;s own identity</summary>
        <div className="mt-2 space-y-2">
          <p className="text-gray-500 leading-relaxed">
            If the role is in a different AWS account from that identity — or the identity cannot yet call sts:AssumeRole — attach this to it as an inline policy.
            {ROLE_ARN_RE.test(roleArn.trim()) ? '' : ' (Fill in the Role ARN below and it is written for you.)'}
          </p>
          <CopyBlock label="Policy for the CloudCraft server's identity" text={buildAssumeRolePolicy(ROLE_ARN_RE.test(roleArn.trim()) ? roleArn.trim() : 'arn:aws:iam::<ACCOUNT-ID>:role/<ROLE-NAME>')} />
        </div>
      </details>
    </div>
  );
}
