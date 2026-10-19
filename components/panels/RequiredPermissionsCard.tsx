'use client';
/**
 * "Permissions needed": shown on the Deploy tab once the design is approved and an account that needs extra permission is selected.
 *
 * AWS: the services the approved architecture uses and a least-privilege IAM policy for exactly those, with the steps to attach it to the
 * role. Azure: the role(s) the service principal needs (Contributor, plus User Access Administrator when the design creates role
 * assignments) with the Azure CLI command and the portal steps. Both come BEFORE anything is planned or deployed, and "Check my access"
 * asks the cloud (read-only) whether the account can already create in each place. Nothing here changes the cloud.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck, Copy, Check, Loader2, CheckCircle2, XCircle, HelpCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { ApiTerraformExecutionService, type RequiredPermissionsInfo } from '@/lib/services/ApiTerraformExecutionService';

interface Props {
  projectId: string;
  environment: string;
  cloudAccountId: string;
  /** Changes whenever the design changes, so the needs are worked out again. */
  designKey: string;
  user?: { id: string; role?: string };
  isLight: boolean;
}

export default function RequiredPermissionsCard({ projectId, environment, cloudAccountId, designKey, user, isLight }: Props) {
  const [info, setInfo] = useState<RequiredPermissionsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState<'policy' | 'commands' | null>(null);
  const [checking, setChecking] = useState(false);
  const resultRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (check: boolean) => {
    try {
      const next = await ApiTerraformExecutionService.getRequiredPermissions(projectId, environment, cloudAccountId, check, user);
      setInfo((prev) => (check || !prev?.access ? next : { ...next, access: prev.access }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not work out the permissions');
    }
  }, [projectId, environment, cloudAccountId, user?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setInfo(null); void load(false); }, [load, designKey]);

  async function runCheck() {
    setChecking(true);
    await load(true);
    setChecking(false);
  }

  // The answer appears under the button, which can be below the visible part of the card: bring it into view.
  useEffect(() => {
    if (info?.access) resultRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [info?.access]);
  async function copy(what: 'policy' | 'commands') {
    const text = what === 'policy' ? info?.policy : info?.commands;
    if (!text) return;
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 1500); } catch { /* the text is selectable */ }
  }

  if (error) return <p className={isLight ? 'text-[11px] text-amber-700' : 'text-[11px] text-amber-400'}>Could not work out the permissions: {error}</p>;
  if (!info) return null;
  if (!info.needed) return null;     // the account's own key can deploy: nothing to add

  const azure = info.cloud === 'azure';
  const muted = isLight ? 'text-slate-600' : 'text-gray-400';
  const box = isLight ? 'bg-white border-slate-200' : 'bg-black/30 border-gray-700';
  const pre = `max-h-48 overflow-auto rounded p-2 font-mono text-[11px] leading-snug select-all ${isLight ? 'bg-slate-50 text-slate-800' : 'bg-gray-950 text-gray-200'}`;
  const chips = azure ? (info.providers ?? []) : (info.services ?? []);
  const roleName = info.roleArn?.split('/').pop() ?? 'your role';
  const copyButton = (what: 'policy' | 'commands', label: string) => (
    <button type="button" onClick={() => void copy(what)} className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium ${isLight ? 'border-slate-300 text-slate-700 hover:bg-slate-50' : 'border-gray-600 text-gray-200 hover:bg-gray-800'}`}>
      {copied === what ? <><Check className="w-3 h-3" /> Copied</> : <><Copy className="w-3 h-3" /> {label}</>}
    </button>
  );

  return (
    <div className={`rounded-lg border p-3 text-xs ${isLight ? 'bg-sky-50 border-sky-200' : 'bg-sky-950/20 border-sky-700/40'}`} data-testid="required-permissions">
      <button type="button" onClick={() => setOpen((v) => !v)} className={`flex w-full items-center gap-2 text-left font-semibold ${isLight ? 'text-sky-900' : 'text-sky-100'}`} aria-expanded={open}>
        {open ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
        <ShieldCheck className={`w-4 h-4 shrink-0 ${isLight ? 'text-sky-600' : 'text-sky-400'}`} />
        {azure ? 'Azure roles your service principal needs for this architecture' : 'Permissions your role needs for this architecture'}
      </button>

      {open && (
        <div className="mt-2 space-y-2.5">
          {azure ? (
            <p className={`leading-relaxed ${muted}`}>
              CloudBuilder signs in to Azure as the service principal <span className="font-mono font-semibold">{info.clientId || 'you connected'}</span>. Azure gives access by <em>role</em> on a subscription,
              so to create the approved design it needs the role{(info.roles?.length ?? 0) === 1 ? '' : 's'} below on subscription <span className="font-mono">{info.subscriptionId || 'your subscription'}</span>. Give {(info.roles?.length ?? 0) === 1 ? 'it' : 'them'} <em>before</em> you plan.
            </p>
          ) : (
            <p className={`leading-relaxed ${muted}`}>
              CloudBuilder connected <span className="font-mono font-semibold">{roleName}</span> to read your account. To create the approved design it also needs write access to
              the {info.services?.length ?? 0} service{(info.services?.length ?? 0) === 1 ? '' : 's'} below, and nothing else. Attach this policy to the role <em>before</em> you plan.
            </p>
          )}

          <div className="flex flex-wrap gap-1.5">
            {chips.map((s) => {
              const row = info.access?.services.find((x) => x.service === s);
              // Solid green for "can create here", solid red for "cannot", plain until the check has answered for that service.
              const tone = row?.allowed === true ? 'border-emerald-500 bg-emerald-600 text-white'
                : row?.allowed === false ? 'border-rose-500 bg-rose-600 text-white'
                  : (isLight ? 'border-slate-300 bg-white text-slate-700' : 'border-gray-600 bg-gray-900 text-gray-300');
              return (
                <span key={s} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors ${tone} ${checking ? 'animate-pulse' : ''}`} data-state={row?.allowed === true ? 'allowed' : row?.allowed === false ? 'denied' : 'unknown'}>
                  {checking && row?.allowed == null && <Loader2 className="w-3 h-3 animate-spin" />}
                  {!checking && row?.allowed === true && <CheckCircle2 className="w-3 h-3" />}
                  {!checking && row?.allowed === false && <XCircle className="w-3 h-3" />}
                  {s}
                </span>
              );
            })}
          </div>

          {!azure && info.includesIam && (
            <p className={`leading-relaxed ${isLight ? 'text-amber-800' : 'text-amber-300'}`}>
              This design creates IAM roles (for example for containers or functions), so the policy includes permission to manage IAM roles and policies. That is the most powerful part: review it, and remove the policy when you are done deploying.
            </p>
          )}
          {azure && info.needsRoleAssignment && (
            <p className={`leading-relaxed ${isLight ? 'text-amber-800' : 'text-amber-300'}`}>
              This design gives one resource access to another (role assignments), which Contributor is not allowed to do. That is why a second role is listed. It is powerful: remove it when you are done deploying.
            </p>
          )}
          {(info.unknownTypes?.length ?? 0) > 0 && (
            <p className={`leading-relaxed ${muted}`}>
              CloudBuilder could not map these to a {azure ? 'resource provider' : 'service'}, so they may need more access than listed: <span className="font-mono">{info.unknownTypes!.join(', ')}</span>. If {azure ? 'Azure' : 'AWS'} refuses one, the deploy page will tell you exactly which permission.
            </p>
          )}

          {azure ? (
            <div className={`rounded-md border p-2.5 space-y-2 ${box}`}>
              <ul className={`space-y-1 ${muted}`}>
                {(info.roles ?? []).map((r) => (
                  <li key={r.name}><span className={`font-semibold ${isLight ? 'text-slate-900' : 'text-white'}`}>{r.name}</span>: {r.why}.</li>
                ))}
              </ul>
              {info.commands && (
                <>
                  <div className="flex items-center justify-between">
                    <p className={`font-semibold ${isLight ? 'text-slate-900' : 'text-white'}`}>Azure CLI (run by someone who is an Owner of the subscription)</p>
                    {copyButton('commands', 'Copy commands')}
                  </div>
                  <pre className={pre}>{info.commands}</pre>
                </>
              )}
              <p className={`font-semibold ${isLight ? 'text-slate-900' : 'text-white'}`}>Or in the Azure portal</p>
              <ol className={`list-decimal pl-5 space-y-0.5 ${muted}`}>
                <li><strong>Subscriptions</strong> → your subscription → <strong>Access control (IAM)</strong> → <strong>Add</strong> → <strong>Add role assignment</strong></li>
                <li>Choose the role (<strong>{info.roles?.[0]?.name ?? 'Contributor'}</strong>{(info.roles?.length ?? 0) > 1 ? `, then repeat for ${info.roles![1]!.name}` : ''}) → <strong>Next</strong></li>
                <li><strong>Select members</strong> → search for <span className="font-mono">{info.clientId || 'the service principal'}</span> (its app registration name) → <strong>Review + assign</strong></li>
                <li>Come back and press <strong>Check my access</strong>, then plan. A new role can take a minute or two to apply.</li>
              </ol>
            </div>
          ) : (
            <div className={`rounded-md border p-2.5 ${box}`}>
              <div className="mb-1.5 flex items-center justify-between">
                <p className={`font-semibold ${isLight ? 'text-slate-900' : 'text-white'}`}>Policy to attach</p>
                {copyButton('policy', 'Copy policy')}
              </div>
              <pre className={pre}>{info.policy}</pre>
              <ol className={`mt-2 list-decimal pl-5 space-y-0.5 ${muted}`}>
                <li>AWS console → <strong>IAM</strong> → <strong>Roles</strong> → <strong>{roleName}</strong></li>
                <li><strong>Add permissions</strong> → <strong>Create inline policy</strong> → <strong>JSON</strong>, paste the policy, save it as <span className="font-mono">CloudBuilderDeploy</span></li>
                <li>Come back and press <strong>Check my access</strong>, then plan.</li>
              </ol>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={checking} onClick={() => void runCheck()} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-60 ${isLight ? 'bg-sky-600 hover:bg-sky-500' : 'bg-sky-700 hover:bg-sky-600'}`}>
              {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />} {checking ? 'Checking…' : 'Check my access'}
            </button>
          </div>

          {info.access && (
            <div
              ref={resultRef}
              role="status"
              className={`flex items-start gap-2 rounded-md border p-2.5 leading-relaxed ${
                info.access.state === 'ok' ? (isLight ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-emerald-700/60 bg-emerald-950/30 text-emerald-300')
                  : info.access.state === 'partial' ? (isLight ? 'border-rose-300 bg-rose-50 text-rose-800' : 'border-rose-700/60 bg-rose-950/30 text-rose-300')
                    : (isLight ? 'border-slate-300 bg-white text-slate-700' : 'border-gray-600 bg-gray-900 text-gray-300')}`}
              data-testid="access-result"
            >
              {info.access.state === 'ok' && <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />}
              {info.access.state === 'partial' && <XCircle className="w-4 h-4 shrink-0 mt-0.5" />}
              {info.access.state === 'cannot-check' && <HelpCircle className="w-4 h-4 shrink-0 mt-0.5" />}
              <span>
                {info.access.state === 'ok' && (azure ? 'The service principal can create everything this design needs.' : 'The role can create everything this design needs.')}
                {info.access.state !== 'ok' && info.access.message}
                {!azure && info.access.state === 'cannot-check' && ' No ticks can be shown until the role can answer this. The policy above now includes that one read-only permission: copy it again, replace the CloudBuilderDeploy inline policy, then press Check my access again.'}
              </span>
            </div>
          )}

          <p className={`text-[11px] leading-relaxed ${muted}`}>
            {azure
              ? 'Quicker for a test subscription: grant Contributor (and User Access Administrator if listed) on the whole subscription, and remove the assignment when you are done. The check only asks Azure what the service principal is allowed to do; it creates nothing.'
              : 'Quicker for a test or sandbox account: attach AWS\'s own AdministratorAccess policy instead (nothing to paste), and remove it afterwards. The check only asks AWS what the role is allowed to do; it creates nothing.'}
          </p>
        </div>
      )}
    </div>
  );
}
