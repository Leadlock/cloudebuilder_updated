/** Small shared bits of the readiness panel: the look of the controls, and the plain-language labels. */
import clsx from 'clsx';
import type { ControlStatus, FindingStatus, Readiness } from '@/lib/compliance/types';

export const theme = (isLight: boolean) => ({
  card: clsx('rounded-2xl border p-5', isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900/60 border-slate-800'),
  inner: clsx('rounded-xl border p-3', isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/40 border-slate-800'),
  muted: isLight ? 'text-slate-500' : 'text-slate-400',
  strong: isLight ? 'text-slate-900' : 'text-slate-100',
  input: clsx('w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-cyan-500/40', isLight ? 'bg-white border-slate-300 text-slate-900' : 'bg-slate-950 border-slate-700 text-slate-100'),
  btn: clsx('px-3 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-50 disabled:cursor-not-allowed', isLight ? 'bg-cyan-600 border-cyan-600 text-white hover:bg-cyan-700' : 'bg-cyan-500/20 border-cyan-400 text-cyan-200 hover:bg-cyan-500/30'),
  btnQuiet: clsx('px-3 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-50 disabled:cursor-not-allowed', isLight ? 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50' : 'bg-slate-900 border-slate-700 text-slate-200 hover:bg-slate-800'),
  error: isLight ? 'text-rose-700' : 'text-rose-300',
  label: clsx('block text-[11px] font-medium mb-1', isLight ? 'text-slate-600' : 'text-slate-400'),
});

export const STATUS_LABEL: Record<ControlStatus, string> = { implemented: 'In place', partial: 'In part', planned: 'Planned', none: 'Not in place', not_applicable: 'Does not apply' };
export const FINDING_STATUS_LABEL: Record<FindingStatus, string> = { open: 'Open', in_progress: 'In progress', closed: 'Closed', risk_accepted: 'Risk accepted' };

const TONE = {
  green: ['text-emerald-700 bg-emerald-50 border-emerald-200', 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'],
  amber: ['text-amber-700 bg-amber-50 border-amber-200', 'text-amber-300 bg-amber-500/10 border-amber-500/30'],
  red: ['text-rose-700 bg-rose-50 border-rose-200', 'text-rose-300 bg-rose-500/10 border-rose-500/30'],
  grey: ['text-slate-600 bg-slate-50 border-slate-200', 'text-slate-300 bg-slate-500/10 border-slate-500/30'],
  teal: ['text-teal-700 bg-teal-50 border-teal-200', 'text-teal-300 bg-teal-500/10 border-teal-500/30'],
} as const;
export type Tone = keyof typeof TONE;
export const pill = (tone: Tone, isLight: boolean) => clsx('inline-block text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-md border whitespace-nowrap', TONE[tone][isLight ? 0 : 1]);

export const scoreTone = (score: number | null): Tone => (score === null ? 'grey' : score >= 4 ? 'teal' : score === 3 ? 'green' : score === 2 ? 'amber' : 'red');
export const readinessTone = (r: Readiness): Tone => (r === 'Ready' ? 'green' : r === 'Ready with conditions' ? 'amber' : r === 'Not ready' ? 'red' : 'grey');
export const severityTone = (s: string): Tone => (s === 'High' ? 'red' : s === 'Medium' ? 'amber' : 'grey');
