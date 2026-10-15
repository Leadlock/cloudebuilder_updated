'use client';
import clsx from 'clsx';
import type { EvaluationStatus, Severity, AutoFixSafety } from '@/lib/engines/assessment/types';
import { useApp } from '@/context/AppContext';
import { useEscapeKey } from '@/lib/ui/useEscapeKey';

export const SEVERITY_STYLE: Record<Severity, { badge: string; badgeLight: string; text: string; border: string; label: string }> = {
  CRITICAL: { badge: 'bg-red-500/18 text-red-400 border-red-500/40', badgeLight: 'bg-red-50 text-red-700 border-red-200', text: 'text-red-400', border: 'border-red-500/40', label: 'Critical' },
  HIGH: { badge: 'bg-orange-500/18 text-orange-400 border-orange-500/40', badgeLight: 'bg-orange-50 text-orange-700 border-orange-200', text: 'text-orange-400', border: 'border-orange-500/40', label: 'High' },
  MEDIUM: { badge: 'bg-amber-500/18 text-amber-300 border-amber-500/40', badgeLight: 'bg-amber-50 text-amber-800 border-amber-200', text: 'text-amber-400', border: 'border-amber-500/40', label: 'Medium' },
  LOW: { badge: 'bg-[#0078d4]/18 text-[#50e6ff] border-[#0078d4]/40', badgeLight: 'bg-blue-50 text-blue-700 border-blue-200', text: 'text-[#50e6ff]', border: 'border-[#0078d4]/40', label: 'Low' },
  INFORMATIONAL: { badge: 'bg-slate-500/18 text-slate-300 border-slate-500/40', badgeLight: 'bg-slate-100 text-slate-700 border-slate-200', text: 'text-slate-400', border: 'border-slate-500/40', label: 'Info' },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const s = SEVERITY_STYLE[severity];
  return (
    <span className={clsx('text-[10px] px-2 py-0.5 rounded border font-semibold uppercase tracking-wide', isLight ? s.badgeLight : s.badge)}>
      {s.label}
    </span>
  );
}

const STATUS_STYLE_DARK: Record<EvaluationStatus, string> = {
  PASS: 'bg-emerald-500/18 text-emerald-300 border-emerald-500/40',
  FAIL: 'bg-red-500/18 text-red-300 border-red-500/40',
  WARNING: 'bg-amber-500/18 text-amber-300 border-amber-500/40',
  NOT_APPLICABLE: 'bg-slate-800 text-slate-400 border-slate-700',
  NOT_EVALUATED: 'bg-slate-800/80 text-slate-400 border-slate-700',
  INSUFFICIENT_DATA: 'bg-slate-800/80 text-slate-400 border-slate-700',
};

const STATUS_STYLE_LIGHT: Record<EvaluationStatus, string> = {
  PASS: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  FAIL: 'bg-red-50 text-red-800 border-red-200',
  WARNING: 'bg-amber-50 text-amber-800 border-amber-200',
  NOT_APPLICABLE: 'bg-slate-100 text-slate-600 border-slate-200',
  NOT_EVALUATED: 'bg-slate-100 text-slate-600 border-slate-200',
  INSUFFICIENT_DATA: 'bg-slate-100 text-slate-600 border-slate-200',
};

export function StatusBadge({ status }: { status: EvaluationStatus }) {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  return (
    <span className={clsx('text-[10px] px-2 py-0.5 rounded border font-semibold tracking-wide', isLight ? STATUS_STYLE_LIGHT[status] : STATUS_STYLE_DARK[status])}>
      {status.replace('_', ' ')}
    </span>
  );
}

export function SafetyBadge({ safety }: { safety: AutoFixSafety }) {
  const { state } = useApp();
  const isLight = state.theme === 'light';
  const cls = safety === 'SAFE_AUTOFIX'
    ? (isLight ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-emerald-500/18 text-emerald-300 border-emerald-500/40')
    : safety === 'REVIEW_REQUIRED'
    ? (isLight ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-amber-500/18 text-amber-300 border-amber-500/40')
    : (isLight ? 'bg-slate-100 text-slate-700 border-slate-200' : 'bg-slate-800 text-slate-300 border-white/10');
  const label = safety === 'SAFE_AUTOFIX' ? 'Safe Auto-Fix' : safety === 'REVIEW_REQUIRED' ? 'Review required' : 'Manual only';
  return <span className={clsx('text-[10px] px-2 py-0.5 rounded border font-medium', cls)}>{label}</span>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const { state: appState } = useApp();
  const isLight = appState.theme === 'light';
  useEscapeKey(onClose);

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${isLight ? 'bg-slate-900/40' : 'bg-black/70'} backdrop-blur-sm p-4`} role="dialog" aria-modal="true" aria-label={title}>
      <div className={clsx('border rounded-2xl shadow-2xl max-h-[90vh] flex flex-col w-full animate-in zoom-in-95 duration-150',
        isLight ? 'bg-white border-slate-200 text-slate-800' : 'bg-[#1c1c1e] border-white/[0.10] text-slate-200 shadow-2xl',
        wide ? 'max-w-3xl' : 'max-w-xl'
      )}>
        <div className={`flex items-center justify-between px-5 py-3 border-b ${isLight ? 'border-slate-100' : 'border-white/[0.08]'}`}>
          <h3 className={`font-semibold text-sm ${isLight ? 'text-slate-900' : 'text-white'}`}>{title}</h3>
          <button onClick={onClose} className={`${isLight ? 'text-slate-400 hover:text-slate-700' : 'text-slate-400 hover:text-white'} text-lg leading-none px-2`} aria-label="Close">×</button>
        </div>
        <div className="overflow-y-auto p-5 text-sm">{children}</div>
      </div>
    </div>
  );
}
