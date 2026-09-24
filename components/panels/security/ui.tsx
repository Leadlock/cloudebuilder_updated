'use client';
import clsx from 'clsx';
import type { EvaluationStatus, Severity, AutoFixSafety } from '@/lib/engines/assessment/types';

export const SEVERITY_STYLE: Record<Severity, { badge: string; text: string; border: string; label: string }> = {
  CRITICAL: { badge: 'bg-red-900 text-red-200', text: 'text-red-400', border: 'border-red-800/70', label: 'Critical' },
  HIGH: { badge: 'bg-orange-900 text-orange-200', text: 'text-orange-400', border: 'border-orange-800/70', label: 'High' },
  MEDIUM: { badge: 'bg-yellow-900 text-yellow-200', text: 'text-yellow-400', border: 'border-yellow-800/70', label: 'Medium' },
  LOW: { badge: 'bg-blue-900 text-blue-200', text: 'text-blue-400', border: 'border-blue-800/70', label: 'Low' },
  INFORMATIONAL: { badge: 'bg-gray-700 text-gray-200', text: 'text-gray-400', border: 'border-gray-700', label: 'Info' },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY_STYLE[severity];
  return <span className={clsx('text-[10px] px-2 py-0.5 rounded font-semibold uppercase tracking-wide', s.badge)}>{s.label}</span>;
}

const STATUS_STYLE: Record<EvaluationStatus, string> = {
  PASS: 'bg-emerald-900/60 text-emerald-300',
  FAIL: 'bg-red-900/60 text-red-300',
  WARNING: 'bg-amber-900/60 text-amber-300',
  NOT_APPLICABLE: 'bg-gray-800 text-gray-400',
  NOT_EVALUATED: 'bg-slate-700 text-slate-200',
  INSUFFICIENT_DATA: 'bg-slate-700 text-slate-200',
};

export function StatusBadge({ status }: { status: EvaluationStatus }) {
  return <span className={clsx('text-[10px] px-2 py-0.5 rounded font-semibold tracking-wide', STATUS_STYLE[status])}>{status.replace('_', ' ')}</span>;
}

export function SafetyBadge({ safety }: { safety: AutoFixSafety }) {
  const cls = safety === 'SAFE_AUTOFIX' ? 'bg-emerald-900/50 text-emerald-300 border-emerald-700/60'
    : safety === 'REVIEW_REQUIRED' ? 'bg-amber-900/40 text-amber-300 border-amber-700/60' : 'bg-gray-800 text-gray-300 border-gray-600';
  const label = safety === 'SAFE_AUTOFIX' ? 'Safe Auto-Fix' : safety === 'REVIEW_REQUIRED' ? 'Review required' : 'Manual only';
  return <span className={clsx('text-[10px] px-2 py-0.5 rounded border font-medium', cls)}>{label}</span>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className={clsx('bg-gray-900 border border-gray-700 rounded-xl shadow-2xl max-h-[90vh] flex flex-col w-full', wide ? 'max-w-3xl' : 'max-w-xl')}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
          <h3 className="text-white font-semibold text-sm">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none px-2" aria-label="Close">×</button>
        </div>
        <div className="overflow-y-auto p-5 text-sm text-gray-300">{children}</div>
      </div>
    </div>
  );
}
