'use client';
/**
 * "Permissions your role needs": shown on the Deploy tab once the design is approved and an account that deploys through a role is
 * selected. Lists the AWS services the approved architecture uses and a least-privilege IAM policy for exactly those, with the steps
 * to attach it, BEFORE anything is planned or deployed. "Check my access" asks AWS (read-only) whether the role can already create in
 * each service. Nothing here changes AWS.
 */
import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Copy, Check, Loader2, CheckCircle2, XCircle, HelpCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { ApiTerraformExecutionService, type RequiredPermissionsInfo } from '@/lib/services/ApiTerraformExecutionService';

interface Props {
  projectId: string;
  environment: string;
  cloudAccountId: string;
  /** Changes whenever the design changes, so the services are worked out again. */
  designKey: string;
  user?: { id: string; role?: string };
  isLight: boolean;
}

export default function RequiredPermissionsCard({ projectId, environment, cloudAccountId, designKey, user, isLight }: Props) {
  const [info, setInfo] = useState<RequiredPermissionsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);

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
  async function copy() {
    if (!info?.policy) return;
    try { await navigator.clipboard.writeText(info.policy); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the text is selectable */ }
  }

  if (error) return <p className={isLight ? 'text-[11px] text-amber-700' : 'text-[11px] text-amber-400'}>Could not work out the permissions: {error}</p>;
  if (!info) return null;
  if (!info.needed) return null;     // the account's own key can deploy: nothing to add

  const muted = isLight ? 'text-slate-600' : 'text-gray-400';
  const box = isLight ? 'bg-white border-slate-200' : 'bg-black/30 border-gray-700';
  const roleName = info.roleArn?.split('/').pop() ?? 'your role';

  return (
    <div className={`rounded-lg border p-3 text-xs ${isLight ? 'bg-sky-50 border-sky-200' : 'bg-sky-950/20 border-sky-700/40'}`} data-testid="required-permissions">
      <button type="button" onClick={() => setOpen((v) => !v)} className={`flex w-full items-center gap-2 text-left font-semibold ${isLight ? 'text-sky-900' : 'text-sky-100'}`} aria-expanded={open}>
        {open ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
        <ShieldCheck className={`w-4 h-4 shrink-0 ${isLight ? 'text-sky-600' : 'text-sky-400'}`} />
        Permissions your role needs for this architecture
      </button>

      {open && (
        <div className="mt-2 space-y-2.5">
          <p className={`leading-relaxed ${muted}`}>
            CloudCraft connected <span className="font-mono font-semibold">{roleName}</span> to read your account. To create the approved design it also needs write access to
            the {info.services?.length ?? 0} service{(info.services?.length ?? 0) === 1 ? '' : 's'} below, and nothing else. Attach this policy to the role <em>before</em> you plan.
          </p>

          <div className="flex flex-wrap gap-1.5">
            {(info.services ?? []).map((s) => {
              const row = info.access?.services.find((x) => x.service === s);
              const tone = row?.allowed === true ? (isLight ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-emerald-700/60 bg-emerald-950/40 text-emerald-300')
                : row?.allowed === false ? (isLight ? 'border-rose-300 bg-rose-50 text-rose-800' : 'border-rose-700/60 bg-rose-950/40 text-rose-300')
                  : (isLight ? 'border-slate-300 bg-white text-slate-700' : 'border-gray-600 bg-gray-900 text-gray-300');
              return (
                <span key={s} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] ${tone}`}>
                  {row?.allowed === true && <CheckCircle2 className="w-3 h-3" />}
                  {row?.allowed === false && <XCircle className="w-3 h-3" />}
                  {s}
                </span>
              );
            })}
          </div>

          {info.includesIam && (
            <p className={`leading-relaxed ${isLight ? 'text-amber-800' : 'text-amber-300'}`}>
              This design creates IAM roles (for example for containers or functions), so the policy includes permission to manage IAM roles and policies. That is the most powerful part: review it, and remove the policy when you are done deploying.
            </p>
          )}
          {(info.unknownTypes?.length ?? 0) > 0 && (
            <p className={`leading-relaxed ${muted}`}>
              CloudCraft could not map these to a service, so they may need more access than listed: <span className="font-mono">{info.unknownTypes!.join(', ')}</span>. If AWS refuses one, the deploy page will tell you exactly which permission.
            </p>
          )}

          <div className={`rounded-md border p-2.5 ${box}`}>
            <div className="mb-1.5 flex items-center justify-between">
              <p className={`font-semibold ${isLight ? 'text-slate-900' : 'text-white'}`}>Policy to attach</p>
              <button type="button" onClick={() => void copy()} className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium ${isLight ? 'border-slate-300 text-slate-700 hover:bg-slate-50' : 'border-gray-600 text-gray-200 hover:bg-gray-800'}`}>
                {copied ? <><Check className="w-3 h-3" /> Copied</> : <><Copy className="w-3 h-3" /> Copy policy</>}
              </button>
            </div>
            <pre className={`max-h-48 overflow-auto rounded p-2 font-mono text-[11px] leading-snug select-all ${isLight ? 'bg-slate-50 text-slate-800' : 'bg-gray-950 text-gray-200'}`}>{info.policy}</pre>
            <ol className={`mt-2 list-decimal pl-5 space-y-0.5 ${muted}`}>
              <li>AWS console → <strong>IAM</strong> → <strong>Roles</strong> → <strong>{roleName}</strong></li>
              <li><strong>Add permissions</strong> → <strong>Create inline policy</strong> → <strong>JSON</strong>, paste the policy, save it as <span className="font-mono">CloudCraftDeploy</span></li>
              <li>Come back and press <strong>Check my access</strong>, then plan.</li>
            </ol>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={checking} onClick={() => void runCheck()} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-60 ${isLight ? 'bg-sky-600 hover:bg-sky-500' : 'bg-sky-700 hover:bg-sky-600'}`}>
              {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />} Check my access
            </button>
          </div>

          {info.access && (
            <div
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
                {info.access.state === 'ok' && 'The role can create everything this design needs.'}
                {info.access.state !== 'ok' && info.access.message}
                {info.access.state === 'cannot-check' && ' No ticks can be shown until the role can answer this. The policy above now includes that one read-only permission: copy it again, replace the CloudCraftDeploy inline policy, then press Check my access again.'}
              </span>
            </div>
          )}

          <p className={`text-[11px] leading-relaxed ${muted}`}>
            Quicker for a test or sandbox account: attach AWS&apos;s own <strong>AdministratorAccess</strong> policy instead (nothing to paste), and remove it afterwards. The check only asks AWS what the role is allowed to do; it creates nothing.
          </p>
        </div>
      )}
    </div>
  );
}
