'use client';
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import type { AutoFixPlan } from '@/lib/engines/assessment/autofix';
import type { Finding } from '@/lib/engines/assessment/types';
import { Modal, SafetyBadge, SeverityBadge } from './ui';
import { useApp } from '@/context/AppContext';

const money = (n: number) => `$${n.toFixed(2)}`;

export function AutoFixPreviewModal({ plan, onApply, onCancel, busy }: { plan: AutoFixPlan; onApply: () => void; onCancel: () => void; busy: boolean }) {
  const { state: appState } = useApp();
  const isLight = appState.theme === 'light';
  const [ack, setAck] = useState(plan.safety === 'SAFE_AUTOFIX');

  return (
    <Modal title={`Auto-Fix preview — ${plan.ruleId}`} onClose={onCancel} wide>
      <div className="space-y-4">
        <div className="flex items-center gap-2"><SafetyBadge safety={plan.safety} /><span className={`font-semibold ${isLight ? 'text-slate-900' : 'text-white'}`}>{plan.title}</span></div>
        <p className={`text-xs ${isLight ? 'text-slate-600' : 'text-gray-400'}`}>{plan.safetyReason}</p>

        <section>
          <p className={`font-semibold text-xs mb-1 ${isLight ? 'text-slate-700' : 'text-gray-400'}`}>Configuration change on “{plan.resourceLabel}”</p>
          <table className="w-full text-xs">
            <thead><tr className={`${isLight ? 'text-slate-500' : 'text-gray-500'} text-left`}><th className="font-medium">Setting</th><th className="font-medium">Current</th><th className="font-medium">Proposed</th></tr></thead>
            <tbody>{plan.changes.map((c) => (
              <tr key={c.field} className={`border-t ${isLight ? 'border-slate-100' : 'border-gray-800'}`}><td className={`py-1 ${isLight ? 'text-slate-700' : 'text-gray-300'}`}>{c.label}</td><td className={`py-1 ${isLight ? 'text-rose-700 font-mono' : 'text-red-300'}`}>{c.current}</td><td className={`py-1 ${isLight ? 'text-emerald-700 font-mono font-medium' : 'text-emerald-300'}`}>{c.proposed}</td></tr>
            ))}</tbody>
          </table>
        </section>

        <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt className={isLight ? 'text-slate-500' : 'text-gray-500'}>Resources affected</dt><dd className={isLight ? 'text-slate-800' : ''}>{plan.affectedResources.join(', ')}</dd>
          <dt className={isLight ? 'text-slate-500' : 'text-gray-500'}>Why</dt><dd className={isLight ? 'text-slate-800' : ''}>{plan.why}</dd>
          <dt className={isLight ? 'text-slate-500' : 'text-gray-500'}>Security improvement</dt><dd className={isLight ? 'text-slate-800' : ''}>{plan.securityImprovement}</dd>
          <dt className={isLight ? 'text-slate-500' : 'text-gray-500'}>Architecture impact</dt><dd className={isLight ? 'text-slate-800' : ''}>{plan.architectureImpact}</dd>
          <dt className={isLight ? 'text-slate-500' : 'text-gray-500'}>Cost impact</dt>
          <dd className={isLight ? 'text-slate-800' : ''}>
            {plan.cost.deltaMonthly === 0 ? 'No change in the static estimate' : `${plan.cost.deltaMonthly > 0 ? '+' : ''}${money(plan.cost.deltaMonthly)}/month`}
            <span className={isLight ? 'text-slate-500' : 'text-gray-500'}> ({money(plan.cost.beforeMonthly)} → {money(plan.cost.afterMonthly)}; {plan.cost.basis})</span>
          </dd>
        </dl>

        <section>
          <p className={`font-semibold text-xs mb-1 ${isLight ? 'text-slate-700' : 'text-gray-400'}`}>Terraform impact {plan.terraform.expectationMet === false && <span className="text-rose-600">(expected change not rendered — fix will be rejected)</span>}</p>
          <pre className={`rounded-lg p-3 text-[11px] leading-relaxed overflow-x-auto max-h-48 border font-mono ${
            isLight ? 'bg-slate-50 border-slate-200' : 'bg-black/40 border-gray-800'
          }`}>
            {plan.terraform.removed.map((l, i) => <div key={`r${i}`} className={isLight ? 'text-rose-700' : 'text-red-300'}>- {l}</div>)}
            {plan.terraform.added.map((l, i) => <div key={`a${i}`} className={isLight ? 'text-emerald-700 font-medium' : 'text-emerald-300'}>+ {l}</div>)}
            {plan.terraform.added.length + plan.terraform.removed.length === 0 && <span className={isLight ? 'text-slate-500' : 'text-gray-500'}>No Terraform change</span>}
          </pre>
        </section>

        {plan.safety === 'REVIEW_REQUIRED' && (
          <label className={`flex items-start gap-2 text-xs rounded-lg p-3 border ${
            isLight ? 'text-amber-950 bg-amber-50 border-amber-200' : 'text-amber-200 bg-amber-900/20 border-amber-800/50'
          }`}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
            I have reviewed this change and its impact on connectivity, cost and deployment.
          </label>
        )}
        <p className={`${isLight ? 'text-slate-500' : 'text-gray-500'} text-[11px]`}>After applying, CloudCraft re-validates the architecture, re-runs this rule, re-assesses all rules for regressions and regenerates Terraform. The change is kept only if every check passes; otherwise the architecture is left unchanged and the fix is reported as failed.</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className={`px-4 py-2 rounded-lg text-xs transition-colors ${
            isLight ? 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200' : 'bg-gray-800 hover:bg-gray-700 text-gray-200'
          }`}>Cancel</button>
          <button onClick={onApply} disabled={!ack || busy} className={clsx('px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-40 shadow-sm transition-colors',
            plan.safety === 'SAFE_AUTOFIX' ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-amber-600 hover:bg-amber-500 text-white')}>
            {busy ? 'Applying…' : 'Apply Fix'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function BulkFixModal({ findings, costDelta, onApply, onCancel, busy }: { findings: Finding[]; costDelta: number; onApply: () => void; onCancel: () => void; busy: boolean }) {
  const { state: appState } = useApp();
  const isLight = appState.theme === 'light';

  const resources = useMemo(() => Array.from(new Set(findings.flatMap((f) => f.resourceLabels))), [findings]);
  const bySev = useMemo(() => findings.reduce<Record<string, number>>((m, f) => ({ ...m, [f.severity]: (m[f.severity] ?? 0) + 1 }), {}), [findings]);
  return (
    <Modal title="Fix all safe issues" onClose={onCancel} wide>
      <div className="space-y-4 text-xs">
        <p className={isLight ? 'text-slate-700' : ''}>Only findings classified <b className={isLight ? 'text-emerald-700' : 'text-emerald-300'}>SAFE_AUTOFIX</b> are included. Review-required and manual findings are never applied automatically.</p>
        <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1.5">
          <dt className={isLight ? 'text-slate-500' : 'text-gray-500'}>Number of fixes</dt><dd className={isLight ? 'text-slate-800 font-semibold' : ''}>{findings.length}</dd>
          <dt className={isLight ? 'text-slate-500' : 'text-gray-500'}>Affected resources</dt><dd className={isLight ? 'text-slate-800' : ''}>{resources.join(', ')}</dd>
          <dt className={isLight ? 'text-slate-500' : 'text-gray-500'}>Security impact</dt><dd className={isLight ? 'text-slate-800' : ''}>{Object.entries(bySev).map(([s, n]) => `${n} ${s.toLowerCase()}`).join(', ')} finding(s) resolved if verification passes</dd>
          <dt className={isLight ? 'text-slate-500' : 'text-gray-500'}>Possible cost impact</dt><dd className={isLight ? 'text-slate-800' : ''}>{costDelta === 0 ? 'No change in the static estimate' : `${costDelta > 0 ? '+' : ''}$${costDelta.toFixed(2)}/month (static estimate)`}</dd>
        </dl>
        <ul className="space-y-1 max-h-56 overflow-y-auto">
          {findings.map((f) => (
            <li key={f.findingId} className={`flex items-center gap-2 p-1.5 rounded ${isLight ? 'bg-slate-50' : ''}`}>
              <SeverityBadge severity={f.severity} />
              <code className={isLight ? 'text-slate-400' : 'text-gray-500'}>{f.findingId}</code>
              <span className={isLight ? 'text-slate-700' : 'text-gray-300'}>{f.autoFix.description} — {f.resourceLabels.join(', ')}</span>
            </li>
          ))}
        </ul>
        <p className={`${isLight ? 'text-slate-500' : 'text-gray-500'} text-[11px]`}>Fixes are applied one at a time; each is verified (validation, rule re-evaluation, regression check, Terraform) and skipped if verification fails.</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className={`px-4 py-2 rounded-lg transition-colors ${
            isLight ? 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200' : 'bg-gray-800 hover:bg-gray-700 text-gray-200'
          }`}>Cancel</button>
          <button onClick={onApply} disabled={busy || findings.length === 0} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-40 shadow-sm transition-colors">{busy ? 'Applying…' : `Apply ${findings.length} safe fix${findings.length === 1 ? '' : 'es'}`}</button>
        </div>
      </div>
    </Modal>
  );
}

export function ReviewModal({ finding, onSubmit, onCancel, busy, error }: {
  finding: Finding;
  onSubmit: (v: { status: 'ACCEPTED_RISK' | 'FALSE_POSITIVE' | 'NOT_APPLICABLE'; reason: string; expiresAt?: string }) => void;
  onCancel: () => void; busy: boolean; error: string | null;
}) {
  const { state: appState } = useApp();
  const isLight = appState.theme === 'light';

  const [status, setStatus] = useState<'ACCEPTED_RISK' | 'FALSE_POSITIVE' | 'NOT_APPLICABLE'>('ACCEPTED_RISK');
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState(() => new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10));
  const needsAdmin = finding.severity === 'CRITICAL' || finding.severity === 'HIGH';

  const inputClass = `mt-1 w-full rounded-lg px-2 py-1.5 text-xs focus:outline-none transition-colors ${
    isLight ? 'bg-slate-50 border border-slate-300 text-slate-900 focus:bg-white focus:border-blue-500' : 'bg-gray-800 border border-gray-700 text-gray-200 focus:border-blue-500'
  }`;

  return (
    <Modal title={`Review decision — ${finding.findingId}`} onClose={onCancel}>
      <div className="space-y-3 text-xs">
        <p className={isLight ? 'text-slate-700' : ''}>Recording a decision does <b>not</b> change the technical result: the finding stays <b className={isLight ? 'text-slate-900' : ''}>{finding.status}</b> and still counts against the score. The decision, approver, date and reason are shown alongside it and in reports.</p>
        {needsAdmin && <p className={isLight ? 'text-amber-800 font-medium' : 'text-amber-300'}>{finding.severity} findings can only be reviewed by an organization owner or admin.</p>}
        <label className={`block font-medium ${isLight ? 'text-slate-700' : ''}`}>Decision
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={inputClass}>
            <option value="ACCEPTED_RISK">Accepted risk</option>
            <option value="FALSE_POSITIVE">False positive</option>
            <option value="NOT_APPLICABLE">Not applicable</option>
          </select>
        </label>
        <label className={`block font-medium ${isLight ? 'text-slate-700' : ''}`}>Justification (required)
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className={inputClass} placeholder="Why is this acceptable / incorrect? Reference compensating controls or approvals." />
        </label>
        {status === 'ACCEPTED_RISK' && (
          <label className={`block font-medium ${isLight ? 'text-slate-700' : ''}`}>Review / expiry date (max 365 days)
            <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} className={inputClass} />
          </label>
        )}
        {error && <p className="text-rose-600 font-medium">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className={`px-4 py-2 rounded-lg transition-colors ${
            isLight ? 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200' : 'bg-gray-800 hover:bg-gray-700 text-gray-200'
          }`}>Cancel</button>
          <button disabled={busy || reason.trim().length < 10}
            onClick={() => onSubmit({ status, reason: reason.trim(), expiresAt: status === 'ACCEPTED_RISK' ? new Date(`${expires}T23:59:59Z`).toISOString() : undefined })}
            className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-semibold disabled:opacity-40 shadow-sm transition-colors">{busy ? 'Saving…' : 'Record decision'}</button>
        </div>
      </div>
    </Modal>
  );
}
