'use client';
import { useState } from 'react';
import { Copy, Check, ShieldAlert } from 'lucide-react';
import { buildDeployPolicy, parseAccessDenied } from '@/lib/terraform/execution/deployPermissions';

/**
 * Shown when a deployment failed because the AWS role was not allowed to create things. Names the role and what it was refused, and
 * gives the policy to attach, built from the resources in this plan. Renders nothing for any other kind of failure.
 */
export default function TerraformPermissionHelp({ message, resourceTypes }: { message: string | null | undefined; resourceTypes: string[] }) {
  const [copied, setCopied] = useState(false);
  const denied = parseAccessDenied(message);
  if (!denied) return null;
  const policy = buildDeployPolicy(resourceTypes);
  const role = denied.roleName ?? 'the CloudCraft role';

  async function copy() {
    try { await navigator.clipboard.writeText(policy.json); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the text is selectable */ }
  }

  return (
    <div className="mb-3 rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-xs text-amber-100" data-testid="permission-help">
      <p className="flex items-center gap-2 font-semibold"><ShieldAlert className="w-4 h-4 shrink-0 text-amber-400" /> Your AWS role is not allowed to create these resources</p>
      <p className="mt-1.5 leading-relaxed text-amber-100/90">
        Terraform ran as <span className="font-mono">{role}</span>, and AWS refused {denied.actions.length} kind{denied.actions.length === 1 ? '' : 's'} of action
        (for example <span className="font-mono">{denied.actions.slice(0, 4).join(', ')}</span>). By default that role can only <strong>read</strong> your account, so nothing was created.
      </p>
      <ol className="mt-2 list-decimal pl-5 space-y-0.5 text-amber-100/90">
        <li>In the AWS console open <strong>IAM → Roles → {denied.roleName ?? 'CloudCraft'}</strong> → Add permissions → Create inline policy → JSON.</li>
        <li>Paste the policy below, save it, then come back here.</li>
        <li>Generate a new plan and apply again. Terraform only creates what is missing.</li>
      </ol>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-amber-200/80">Policy for this plan ({policy.services.join(', ') || 'no services found'})</span>
        <button type="button" onClick={copy} className="flex items-center gap-1 text-[11px] text-amber-200 hover:text-white">
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="mt-1 max-h-48 overflow-auto rounded bg-black/50 border border-amber-900/50 p-2 text-[11px] leading-snug text-amber-50 select-all">{policy.json}</pre>
      {policy.includesIam && (
        <p className="mt-2 text-[11px] text-amber-200/90 leading-relaxed">
          <strong>Note:</strong> this plan creates IAM roles, so the policy must allow the role to create IAM roles. That is powerful: a role that can create roles can grant itself more access. Use it in a sandbox or non-production account, and remove the policy when you are finished deploying.
        </p>
      )}
      {policy.unknownTypes.length > 0 && (
        <p className="mt-1 text-[11px] text-amber-200/80">CloudCraft could not work out the permissions for: {policy.unknownTypes.join(', ')}. If the next apply is refused for these, add what the error names.</p>
      )}
    </div>
  );
}
