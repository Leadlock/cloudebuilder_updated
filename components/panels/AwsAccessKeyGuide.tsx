'use client';
/**
 * Setup help for connecting an AWS account with an access key (the quick, read-only method): says plainly what the method is for
 * and what it costs, how to create the IAM user, and gives the read-only policy to paste.
 */
import { useState } from 'react';
import { ShieldAlert, Copy, Check } from 'lucide-react';
import { buildDiscoveryPolicy } from '@/lib/cloud/discoveryPolicy';

export default function AwsAccessKeyGuide() {
  const [copied, setCopied] = useState(false);
  const policy = buildDiscoveryPolicy();
  async function copy() {
    try { await navigator.clipboard.writeText(policy); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable: the text is selectable */ }
  }
  return (
    <div className="space-y-3" data-testid="aws-access-key-guide">
      <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-600/40 text-xs space-y-1.5">
        <p className="flex items-start gap-2 text-amber-300 font-medium"><ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" /> Read-only access key — for discovery only</p>
        <ul className="text-gray-300 leading-relaxed list-disc pl-5 space-y-0.5">
          <li>CloudCraft stores the key encrypted on the server and uses it only to <strong>read</strong> your resources. It is never shown again.</li>
          <li>An access key is long-lived: if it leaks, it works until you delete it. Use a dedicated user with only the read-only policy below, and rotate the key from time to time.</li>
          <li>It <strong>cannot be used to run Terraform</strong>. For apply or teardown, connect the account with an IAM role instead.</li>
        </ul>
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer text-gray-300 font-medium">How to create the key</summary>
        <ol className="mt-2 list-decimal pl-5 space-y-1 text-gray-400 leading-relaxed">
          <li>In AWS: IAM → Users → Create user (for example <span className="font-mono text-gray-300">cloudcraft-readonly</span>), with no console access.</li>
          <li>Add permissions → Create inline policy → JSON → paste the policy below.</li>
          <li>Security credentials → Create access key → &ldquo;Application running outside AWS&rdquo;.</li>
          <li>Copy the Access key ID and the Secret access key (shown once) into the fields below.</li>
        </ol>
        <div className="mt-2 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-gray-400">Read-only policy</span>
            <button type="button" onClick={copy} className="flex items-center gap-1 text-[11px] text-blue-300 hover:text-blue-200">
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}{copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="text-[11px] leading-snug text-gray-300 bg-black/40 border border-gray-700 rounded-lg p-2.5 max-h-48 overflow-auto select-all">{policy}</pre>
        </div>
      </details>
    </div>
  );
}
