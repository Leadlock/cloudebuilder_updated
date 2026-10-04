'use client';
/**
 * Setup help for connecting an AWS account: the user's OWN access key signs in and assumes the user's OWN role. Everything lives in
 * the user's AWS account — CloudCraft has no AWS account of its own that anyone has to trust. The guide writes the three pieces of
 * IAM the user needs, ready to paste:
 *   1. the role's trust policy (trusts the user's own account; only the user created in step 3 can use it);
 *   2. the role's permissions (read-only for discovery; more only if Terraform will run);
 *   3. the IAM user's inline policy (it may do exactly one thing: assume that role).
 */
import { useEffect, useState } from 'react';
import { Copy, Check, Wand2, ShieldCheck } from 'lucide-react';
import { buildTrustPolicy, buildAssumeRolePolicy, generateExternalId } from '@/lib/cloud/trustPolicy';
import { buildDiscoveryPolicy } from '@/lib/cloud/discoveryPolicy';
import { buildStateStoragePolicy, STATE_BUCKET_PREFIX, STATE_LOCK_TABLE_PREFIX } from '@/lib/cloud/stateStoragePolicy';

const ROLE_ARN_RE = /^arn:aws:iam::(\d{12}):role\/[\w+=,.@/-]{1,64}$/;
const ACCOUNT_RE = /^\d{12}$/;

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
      <pre className="text-[11px] leading-snug text-gray-300 bg-black/40 border border-gray-700 rounded-lg p-2.5 max-h-48 overflow-auto select-all">{text}</pre>
    </div>
  );
}

export default function AwsKeyRoleGuide({ roleArn, externalId, onExternalId }: { roleArn: string; externalId: string; onExternalId: (value: string) => void }) {
  const fromArn = ROLE_ARN_RE.exec(roleArn.trim())?.[1] ?? '';
  const [typedAccount, setTypedAccount] = useState('');
  const accountId = fromArn || typedAccount.trim();
  const accountOk = ACCOUNT_RE.test(accountId);
  const account = accountOk ? accountId : '<YOUR-12-DIGIT-ACCOUNT-ID>';
  const roleToAssume = ROLE_ARN_RE.test(roleArn.trim()) ? roleArn.trim() : `arn:aws:iam::${account}:role/CloudCraftRole`;

  // Once the Role ARN is filled in, the account id comes from it.
  useEffect(() => { if (fromArn) setTypedAccount(fromArn); }, [fromArn]);

  return (
    <div className="space-y-3" data-testid="aws-key-role-guide">
      <div className="p-3 rounded-lg bg-emerald-950/20 border border-emerald-700/40 text-xs space-y-1.5">
        <p className="flex items-center gap-2 text-emerald-300 font-medium"><ShieldCheck className="w-4 h-4 shrink-0 text-emerald-400" /> Connect your own AWS account — nothing of CloudCraft&apos;s is involved</p>
        <ul className="text-gray-300 leading-relaxed list-disc pl-5 space-y-0.5">
          <li>You create a role and an IAM user in <strong>your</strong> account. The user&apos;s access key is stored encrypted and can only do one thing: assume that role.</li>
          <li>Everything CloudCraft does then runs on <strong>temporary role credentials</strong> — read-only for discovery, and more only if you give the role permissions for Terraform.</li>
          <li>You decide what the role may do, and you can delete the user or the role in AWS at any time to cut CloudCraft off.</li>
        </ul>
      </div>

      <details className="text-xs" open>
        <summary className="cursor-pointer text-gray-300 font-medium">How to set it up in AWS (4 short steps)</summary>
        <div className="mt-3 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="aws-account-id" className="text-gray-400">Your AWS account ID (used to write the policies below)</label>
            <input
              id="aws-account-id"
              type="text"
              inputMode="numeric"
              placeholder="123456789012"
              value={fromArn || typedAccount}
              onChange={(e) => setTypedAccount(e.target.value.replace(/\D/g, '').slice(0, 12))}
              disabled={!!fromArn}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-white text-xs font-mono placeholder-gray-500 focus:outline-none focus:border-blue-500 disabled:opacity-70"
            />
          </div>

          <div className="space-y-2">
            <p className="text-gray-300 font-medium">1. Create the role</p>
            <p className="text-gray-500 leading-relaxed">IAM → Roles → Create role → Custom trust policy → paste this. An External ID is optional; add one if you want an extra check.</p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => onExternalId(generateExternalId())} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-blue-600/30 hover:bg-blue-600/50 border border-blue-500/50 text-blue-100">
                <Wand2 className="w-3 h-3" /> {externalId ? 'Generate a new External ID' : 'Generate an External ID (optional)'}
              </button>
              {externalId && <button type="button" onClick={() => onExternalId('')} className="text-[11px] text-gray-500 hover:text-gray-300">Don&apos;t use one</button>}
            </div>
            <CopyBlock label="Trust policy for the role" text={buildTrustPolicy(`arn:aws:iam::${account}:root`, externalId.trim() || undefined)} />
          </div>

          <div className="space-y-2">
            <p className="text-gray-300 font-medium">2. Give the role its permissions</p>
            <p className="text-gray-500 leading-relaxed">
              For <strong>discovery</strong>, attach the AWS-managed <span className="font-mono text-gray-300">ReadOnlyAccess</span> policy, or this narrower one that can only list and describe.
              To also run <strong>Terraform</strong>, add permissions for the resources it will create or delete — only if you want that.
            </p>
            <CopyBlock label="Read-only policy for discovery" text={buildDiscoveryPolicy()} />
            <p className="text-gray-500 leading-relaxed pt-1">
              <strong>Optional — let CloudCraft create the Terraform state storage for you.</strong> The &ldquo;Create state storage for me&rdquo; button needs this extra inline policy on the role.
              It only covers buckets named <span className="font-mono text-gray-300">{STATE_BUCKET_PREFIX}*</span> and lock tables named <span className="font-mono text-gray-300">{STATE_LOCK_TABLE_PREFIX}*</span> (leave the bucket name empty and CloudCraft picks a matching one); it cannot touch any other bucket or table and cannot delete either.
            </p>
            <CopyBlock label="Extra policy for state storage (optional)" text={buildStateStoragePolicy()} />
          </div>

          <div className="space-y-2">
            <p className="text-gray-300 font-medium">3. Create an IAM user that may only assume the role</p>
            <p className="text-gray-500 leading-relaxed">IAM → Users → Create user (no console access) → Add permissions → Create inline policy → JSON → paste this.</p>
            <CopyBlock label="Inline policy for the user" text={buildAssumeRolePolicy(roleToAssume)} />
          </div>

          <div className="space-y-1.5">
            <p className="text-gray-300 font-medium">4. Create the user&apos;s access key</p>
            <p className="text-gray-500 leading-relaxed">Security credentials → Create access key → &ldquo;Application running outside AWS&rdquo;. Paste the Access key ID, the Secret access key (shown once) and the role&apos;s ARN below.</p>
          </div>
        </div>
      </details>
    </div>
  );
}
