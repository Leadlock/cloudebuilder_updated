'use client';
import { useState } from 'react';
import { Copy, Check, ShieldAlert } from 'lucide-react';
import { buildDeployPolicy, parseAccessDenied } from '@/lib/terraform/execution/deployPermissions';
import { useApp } from '@/context/AppContext';

/**
 * Shown when a deployment failed because the AWS role was not allowed to create things. The simple fix comes first: attach one of
 * AWS's own ready-made policies to the role (two clicks, nothing to write). The narrower, custom policy is available underneath for
 * anyone who does not want to grant that much. Renders nothing for any other kind of failure.
 */
export default function TerraformPermissionHelp({ message, resourceTypes }: { message: string | null | undefined; resourceTypes: string[] }) {
  const { state: appState } = useApp();
  const isLight = appState.theme === 'light';

  const [copied, setCopied] = useState(false);
  const denied = parseAccessDenied(message);
  if (!denied) return null;
  const policy = buildDeployPolicy(resourceTypes);
  const roleName = denied.roleName ?? 'CloudBuilder';

  async function copy() {
    try { await navigator.clipboard.writeText(policy.json); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the text is selectable */ }
  }

  return (
    <div className={`mb-3 rounded-lg border p-3 text-xs ${
      isLight ? 'bg-amber-50 border-amber-200 text-amber-950' : 'border-amber-700/50 bg-amber-950/30 text-amber-100'
    }`} data-testid="permission-help">
      <p className={`flex items-center gap-2 font-semibold ${isLight ? 'text-amber-900' : ''}`}><ShieldAlert className={`w-4 h-4 shrink-0 ${isLight ? 'text-amber-600' : 'text-amber-400'}`} /> Your AWS role can only look, not create</p>
      <p className={`mt-1.5 leading-relaxed ${isLight ? 'text-slate-700' : 'text-amber-100/90'}`}>
        The role <span className={`font-mono font-semibold ${isLight ? 'text-slate-900' : ''}`}>{roleName}</span> was set up to read your account, so AWS refused to create anything (nothing was created). To let CloudBuilder deploy, give that role more access:
      </p>

      <div className={`mt-2 rounded-md border p-2.5 ${isLight ? 'bg-white border-amber-200 shadow-sm' : 'border-amber-600/40 bg-black/30'}`}>
        <p className={`font-semibold ${isLight ? 'text-amber-900' : 'text-amber-50'}`}>Easiest: attach AWS&apos;s own &ldquo;AdministratorAccess&rdquo; policy</p>
        <ol className={`mt-1 list-decimal pl-5 space-y-0.5 ${isLight ? 'text-slate-700' : 'text-amber-100/90'}`}>
          <li>AWS console → <strong>IAM</strong> → <strong>Roles</strong> → <strong>{roleName}</strong></li>
          <li><strong>Add permissions</strong> → <strong>Attach policies</strong> → tick <strong>AdministratorAccess</strong> → <strong>Add permissions</strong></li>
          <li>Come back here, generate a new plan and apply again.</li>
        </ol>
        <p className={`mt-1.5 text-[11px] leading-relaxed ${isLight ? 'text-slate-500' : 'text-amber-200/90'}`}>
          Nothing to write or paste. It gives this role full access, so use it for a test or sandbox account, and remove the policy when you are done deploying.
        </p>
      </div>

      <p className={`mt-2 text-[11px] leading-relaxed ${isLight ? 'text-slate-600' : 'text-amber-200/90'}`}>
        <strong>Or skip the role entirely:</strong> attach <strong>AdministratorAccess</strong> to your IAM <em>user</em> instead, then in <strong>Cloud Accounts → Connect an AWS account → Simple</strong> connect that user&apos;s access key. CloudBuilder then deploys as that user, with no role involved.
      </p>

      <details className="mt-2">
        <summary className={`cursor-pointer font-medium ${isLight ? 'text-amber-900' : 'text-amber-200'}`}>Want less access than that? Use a narrower policy instead</summary>
        <div className="mt-2">
          <p className={`leading-relaxed ${isLight ? 'text-slate-700' : 'text-amber-100/90'}`}>
            Same place (IAM → Roles → {roleName}), but choose <strong>Add permissions → Create inline policy → JSON</strong> and paste this. It only covers the services in this plan ({policy.services.join(', ') || 'none found'}).
          </p>
          <div className="mt-1.5 flex justify-end">
            <button type="button" onClick={copy} className={`flex items-center gap-1 text-[11px] ${isLight ? 'text-blue-600 hover:text-blue-800 font-medium' : 'text-amber-200 hover:text-white'}`}>
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}{copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className={`mt-1 max-h-48 overflow-auto rounded border p-2 text-[11px] leading-snug font-mono select-all ${
            isLight ? 'bg-slate-100 border-slate-300 text-slate-800' : 'bg-black/50 border-amber-900/50 text-amber-50'
          }`}>{policy.json}</pre>
          {policy.includesIam && (
            <p className={`mt-2 text-[11px] leading-relaxed ${isLight ? 'text-slate-600' : 'text-amber-200/90'}`}>
              This plan creates IAM roles, so even this policy lets the role create roles, and a role that can create roles can grant itself more access.
            </p>
          )}
          {policy.unknownTypes.length > 0 && (
            <p className={`mt-1 text-[11px] ${isLight ? 'text-slate-500' : 'text-amber-200/80'}`}>CloudBuilder could not work out the permissions for: {policy.unknownTypes.join(', ')}. If the next apply is refused for these, add what the error names.</p>
          )}
        </div>
      </details>
    </div>
  );
}
