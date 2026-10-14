'use client';
import { Lock } from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '@/context/AppContext';
import { RESTRICTED_FEATURE_LABEL, RESTRICTED_FEATURE_MESSAGE } from '@/lib/auth/restrictedFeatures';

/** Shown in place of the Deploy tab or the AI Generator for an account that is not allowed to use them. */
export default function LockedFeature() {
  const { state, dispatch } = useApp();
  const isLight = state.theme === 'light';
  return (
    <div className={clsx('flex-1 flex items-center justify-center p-6', isLight ? 'bg-slate-50 text-slate-900' : 'bg-gray-950 text-white')}>
      <div className="max-w-sm text-center space-y-3">
        <Lock className={clsx('w-8 h-8 mx-auto', isLight ? 'text-slate-400' : 'text-gray-500')} />
        <p className="text-sm font-semibold">{RESTRICTED_FEATURE_LABEL}</p>
        <p className="text-xs opacity-70">{RESTRICTED_FEATURE_MESSAGE}</p>
        <button type="button" onClick={() => dispatch({ type: 'SET_VIEW', view: 'dashboard' })} className="text-xs text-blue-500 hover:underline">Back to the dashboard</button>
      </div>
    </div>
  );
}
