'use client';
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import type { AutoFixPlan } from '@/lib/engines/assessment/autofix';
import type { Finding } from '@/lib/engines/assessment/types';
import { Modal, SafetyBadge, SeverityBadge } from './ui';

const money = (n: number) => `$${n.toFixed(2)}`;

export function AutoFixPreviewModal({ plan, onApply, onCancel, busy }: { plan: AutoFixPlan; onApply: () => void; onCancel: () => void; busy: boolean }) {
  const [ack, setAck] = useState(plan.safety === 'SAFE_AUTOFIX');
  return (
    <Modal title={`Auto-Fix preview — ${plan.ruleId}`} onClose={onCancel} wide>
      <div className="space-y-4">
        <div className="flex items-center gap-2"><SafetyBadge safety={plan.safety} /><span className="text-white font-medium">{plan.title}</span></div>
        <p className="text-gray-400 text-xs">{plan.safetyReason}</p>

        <section>
          <p className="text-gray-400 font-semibold text-xs mb-1">Configuration change on “{plan.resourceLabel}”</p>
          <table className="w-full text-xs">
            <thead><tr className="text-gray-500 text-left"><th className="font-medium">Setting</th><th className="font-medium">Current</th><th className="font-medium">Proposed</th></tr></thead>
            <tbody>{plan.changes.map((c) => (
              <tr key={c.field} className="border-t border-gray-800"><td className="py-1 text-gray-300">{c.label}</td><td className="py-1 text-red-300">{c.current}</td><td className="py-1 text-emerald-300">{c.proposed}</td></tr>
            ))}</tbody>
          </table>
        </section>

        <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-gray-500">Resources affected</dt><dd>{plan.affectedResources.join(', ')}</dd>
          <dt className="text-gray-500">Why</dt><dd>{plan.why}</dd>
          <dt className="text-gray-500">Security improvement</dt><dd>{plan.securityImprovement}</dd>
          <dt className="text-gray-500">Architecture impact</dt><dd>{plan.architectureImpact}</dd>
          <dt className="text-gray-500">Cost impact</dt>
          <dd>
            {plan.cost.deltaMonthly === 0 ? 'No change in the static estimate' : `${plan.cost.deltaMonthly > 0 ? '+' : ''}${money(plan.cost.deltaMonthly)}/month`}
            <span className="text-gray-500"> ({money(plan.cost.beforeMonthly)} → {money(plan.cost.afterMonthly)}; {plan.cost.basis})</span>
          </dd>
        </dl>

        <section>
          <p className="text-gray-400 font-semibold text-xs mb-1">Terraform impact {plan.terraform.expectationMet === false && <span className="text-red-400">(expected change not rendered — fix will be rejected)</span>}</p>
          <pre className="bg-black/40 rounded-lg p-3 text-[11px] leading-relaxed overflow-x-auto max-h-48">
            {plan.terraform.removed.map((l, i) => <div key={`r${i}`} className="text-red-300">- {l}</div>)}
            {plan.terraform.added.map((l, i) => <div key={`a${i}`} className="text-emerald-300">+ {l}</div>)}
            {plan.terraform.added.length + plan.terraform.removed.length === 0 && <span className="text-gray-500">No Terraform change</span>}
          </pre>
        </section>

        {plan.safety === 'REVIEW_REQUIRED' && (
          <label className="flex items-start gap-2 text-xs text-amber-200 bg-amber-900/20 border border-amber-800/50 rounded-lg p-3">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
            I have reviewed this change and its impact on connectivity, cost and deployment.
          </label>
        )}
        <p className="text-gray-500 text-[11px]">After applying, CloudCraft re-validates the architecture, re-runs this rule, re-assesses all rules for regressions and regenerates Terraform. The change is kept only if every check passes; otherwise the architecture is left unchanged and the fix is reported as failed.</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs">Cancel</button>
          <button onClick={onApply} disabled={!ack || busy} className={clsx('px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-40', plan.safety === 'SAFE_AUTOFIX' ? 'bg-emerald-700 hover:bg-emerald-600 text-white' : 'bg-amber-700 hover:bg-amber-600 text-white')}>
            {busy ? 'Applying…' : 'Apply Fix'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function BulkFixModal({ findings, costDelta, onApply, onCancel, busy }: { findings: Finding[]; costDelta: number; onApply: () => void; onCancel: () => void; busy: boolean }) {
  const resources = useMemo(() => Array.from(new Set(findings.flatMap((f) => f.resourceLabels))), [findings]);
  const bySev = useMemo(() => findings.reduce<Record<string, number>>((m, f) => ({ ...m, [f.severity]: (m[f.severity] ?? 0) + 1 }), {}), [findings]);
  return (
    <Modal title="Fix all safe issues" onClose={onCancel} wide>
      <div className="space-y-4 text-xs">
        <p>Only findings classified <b className="text-emerald-300">SAFE_AUTOFIX</b> are included. Review-required and manual findings are never applied automatically.</p>
        <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-gray-500">Number of fixes</dt><dd>{findings.length}</dd>
          <dt className="text-gray-500">Affected resources</dt><dd>{resources.join(', ')}</dd>
          <dt className="text-gray-500">Security impact</dt><dd>{Object.entries(bySev).map(([s, n]) => `${n} ${s.toLowerCase()}`).join(', ')} finding(s) resolved if verification passes</dd>
          <dt className="text-gray-500">Possible cost impact</dt><dd>{costDelta === 0 ? 'No change in the static estimate' : `${costDelta > 0 ? '+' : ''}$${costDelta.toFixed(2)}/month (static estimate)`}</dd>
        </dl>
        <ul className="space-y-1 max-h-56 overflow-y-auto">
          {findings.map((f) => (
            <li key={f.findingId} className="flex items-center gap-2"><SeverityBadge severity={f.severity} /><code className="text-gray-500">{f.findingId}</code><span className="text-gray-300">{f.autoFix.description} — {f.resourceLabels.join(', ')}</span></li>
          ))}
        </ul>
        <p className="text-gray-500 text-[11px]">Fixes are applied one at a time; each is verified (validation, rule re-evaluation, regression check, Terraform) and skipped if verification fails.</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200">Cancel</button>
          <button onClick={onApply} disabled={busy || findings.length === 0} className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-semibold disabled:opacity-40">{busy ? 'Applying…' : `Apply ${findings.length} safe fix${findings.length === 1 ? '' : 'es'}`}</button>
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
  const [status, setStatus] = useState<'ACCEPTED_RISK' | 'FALSE_POSITIVE' | 'NOT_APPLICABLE'>('ACCEPTED_RISK');
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState(() => new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10));
  const needsAdmin = finding.severity === 'CRITICAL' || finding.severity === 'HIGH';
  return (
    <Modal title={`Review decision — ${finding.findingId}`} onClose={onCancel}>
      <div className="space-y-3 text-xs">
        <p>Recording a decision does <b>not</b> change the technical result: the finding stays <b>{finding.status}</b> and still counts against the score. The decision, approver, date and reason are shown alongside it and in reports.</p>
        {needsAdmin && <p className="text-amber-300">{finding.severity} findings can only be reviewed by an organization owner or admin.</p>}
        <label className="block">Decision
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200">
            <option value="ACCEPTED_RISK">Accepted risk</option>
            <option value="FALSE_POSITIVE">False positive</option>
            <option value="NOT_APPLICABLE">Not applicable</option>
          </select>
        </label>
        <label className="block">Justification (required)
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200" placeholder="Why is this acceptable / incorrect? Reference compensating controls or approvals." />
        </label>
        {status === 'ACCEPTED_RISK' && (
          <label className="block">Review / expiry date (max 365 days)
            <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
          </label>
        )}
        {error && <p className="text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200">Cancel</button>
          <button disabled={busy || reason.trim().length < 10}
            onClick={() => onSubmit({ status, reason: reason.trim(), expiresAt: status === 'ACCEPTED_RISK' ? new Date(`${expires}T23:59:59Z`).toISOString() : undefined })}
            className="px-4 py-2 rounded-lg bg-violet-700 hover:bg-violet-600 text-white font-semibold disabled:opacity-40">{busy ? 'Saving…' : 'Record decision'}</button>
        </div>
      </div>
    </Modal>
  );
}
