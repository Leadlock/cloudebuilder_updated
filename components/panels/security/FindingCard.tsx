'use client';
import { useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, Wrench, ExternalLink, ShieldQuestion } from 'lucide-react';
import type { Finding } from '@/lib/engines/assessment/types';
import { SEVERITY_STYLE, SeverityBadge, StatusBadge, SafetyBadge } from './ui';

const human = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

export default function FindingCard({ finding: f, onAutoFix, onReview, canReview }: {
  finding: Finding;
  onAutoFix: (f: Finding) => void;
  onReview: (f: Finding) => void;
  canReview: boolean;
}) {
  const [open, setOpen] = useState(false);
  const sev = SEVERITY_STYLE[f.severity];
  return (
    <div className={clsx('rounded-xl border bg-gray-800/60', sev.border)} data-testid="finding-card" data-finding-id={f.findingId}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full text-left p-4 flex gap-3 items-start" aria-expanded={open}>
        {open ? <ChevronDown className="w-4 h-4 mt-0.5 text-gray-500 shrink-0" /> : <ChevronRight className="w-4 h-4 mt-0.5 text-gray-500 shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <SeverityBadge severity={f.severity} />
            <StatusBadge status={f.status} />
            {f.reviewStatus !== 'OPEN' && <span className="text-[10px] px-2 py-0.5 rounded bg-violet-900/60 text-violet-200 font-semibold">{human(f.reviewStatus)}</span>}
            <code className="text-[10px] text-gray-500">{f.findingId}</code>
          </div>
          <p className="text-white font-medium text-sm">{f.title}</p>
          <p className="text-gray-400 text-xs mt-0.5">
            {f.resourceLabels.join(', ') || 'Architecture-wide'} · {f.service}{f.region ? ` · ${f.region}` : ''}
          </p>
          <p className="text-gray-300 text-xs mt-1.5">{f.observation}</p>
        </div>
        <div className="shrink-0"><SafetyBadge safety={f.autoFix.available ? f.autoFix.safety : 'MANUAL_ONLY'} /></div>
      </button>

      {open && (
        <div className="px-4 pb-4 pl-11 space-y-3 text-xs">
          {f.evidence.length > 0 && (
            <div>
              <p className="text-gray-400 font-semibold mb-1">Evidence</p>
              <table className="w-full text-left">
                <thead><tr className="text-gray-500"><th className="font-medium pr-2">Setting</th><th className="font-medium pr-2">Observed</th><th className="font-medium pr-2">Expected</th><th className="font-medium">Basis</th></tr></thead>
                <tbody>
                  {f.evidence.map((e, i) => (
                    <tr key={i} className="border-t border-gray-700/60"><td className="py-1 pr-2 text-gray-300">{e.label}</td><td className="py-1 pr-2 text-white">{e.observed}</td><td className="py-1 pr-2 text-gray-400">{e.expected ?? '—'}</td><td className="py-1 text-gray-500">{human(e.basis)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p><span className="text-gray-400 font-semibold">Why this matters: </span><span className="text-gray-300">{f.rationale}</span></p>
          <p><span className="text-gray-400 font-semibold">Risk: </span><span className="text-gray-300">{f.risk} {f.impact}</span></p>
          <div className="p-2.5 bg-black/20 rounded-lg">
            <p className="text-gray-300"><span className="text-emerald-400 font-semibold">Recommendation: </span>{f.recommendation}</p>
            {f.manualSteps.length > 0 && <ol className="list-decimal ml-5 mt-1 text-gray-400 space-y-0.5">{f.manualSteps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
            {f.terraform && <p className="mt-1 text-gray-500">Terraform: <code className="text-gray-400">{f.terraform}</code></p>}
          </div>
          <p className="text-gray-500">
            {f.domain === 'SECURITY' ? 'Security' : human(f.domain)} · {f.category} · {human(f.pillar)}{f.practice ? ` (${f.practice})` : ''} · Evidence: {f.provenance === 'DESIGN_TIME' ? 'design-time configuration' : 'discovered configuration (point-in-time)'}
          </p>
          {f.references.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {f.references.filter((r) => r.identifier || r.url).map((r) => r.url ? (
                <a key={r.key} href={r.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1">
                  {r.identifier ? `${r.framework.includes('Security Hub') ? 'Security Hub' : r.framework.includes('benchmark') ? 'MCSB' : r.framework} ${r.identifier}` : r.title}<ExternalLink className="w-3 h-3" />
                </a>
              ) : (
                <span key={r.key} className="text-gray-400">Azure Policy {r.identifier}</span>
              ))}
            </div>
          )}
          {f.review && (
            <p className="text-violet-300">{human(f.review.status)} by {f.review.approvedBy} on {f.review.approvedAt.slice(0, 10)}{f.review.expiresAt ? ` (review by ${f.review.expiresAt.slice(0, 10)})` : ''}: “{f.review.reason}”. The finding still counts as failing.</p>
          )}
          <p className="text-gray-500">{f.autoFix.safetyReason}</p>
          <div className="flex flex-wrap gap-2 pt-1">
            {f.autoFix.available && (
              <button onClick={() => onAutoFix(f)} aria-label={`Auto-fix ${f.findingId}`}
                className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium focus:outline-none focus:ring-2',
                  f.autoFix.safety === 'SAFE_AUTOFIX' ? 'bg-emerald-800 hover:bg-emerald-700 text-emerald-100 focus:ring-emerald-500' : 'bg-amber-800 hover:bg-amber-700 text-amber-50 focus:ring-amber-500')}>
                <Wrench className="w-3 h-3" />{f.autoFix.safety === 'SAFE_AUTOFIX' ? 'Auto-Fix' : 'Review & Auto-Fix'}
              </button>
            )}
            {canReview && (
              <button onClick={() => onReview(f)} className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg text-xs font-medium">
                <ShieldQuestion className="w-3 h-3" />Record review decision
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
